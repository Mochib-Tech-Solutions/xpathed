import assert from "node:assert/strict";
import test from "node:test";

import { request, withFixture } from "./fixture.mjs";

test("appearance-css-evidence-reports-uncertainty-without-pixels-or-private-styles", async () => {
  await withFixture(
    `<style>#pseudo::before{content:'decorative';background:red}</style>
    <button style="background:linear-gradient(red,blue)">Gradient</button>
    <div style="opacity:.5"><button style="background:red">Translucent</button></div>
    <button id="pseudo">Pseudo artwork</button><button style="background-image:url('/PRIVATE_STYLE_URL')">Image fill</button>
    <button><svg width="10" height="10"><rect width="10" height="10" fill="red"/></svg>Icon</button>
    <button style="background:transparent">Transparent</button>
    <button style="background:color(display-p3 1 0 0)">Wide gamut</button>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_STYLE_URL"));
      for (const [label, reason] of [
        ["Gradient", "background_image"],
        ["Translucent", "complex_effects"],
        ["Pseudo artwork", "pseudo_element_appearance"],
        ["Image fill", "background_image"],
        ["Icon", "replaced_content"],
        ["Transparent", "background_transparent"],
        ["Wide gamut", "unsupported_color"],
      ]) {
        const candidate = capture.candidates.find((c) => c.label === label);
        assert.ok(candidate, label);
        assert.equal(candidate.appearance.backgroundColor, null, label);
        assert.ok(candidate.appearance.limitations.includes(reason), label);
      }
      const defaultCapture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(defaultCapture.scope, "current_view");
      assert.ok(defaultCapture.candidates.every((c) => c.appearance));
    },
  );
});
