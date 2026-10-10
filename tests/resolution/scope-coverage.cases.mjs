import assert from "node:assert/strict";
import test from "node:test";
import { targetMarkup, request, observe, verify, expectError, withFixture } from "./fixture.mjs";

test("scope-capture-retains-partial-and-blocked-targets-with-safe-layout-evidence", async () => {
  await withFixture(
    `<style>body{margin:0}button{width:100px;height:30px;background:rgb(255,0,0);color:rgb(255,255,255);border:2px solid rgb(0,0,0)}
    #partial{position:fixed;top:790px;left:10px}#edge{position:fixed;top:800px}#covered{position:absolute;top:100px;left:0}
    #overlay{position:absolute;top:100px;left:0;width:100px;height:30px;background:white;z-index:2}
    #reordered{display:flex;flex-direction:column}#above{order:0}#red{order:1}</style>
    <span id="safe-label" hidden>Named safely<input value="PRIVATE_LABEL_VALUE"></span>
    <button id="named" aria-labelledby="safe-label" disabled></button><input aria-label="Readonly notes" readonly>
    <button id="covered">Covered</button><div id="overlay"></div>
    <button id="partial">Partial</button><button id="edge">Edge only</button>
    <section aria-label="Approval list"><h2>Approval heading</h2><div id="reordered"><button id="red">Red anchor</button><button id="above" style="background:rgb(0,0,255)">Above anchor</button></div></section>
    <button hidden>Hidden target</button><button id="offscreen" style="position:absolute;top:2000px">Outside view</button>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.scope, "current_view");
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.excludedOffscreenCount, 2);
      const named = capture.candidates.find((c) => c.label === "Named safely");
      const partial = capture.candidates.find((c) => c.label === "Partial");
      const covered = capture.candidates.find((c) => c.label === "Covered");
      assert.ok(named && partial && covered);
      assert.equal(named.state.enabled, false);
      assert.ok(capture.candidates.some((c) => c.label === "Readonly notes" && c.state.readonly));
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_LABEL_VALUE"));
      assert.ok(
        !capture.candidates.some((c) =>
          ["Outside view", "Edge only", "Hidden target"].includes(c.label),
        ),
      );
      const red = capture.candidates.find((c) => c.label === "Red anchor");
      const above = capture.candidates.find((c) => c.label === "Above anchor");
      assert.deepEqual(red.appearance, {
        backgroundColor: "rgb(255, 0, 0)",
        textColor: "rgb(255, 255, 255)",
        borderColor: "rgb(0, 0, 0)",
        limitations: [],
      });
      assert.equal(above.appearance.backgroundColor, "rgb(0, 0, 255)");
      assert.ok(above.geometry.y < red.geometry.y);
      assert.ok(capture.candidates.some((c) => c.text === "Approval heading"));
      for (const [candidate, reason] of [
        [named, "disabled"],
        [covered, "obstructed_at_hit_point"],
        [partial, null],
      ]) {
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        assert.equal(target.state.inViewport, true);
        if (reason) assert.ok(target.interactability.reasons.includes(reason));
        const observation = await verify(target.xpaths);
        assert.deepEqual(observation.matches, [
          [candidate === named ? "named" : candidate === covered ? "covered" : "partial"],
        ]);
        assert.equal(observation.scrollY, before.scrollY);
        assert.equal(observation.activeElement, before.activeElement);
      }
    },
  );
});

test("scope-large-lists-retain-every-visible-candidate-and-exclude-offscreen-targets", async () => {
  await withFixture(
    `<button id="expected-target">Visible approval</button><div style="position:absolute;top:2000px">${"<button>Outside approval</button>".repeat(2200)}</div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.eligibleCount, 2201);
      assert.equal(capture.coverage.excludedOffscreenCount, 2200);
      assert.equal(capture.coverage.capturedCount, 1);
      assert.equal(capture.candidates[0].label, "Visible approval");
    },
  );
  await withFixture(
    `<style>button{position:fixed;left:0;top:0}</style>${"<button>Visible approval</button>".repeat(2001)}`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.coverage.capturedCount, 2001);
      assert.equal(capture.candidates.length, 2001);
    },
  );
});

test("scope-offscreen-target-requires-manual-scroll-and-recapture", async () => {
  await withFixture(
    '<style>body{height:3200px}</style><button id="expected-target" style="position:absolute;top:2200px;width:240px;height:100px">Footer gallery</button>',
    async (session, page) => {
      const initial = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!initial.candidates.some((candidate) => candidate.label === "Footer gallery"));
      assert.equal((await observe()).scrollY, 0);
      await observe({ scrollToY: 2100 });
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (candidate) => candidate.label === "Footer gallery",
      );
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual((await observe({ xpaths: target.xpaths })).matches, [["expected-target"]]);
      assert.equal((await observe()).scrollY, 2100);
    },
  );
});

