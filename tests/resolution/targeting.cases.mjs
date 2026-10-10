import assert from "node:assert/strict";
import test from "node:test";

import { targetMarkup, request, observe, verify, withFixture } from "./fixture.mjs";

test("targeting-descriptions-preserve-roles-and-accessible-image-names", async () => {
  await withFixture(
    `<input id="submit" type="submit" value="Search">
     <img id="photo" alt="Product photo" width="50" height="50">
     <img id="unnamed" role="img" tabindex="0" width="50" height="50">
     <div id="group" role="group">Unrelated descendant content</div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const before = await observe();
      for (const [tag, role, name, expectedId] of [
        ["input", "button", "Search", "submit"],
        ["img", "img", "Product photo", "photo"],
        ["img", "img", "", "unnamed"],
        ["div", "group", "", "group"],
      ]) {
        const candidate = capture.candidates.find(
          (entry) => entry.tag === tag && entry.role === role && entry.label === name,
        );
        assert.ok(candidate, expectedId);
        const body = {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        };
        const { target } = await request(`/pages/${page.pageId}/selection`, body);
        const batch = await request(`/pages/${page.pageId}/selections`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          actions: [{ actionId: "a1", candidateId: candidate.id, action: "inspect" }],
        });
        for (const selected of [target, batch.actions[0].target]) {
          assert.equal(selected.role, role);
          assert.equal(selected.accessibleName, name);
          assert.deepEqual((await verify(selected.xpaths)).matches, [[expectedId]]);
        }
      }
      const after = await observe();
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.clicks, before.clicks);
    },
  );
});

test("targeting-unnamed-visible-graphics-retain-verifiable-dom-targets", async () => {
  await withFixture(
    `<img id="picture" width="60" height="60" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Ccircle fill='red' cx='30' cy='30' r='25'/%3E%3C/svg%3E">
     <svg id="drawing" width="60" height="60"><circle cx="30" cy="30" r="25" fill="blue"/></svg>
     <canvas id="chart" width="60" height="60"></canvas>
     <video id="clip" width="60" height="60"></video>
     <img id="hidden-image" hidden width="60" height="60">
     <svg id="decorative" aria-hidden="true" width="60" height="60"><circle r="20"/></svg>
     <script>document.querySelector('canvas').getContext('2d').fillRect(5,5,40,40)</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.deepEqual(
        capture.candidates.map((candidate) => candidate.tag),
        ["img", "svg", "canvas", "video"],
      );
      const image = await request(`/pages/${page.pageId}/capture-image`, {
        documentId: page.documentId,
        captureId: capture.captureId,
      });
      assert.equal(image.captureId, capture.captureId);
      for (const [tag, expectedId] of [
        ["img", "picture"],
        ["svg", "drawing"],
        ["canvas", "chart"],
        ["video", "clip"],
      ]) {
        const candidate = capture.candidates.find((entry) => entry.tag === tag);
        assert.equal(candidate.label, "", "Pixels must not invent an accessible name");
        assert.equal(candidate.text, "");
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual((await verify(target.xpaths)).matches, [[expectedId]]);
        assert.equal(target.accessibleName, "");
      }
      const after = await observe();
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.deepEqual(after.events, before.events);
    },
  );
});

