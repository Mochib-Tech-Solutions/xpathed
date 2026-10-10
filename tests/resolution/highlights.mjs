import assert from "node:assert/strict";

import { request, observe } from "./fixture.mjs";

export function outlineColumns({ pixels, width }, left, top) {
  let count = 0;
  for (let x = left + 10; x < left + 110; x++) {
    const rgb = (y) => pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3);
    if (
      rgb(top - 8).every((channel) => channel < 30) &&
      rgb(top - 4).every((channel) => channel > 225) &&
      rgb(top - 1).every((channel) => channel < 30)
    )
      count++;
  }
  return count;
}

export async function expectHighlights(frame, locations, visible) {
  let counts;
  for (let attempt = 0; attempt < 20; attempt++) {
    const image = await frame();
    counts = locations.map(([left, top]) => outlineColumns(image, left, top));
    if (counts.every((count) => (visible ? count >= 90 : count === 0))) return image;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Expected highlights ${visible ? "visible" : "cleared"} at ${JSON.stringify(locations)}; outline columns: ${counts}`,
  );
}

export async function waitForFixtureEvent(type) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await observe()).events[type]) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Viewer did not deliver trusted ${type}`);
}

export const highlightFixture = `<style>body {margin:0;background:white} button {position:absolute;left:100px;top:100px;width:240px;height:100px;background:white;border:0} #second-target {left:500px}</style>
<button id="expected-target">First approval</button><button id="second-target">Second approval</button>
<script>window.observedEvents = {}; for (const type of ['pointermove','pointerdown','keydown']) addEventListener(type, event => { if(event.isTrusted) window.observedEvents[type] = (window.observedEvents[type] ?? 0) + 1; });</script>`;

export async function selectHighlights(page, plural = false, scope = "current_view") {
  const capture = await request(`/pages/${page.pageId}/capture`, {
    documentId: page.documentId,
    scope,
  });
  const buttons = capture.candidates.filter((entry) => entry.tag === "button");
  const batch = {
    documentId: page.documentId,
    captureId: capture.captureId,
    actions: (plural ? buttons : buttons.slice(0, 1)).map((candidate, index) => ({
      actionId: `a${index}`,
      candidateId: candidate.id,
      action: "click",
    })),
  };
  await request(`/pages/${page.pageId}/selections`, batch);
  return batch;
}

export async function expectSpotlightPixels(frame, samples, outlines = []) {
  let observed;
  for (let attempt = 0; attempt < 20; attempt++) {
    const image = await frame();
    observed = samples.map(([x, y]) => image.pixels[(y * image.width + x) * 4]);
    if (
      samples.every(([, , clear], index) =>
        clear ? observed[index] > 240 : observed[index] < 210,
      ) &&
      outlines.every(([left, top, visible]) => {
        const count = outlineColumns(image, left, top);
        return visible ? count >= 90 : count === 0;
      })
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Spotlight samples ${JSON.stringify(samples)} had pixels ${JSON.stringify(observed)}`,
  );
}
