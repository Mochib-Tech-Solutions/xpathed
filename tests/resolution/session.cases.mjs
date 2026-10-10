import assert from "node:assert/strict";
import test from "node:test";

import {
  browserUrl,
  fixtureUrl,
  targetMarkup,
  request,
  observe,
  verify,
  expectError,
  withFixture,
} from "./fixture.mjs";
import { withFramebuffer } from "./viewer.mjs";

test("session-teardown-releases-runtime-before-slot-reuse", { timeout: 600000 }, async () => {
  // Allow the hosted runner to finish all 128 launches and cleanups.
  for (let index = 0; index < 128; index++) {
    const session = await request("/sessions");
    try {
      if (index === 127) {
        await withFramebuffer(session, async (readFrame) => {
          const frame = await readFrame();
          assert.equal(frame.width, 1280);
          assert.equal(frame.height, 800);
        });
      }
    } finally {
      await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
    }
    assert.equal((await fetch(`${browserUrl}/sessions/${session.sessionId}`)).status, 404);
  }
});

test("session-concurrent-close-keeps-service-healthy", async () => {
  const session = await request("/sessions");
  await Promise.all([
    request(`/sessions/${session.sessionId}`, undefined, "DELETE"),
    request(`/sessions/${session.sessionId}`, undefined, "DELETE"),
  ]);
  assert.equal((await fetch(`${browserUrl}/health`)).status, 200);
  assert.equal((await fetch(`${browserUrl}/sessions/${session.sessionId}`)).status, 404);
});