test("targeting-labels-with-comment-nodes-retain-action-targets", async () => {
  await withFixture(
    `<section aria-label="Videos"><a id="expected-target" href="#first">First<!-- PRIVATE_COMMENT_SENTINEL --> video</a>
      <button aria-labelledby="video-name">Play</button><span id="video-name" hidden>Second<!-- comment --> video</span></section>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_COMMENT_SENTINEL"));
      const link = capture.candidates.find((candidate) => candidate.tag === "a");
      const button = capture.candidates.find((candidate) => candidate.tag === "button");
      assert.equal(link.label, "First video");
      assert.equal(button.label, "Second video");
      const selection = await request(`/pages/${page.pageId}/selections`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        actions: [{ actionId: "a1", candidateId: link.id, action: "click" }],
      });
      assert.deepEqual(
        (await verify(selection.actions[0].target.xpaths)).matches,
        selection.actions[0].target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("targeting-private-label-references-exclude-values-and-preserve-hidden-public-names", async () => {
  await withFixture(
    `<span id="public-hidden" hidden aria-label="Hidden public name"></span>
    <div data-sensitive><span id="private-label" aria-label="Private reference name"></span></div>
    <img id="private-alt" data-private alt="Private reference image">
    <button aria-labelledby="private-label">Label fallback</button>
    <button aria-labelledby="private-alt">Image fallback</button>
    <button aria-labelledby="public-hidden">Public text</button>
    <label for="public-input" data-private aria-label="Private reference associated"></label>
    <input id="public-input" placeholder="Public input">`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!JSON.stringify(capture.candidates).includes("Private reference"));
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Label fallback", "Image fallback", "Hidden public name"],
      );
      const input = capture.candidates.find((candidate) => candidate.tag === "input");
      assert.equal(input.label, "");
      assert.equal(input.placeholder, "Public input");
    },
  );
});

test("targeting-independent-target-is-captured-and-highlighted-without-execution", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    assert.equal(typeof page.documentId, "string");
    const capture = await request(`/pages/${session.pageId}/capture`, {
      documentId: page.documentId,
    });
    const candidate = capture.candidates.find(
      (entry) => entry.tag === "button" && entry.text === "About us",
    );
    assert.ok(candidate, "The rendered button must be captured");
    assert.equal(capture.coverage.complete, true);
    const before = await verify([]);
    const selection = await request(`/pages/${session.pageId}/selection`, {
      documentId: page.documentId,
      captureId: capture.captureId,
      candidateId: candidate.id,
      action: "click",
    });
    assert.deepEqual(selection.target.xpaths, ["//*[@data-testid='about-us']"]);
    const after = await verify(selection.target.xpaths);
    assert.deepEqual(
      after.matches,
      selection.target.xpaths.map(() => ["expected-target"]),
    );
    assert.equal(after.clicks, "0");
    assert.equal(after.scrollY, before.scrollY);
    assert.equal(after.nodeCount, before.nodeCount + 1, "Only the inert highlight host is added");
    assert.equal(after.targetMarkup, before.targetMarkup);
    assert.equal(selection.target.state.rendered, true);
    assert.equal(selection.target.state.enabled, true);
    assert.equal(selection.target.state.inViewport, true);
    assert.equal(selection.target.interactability.status, "ready");
    assert.equal(selection.target.interactability.checks.eventOutcome, "unknown");
  });
});

test("targeting-native-semantics-preserve-normalized-inputs-and-descendant-names", async () => {
  await withFixture(
    `<input type="unknown" aria-label="Normalized text"><input readonly type="checkbox" aria-label="Readonly inapplicable">
    <input role="presentation" aria-label="Native presentation"><button id="expected-target"><span aria-label="Save"><span>Icon text</span></span></button>
    <button id="referenced-name"><span aria-labelledby="save-name">Icon</span></button><span id="save-name" hidden>Save reference<input value="PRIVATE_VALUE"></span>
    <button id="cyclic-name"><span id="cycle" aria-labelledby="cycle">Cycle</span></button>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(
        capture.candidates.find((entry) => entry.label === "Readonly inapplicable").state.readonly,
        false,
      );
      assert.equal(
        capture.candidates.find((entry) => entry.label === "Native presentation").role,
        "textbox",
      );
      const named = capture.candidates.find((entry) => entry.tag === "button");
      assert.equal(named.label, "Save");
      assert.ok(
        capture.candidates.some(
          (entry) => entry.label === "Save reference" && entry.tag === "button",
        ),
      );
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_VALUE/);
      assert.equal(capture.coverage.complete, true);
      const text = capture.candidates.find((entry) => entry.label === "Normalized text");
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: text.id,
        action: "fill",
      });
      assert.equal(target.interactability.checks.compatibleControl, "pass");
      assert.equal(target.interactability.status, "ready");
    },
  );
});

test("targeting-large-multilingual-capture-retains-complete-set-and-verified-target", async () => {
  await withFixture(
    Array.from(
      { length: 500 },
      (_, index) =>
        `<button style="position:absolute;left:${(index % 20) * 60}px;top:${Math.floor(index / 20) * 28}px;width:60px;height:28px" data-oracle="control-${index}">حالة الطقس ${index}</button>`,
    ).join(""),
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.length, 500);
      const target = capture.candidates.find((candidate) => candidate.text === "حالة الطقس 499");
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: target.id,
        action: "click",
      });
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["control-499"]),
      );
    },
  );
});

test("targeting-dynamic-light-dom-button-resolves-after-insertion", async () => {
  await withFixture(
    `<button id="show">Show consent</button><script>
    document.querySelector('#show').onclick=()=>{
      const button=document.createElement('button');button.textContent='Accept all';button.dataset.oracle='consent';
      document.body.append(button);
    };</script>`,
    async (session, page) => {
      await observe({ click: "#show" });
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.shadowChain, undefined);
      assert.deepEqual((await observe({ locators: [{ xpath: target.xpaths[0] }] })).shadowMatches, [
        ["consent"],
      ]);
    },
  );
});

test("targeting-icon-buttons-and-labelled-images-are-found-without-visible-text", async () => {
  await withFixture(
    `<button title="Download" style="width:40px;height:30px"></button>
    <img alt="Logo" width="50" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-oracle="expected-target">
    <div aria-label="Status" style="width:20px;height:20px"></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(
        capture.candidates.some(
          (candidate) => candidate.tag === "button" && candidate.label === "Download",
        ),
      );
      assert.ok(capture.candidates.some((candidate) => candidate.label === "Status"));
      const image = capture.candidates.find(
        (candidate) => candidate.tag === "img" && candidate.label === "Logo",
      );
      assert.ok(image);
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: image.id,
        action: "hover",
      });
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});
