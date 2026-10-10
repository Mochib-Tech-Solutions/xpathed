import assert from "node:assert/strict";
import test from "node:test";

import {
  browserUrl,
  fixtureUrl,
  targetMarkup,
  request,
  observe,
  verify,
  waitForSession,
  expectError,
  withFixture,
} from "./fixture.mjs";
import { fillsDisplay, observeFullscreen } from "./viewer.mjs";

test("tabs-create-activate-close-and-replace-last-page-with-stable-viewer", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const sessionPath = `/sessions/${session.sessionId}`;
    const initial = await request(sessionPath, undefined, "GET");
    assert.equal(initial.sessionId, session.sessionId);
    assert.equal(initial.activePageId, page.pageId);
    assert.equal(typeof initial.activationVersion, "number");
    assert.equal(initial.viewPath, `/view/${session.sessionId}`);
    assert.equal(session.viewPath, initial.viewPath);
    assert.deepEqual(
      initial.pages.map((entry) => entry.pageId),
      [page.pageId],
    );

    const added = await request(`${sessionPath}/pages`);
    assert.equal(added.pages.length, 2);
    assert.notEqual(added.activePageId, page.pageId);
    const second = added.pages.find((entry) => entry.pageId === added.activePageId);
    assert.equal(second.url, "about:blank");
    assert.equal(added.viewPath, initial.viewPath);

    const switched = await request(`/pages/${page.pageId}/activate`);
    assert.equal(switched.activePageId, page.pageId);
    assert.ok(switched.activationVersion > initial.activationVersion);
    assert.equal(
      switched.pages.find((entry) => entry.pageId === page.pageId).documentId,
      page.documentId,
    );
    assert.equal(switched.viewPath, initial.viewPath);

    const closedBackground = await request(`/pages/${second.pageId}`, undefined, "DELETE");
    assert.equal(closedBackground.activePageId, page.pageId);
    assert.deepEqual(
      closedBackground.pages.map((entry) => entry.pageId),
      [page.pageId],
    );
    const closed = await fetch(`${browserUrl}/pages/${second.pageId}`);
    assert.equal(closed.status, 404);

    const replacement = await request(`/pages/${page.pageId}`, undefined, "DELETE");
    assert.equal(replacement.pages.length, 1);
    assert.notEqual(replacement.activePageId, page.pageId);
    assert.equal(replacement.pages[0].url, "about:blank");
    assert.equal(replacement.pages[0].pageId, replacement.activePageId);
    assert.equal(replacement.viewPath, initial.viewPath);
  });
});

test("tabs-native-links-and-popups-preserve-opener-and-shared-cookies", async () => {
  await withFixture(
    (path) =>
      `${targetMarkup}${path === "/fixture" ? '<a id="new-tab" href="/link-tab" target="_blank" rel="opener">Open linked tab</a>' : ""}`,
    async (session, page) => {
      const initial = await request(`/sessions/${session.sessionId}`, undefined, "GET");
      await observe({ cookie: "tabs_shared=fixture-cookie; path=/", click: "#new-tab" });
      const linked = await waitForSession(
        session.sessionId,
        (state) =>
          state.pages.length === 2 &&
          state.pages.some(
            (entry) => entry.pageId === state.activePageId && entry.url.endsWith("/link-tab"),
          ),
      );
      const linkedPageId = linked.activePageId;
      const linkObservation = await observeFullscreen("/link-tab");
      assert.equal(linkObservation.cookie, "tabs_shared=fixture-cookie");
      assert.equal(linkObservation.openerPath, "/fixture");
      assert.ok(fillsDisplay(linkObservation), JSON.stringify(linkObservation));
      assert.equal(linked.viewPath, initial.viewPath);
      assert.ok(linked.activationVersion > initial.activationVersion);

      await request(`/pages/${page.pageId}/activate`);
      await observe({
        open: {
          url: "/feature-popup",
          name: "fixture-popup",
          features: "popup,width=320,height=240",
        },
      });
      const popup = await waitForSession(
        session.sessionId,
        (state) =>
          state.pages.length === 3 &&
          state.pages.some(
            (entry) => entry.pageId === state.activePageId && entry.url.endsWith("/feature-popup"),
          ),
      );
      const popupId = popup.activePageId;
      const popupObservation = await observeFullscreen("/feature-popup");
      assert.equal(popupObservation.cookie, "tabs_shared=fixture-cookie");
      assert.equal(popupObservation.openerPath, "/fixture");
      assert.ok(fillsDisplay(popupObservation), JSON.stringify(popupObservation));
      assert.equal(popup.viewPath, initial.viewPath);

      await request(`/pages/${page.pageId}/activate`);
      await observe({
        open: {
          url: "/feature-popup?reused=1",
          name: "fixture-popup",
          features: "popup,width=320,height=240",
        },
      });
      await waitForSession(session.sessionId, (state) =>
        state.pages.some((entry) => entry.pageId === popupId && entry.url.endsWith("?reused=1")),
      );
      // Re-establish the opener after navigation so native focus must be observed in the new document.
      await request(`/pages/${page.pageId}/activate`);
      // Chromium may ignore focus while a reused native window is settling.
      // Establish native focus first, then independently check managed-page routing.
      let nativeFocused = false;
      for (let attempt = 0; attempt < 20 && !nativeFocused; attempt++) {
        await observe({ focusPopup: true });
        nativeFocused = (await observe({}, "/feature-popup")).focused;
      }
      assert.equal(nativeFocused, true, "Reused popup did not receive native focus");
      const expectedActivePage = nativeFocused ? popupId : page.pageId;
      const reused = await waitForSession(
        session.sessionId,
        (state) =>
          state.activePageId === expectedActivePage &&
          state.pages.some((entry) => entry.pageId === popupId && entry.url.endsWith("?reused=1")),
      );
      assert.equal(reused.pages.length, 3);
      assert.equal((await observe({}, "/feature-popup")).focused, nativeFocused);
      assert.equal((await observe()).focused, !nativeFocused);
      await observe({ close: true }, "/feature-popup");
      const closed = await waitForSession(
        session.sessionId,
        (state) =>
          state.pages.length === 2 && !state.pages.some((entry) => entry.pageId === popupId),
      );
      assert.ok([page.pageId, linkedPageId].includes(closed.activePageId));
      assert.equal(closed.viewPath, initial.viewPath);
    },
  );
});

