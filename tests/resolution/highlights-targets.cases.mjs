import assert from "node:assert/strict";
import test from "node:test";

import {
  fixturePort,
  fixtureAddress,
  request,
  observe,
  expectError,
  withFixture,
} from "./fixture.mjs";
import { withFramebuffer } from "./viewer.mjs";
import {
  outlineColumns,
  expectHighlights,
  waitForFixtureEvent,
  highlightFixture,
  selectHighlights,
  expectSpotlightPixels,
} from "./highlights.mjs";

test("highlights-persist-through-scroll-and-clear-on-new-capture", async () => {
  await withFixture(
    '<style>body { margin:0; background:white; height:3200px; } button { position:absolute; top:100px; left:100px; width:240px; height:100px; background:white; border:0; }</style><button id="expected-target">Footer gallery</button>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.label === "Footer gallery");
      await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal((await observe()).scrollY, 0);
      await withFramebuffer(session, async (frame) => {
        await expectHighlights(frame, [[100, 100]], true);
        await observe({ scrollToY: 2100 });
        await expectHighlights(frame, [[100, 100]], false);
        await observe({ scrollToY: 0 });
        await expectHighlights(frame, [[100, 100]], true);
        await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
        await expectHighlights(frame, [[100, 100]], false);
        assert.equal((await observe()).scrollY, 0);
      });
    },
  );
});

for (const shadow of [false, true])
  test(`highlights-fixed-cookie-banner-escapes-ancestor-overflow-shadow-${shadow}`, async () => {
    const banner = `<style>section{position:fixed;left:80px;top:80px;width:400px;height:160px;background:white}button{position:absolute;left:20px;top:20px;width:120px;height:48px;border:0;background:white}</style><section aria-label="We use cookies"><button id="expected-target" data-oracle="cookie-close" aria-label="Close" onclick="this.dataset.clicks='1'">×</button></section>`;
    await withFixture(
      `<style>body{margin:0;background:white}main{height:40px;overflow:hidden}</style><main id="consent-host">${shadow ? "" : banner}</main>${shadow ? `<script>document.querySelector('#consent-host').attachShadow({mode:'open'}).innerHTML = ${JSON.stringify(banner)};</script>` : ""}`,
      async (session, page) => {
        const before = await observe();
        const batch = await selectHighlights(page);
        const { actions } = await request(`/pages/${page.pageId}/selections`, batch);
        const target = actions[0].target;
        assert.equal(target.interactability.status, "ready");
        assert.equal(target.shadowChain?.length ?? 0, shadow ? 1 : 0);
        assert.deepEqual(
          (
            await observe({
              locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
            })
          ).shadowMatches,
          [["cookie-close"]],
        );
        await withFramebuffer(session, async (frame) => {
          assert.ok(
            outlineColumns(await frame(), 100, 100) >= 90,
            "Visible cookie Close button has both outline edges",
          );
          await request(`/pages/${page.pageId}/spotlight`, {
            documentId: page.documentId,
            captureId: batch.captureId,
            actionId: "a0",
          });
          await expectSpotlightPixels(frame, [
            [40, 40, false],
            [150, 120, true],
          ]);
        });
        const after = await observe();
        assert.equal(after.targetMarkup, before.targetMarkup);
        assert.equal(after.clicks, "0");
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.scrollY, before.scrollY);
      },
    );
  });

test("highlights-outlines-leave-target-pixels-unchanged", async () => {
  await withFixture(
    `<style>body{margin:0;background:#888}button{position:absolute;left:100px;top:100px;width:240px;height:100px;border:2px solid #c23;background:white;color:black}button+button{left:340px;width:8px;height:8px;padding:0}</style>
    <button id="expected-target">Readable target</button><button aria-label="Tiny target"></button>
    <script>const nativeMatchMedia = matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? {matches:true} : nativeMatchMedia(query);</script>`,
    async (session, page) => {
      await withFramebuffer(session, async (frame) => {
        const targetBefore = (await observe()).targetMarkup;
        const initial = await frame();
        const before = Buffer.from(initial.pixels);
        await selectHighlights(page, true);
        const after = await expectHighlights(frame, [[100, 100]], true);
        for (const [left, top, width, height] of [
          [100, 100, 240, 100],
          [340, 100, 8, 8],
        ]) {
          for (let y = top; y < top + height; y++) {
            for (let x = left; x < left + width; x++) {
              // JPEG changes blocks beside the outline; the inner pixels remain exact.
              const edge =
                x < left + 8 || x >= left + width - 8 || y < top + 8 || y >= top + height - 8;
              const start = (y * after.width + x) * 4;
              for (let channel = 0; channel < 3; channel++)
                assert.ok(
                  Math.abs(after.pixels[start + channel] - before[start + channel]) <=
                    (edge ? 40 : 0),
                  `Target pixel ${x},${y} stays unchanged within stream compression`,
                );
              assert.equal(after.pixels[start + 3], before[start + 3]);
            }
          }
        }
        assert.equal((await observe()).targetMarkup, targetBefore);
      });
    },
  );
});

