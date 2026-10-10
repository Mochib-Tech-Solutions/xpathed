import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import jpeg from "jpeg-js";

import { browserUrl, observe } from "./fixture.mjs";

export async function withFramebuffer(session, check) {
  const socket = new WebSocket(`${browserUrl.replace("http", "ws")}${session.viewPath}`, {
    headers: { Origin: process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081" },
  });
  let latest,
    displayed,
    decoded,
    previousButtons = 0;
  const controls = [];
  const send = (message) => socket.send(JSON.stringify(message));
  const control = async (type, matches = () => true) => {
    for (let attempt = 0; attempt < 250; attempt++) {
      const index = controls.findIndex((message) => message.type === type && matches(message));
      if (index >= 0) return controls.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Viewer did not send ${type}: ${JSON.stringify(controls)}`);
  };
  const receive = ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type !== "frame") {
      controls.push(frame);
      return;
    }
    latest = frame;
    send({ type: "ack", frameId: frame.frameId });
  };
  socket.addEventListener("message", receive);
  const input = (message) => {
    assert.ok(displayed, "Read a displayed frame before sending input");
    send({ ...message, pageId: displayed.pageId, documentId: displayed.documentId });
  };
  try {
    await once(socket, "message", { signal: AbortSignal.timeout(15000) });
    await check(
      async (matches = () => true) => {
        // A static page emits no new frames. Keep its last actual rendered image.
        for (let attempt = 0; attempt < 300; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (latest && matches(latest)) break;
        }
        assert.ok(latest && matches(latest), "Viewer did not render the expected current page");
        if (displayed?.frameId !== latest.frameId) {
          displayed = latest;
          const image = jpeg.decode(Buffer.from(displayed.data, "base64"), {
            maxResolutionInMP: 3,
            maxMemoryUsageInMB: 128,
          });
          assert.equal(image.width, displayed.width);
          assert.equal(image.height, displayed.height);
          decoded = { pixels: image.data, width: image.width, height: image.height };
        }
        return decoded;
      },
      {
        input,
        raw: send,
        control,
        pointer(x, y, buttons = 0) {
          const event = buttons === previousButtons ? "move" : buttons ? "down" : "up";
          input({
            type: "mouse",
            event,
            x,
            y,
            buttons,
            button: event === "move" && !buttons ? "none" : "left",
            modifiers: 0,
            ...(event === "down" || event === "up" ? { clickCount: 1 } : {}),
          });
          previousButtons = buttons;
        },
        key(key, down) {
          assert.equal(key, 0xffe1, "Fixture supports the Shift key");
          input({
            type: "key",
            event: down ? "down" : "up",
            key: "Shift",
            code: "ShiftLeft",
            modifiers: down ? 8 : 0,
          });
        },
      },
    );
  } finally {
    socket.removeEventListener("message", receive);
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) }).catch(() => {});
      socket.close(1000);
      await closed;
    }
  }
}

export function viewerKey(viewer, key, code, text) {
  viewer.input({
    type: "key",
    event: "down",
    key,
    code,
    modifiers: 0,
    ...(text !== undefined ? { text } : {}),
  });
  viewer.input({ type: "key", event: "up", key, code, modifiers: 0 });
}

export function viewerClick(viewer, x, y) {
  viewer.pointer(x, y, 1);
  viewer.pointer(x, y, 0);
}

export async function assertSameMaskedImage(actual, expected, caseName) {
  if (actual === expected) return;
  const artifactPath = join(".artifacts/ci/browser-contract-images", caseName);
  const directory = join(process.env.XPATHED_WORKSPACE ?? process.cwd(), artifactPath);
  let artifactError;
  try {
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "expected.png"), Buffer.from(expected, "base64")),
      writeFile(join(directory, "actual.png"), Buffer.from(actual, "base64")),
    ]);
  } catch (error) {
    artifactError = error.message;
  }
  assert.fail(
    `Changing only private values must not change exported PNG data. Evidence: ${artifactPath}${artifactError ? `; artifact capture failed: ${artifactError}` : ""}`,
  );
}

export function fillsDisplay(observation) {
  return (
    observation.innerWidth === observation.outerWidth &&
    observation.innerHeight === observation.outerHeight &&
    Math.abs(observation.outerWidth - observation.screenWidth) <= 1 &&
    Math.abs(observation.outerHeight - observation.screenHeight) <= 1
  );
}

export async function observeFullscreen(pagePath) {
  let observation;
  for (let attempt = 0; attempt < 50; attempt++) {
    observation = await observe({}, pagePath);
    if (fillsDisplay(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return observation;
}