test("session-empty-creation-uses-configured-default", async () => {
  const options = await request("/sessions/options", undefined, "GET");
  const response = await fetch(`${browserUrl}/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const session = await response.json();
  try {
    assert.equal(session.browserType, options.defaultBrowserType);
  } finally {
    await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
  }
});

test("session-selected-engine-owns-viewer-and-capture", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const expected = "chromium";
    assert.equal(session.browserType, expected);
    const state = await request(`/sessions/${session.sessionId}`, undefined, "GET");
    assert.equal(state.browserType, expected);
    const observed = await observe();
    assert.match(observed.userAgent, /Chrome\//);
    const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
    assert.ok(capture.candidates.some((candidate) => candidate.label === "About us"));
    await withFramebuffer(session, async (readFrame) => {
      const frame = await readFrame();
      assert.equal(frame.width, 1280);
      assert.equal(frame.height, 800);
    });
  });
});

for (const [width, height] of [
  [1024, 768],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
]) {
  test(`session-resolution-${width}x${height}-matches-viewer-and-current-view`, async () => {
    const resolution = `${width}x${height}`;
    await withFixture(
      `<style>html { background: rgb(12, 34, 56); }</style>${targetMarkup}`,
      async (session, page) => {
        assert.equal(session.resolution, resolution);
        const observed = await observe();
        assert.equal(observed.innerWidth, width);
        assert.equal(observed.innerHeight, height);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          includeImage: true,
        });
        assert.ok(capture.candidates.some((candidate) => candidate.label === "About us"));
        assert.equal(capture.image.width, width);
        assert.equal(capture.image.height, height);
        await withFramebuffer(session, async (readFrame) => {
          const frame = await readFrame();
          assert.equal(frame.width, width);
          assert.equal(frame.height, height);
          assert.ok(
            [...frame.pixels.subarray(-4, -1)].every(
              (channel, index) => Math.abs(channel - [12, 34, 56][index]) <= 3,
            ),
            "JPEG preserves the background color",
          );
        });
        const next = await request(`/sessions/${session.sessionId}/pages`);
        assert.equal(next.resolution, resolution);
        await request(`/pages/${next.activePageId}/navigate`, {
          url: `${fixtureUrl}/new`,
        });
        const newTab = await observe({}, "/new");
        assert.equal(newTab.innerWidth, width);
        assert.equal(newTab.innerHeight, height);
      },
      { resolution },
    );
  });
}

test("session-concurrent-workspaces-remain-isolated-after-one-closes", async () => {
  await withFixture(targetMarkup, async (first, firstPage) => {
    const second = await request("/sessions");
    assert.equal(first.browserType, "chromium");
    assert.equal(second.browserType, "chromium");
    let replacement;
    try {
      const secondPage = await request(`/pages/${second.pageId}/navigate`, {
        url: `${fixtureUrl}/second`,
      });
      for (const id of [first.sessionId, second.sessionId, first.pageId, second.pageId])
        assert.match(id, /^[a-f0-9]{32}$/);
      assert.equal(
        new Set([first.sessionId, second.sessionId, first.pageId, second.pageId]).size,
        4,
      );
      assert.notEqual(first.viewPath, second.viewPath);
      await observe({ cookie: "workspace=first" }, "/fixture");
      assert.equal((await observe({}, "/second")).cookie, "");
      const firstCapture = await request(`/pages/${first.pageId}/capture`, {
        documentId: firstPage.documentId,
      });
      const secondCapture = await request(`/pages/${second.pageId}/capture`, {
        documentId: secondPage.documentId,
      });
      await expectError(
        `/pages/${second.pageId}/selection`,
        {
          documentId: secondPage.documentId,
          captureId: firstCapture.captureId,
          candidateId: firstCapture.candidates[0].id,
          action: "click",
        },
        409,
        "stale_capture",
      );
      await request(`/sessions/${first.sessionId}`, undefined, "DELETE");
      replacement = await request("/sessions");
      assert.notEqual(replacement.sessionId, first.sessionId);
      assert.notEqual(replacement.sessionId, second.sessionId);
      assert.equal(
        (await request(`/sessions/${second.sessionId}`, undefined, "GET")).activePageId,
        second.pageId,
      );
      const target = secondCapture.candidates.find((candidate) => candidate.tag === "button");
      const selection = await request(`/pages/${second.pageId}/selection`, {
        documentId: secondPage.documentId,
        captureId: secondCapture.captureId,
        candidateId: target.id,
        action: "click",
      });
      assert.deepEqual(
        (await observe({ xpaths: selection.target.xpaths }, "/second")).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
    } finally {
      await request(`/sessions/${second.sessionId}`, undefined, "DELETE");
      if (replacement) await request(`/sessions/${replacement.sessionId}`, undefined, "DELETE");
    }
  });
});

test("session-close-all-tabs-allows-fresh-captures-and-selections", async () => {
  await withFixture(targetMarkup, async (initialSession, initialPage) => {
    let session = initialSession;
    let page = initialPage;
    const sessionIds = new Set();
    const pageIds = new Set();
    const captureIds = new Set();
    try {
      for (let cycle = 0; cycle < 6; cycle++) {
        assert.ok(!sessionIds.has(session.sessionId));
        assert.ok(!pageIds.has(page.pageId));
        sessionIds.add(session.sessionId);
        pageIds.add(page.pageId);
        assert.equal(session.viewPath, `/view/${session.sessionId}`);
        assert.equal((await observe()).cookie, "");
        assert.equal(
          (await observe({ cookie: "old_session=must_clear; path=/" })).cookie,
          "old_session=must_clear",
        );
        const added = await request(`/sessions/${session.sessionId}/pages`);
        await request(`/pages/${page.pageId}/activate`);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.ok(!captureIds.has(capture.captureId));
        captureIds.add(capture.captureId);
        const target = capture.candidates.find((candidate) => candidate.label === "About us");
        assert.ok(target);
        const batch = {
          documentId: page.documentId,
          captureId: capture.captureId,
          actions: [{ actionId: "a1", candidateId: target.id, action: "click" }],
        };
        const selection = await request(`/pages/${page.pageId}/selections`, batch);
        const xpaths = selection.actions[0].target.xpaths;
        assert.deepEqual(
          (await verify(xpaths)).matches,
          xpaths.map(() => ["expected-target"]),
        );
        await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
        await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
        assert.equal((await fetch(`${browserUrl}/sessions/${session.sessionId}`)).status, 404);
        for (const closedPage of added.pages) {
          assert.equal((await fetch(`${browserUrl}/pages/${closedPage.pageId}`)).status, 404);
        }
        await expectError(`/pages/${page.pageId}/selections`, batch, 404, "page_not_found");
        if (cycle < 5) {
          session = await request("/sessions");
          page = await request(`/pages/${session.pageId}/navigate`, {
            url: `${fixtureUrl}/fixture`,
          });
        }
      }
    } finally {
      await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
    }
  });
});
