import assert from "node:assert/strict";
import test from "node:test";

import { request, observe, withFixture } from "./fixture.mjs";

test("capture-skips-style-reads-for-empty-non-candidates", async () => {
  await withFixture(
    "<div data-empty></div>".repeat(1000) +
      `<button id="expected-target" data-testid="about-us">About us</button>
      <div aria-label="Status" style="width:20px;height:20px"></div><span>Plain text</span>
      <div hidden><button>Hidden control</button></div><div inert><button>Inert control</button></div>
      <script>
        const nativeStyle = window.getComputedStyle;
        window.observedEvents = { emptyStyles: 0 };
        window.getComputedStyle = (element, pseudo) => {
          if (element.hasAttribute('data-empty')) window.observedEvents.emptyStyles++;
          return nativeStyle(element, pseudo);
        };
      </script>`,
    async (_session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(capture.coverage.scannedCount > 1000);
      assert.deepEqual(
        capture.candidates.map((candidate) => candidate.label || candidate.text),
        ["About us", "Status", "Plain text"],
      );
      const after = await observe();
      assert.equal(after.events.emptyStyles, 0);
      assert.equal(after.clicks, "0");
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
    },
  );
});