test("tabs-only-active-page-can-resolve-and-switching-invalidates-capture", async () => {
  await withFixture(
    (path) =>
      path === "/second"
        ? '<button data-oracle="second-target">Second page</button>'
        : targetMarkup,
    async (session, firstPage) => {
      const capturePath = `/pages/${firstPage.pageId}/capture`;
      const firstCapture = await request(capturePath, { documentId: firstPage.documentId });
      const firstTarget = firstCapture.candidates.find(
        (candidate) => candidate.text === "About us",
      );
      const firstSelection = {
        documentId: firstPage.documentId,
        captureId: firstCapture.captureId,
        candidateId: firstTarget.id,
        action: "click",
      };
      const added = await request(`/sessions/${session.sessionId}/pages`);
      const secondId = added.activePageId;
      await expectError(capturePath, { documentId: firstPage.documentId }, 409, "inactive_page");
      await expectError(
        `/pages/${firstPage.pageId}/selection`,
        firstSelection,
        409,
        "inactive_page",
      );

      const secondPage = await request(`/pages/${secondId}/navigate`, {
        url: `${fixtureUrl}/second`,
      });
      const secondCapture = await request(`/pages/${secondId}/capture`, {
        documentId: secondPage.documentId,
      });
      assert.equal(secondCapture.pageId, secondId);
      assert.ok(!secondCapture.candidates.some((candidate) => candidate.text === "About us"));
      const secondTarget = secondCapture.candidates.find(
        (candidate) => candidate.text === "Second page",
      );
      assert.ok(secondTarget);
      const secondSelection = await request(`/pages/${secondId}/selection`, {
        documentId: secondPage.documentId,
        captureId: secondCapture.captureId,
        candidateId: secondTarget.id,
        action: "click",
      });
      assert.ok(secondSelection.target.xpaths.length > 0);
      assert.deepEqual(
        (await observe({ xpaths: secondSelection.target.xpaths }, "/second")).matches,
        secondSelection.target.xpaths.map(() => ["second-target"]),
      );

      const returned = await request(`/pages/${firstPage.pageId}/activate`);
      assert.equal(
        returned.pages.find((page) => page.pageId === firstPage.pageId).documentId,
        firstPage.documentId,
      );
      await expectError(
        `/pages/${firstPage.pageId}/selection`,
        firstSelection,
        409,
        "stale_capture",
      );
      const fresh = await request(capturePath, { documentId: firstPage.documentId });
      assert.notEqual(fresh.captureId, firstCapture.captureId);
      const target = fresh.candidates.find((candidate) => candidate.text === "About us");
      const selected = await request(`/pages/${firstPage.pageId}/selection`, {
        ...firstSelection,
        captureId: fresh.captureId,
        candidateId: target.id,
      });
      assert.deepEqual(
        (await verify(selected.target.xpaths)).matches,
        selected.target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("tabs-limits-reject-excess-pages-and-closing-restores-capacity", async () => {
  await withFixture(targetMarkup, async (session, first) => {
    const sessionPath = `/sessions/${session.sessionId}`;
    let state;
    for (let count = 1; count < 8; count++) state = await request(`${sessionPath}/pages`);
    assert.equal(state.pages.length, 8);
    await expectError(`${sessionPath}/pages`, undefined, 409, "tab_limit");
    const activeId = state.activePageId;
    const page = await request(`/pages/${activeId}/navigate`, {
      url: `${fixtureUrl}/limit`,
    });
    await observe({ open: { url: "/overflow" } }, "/limit");
    const rejected = await waitForSession(session.sessionId, (current) =>
      current.pages.some((entry) => entry.blockedPopups > 0),
    );
    assert.equal(rejected.pages.length, 8);
    assert.equal(rejected.activePageId, activeId);
    assert.ok(rejected.pages.every((entry) => !entry.url.endsWith("/overflow")));
    const capture = await request(`/pages/${activeId}/capture`, { documentId: page.documentId });
    assert.equal(capture.coverage.complete, true);
    assert.ok(capture.candidates.some((candidate) => candidate.text === "About us"));

    const closed = await request(`/pages/${first.pageId}`, undefined, "DELETE");
    assert.equal(closed.pages.length, 7);
    assert.equal(closed.activePageId, activeId);
    const replacement = await request(`${sessionPath}/pages`);
    assert.equal(replacement.pages.length, 8);
    assert.notEqual(replacement.activePageId, activeId);
    assert.equal(
      replacement.pages.find((entry) => entry.pageId === replacement.activePageId).url,
      "about:blank",
    );
  });
});