test("scope-accessibility-exposure-preserves-visual-limits-and-safe-hidden-names", async () => {
  await withFixture(
    `<style>.sr-only { position:absolute; width:1px; height:1px; clip:rect(0,0,0,0); overflow:hidden; }</style>
    <button id="expected-target" aria-labelledby="hidden-name" aria-label="Wrong name">Visible duplicate</button>
    <span id="hidden-name" hidden>Hidden name <input value="NAME_SECRET"><img alt="Icon"></span>
    <button hidden>Excluded hidden</button><div inert><button>Excluded inert</button></div>
    <div aria-hidden="true"><button aria-hidden="false">Excluded aria</button></div>
    <div style="display:none"><button>Excluded display</button></div>
    <div style="visibility:hidden"><button>Excluded visibility</button><button style="visibility:visible">Visibility override</button></div>
    <button hidden style="display:block">Hidden override</button>
    <button style="opacity:0">Transparent</button><button class="sr-only">Screen reader</button>
    <button style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero area</button>
    <button style="position:absolute;top:4000px">Offscreen exposed</button>
    <label hidden for="named-input">Native hidden label</label><input id="named-input" value="VALUE_SECRET">
    <details><summary>Closed disclosure</summary><button>Excluded disclosure</button></details>
    <input type="hidden" aria-label="Excluded hidden input">`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(
        capture.candidates.every(
          (entry) => !entry.text.startsWith("Excluded") && !entry.label.startsWith("Excluded"),
        ),
      );
      assert.doesNotMatch(JSON.stringify(capture), /SECRET/);
      const named = capture.candidates.find((entry) => entry.label === "Hidden name Icon");
      assert.ok(
        named,
        "aria-labelledby precedes aria-label and includes safe hidden reference text",
      );
      assert.ok(capture.candidates.some((entry) => entry.label === "Native hidden label"));
      for (const name of ["Screen reader", "Zero area", "Offscreen exposed"])
        assert.ok(!capture.candidates.some((entry) => entry.text === name), name);
      for (const name of ["Visibility override", "Hidden override", "Transparent"]) {
        const candidate = capture.candidates.find((entry) => entry.text === name);
        assert.ok(candidate, name);
        assert.equal(candidate.state.accessibilityExposed, true);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "hover",
        });
        assert.ok(target.xpaths.length > 0, name);
        if (name === "Transparent") assert.equal(target.state.rendered, false);
      }
      const selected = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: named.id,
        action: "click",
      });
      assert.deepEqual(
        (await verify(selected.target.xpaths)).matches,
        selected.target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("scope-large-captures-have-no-candidate-scan-text-or-byte-ceiling", async () => {
  for (const [markup, count, label] of [
    [
      "<style>button{position:fixed;left:0;top:0}</style>" + "<button>Target</button>".repeat(2001),
      2001,
      "Target",
    ],
    ["<div></div>".repeat(20001) + "<button>Last target</button>", 1, "Last target"],
    [
      `<button style="position:fixed;left:0;top:0;width:100px;height:40px;overflow:hidden">${"長".repeat(65000)}</button>`,
      1,
      "長".repeat(65000),
    ],
    [
      `<button style="position:fixed;left:0;top:0;width:100px;height:40px;overflow:hidden">${"長".repeat(15000)}</button>`.repeat(
        6,
      ),
      6,
      "長".repeat(15000),
    ],
  ]) {
    await withFixture(markup, async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.coverage.capturedCount, count);
      assert.equal(capture.candidates.length, count);
      assert.ok(capture.candidates.every((candidate) => candidate.label === label));
    });
  }
});

for (const [name, ancestorStyle, position, modal, visible] of [
  ["fixed control escapes static overflow", "", "fixed", false, true],
  ["absolute control escapes static overflow", "", "absolute", false, true],
  [
    "fixed control stays clipped by transformed ancestor",
    "transform:translateX(0)",
    "fixed",
    false,
    false,
  ],
  [
    "absolute control stays clipped by positioned ancestor",
    "position:relative",
    "absolute",
    false,
    false,
  ],
  [
    "modal escapes ancestor clipping in the top layer",
    "transform:translateX(0)",
    "fixed",
    true,
    true,
  ],
]) {
  test(`scope-native-viewport-observation-${name}`, async () => {
    await withFixture(
      `<div style="overflow:hidden;width:0;height:0;${ancestorStyle}">
        ${modal ? "<dialog>" : `<header style="position:${position};left:20px;top:20px">`}
        <button id="expected-target">Search</button>${modal ? "</dialog>" : "</header>"}</div>
      <script>${modal ? "document.querySelector('dialog').showModal();" : ""}
        const button = document.querySelector('#expected-target'); const rect = button.getBoundingClientRect();
        window.observedEvents = { receivesPointer: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button };
        for (const type of ['click', 'input', 'change']) button.addEventListener(type, () => window.observedEvents[type] = true);</script>`,
      async (session, page) => {
        const before = await observe();
        assert.equal(before.events.receivesPointer, visible);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.equal(capture.coverage.complete, true);
        const candidate = capture.candidates.find((candidate) => candidate.label === "Search");
        assert.equal(Boolean(candidate), visible);
        if (!visible) {
          assert.deepEqual((await observe()).events, before.events);
          return;
        }
        assert.equal(candidate.state.inViewport, true);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        assert.equal(target.state.inViewport, visible);
        assert.equal(target.interactability.status, visible ? "ready" : "blocked");
        assert.equal(target.interactability.checks.pointerReception, visible ? "pass" : "unknown");
        assert.deepEqual(target.interactability.reasons, visible ? [] : ["off_screen"]);
        const after = await verify(target.xpaths);
        assert.deepEqual(after.matches, [["expected-target"]]);
        assert.deepEqual(after.events, before.events);
        assert.equal(after.scrollY, before.scrollY);
        assert.equal(after.activeElement, before.activeElement);
      },
    );
  });
}
