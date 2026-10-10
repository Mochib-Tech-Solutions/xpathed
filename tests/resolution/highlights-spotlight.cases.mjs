import assert from "node:assert/strict";
import test from "node:test";

import { withFramebuffer } from "./viewer.mjs";
import { request, observe, expectError, withFixture } from "./fixture.mjs";
import {
  outlineColumns,
  highlightFixture,
  selectHighlights,
  expectSpotlightPixels,
} from "./highlights.mjs";

for (const reducedMotion of [false, true])
  test(`highlights-hover-spotlight-isolates-target-and-restores-outlines-motion-${reducedMotion}`, async () => {
    await withFixture(
      `${highlightFixture}${reducedMotion ? `<script>const nativeMatchMedia = matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? {matches:true} : nativeMatchMedia(query);</script>` : ""}`,
      async (session, page) => {
        const before = await observe();
        const batch = await selectHighlights(page, true);
        const spotlight = (actionId) =>
          request(`/pages/${page.pageId}/spotlight`, {
            documentId: page.documentId,
            captureId: batch.captureId,
            actionId,
          });
        await spotlight("a0");
        await new Promise((resolve) => setTimeout(resolve, 1400));
        await withFramebuffer(session, async (frame) => {
          const image = await frame();
          const red = (x, y) => image.pixels[(y * image.width + x) * 4];
          assert.ok(
            red(40, 40) < 210,
            "Hover keeps surroundings dimmed beyond the brief spotlight",
          );
          assert.ok(red(150, 150) > 240, "Hovered target interior stays clear");
          assert.equal(
            outlineColumns(image, 500, 100),
            0,
            "Other target has no outline during hover",
          );
          assert.ok(red(550, 150) < 210, "Other target is dimmed during hover");
        });
        await spotlight("a1");
        await withFramebuffer(session, async (frame) => {
          await expectSpotlightPixels(
            frame,
            [
              [90, 150, false],
              [490, 150, true],
              [150, 150, false],
              [550, 150, true],
            ],
            [
              [500, 100, true],
              [100, 100, false],
            ],
          );
        });
        await spotlight(null);
        await withFramebuffer(session, async (frame) => {
          await expectSpotlightPixels(
            frame,
            [[40, 40, true]],
            [
              [100, 100, true],
              [500, 100, true],
            ],
          );
        });
        await expectError(
          `/pages/${page.pageId}/spotlight`,
          { documentId: page.documentId, captureId: batch.captureId, actionId: "invented" },
          409,
          "unknown_action",
        );
        const after = await observe();
        assert.equal(after.targetMarkup, before.targetMarkup);
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.scrollY, before.scrollY);
        await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
        await expectError(
          `/pages/${page.pageId}/spotlight`,
          { documentId: page.documentId, captureId: batch.captureId, actionId: "a0" },
          409,
          "stale_capture",
        );
      },
    );
  });

for (const reducedMotion of [false, true])
  test(`highlights-small-target-spotlight-preserves-outlines-with-motion-${reducedMotion}`, async () => {
    await withFixture(
      `<style>body{margin:0;background:white}button{position:absolute;left:100px;top:100px;width:8px;height:8px;padding:0;border:0;background:white}</style><button id="expected-target" aria-label="Tiny target"></button><button style="left:300px;width:240px;height:100px" aria-label="Large target"></button>
    ${reducedMotion ? `<script>const nativeMatchMedia = matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? {matches:true} : nativeMatchMedia(query);</script>` : ""}`,
      async (session, page) => {
        const before = await observe();
        await selectHighlights(page, true);
        await withFramebuffer(session, async (frame) => {
          const image = await frame();
          const ambient = (40 * image.width + 40) * 4;
          const aperture = (85 * image.width + 104) * 4;
          assert.ok(
            reducedMotion ? image.pixels[ambient] > 240 : image.pixels[ambient] < 210,
            "Only unrestricted motion briefly dims the surroundings",
          );
          assert.ok(
            image.pixels[aperture] > 240,
            "The small target has a larger clear locator area",
          );
          assert.ok(
            image.pixels[(125 * image.width + 290) * 4] > 240,
            "Other selected targets also keep a clear aperture",
          );
        });
        // Allow the raw viewer stream to deliver the completed 1.2-second fade.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        // Reconnect for a fresh full framebuffer instead of queued animation damage updates.
        await withFramebuffer(session, async (frame) => {
          const settled = await frame();
          const ambient = (40 * settled.width + 40) * 4;
          assert.ok(settled.pixels[ambient] > 240, "The spotlight fades away");
          const border = (96 * settled.width + 104) * 4;
          const outerBorder = (92 * settled.width + 104) * 4;
          assert.ok(
            settled.pixels[border] > 225 && settled.pixels[outerBorder] < 30,
            "Both outline edges remain after the spotlight",
          );
        });
        const after = await observe();
        assert.equal(after.targetMarkup, before.targetMarkup);
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.scrollY, before.scrollY);
      },
    );
  });

for (const mutation of ["navigate", "detach"])
  test(`highlights-selected-frame-${mutation}-invalidates-after-main-target-spotlight`, async () => {
    await withFixture(
      (path) =>
        path === "/fixture"
          ? `${highlightFixture}<iframe title="Approval frame" src="/highlight-frame" style="position:absolute;left:100px;top:300px;width:800px;height:300px;border:0"></iframe>
            <script>window.mutateXpathFixture = () => ${mutation === "navigate" ? "document.querySelector('iframe').srcdoc='<p>Replacement document</p>'" : "document.querySelector('iframe').remove()"};</script>`
          : `<style>body{margin:0;background:white}button{position:absolute;left:100px;top:20px;width:240px;height:100px;background:white;border:0}</style><button id="expected-target">Frame approval</button>`,
      async (session, page) => {
        await observe({}, "/highlight-frame");
        const batch = await selectHighlights(page, true);
        await request(`/pages/${page.pageId}/spotlight`, {
          documentId: page.documentId,
          captureId: batch.captureId,
          actionId: "a1",
        });
        assert.equal(batch.actions.length, 3, "Selection includes both documents");
        await observe({ mutateXpath: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expectError(
          `/pages/${page.pageId}/highlight`,
          { documentId: page.documentId, captureId: batch.captureId, actionId: "a1" },
          409,
          "stale_capture",
        );
      },
    );
  });
