import assert from "node:assert/strict";
import test from "node:test";
import { targetMarkup, request, observe, verify, expectError, withFixture } from "./fixture.mjs";

test("scope-unrelated-carousel-replacement-preserves-a-fixed-target", async () => {
  await withFixture(
    `<button id="expected-target" style="position:fixed;top:20px;left:20px">Login</button>
    <div id="carousel" style="position:absolute;top:200px;overflow:hidden;width:200px"><img alt="Partner A" width="200" height="40"></div>
    <script>window.mutateXpathFixture = () => document.querySelector('#carousel').innerHTML='<img alt="Partner B" width="200" height="40">';</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Login");
      assert.ok(candidate);
      await observe({ mutateXpath: true });
      const selected = await request(`/pages/${session.pageId}/selections`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        actions: [{ actionId: "a1", candidateId: candidate.id, action: "click" }],
      });
      assert.deepEqual((await verify(selected.actions[0].target.xpaths)).matches, [
        ["expected-target"],
      ]);
      assert.equal(selected.actions[0].target.interactability.status, "ready");
      const after = await observe();
      assert.equal(after.clicks, before.clicks);
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
    },
  );
});

for (const visibility of ["hidden", "offscreen", "visible"]) {
  for (const mutation of ["attach", "navigate", "detach"]) {
    test(`scope-unrelated-${visibility}-frame-${mutation}-preserves-target`, async () => {
      const style =
        visibility === "hidden"
          ? "display:none"
          : visibility === "offscreen"
            ? "position:absolute;top:1800px"
            : "";
      await withFixture(
        `<button id="expected-target">Login</button>
        ${mutation === "attach" ? "" : `<iframe id="changing-frame" style="${style}" srcdoc="<p>Unrelated content</p>"></iframe>`}
        <script>window.mutateXpathFixture = () => {
          ${mutation === "attach" ? `const frame = document.createElement('iframe'); frame.id='changing-frame'; frame.style='${style}'; frame.srcdoc='<button>Login</button>'; document.body.append(frame);` : mutation === "navigate" ? `document.querySelector('#changing-frame').srcdoc='<button>Login</button>';` : `document.querySelector('#changing-frame').remove();`}
        };</script>`,
        async (session, page) => {
          const before = await observe();
          const capture = await request(`/pages/${session.pageId}/capture`, {
            documentId: page.documentId,
          });
          const candidate = capture.candidates.find((c) => c.label === "Login");
          const body = {
            documentId: page.documentId,
            captureId: capture.captureId,
            actions: [{ actionId: "a1", candidateId: candidate.id, action: "click" }],
          };
          await request(`/pages/${session.pageId}/selections`, body);
          await observe({ mutateXpath: true });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await request(`/pages/${session.pageId}/highlight`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            actionId: "a1",
          });
          assert.deepEqual((await verify(result.target.xpaths)).matches, [["expected-target"]]);
          assert.equal(result.target.interactability.status, "ready");
          const after = await observe();
          assert.equal(after.scrollY, before.scrollY);
          assert.equal(after.clicks, before.clicks);
          assert.equal(after.activeElement, before.activeElement);
        },
      );
    });
  }
}

test("scope-scroll-change-preserves-a-visible-fixed-target", async () => {
  await withFixture(
    `<style>body{height:2400px}#expected-target{position:fixed;left:10px;top:10px}</style><button id="expected-target">Approval</button><button style="position:absolute;top:850px">Another approval</button>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      const candidate = capture.candidates.find((c) => c.label === "Approval");
      await observe({ scrollToY: 150 });
      const result = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.deepEqual((await verify(result.target.xpaths)).matches, [["expected-target"]]);
      assert.equal((await observe()).scrollY, 150);
    },
  );
});

test("scope-nested-scroll-outside-view-invalidates-selected-target", async () => {
  await withFixture(
    `<div id="list" style="height:100px;overflow:auto"><button id="expected-target">Approval</button><div style="height:150px"></div><button>Another approval</button></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      const candidate = capture.candidates.find((c) => c.label === "Approval");
      await observe({ scrollElement: { selector: "#list", y: 100 } });
      await expectError(
        `/pages/${page.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        },
        409,
        "stale_capture",
      );
    },
  );
});

