import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, verify, withFixture } from "./fixture.mjs";

test("state-static-text-does-not-claim-enabled-control-readiness", async () => {
  await withFixture(
    `<h1><span id="expected-target">Where should we begin?</span></h1>
    <h2 id="heading">Welcome</h2><p id="paragraph">Instructions</p><div id="container">Content</div>
    <img id="image" alt="Logo" width="24" height="24"><input id="input" type="email" aria-label="Email address">
    <button id="native">Continue</button><span id="custom" role="button">Custom action</span>
    <a id="link" href="#">Help</a><span id="declared" aria-disabled="false">Declared state</span>
    <div aria-disabled="true"><span id="disabled">Disabled text</span></div>
    <script>window.observedEvents = { click: 0, focus: 0 };
    document.addEventListener('click', () => window.observedEvents.click++);
    document.addEventListener('focusin', () => window.observedEvents.focus++);</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      for (const [text, id, enabled] of [
        ["Where should we begin?", "expected-target", "not_applicable"],
        ["Welcome", "heading", "not_applicable"],
        ["Instructions", "paragraph", "not_applicable"],
        ["Content", "container", "not_applicable"],
        ["Logo", "image", "not_applicable"],
        ["Email address", "input", "pass"],
        ["Continue", "native", "pass"],
        ["Custom action", "custom", "pass"],
        ["Help", "link", "pass"],
        ["Declared state", "declared", "pass"],
        ["Disabled text", "disabled", "fail"],
      ]) {
        const candidate = capture.candidates.find((entry) => (entry.text || entry.label) === text);
        assert.ok(candidate, text);
        for (const action of ["click", "double_click", "right_click"]) {
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(target.interactability.checks.enabled, enabled, `${id}/${action}`);
          assert.equal(target.interactability.status, enabled === "fail" ? "blocked" : "ready");
          assert.equal(target.interactability.checks.viewport, "pass");
          assert.equal(target.interactability.checks.pointerReception, "pass");
          assert.equal(target.interactability.checks.eventOutcome, "unknown");
          assert.deepEqual((await verify(target.xpaths)).matches, [[id]]);
        }
      }
      const after = await observe();
      assert.deepEqual(after.events, before.events);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
    },
  );
});

test("state-disabled-target-has-distinct-click-and-hover-readiness", async () => {
  await withFixture(
    '<button id="expected-target" disabled>Disabled action</button>',
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.text === "Disabled action");
      for (const [action, status] of [
        ["click", "blocked"],
        ["hover", "ready"],
      ]) {
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action,
        });
        assert.equal(target.interactability.action, action);
        assert.equal(target.interactability.status, status);
        assert.equal(
          target.interactability.checks.enabled,
          action === "hover" ? "not_applicable" : "fail",
        );
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
        assert.deepEqual(
          (await verify(target.xpaths)).matches,
          target.xpaths.map(() => ["expected-target"]),
        );
      }
    },
  );
});

for (const focused of [false, true])
  test(`state-native-email-keyboard-readiness-is-passive-${focused ? "focused" : "unfocused"}`, async () => {
    await withFixture(
      `<label for="expected-target">Email address</label><input id="expected-target" type="email" data-observe-value value="PRIVATE_EMAIL">
    <script>${focused ? "document.querySelector('#expected-target').focus();" : ""}window.observedEvents={};for(const name of ['input','change','focusin','focusout','keydown'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`,
      async (session, page) => {
        const before = await observe();
        assert.equal(before.activeElement, focused ? "expected-target" : "");
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((entry) => entry.label === "Email address");
        assert.ok(candidate);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "type",
        });
        assert.equal(target.interactability.checks.keyboard, "pass");
        assert.equal(target.interactability.status, "ready");
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
        const after = await verify(target.xpaths);
        assert.deepEqual(after.matches, [["expected-target"]]);
        assert.equal(after.activeElement, before.activeElement);
        assert.deepEqual(after.events, before.events);
        assert.deepEqual(after.values, before.values);
        assert.equal(after.scrollY, before.scrollY);
        assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_EMAIL/);
      },
    );
  });

test("state-readiness-reports-control-limitations-without-interaction", async () => {
  await withFixture(
    `<input aria-label="Readonly field" readonly value="PRIVATE_VALUE">
    <input aria-label="Disabled field" disabled><textarea aria-label="Native notes"></textarea>
    <div contenteditable aria-label="Native editor" style="height:30px"></div>
    <div role="textbox" aria-label="Custom writable editor" tabindex="0" style="height:30px"></div>
    <input type="checkbox" aria-label="Check choice"><input type="radio" aria-label="Radio choice">
    <select aria-label="Select country"><option>PRIVATE_OPTION</option></select>
    <div role="combobox" aria-label="Custom select" tabindex="0">Custom</div>
    <div role="textbox" aria-label="Custom editor" aria-readonly="true" tabindex="0" style="height:30px"></div>
    <button aria-label="Blocked pointer" style="pointer-events:none">Pointer</button>
    <div style="position:relative;width:160px;height:40px"><button aria-label="Covered" style="width:160px;height:40px">Covered</button><div style="position:absolute;inset:0;background:black"></div></div>
    <button aria-label="Plain button">Plain</button>
    <script>window.observedEvents={};for(const name of ['click','input','change','focusin','mouseover','pointerover','scroll'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      for (const [name, action, status, reason] of [
        ["Readonly field", "fill", "blocked", "readonly"],
        ["Readonly field", "type", "blocked", "readonly"],
        ["Readonly field", "click", "ready", null],
        ["Disabled field", "type", "blocked", "disabled"],
        ["Native notes", "fill", "ready", null],
        ["Native editor", "type", "ready", null],
        ["Native editor", "clear", "ready", null],
        ["Custom writable editor", "type", "unsupported", "custom_control_unverified"],
        ["Plain button", "fill", "blocked", "incompatible_control"],
        ["Blocked pointer", "hover", "blocked", "pointer_events_none"],
        ["Covered", "click", "blocked", "obstructed_at_hit_point"],
        ["Select country", "select", "unknown", null],
        ["Check choice", "check", "ready", null],
        ["Check choice", "uncheck", "ready", null],
        ["Radio choice", "uncheck", "blocked", "incompatible_control"],
        ["Custom select", "select", "unsupported", "custom_control_unverified"],
        ["Custom editor", "fill", "blocked", "readonly"],
      ]) {
        const candidate = capture.candidates.find((entry) => entry.label === name);
        assert.ok(candidate, name);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action,
        });
        assert.equal(target.interactability.status, status, `${name}: ${action}`);
        if (reason)
          assert.ok(target.interactability.reasons.includes(reason), `${name}: ${reason}`);
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
      }
      const after = await observe();
      assert.deepEqual(after.events, before.events);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_/);
    },
  );
});

