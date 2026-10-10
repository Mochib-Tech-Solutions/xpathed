import assert from "node:assert/strict";
import test from "node:test";

import {
  fixturePort,
  fixtureAddress,
  targetMarkup,
  request,
  observe,
  verify,
  expectError,
  withFixture,
} from "./fixture.mjs";
import { withFramebuffer } from "./viewer.mjs";
import { expectHighlights } from "./highlights.mjs";

for (const source of [
  "frame-owner",
  "referenced-name",
  "associated-label",
  "scope-text",
  "unrelated",
  "offscreen",
]) {
  test(`frames-private-source-changed-during-child-capture-${source}`, async () => {
    const controls = {
      "frame-owner": `<button>Keep me</button><iframe id="source" src="/child" title="Child"></iframe>`,
      "referenced-name": `<span id="source" hidden aria-label="Private marker reference"></span><button aria-labelledby="source">Keep me</button>`,
      "associated-label": `<label id="source" for="public-input">Private marker associated</label><input id="public-input">`,
      "scope-text": `<section><h2 id="source">Private marker scope</h2><button>Keep me</button></section>`,
      unrelated: `<span id="source" hidden>Unrelated hidden text</span><button>Keep me</button>`,
      offscreen: `<div style="position:absolute;top:1600px"><article><h2 id="source">Offscreen first</h2><button>View</button></article><article><h2>Offscreen second</h2><button>View</button></article></div><button>Keep me</button>`,
    };
    await withFixture(
      (path) =>
        path === "/child"
          ? `<button>Child control</button><script>
            const NativeObserver = window.IntersectionObserver;
            window.IntersectionObserver = class extends NativeObserver {
              constructor(callback, options) {
                super(callback, options);
                requestAnimationFrame(() => parent.document.querySelector('#source').setAttribute('data-private', ''));
              }
            };
          </script>`
          : `${controls[source]}${source === "frame-owner" ? "" : '<iframe src="/child" title="Child"></iframe>'}`,
      async (session, page) => {
        const requestBody = { documentId: page.documentId };
        if (["unrelated", "offscreen"].includes(source)) {
          const capture = await request(`/pages/${page.pageId}/capture`, requestBody);
          assert.equal(capture.coverage.complete, true);
          assert.ok(capture.candidates.some((candidate) => candidate.label === "Keep me"));
          assert.ok(capture.candidates.some((candidate) => candidate.label === "Child control"));
        } else {
          await expectError(`/pages/${page.pageId}/capture`, requestBody, 409, "stale_capture");
        }
        const observation = await verify(["//*[@id='source' and @data-private]"]);
        assert.deepEqual(observation.matches, [["source"]]);
      },
    );
  });
}

test("frames-offscreen-content-is-excluded-and-ancestor-appearance-limits-are-retained", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div style="opacity:.5"><iframe src="/visible-child"></iframe></div><iframe style="position:absolute;top:2000px" src="/outside-child"></iframe>`
        : `<button id="expected-target" style="background:red">${path === "/visible-child" ? "Visible child" : "OFFSCREEN_CHILD_CONTENT"}</button>`,
    async (session, page) => {
      await observe({}, "/visible-child");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.length, 1);
      assert.equal(capture.candidates[0].label, "Visible child");
      assert.equal(capture.candidates[0].appearance.backgroundColor, null);
      assert.ok(capture.candidates[0].appearance.limitations.includes("complex_effects"));
      assert.ok(!JSON.stringify(capture).includes("OFFSCREEN_CHILD_CONTENT"));
    },
  );
});

test("frames-nested-target-retains-document-xpath-and-viewport-geometry", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0;height:3000px}iframe{position:absolute;left:100px;top:80px;width:600px;height:400px;border:0}</style><button>Approval</button><iframe title="Employee" src="/outer"></iframe>`
        : path === "/outer"
          ? `<style>body{margin:0}iframe{position:absolute;left:30px;top:40px;width:400px;height:240px;border:0}</style><iframe title="Payroll" src="/inner"></iframe>`
          : `<style>body{margin:0;height:1600px}button{position:absolute;left:20px;top:30px;width:120px;height:40px}</style><button id="expected-target">Approval</button>`,
    async (session, page) => {
      await observe({}, "/inner");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      assert.equal(buttons.length, 2);
      assert.ok(
        capture.candidates.every(
          (candidate) =>
            candidate.frame?.id &&
            candidate.frame.documentId &&
            Array.isArray(candidate.frame.chain),
        ),
      );
      const candidate = buttons.find((candidate) => candidate.frame?.chain.length === 2);
      assert.ok(candidate, "Nested document candidates carry their frame chain");
      assert.deepEqual(
        candidate.frame.chain.map((frame) => frame.label),
        ["Employee", "Payroll"],
      );
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.frame.id, candidate.frame.id);
      assert.equal(target.xpaths.length, 1);
      assert.deepEqual(target.geometry, { x: 150, y: 150, width: 120, height: 40 });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/inner")).matches, [
        ["expected-target"],
      ]);
      assert.equal((await observe({}, "/fixture")).scrollY, 0);
      assert.equal((await observe({}, "/inner")).clicks, "0");
      await withFramebuffer(session, async (frame) => {
        await expectHighlights(frame, [[150, 150]], true);
      });
      await observe({ scrollToY: 20 }, "/inner");
      await observe({ scrollToY: 50 }, "/fixture");
      const retained = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "hover",
      });
      assert.equal(retained.target.geometry.y, 80);
      assert.deepEqual((await observe({ xpaths: retained.target.xpaths }, "/inner")).matches, [
        ["expected-target"],
      ]);
      const refreshed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const recaptured = refreshed.candidates.find(
        (entry) => entry.frame?.chain.length === 2 && entry.tag === "button",
      );
      const moved = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: refreshed.captureId,
        candidateId: recaptured.id,
        action: "hover",
      });
      assert.equal(moved.target.geometry.y, 80);
      assert.equal((await observe({}, "/inner")).scrollY, 20);
      assert.equal((await observe({}, "/fixture")).scrollY, 50);
    },
  );
});