for (const change of ["leave", "enter", "insert"])
  test(`scope-absence-retains-captured-evidence-after-${change}`, async () => {
    await withFixture(
      `<style>body{min-height:3000px}</style><button id="expected-target" style="position:absolute;top:${change === "leave" ? 10 : 2000}px">Approval</button>
      <script>window.mutateXpathFixture = () => {
        ${change === "insert" ? 'const node = document.createElement("button"); node.textContent = "New approval"; document.body.append(node);' : `document.querySelector('#expected-target').style.top = '${change === "leave" ? 2000 : 10}px';`}
      };</script>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        assert.equal(capture.coverage.complete, true);
        assert.equal(capture.candidates.length, change === "leave" ? 1 : 0);
        const before = await observe();
        await observe({ mutateXpath: true });
        const result = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: null,
          action: "click",
        });
        assert.equal(result.target, null);
        const after = await observe();
        assert.equal(after.scrollY, before.scrollY);
        assert.equal(after.activeElement, before.activeElement);
      },
    );
  });

for (const location of ["main", "scroll-container", "frame"])
  test(`scope-target-outside-clipped-viewport-invalidates-selection-${location}`, async () => {
    const content = `<style>body{margin:0;min-height:3000px}</style>
      ${location === "scroll-container" ? '<div style="height:80px;overflow:hidden">' : ""}
      <input id="expected-target" aria-label="Notes" style="display:block;margin-top:10px" value="UNCHANGED">
      ${location === "scroll-container" ? "</div>" : ""}
      <script>window.mutateXpathFixture = () => document.querySelector('input').style.marginTop = '2000px';</script>`;
    await withFixture(
      (path) =>
        location === "frame" && path === "/fixture"
          ? `<iframe title="Editor" src="/editor" style="height:100px"></iframe>`
          : content,
      async (session, page) => {
        const path = location === "frame" ? "/editor" : "/fixture";
        await observe({}, path);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        const candidate = capture.candidates.find((c) => c.label === "Notes");
        assert.ok(candidate);
        const body = {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "fill",
        };
        const { target } = await request(`/pages/${page.pageId}/selection`, body);
        assert.equal(target.state.inViewport, true);
        assert.deepEqual((await observe({ xpaths: target.xpaths }, path)).matches, [
          ["expected-target"],
        ]);
        await observe({ mutateXpath: true }, path);
        await expectError(`/pages/${page.pageId}/selection`, body, 409, "stale_capture");
        const fresh = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        assert.ok(!fresh.candidates.some((c) => c.label === "Notes"));
        assert.equal((await observe({}, path)).scrollY, 0);
      },
    );
  });

test("scope-target-validation-does-not-rescan-unrelated-frame-dom", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? '<iframe title="First" src="/first"></iframe><iframe title="Second" src="/second"></iframe>'
        : `<style>body{min-height:3000px}</style><button>Approval</button><div id="outside" style="position:absolute;top:2000px"></div>
         <script>window.mutateXpathFixture = () => document.querySelector('#outside').innerHTML = '<i></i>'.repeat(10500);</script>`,
    async (session, page) => {
      await observe({}, "/first");
      await observe({}, "/second");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      await observe({ mutateXpath: true }, "/first");
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: null,
        action: "click",
      };
      assert.equal((await request(`/pages/${page.pageId}/selection`, selection)).target, null);
      await observe({ mutateXpath: true }, "/second");
      assert.equal((await request(`/pages/${page.pageId}/selection`, selection)).target, null);
      const candidate = capture.candidates.find(
        (c) => c.frame.chain[0]?.label === "First" && c.label === "Approval",
      );
      assert.ok(candidate);
      const result = await request(`/pages/${page.pageId}/selection`, {
        ...selection,
        candidateId: candidate.id,
      });
      assert.equal(result.target.candidateId, candidate.id);
      assert.equal(result.target.interactability.status, "ready");
    },
  );
});

test("scope-stale-captures-fabricated-candidates-and-replaced-nodes-are-rejected", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const capturePath = `/pages/${session.pageId}/capture`;
    const selectionPath = `/pages/${session.pageId}/selection`;
    const oldCapture = await request(capturePath, { documentId: page.documentId });
    const capture = await request(capturePath, { documentId: page.documentId });
    const candidate = capture.candidates.find((entry) => entry.tag === "button");
    const selection = {
      documentId: page.documentId,
      captureId: capture.captureId,
      candidateId: candidate.id,
      action: "click",
    };
    await expectError(
      selectionPath,
      { ...selection, captureId: oldCapture.captureId },
      409,
      "stale_capture",
    );
    await expectError(
      selectionPath,
      { ...selection, candidateId: "fabricated" },
      409,
      "unknown_candidate",
    );
    await verify([], true);
    await expectError(selectionPath, selection, 409, "stale_capture");
    assert.equal((await request(selectionPath, { ...selection, candidateId: null })).target, null);
    await verify([], false, true);
    let current = page;
    for (let attempt = 0; attempt < 30 && current.documentId === page.documentId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      current = await request(`/pages/${session.pageId}`, undefined, "GET");
    }
    assert.notEqual(current.documentId, page.documentId);
    await expectError(selectionPath, selection, 409, "stale_document");
    await expectError(capturePath, { documentId: page.documentId }, 409, "stale_document");
    const fresh = await request(capturePath, { documentId: current.documentId });
    assert.equal(fresh.documentId, current.documentId);
    const freshTarget = fresh.candidates.find((entry) => entry.tag === "button");
    await request(selectionPath, {
      documentId: current.documentId,
      captureId: fresh.captureId,
      candidateId: freshTarget.id,
      action: "click",
    });
    await verify([], false, "hash");
    let hashPage = current;
    for (let attempt = 0; attempt < 30 && hashPage.documentId === current.documentId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      hashPage = await request(`/pages/${session.pageId}`, undefined, "GET");
    }
    assert.notEqual(hashPage.documentId, current.documentId);
    await expectError(
      selectionPath,
      {
        documentId: hashPage.documentId,
        captureId: fresh.captureId,
        candidateId: freshTarget.id,
        action: "click",
      },
      409,
      "stale_capture",
    );
  });
});