test("state-native-date-and-time-fill-and-clear-remain-passive", async () => {
  const types = [
    ["date", "2030-06-15"],
    ["month", "2030-06"],
    ["week", "2030-W24"],
    ["time", "12:30"],
    ["datetime-local", "2030-06-15T12:30"],
  ];
  const markup =
    types
      .flatMap(([type, value]) =>
        [false, true].map(
          (readonly) =>
            `<input type="${type}" aria-label="${type} ${readonly ? "readonly" : "writable"}" value="${value}" data-observe-value ${readonly ? "readonly" : ""}>`,
        ),
      )
      .join("") +
    `<script>window.observedEvents={};for(const name of ['click','input','change','focusin','keydown','keyup'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`;
  await withFixture(markup, async (session, page) => {
    const before = await observe();
    const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
    for (const [type] of types)
      for (const readonly of [false, true]) {
        assert.ok(
          before.inputTypes.some((input) => input.declared === type && input.actual === type),
        );
        const candidate = capture.candidates.find(
          (entry) => entry.label === `${type} ${readonly ? "readonly" : "writable"}`,
        );
        assert.ok(candidate);
        for (const action of ["fill", "clear", "type"]) {
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(
            target.interactability.checks.compatibleControl,
            action === "type" ? "fail" : "pass",
            `${type}: ${action}`,
          );
          assert.equal(
            target.interactability.checks.keyboard,
            action === "type" ? "unknown" : "pass",
          );
          assert.equal(target.state.editable, !readonly);
          assert.equal(target.interactability.checks.writable, readonly ? "fail" : "pass");
          assert.equal(
            target.interactability.status,
            action === "type" || readonly ? "blocked" : "ready",
          );
        }
      }
    const after = await observe();
    assert.deepEqual(after.values, before.values);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.activeElement, before.activeElement);
    assert.equal(after.scrollY, before.scrollY);
  });
});

for (const framed of [false, true])
  test(`state-action-observations-preserve-identity-and-selected-state-${framed ? "iframe" : "main"}`, async () => {
    const markup = `<input id="expected-target" aria-label="Notes" readonly value="PRIVATE_VALUE">
     <input type="file" aria-label="Upload document"><input type="file" hidden aria-label="Hidden upload">
     <select aria-label="Countries" multiple><option selected>PRIVATE_SELECTION</option><option selected>PRIVATE_OTHER</option></select>
     <div role="tab" tabindex="0" aria-selected="true" aria-label="Overview" style="height:30px"></div>
     <button disabled aria-label="Disabled"><span>Inside button</span></button>
     <p id="help">Text help</p><svg><circle aria-label="Diagram node" cx="20" cy="20" r="10"/></svg>`;
    await withFixture(
      (path) =>
        framed && path === "/fixture"
          ? '<iframe title="Controls" src="/matrix" style="width:900px;height:650px"></iframe>'
          : markup,
      async (session, page) => {
        if (framed) await observe({}, "/matrix");
        const before = await observe();
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_|Hidden upload/);
        for (const [label, action, status, check, value] of [
          ["Notes", "clear", "blocked", "writable", "fail"],
          ["Notes", "press", "unknown", "keyboard", "unknown"],
          ["Overview", "focus", "unknown", "keyboard", "unknown"],
          ["Overview", "blur", "unknown", "keyboard", "unknown"],
          ["Upload document", "upload", "unknown", "compatibleControl", "pass"],
          ["Notes", "upload", "blocked", "compatibleControl", "fail"],
          ["Disabled", "double_click", "blocked", "enabled", "fail"],
          ["Disabled", "right_click", "blocked", "enabled", "fail"],
          ["Disabled", "inspect", "ready", "enabled", "not_applicable"],
          ["Text help", "hover", "ready", "enabled", "not_applicable"],
          ["Diagram node", "inspect", "ready", "enabled", "not_applicable"],
          ["Countries", "select", "unknown", "compatibleControl", "pass"],
        ]) {
          const candidate = capture.candidates.find(
            (candidate) => (candidate.label || candidate.text) === label,
          );
          assert.ok(candidate, label);
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(target.interactability.status, status, `${label}: ${action}`);
          assert.equal(target.interactability.checks[check], value);
          assert.equal(target.xpaths.length, 1);
          if (label === "Countries") assert.equal(target.state.selectedOptionCount, 2);
          if (label === "Overview") assert.equal(target.state.selected, true);
          if (label === "Diagram node") assert.match(target.xpaths[0], /local-name\(\)/);
        }
        const after = await observe();
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.clicks, before.clicks);
        assert.equal(after.scrollY, before.scrollY);
      },
    );
  });