test("highlights-outlines-contrast-across-background-colors-and-patterns", async () => {
  await withFixture(
    `<style>body{margin:0;background:white}section{position:absolute;top:60px;width:280px;height:200px}button{position:absolute;left:20px;top:40px;width:240px;height:100px;border:0;background:inherit;color:inherit}</style>
    ${[
      "white",
      "black",
      "rgb(37,99,235)",
      "repeating-linear-gradient(90deg,black 0 8px,white 8px 16px)",
    ]
      .map(
        (background, index) =>
          `<section style="left:${80 + index * 290}px;background:${background}"><button aria-label="Target ${index}"></button></section>`,
      )
      .join("")}`,
    async (session, page) => {
      await selectHighlights(page, true);
      await withFramebuffer(session, async (frame) => {
        const image = await frame();
        for (let index = 0; index < 4; index++) {
          let dark = 0,
            light = 0;
          for (let y = 92; y < 100; y++)
            for (let x = 120 + index * 290; x < 320 + index * 290; x++) {
              const rgb = image.pixels.subarray(
                (y * image.width + x) * 4,
                (y * image.width + x) * 4 + 3,
              );
              if (rgb.every((channel) => channel < 30)) dark++;
              if (rgb.every((channel) => channel > 225)) light++;
            }
          assert.ok(
            dark >= 400 && light >= 400,
            `Target ${index}: expected thick contrasting edges; dark=${dark}, light=${light}`,
          );
        }
      });
    },
  );
});

test("highlights-clipped-target-outlines-stay-outside-visible-bounds", async () => {
  await withFixture(
    '<style>body{margin:0;background:white}button{position:absolute;left:-40px;top:-40px;width:240px;height:100px;border:0;background:white}section{position:absolute;left:100px;top:200px;width:80px;height:60px;overflow:hidden}</style><button aria-label="Viewport target"></button><section><button aria-label="Clipped target"></button></section>',
    async (session, page) => {
      await selectHighlights(page, true);
      await withFramebuffer(session, async (frame) => {
        const image = await frame();
        for (const [x, y] of [
          [40, 60],
          [140, 260],
        ]) {
          const innerEdge = (y * image.width + x) * 4;
          const whiteEdge = ((y + 3) * image.width + x) * 4;
          const outerEdge = ((y + 7) * image.width + x) * 4;
          assert.ok(
            image.pixels[innerEdge] < 30 &&
              image.pixels[whiteEdge] > 225 &&
              image.pixels[outerEdge] < 30,
            `Outside outline at ${x},${y}`,
          );
          assert.ok(
            image.pixels[((y - 1) * image.width + x) * 4] > 240,
            "Visible target remains unpainted",
          );
        }
        assert.ok(
          image.pixels[(200 * image.width + 140) * 4] > 240,
          "Clipped interior stays clear",
        );
      });
    },
  );
});

test("highlights-all-selected-targets-are-shown-together", async () => {
  await withFixture(highlightFixture, async (session, page) => {
    await selectHighlights(page, true);
    await observe({ staleInput: true });
    await withFramebuffer(session, async (frame) => {
      await expectHighlights(
        frame,
        [
          [100, 100],
          [500, 100],
        ],
        true,
      );
    });
  });
});

test("highlights-selection-remains-valid-after-in-view-scrolling", async () => {
  await withFixture(
    `${highlightFixture}<style>body{height:2400px}</style>`,
    async (session, page) => {
      const batch = await selectHighlights(page, true, "current_view");
      await withFramebuffer(session, async (frame) => {
        await expectHighlights(
          frame,
          [
            [100, 100],
            [500, 100],
          ],
          true,
        );
        await observe({ scrollToY: 50 });
        await expectHighlights(
          frame,
          [
            [100, 50],
            [500, 50],
          ],
          true,
        );
        const refreshed = await request(`/pages/${page.pageId}/selections`, batch);
        assert.equal(refreshed.actions.length, 2);
        assert.ok(refreshed.actions.every((action) => action.target));
      });
    },
  );
});

