import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, verify, expectError, withFixture } from "./fixture.mjs";

test("cardinality-distinct-targets-are-verified-and-inspected-without-execution", async () => {
  await withFixture(
    `<button id="expected-target">Approval</button><button id="second-target" data-oracle="second-target" disabled>Approval</button>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      const batch = {
        documentId: page.documentId,
        captureId: capture.captureId,
        actions: buttons.map((candidate, index) => ({
          actionId: `a${index + 1}`,
          candidateId: candidate.id,
          action: "click",
        })),
      };
      const result = await request(`/pages/${page.pageId}/selections`, batch);
      assert.equal(result.actions.length, 2);
      assert.equal(result.inspectedActionId, "a1");
      for (const [index, action] of result.actions.entries()) {
        assert.equal(action.target.candidateId, buttons[index].id);
        assert.deepEqual(
          (await verify(action.target.xpaths)).matches,
          action.target.xpaths.map(() => [index === 0 ? "expected-target" : "second-target"]),
        );
      }
      assert.equal(result.actions[1].target.interactability.status, "blocked");
      const inspected = await request(`/pages/${page.pageId}/highlight`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        actionId: "a2",
      });
      assert.equal(inspected.actionId, "a2");
      assert.equal(inspected.target.candidateId, buttons[1].id);
      await expectError(
        `/pages/${page.pageId}/highlight`,
        { documentId: page.documentId, captureId: capture.captureId, actionId: "fabricated" },
        409,
        "unknown_action",
      );
      const after = await observe();
      assert.equal(after.clicks, before.clicks);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      await request(`/sessions/${session.sessionId}/pages`);
      await expectError(
        `/pages/${page.pageId}/highlight`,
        { documentId: page.documentId, captureId: capture.captureId, actionId: "a1" },
        409,
        "inactive_page",
      );
      await request(`/pages/${page.pageId}/activate`);
      await expectError(
        `/pages/${page.pageId}/highlight`,
        { documentId: page.documentId, captureId: capture.captureId, actionId: "a1" },
        409,
        "stale_capture",
      );
    },
  );
});
