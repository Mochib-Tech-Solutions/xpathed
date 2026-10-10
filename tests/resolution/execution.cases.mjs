import assert from "node:assert/strict";
import test from "node:test";

import {
  targetMarkup,
  request,
  observe,
  expectError,
  withFixture,
  prepareExecution,
} from "./fixture.mjs";

test("execution-click-is-explicit-and-consumes-the-capture", async () => {
  await withFixture(
    '<button id="expected-target" onclick="this.dataset.clicks = String(Number(this.dataset.clicks ?? 0) + 1)">Save</button>',
    async (session, page) => {
      const execution = await prepareExecution(session, page, "click", "Save");
      assert.equal((await observe()).clicks, "0");
      await expectError(
        `/pages/${page.pageId}/execute`,
        { ...execution, sessionId: "different-session" },
        409,
        "stale_session",
      );
      const result = await request(`/pages/${page.pageId}/execute`, execution);
      assert.equal(result.status, "completed");
      assert.equal((await observe()).clicks, "1");
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
      assert.equal((await observe()).clicks, "1");
    },
  );
});

test("execution-rejects-a-replaced-retained-target", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const execution = await prepareExecution(session, page, "click", "About us");
    await observe({ replaceTarget: true });
    await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
    assert.equal((await observe()).clicks, "0");
  });
});

test("execution-rechecks-readiness-and-consumes-a-failed-attempt", async () => {
  await withFixture(
    `${targetMarkup}<button id="disable" onclick="document.querySelector('#expected-target').disabled = true">Disable</button>`,
    async (session, page) => {
      const execution = await prepareExecution(session, page, "click", "About us");
      await observe({ click: "#disable" });
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "action_not_ready");
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
      assert.equal((await observe()).clicks, "0");
    },
  );
});

test("execution-edits-only-the-retained-input-with-explicit-values", async () => {
  await withFixture(
    '<label>Notes<input id="expected-target" data-observe-value></label><label>Other<input data-observe-value value="untouched"></label>',
    async (session, page) => {
      for (const [action, value, expected] of [
        ["fill", "private-test-value", "private-test-value"],
        ["type", " appended", "private-test-value appended"],
        ["clear", undefined, ""],
      ]) {
        const execution = await prepareExecution(session, page, action, "Notes");
        const result = await request(`/pages/${page.pageId}/execute`, {
          ...execution,
          ...(value === undefined ? {} : { value }),
        });
        assert.equal(result.status, "completed");
        assert.ok(!JSON.stringify(result).includes("private-test-value"));
        assert.deepEqual((await observe()).values, [expected, "untouched"]);
      }
    },
  );
});

test("execution-check-and-select-use-native-controls", async () => {
  await withFixture(
    '<label>Consent<input type="checkbox"></label><label>Color<select data-observe-value><option value="red">Red</option><option value="blue">Blue</option><option value="">No color</option><option value="disabled" disabled>Unavailable</option><optgroup label="Unavailable group" disabled><option value="grouped">Grouped</option></optgroup><option value="duplicate">First duplicate</option><option value="duplicate">Second duplicate</option></select></label>',
    async (session, page) => {
      for (const [action, expected] of [
        ["check", true],
        ["uncheck", false],
      ]) {
        const execution = await prepareExecution(session, page, action, "Consent");
        assert.equal(
          (await request(`/pages/${page.pageId}/execute`, execution)).status,
          "completed",
        );
        assert.deepEqual((await observe()).checked, [expected]);
      }
      const selection = await prepareExecution(session, page, "select", "Color");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...selection, value: "blue" })).status,
        "completed",
      );
      assert.deepEqual((await observe()).values, ["blue"]);
      for (const value of ["disabled", "grouped", "duplicate"]) {
        const rejected = await prepareExecution(session, page, "select", "Color");
        await expectError(
          `/pages/${page.pageId}/execute`,
          { ...rejected, value },
          409,
          "invalid_action_value",
        );
        assert.deepEqual((await observe()).values, ["blue"]);
        await expectError(
          `/pages/${page.pageId}/execute`,
          { ...rejected, value: "red" },
          409,
          "stale_capture",
        );
      }
      const empty = await prepareExecution(session, page, "select", "Color");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...empty, value: "" })).status,
        "completed",
      );
      assert.deepEqual((await observe()).values, [""]);
    },
  );
});

test("execution-focus-press-and-blur-stay-on-the-selected-control", async () => {
  await withFixture(
    '<label>Notes<input id="expected-target" onkeydown="window.observedEvents = { key: event.key }"></label>',
    async (session, page) => {
      let execution = await prepareExecution(session, page, "focus", "Notes");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).activeElement, "expected-target");
      execution = await prepareExecution(session, page, "press", "Notes");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...execution, value: "ArrowRight" }))
          .status,
        "completed",
      );
      assert.equal((await observe()).events.key, "ArrowRight");
      execution = await prepareExecution(session, page, "blur", "Notes");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).activeElement, "");
      execution = await prepareExecution(session, page, "press", "Notes");
      await expectError(
        `/pages/${page.pageId}/execute`,
        { ...execution, value: "Control+L" },
        400,
        "invalid_action_value",
      );
    },
  );
});

test("execution-keeps-frame-and-shadow-target-identity", async () => {
  await withFixture(
    (path) =>
      path === "/child"
        ? '<button id="expected-target" onclick="this.dataset.clicks = \'1\'">Child Save</button>'
        : '<iframe src="/child" title="Child" style="width:400px;height:200px"></iframe><div id="consent-host"></div><script>document.querySelector("#consent-host").attachShadow({mode:"open"}).innerHTML = `<button id="expected-target" onclick="this.dataset.clicks = 1">Shadow Save</button>`;</script>',
    async (session, page) => {
      let execution = await prepareExecution(session, page, "click", "Child Save");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe({}, "/child")).clicks, "1");
      assert.equal((await observe()).clicks, "0");
      execution = await prepareExecution(session, page, "click", "Shadow Save");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).clicks, "1");
    },
  );
});