test("frames-cross-origin-clipping-and-obstruction-are-passive-and-navigation-invalidates-capture", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0}#clip{position:absolute;left:100px;top:100px;width:200px;height:100px;overflow:hidden}iframe{width:400px;height:300px;border:0}#cover{position:absolute;left:100px;top:100px;width:160px;height:80px;background:black;z-index:2}</style>
        <div id="clip"><iframe title="External" src="http://${fixtureAddress}:${fixturePort}/external"></iframe></div><div id="cover"></div>`
        : `<style>body{margin:0}button{position:absolute;left:20px;top:20px;width:120px;height:40px}#below{top:180px}</style><button id="expected-target">Covered child</button><button id="below">Clipped child</button>`,
    async (session, page) => {
      await observe({}, "/external");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const covered = capture.candidates.find((candidate) => candidate.label === "Covered child");
      const clipped = capture.candidates.find((candidate) => candidate.label === "Clipped child");
      assert.ok(covered);
      assert.equal(clipped, undefined);
      const body = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: covered.id,
        action: "click",
      };
      const { target } = await request(`/pages/${page.pageId}/selection`, body);
      assert.equal(target.state.inViewport, true);
      assert.equal(target.interactability.status, "blocked");
      assert.ok(target.interactability.reasons.includes("ancestor_frame_obstructed"));
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/external")).matches, [
        ["expected-target"],
      ]);
      const current = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(current.coverage.complete, true);
      assert.equal(current.coverage.excludedOffscreenCount, 1);
      assert.ok(!current.candidates.some((candidate) => candidate.label === "Clipped child"));
      const visible = current.candidates.find((candidate) => candidate.label === "Covered child");
      assert.ok(visible);
      const selected = await request(`/pages/${page.pageId}/selection`, {
        ...body,
        captureId: current.captureId,
        candidateId: visible.id,
      });
      assert.ok(selected.target.interactability.reasons.includes("ancestor_frame_obstructed"));
      assert.deepEqual((await observe({ xpaths: selected.target.xpaths }, "/external")).matches, [
        ["expected-target"],
      ]);
      await observe({ reload: true }, "/external");
      await observe({}, "/external");
      await expectError(`/pages/${page.pageId}/selection`, body, 409, "stale_capture");
    },
  );
});