test("highlights-mouse-movement-preserves-and-click-or-key-input-clears", async () => {
  await withFixture(highlightFixture, async (session, page) => {
    const batch = await selectHighlights(page);
    await withFramebuffer(session, async (frame, input) => {
      await expectHighlights(frame, [[100, 100]], true);
      input.pointer(20, 20);
      await new Promise((resolve) => setTimeout(resolve, 100));
      input.pointer(180, 140);
      await expectHighlights(frame, [[100, 100]], true);

      input.pointer(180, 140, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      input.pointer(180, 140, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await expectHighlights(frame, [[100, 100]], false);
      await waitForFixtureEvent("pointerdown");
      await expectError(`/pages/${page.pageId}/selections`, batch, 409, "stale_capture");
      await selectHighlights(page);
      await expectHighlights(frame, [[100, 100]], true);
      input.key(0xffe1, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      input.key(0xffe1, false);
      await expectHighlights(frame, [[100, 100]], false);
    });
  });
});

for (const crossOrigin of [false, true])
  test(`highlights-main-and-${crossOrigin ? "cross-origin" : "same-origin"}-frame-targets-clear-on-frame-input`, async () => {
    await withFixture(
      (path) =>
        path === "/fixture"
          ? `${highlightFixture}<iframe title="Approval frame" src="${crossOrigin ? `http://${fixtureAddress}:${fixturePort}` : ""}/highlight-frame" style="position:absolute;left:100px;top:300px;width:800px;height:300px;border:0"></iframe>`
          : `<style>body{margin:0;background:white}button{position:absolute;left:100px;top:20px;width:240px;height:100px;background:white;border:0}</style><button id="expected-target">Frame approval</button>`,
      async (session, page) => {
        await observe({}, "/highlight-frame");
        const batch = await selectHighlights(page, true);
        await withFramebuffer(session, async (frame, input) => {
          await expectHighlights(
            frame,
            [
              [100, 100],
              [500, 100],
              [200, 320],
            ],
            true,
          );
          await request(`/pages/${page.pageId}/spotlight`, {
            documentId: page.documentId,
            captureId: batch.captureId,
            actionId: "a2",
          });
          await expectSpotlightPixels(
            frame,
            [
              [120, 570, false],
              [190, 350, true],
              [40, 40, true],
            ],
            [
              [200, 320, true],
              [100, 100, false],
              [500, 100, false],
            ],
          );
          await request(`/pages/${page.pageId}/spotlight`, {
            documentId: page.documentId,
            captureId: batch.captureId,
            actionId: "a0",
          });
          await expectSpotlightPixels(
            frame,
            [
              [40, 40, false],
              [150, 150, true],
            ],
            [
              [100, 100, true],
              [500, 100, false],
              [200, 320, false],
            ],
          );
          await request(`/pages/${page.pageId}/spotlight`, {
            documentId: page.documentId,
            captureId: batch.captureId,
            actionId: null,
          });
          await expectSpotlightPixels(frame, [[120, 570, true]]);
          input.pointer(280, 350);
          await new Promise((resolve) => setTimeout(resolve, 100));
          await expectHighlights(
            frame,
            [
              [100, 100],
              [500, 100],
              [200, 320],
            ],
            true,
          );
          input.pointer(280, 350, 1);
          await new Promise((resolve) => setTimeout(resolve, 100));
          input.pointer(280, 350, 0);
          await expectHighlights(
            frame,
            [
              [100, 100],
              [500, 100],
              [200, 320],
            ],
            false,
          );
          await expectError(`/pages/${page.pageId}/selections`, batch, 409, "stale_capture");
          await expectError(
            `/pages/${page.pageId}/spotlight`,
            {
              documentId: page.documentId,
              captureId: batch.captureId,
              actionId: "a2",
            },
            409,
            "stale_capture",
          );
        });
      },
    );
  });

test("highlights-input-in-unsupported-transformed-frame-clears-main-targets", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `${highlightFixture}<iframe src="/unsupported-input" style="position:absolute;left:500px;top:350px;width:400px;height:200px;transform:rotate(2deg)"></iframe>`
        : '<button style="width:100%;height:150px">Frame input</button>',
    async (session, page) => {
      await observe({}, "/unsupported-input");
      const batch = await selectHighlights(page);
      await withFramebuffer(session, async (frame, input) => {
        await expectHighlights(frame, [[100, 100]], true);
        input.pointer(650, 430, 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
        input.pointer(650, 430, 0);
        await expectHighlights(frame, [[100, 100]], false);
        await expectError(`/pages/${page.pageId}/selections`, batch, 409, "stale_capture");
      });
    },
  );
});

for (const mode of ["popover", "dialog"])
  test(`highlights-render-above-transformed-${mode}-without-state-changes`, async () => {
    await withFixture(
      `<style>body{margin:0;background:white}::backdrop{background:rgb(255,0,0)}#surface{position:fixed;left:100px;top:100px;margin:0;width:600px;height:300px;border:0;padding:0;background:white;transform:translate(30px,20px)}button{position:absolute;left:50px;top:50px;width:240px;height:100px;background:white;border:0}</style>
    <${mode === "dialog" ? "dialog" : 'div popover="manual"'} id="surface"><button id="expected-target">Surface action</button></${mode === "dialog" ? "dialog" : "div"}>
    <script>document.querySelector('#surface').${mode === "dialog" ? "showModal" : "showPopover"}();</script>`,
      async (session, page) => {
        const before = await observe();
        await selectHighlights(page);
        const after = await observe();
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.targetMarkup, before.targetMarkup);
        await withFramebuffer(session, async (frame) => {
          await expectHighlights(frame, [[180, 170]], true);
          const image = await frame();
          // The existing surface stays white; our full-viewport host adds no red backdrop.
          const offset = (400 * image.width + 650) * 4;
          assert.ok(
            image.pixels[offset] > 240 &&
              image.pixels[offset + 1] > 240 &&
              image.pixels[offset + 2] > 240,
          );
        });
      },
    );
  });