test("frames-exposed-frame-and-open-shadow-content-is-captured-and-hidden-content-is-excluded", async () => {
  await withFixture(
    `${targetMarkup}<iframe srcdoc="<button>FRAME_SECRET</button>"></iframe>
    <iframe hidden srcdoc="<button>HIDDEN_FRAME</button>"></iframe><div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SECRET</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.unsupportedBoundaryCount, 0);
      assert.equal(capture.frameId, "main");
      assert.equal(capture.coverage.complete, true);
      assert.ok(capture.candidates.some((candidate) => candidate.text === "FRAME_SECRET"));
      assert.doesNotMatch(JSON.stringify(capture.candidates), /HIDDEN_FRAME/);
      assert.ok(capture.candidates.some((candidate) => candidate.label === "SHADOW_SECRET"));
      const absence = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: null,
        action: "unsupported",
      });
      assert.equal(absence.target, null);
    },
  );
});

test("frames-scaled-clipping-preserves-section-context-and-reflections-are-unsupported", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0}#clip{position:absolute;left:10px;top:10px;width:200px;height:100px;overflow:hidden;transform:scale(2);transform-origin:top left}#scaled{position:absolute;left:150px;top:20px;width:40px;height:30px}</style>
      <div id="clip"><button id="scaled">Scaled target</button></div>
      <section aria-label="Employee" style="margin-top:240px"><iframe src="/employee"></iframe></section>
      <section aria-label="Customer"><iframe src="/customer"></iframe></section>
      <iframe style="scale:-1 1" src="/reflected"></iframe><div style="scale:-1 1"><iframe src="/ancestor-reflected"></iframe></div>`
        : "<button>OK</button>",
    async (session, page) => {
      await observe({}, "/customer");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const scaled = capture.candidates.find((candidate) => candidate.label === "Scaled target");
      assert.equal(scaled.state.inViewport, true);
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: scaled.id,
        action: "click",
      });
      assert.deepEqual(target.geometry, { x: 310, y: 50, width: 80, height: 60 });
      assert.equal(target.interactability.status, "ready");
      const buttons = capture.candidates.filter((candidate) => candidate.label === "OK");
      assert.equal(buttons.length, 2);
      assert.ok(buttons[0].scope.includes("Employee"));
      assert.ok(buttons[1].scope.includes("Customer"));
      assert.equal(capture.unsupportedBoundaryCount, 2);
    },
  );
});

test("frames-slow-capture-completes-while-target-validation-keeps-its-budget", async () => {
  await withFixture(
    '<button>Save</button><iframe srcdoc="<button>Child</button>"></iframe>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Child");
      await observe({ slowFrame: true });
      await expectError(
        `/pages/${page.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        },
        409,
        "validation_budget_exceeded",
      );
      const complete = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(complete.coverage.complete, true);
      assert.equal(complete.coverage.errorCode, null);
      assert.ok(complete.candidates.some((candidate) => candidate.label === "Child"));
    },
  );
});

test("frames-exposure-and-transforms-preserve-complete-large-captures", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div aria-hidden="true"><iframe src="/hidden" title="Hidden"></iframe></div>
        <div inert><iframe src="/inert"></iframe></div>
        <iframe src="/rotated" style="transform:rotate(15deg)"></iframe>
        <iframe src="/exposed" style="opacity:0" title="Transparent"></iframe>`
        : `<button>${path}</button>`,
    async (session, page) => {
      await observe({}, "/exposed");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.unsupportedBoundaryCount, 1);
      assert.doesNotMatch(JSON.stringify(capture.candidates), /\/hidden|\/inert|\/rotated/);
      const target = capture.candidates.find((candidate) => candidate.text === "/exposed");
      assert.equal(target.state.accessibilityExposed, true);
      assert.equal(target.state.rendered, false);
    },
  );
  await withFixture(
    (path) =>
      path === "/fixture"
        ? '<iframe src="/large-one"></iframe><iframe src="/large-two"></iframe><iframe src="/large-three"></iframe>'
        : '<button style="position:fixed;left:0;top:0">Ordinary target</button>'.repeat(750),
    async (session, page) => {
      await observe({}, "/large-three");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.candidates.length, 2250);
      assert.equal(capture.coverage.capturedCount, 2250);
    },
  );
});

test("frames-capture-retains-visible-targets-beyond-64-documents", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? Array.from(
            { length: 65 },
            (_, index) =>
              `<iframe style="position:fixed;left:0;top:0;width:100px;height:50px" src="/frame-${index + 1}"></iframe>`,
          ).join("")
        : `<style>body{margin:0}</style><button data-oracle="frame-target">${path.slice(1)}</button>`,
    async (session, page) => {
      await observe({}, "/frame-65");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.filter((candidate) => candidate.tag === "button").length, 65);
      const candidate = capture.candidates.find((candidate) => candidate.label === "frame-65");
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      const target = selected.target;
      const observed = await observe({
        locators: [{ xpath: target.xpaths[0], frame: target.frame }],
      });
      assert.deepEqual(observed.shadowMatches, [["frame-target"]]);
      assert.equal(target.interactability.status, "ready");
      assert.equal(observed.scrollY, 0);
    },
  );
});
