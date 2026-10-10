import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

import {
  browserUrl,
  fixtureUrl,
  targetMarkup,
  waitForObservation,
  request,
  observe,
  withFixture,
} from "./fixture.mjs";
import { withFramebuffer, viewerKey, viewerClick } from "./viewer.mjs";

test("viewer-unresponsive-connection-is-aborted-by-heartbeat", { timeout: 60000 }, async () => {
  const session = await request("/sessions");
  const url = new URL(browserUrl);
  const socket = createConnection({ host: url.hostname, port: Number(url.port || 80) });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const timeout = setTimeout(
    () => socket.destroy(new Error("Viewer heartbeat did not abort")),
    55000,
  );
  let socketError;
  socket.on("error", (error) => {
    socketError = error;
  });
  let headers = "";
  socket.on("data", (data) => {
    if (!headers.includes("\r\n\r\n")) headers += data.toString("latin1");
    // A vanished client never answers WebSocket ping frames.
  });
  try {
    await once(socket, "connect");
    socket.write(
      `GET ${session.viewPath} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nOrigin: ${process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081"}\r\n\r\n`,
    );
    await closed;
    if (socketError) assert.equal(socketError.code, "ECONNRESET");
    assert.match(headers, /^HTTP\/1\.1 101 /u);
    assert.equal((await fetch(`${browserUrl}/sessions/${session.sessionId}`)).status, 200);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
    await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
  }
});

test("viewer-disconnect-completes-close-handshake-and-allows-reconnect", async () => {
  await withFixture(targetMarkup, async (session) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = new WebSocket(`${browserUrl.replace("http", "ws")}${session.viewPath}`, {
        headers: { Origin: process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081" },
      });
      const [message] = await once(socket, "message", { signal: AbortSignal.timeout(5000) });
      assert.equal(JSON.parse(message.data).type, "frame");
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
      socket.close(1000);
      const [event] = await closed;
      assert.equal(event.code, 1000);
      assert.equal(event.wasClean, true);
    }
  });
});

test("viewer-cursor-follows-links-inputs-shadow-elements-and-frames", async () => {
  await withFixture(
    `<style>body{margin:0}a,input,#shadow,iframe{position:absolute;left:20px;width:220px;height:40px}a{top:20px}input{top:80px}#shadow{top:140px}iframe{top:200px;border:0}</style>
     <a href="#">A link</a><input><div id="shadow"></div>
     <iframe srcdoc='<style>body{margin:0}button{width:220px;height:40px;cursor:crosshair}</style><button>Frame control</button>'></iframe>
     <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button style="width:220px;height:40px;cursor:ew-resize">Resize</button>';</script>`,
    async (session, page) => {
      await withFramebuffer(session, async (readFrame, viewer) => {
        await readFrame();
        for (const [x, y, expected] of [
          [40, 30, "pointer"],
          [40, 100, "text"],
          [40, 160, "ew-resize"],
          [40, 220, "crosshair"],
          [400, 300, "default"],
        ]) {
          viewer.pointer(x, y);
          const cursor = await viewer.control("cursor", (value) => value.cursor === expected);
          assert.equal(cursor.pageId, page.pageId);
          assert.equal(cursor.documentId, page.documentId);
        }
      });
    },
  );
});

test("viewer-scroll-bursts-preserve-distance-and-subsequent-clicks", async () => {
  await withFixture(
    `<style>body { margin: 0; width: 10000px; height: 10000px; background: linear-gradient(white, black); }
    #expected-target { position: fixed; left: 20px; top: 20px; width: 200px; height: 60px; }
    select { position: fixed; left: 260px; top: 20px; width: 180px; height: 60px; }</style>
    <button id="expected-target" onclick="this.dataset.clicks='1';this.style.background='lime'">Click after scrolling</button>
    <select><option>First</option><option>Second</option></select>
    <script>window.observedEvents = {};
    addEventListener('scrollend', () => {window.observedEvents.scrollEndX = scrollX; window.observedEvents.scrollEndY = scrollY;});</script>`,
    async (session) => {
      await withFramebuffer(session, async (readFrame, viewer) => {
        await readFrame();
        const scroll = (deltaY, count) => {
          for (let index = 0; index < count; index++)
            viewer.input({
              type: "mouse",
              event: "wheel",
              x: 100,
              y: 100,
              button: "none",
              buttons: 0,
              modifiers: 0,
              deltaX: deltaY * 0.3,
              deltaY,
            });
        };
        scroll(10, 100);
        await waitForObservation(
          (value) =>
            value.scrollY === 1000 &&
            value.events.scrollEndY === 1000 &&
            value.events.scrollEndX === 300,
        );
        await readFrame();
        viewer.pointer(80, 40);
        viewerClick(viewer, 80, 40);
        await waitForObservation((value) => value.clicks === "1");
        scroll(-10, 30);
        await waitForObservation(
          (value) =>
            value.scrollY === 700 && value.events.scrollEndX === 210 && value.clicks === "1",
        );
        viewer.pointer(300, 40);
        viewerClick(viewer, 300, 40);
        const picker = await viewer.control("select");
        assert.deepEqual(
          picker.options.map((option) => option.label),
          ["First", "Second"],
        );
        viewer.input({ type: "select", pickerId: picker.pickerId, optionId: null });
        await viewer.control("selectClosed");
        let rendered;
        for (let attempt = 0; attempt < 50; attempt++) {
          rendered = await readFrame();
          const offset = (40 * rendered.width + 30) * 4;
          if (rendered.pixels[offset + 1] > 200 && rendered.pixels[offset] < 50) return;
        }
        assert.fail("Viewer did not stream the click's green result after scrolling");
      });
    },
  );
});

test("viewer-native-key-cancellation-text-and-enter-preserve-page-effects", async () => {
  await withFixture(
    `<style>body{margin:0}input,textarea,button{position:absolute;left:20px;width:220px;height:40px}#cancel{top:20px}#notes{top:80px}#expected-target{top:150px}</style>
     <input id="cancel" data-observe-value onkeydown="event.preventDefault()">
     <textarea id="notes" data-observe-value></textarea>
     <button id="expected-target" onclick="this.dataset.clicks=String(Number(this.dataset.clicks??0)+1)">Activate</button>
     <script>window.observedEvents={keys:[]};document.addEventListener('keyup',event=>observedEvents.keys.push({id:event.target.id,key:event.key}));</script>`,
    async (session) => {
      await withFramebuffer(session, async (readFrame, viewer) => {
        await readFrame();
        viewerClick(viewer, 80, 40);
        viewerKey(viewer, "a", "KeyA", "a");
        viewerKey(viewer, " ", "Space", " ");
        let observed = await waitForObservation((value) => value.events.keys.length === 2);
        assert.deepEqual(observed.values, ["", ""]);
        assert.deepEqual(observed.events.keys, [
          { id: "cancel", key: "a" },
          { id: "cancel", key: " " },
        ]);
        viewerClick(viewer, 80, 100);
        viewerKey(viewer, "a", "KeyA", "a");
        viewerKey(viewer, " ", "Space", " ");
        viewer.input({ type: "text", text: "é日本語👋" });
        viewerKey(viewer, "Enter", "Enter");
        observed = await waitForObservation((value) => value.events.keys.length === 5);
        assert.deepEqual(observed.values, ["", "a é日本語👋\n"]);
        viewerClick(viewer, 80, 170);
        viewerKey(viewer, "Enter", "Enter");
        viewerKey(viewer, " ", "Space", " ");
        observed = await waitForObservation((value) => value.events.keys.length === 7);
        assert.equal(observed.clicks, "3", "Pointer, Enter and Space each activate exactly once");
      });
    },
  );
});

test("viewer-stale-document-and-inactive-page-input-cannot-reach-current-controls", async () => {
  await withFixture("<input autofocus data-observe-value>", async (session, page) => {
    await withFramebuffer(session, async (readFrame, viewer) => {
      await readFrame();
      const reloaded = await request(`/pages/${page.pageId}/navigate`, {
        url: `${fixtureUrl}/fixture?next=1`,
      });
      assert.notEqual(reloaded.documentId, page.documentId);
      viewer.raw({
        type: "text",
        text: "stale-document",
        pageId: page.pageId,
        documentId: page.documentId,
      });
      assert.equal((await viewer.control("error")).code, "stale_view");
      assert.deepEqual((await observe()).values, [""]);
      await readFrame((frame) => frame.documentId === reloaded.documentId);
      viewer.input({ type: "text", text: "fresh" });
      assert.deepEqual((await waitForObservation((value) => value.values[0] === "fresh")).values, [
        "fresh",
      ]);
      const state = await request(`/sessions/${session.sessionId}/pages`);
      const second = state.pages.find((entry) => entry.pageId === state.activePageId);
      await request(`/pages/${second.pageId}/navigate`, { url: `${fixtureUrl}/second` });
      viewer.raw({
        type: "text",
        text: "inactive",
        pageId: page.pageId,
        documentId: reloaded.documentId,
      });
      assert.equal((await viewer.control("error")).code, "stale_view");
      assert.deepEqual((await observe({}, "/second")).values, [""]);
      assert.deepEqual((await observe()).values, ["fresh"]);
    });
  });
});

test("viewer-dialog-reconnect-preserves-an-explicit-answer-without-replay", async () => {
  await withFixture(
    `<style>body{margin:0}button{position:absolute;left:20px;top:20px;width:200px;height:40px}</style>
     <button onclick="observedEvents.answer=prompt('Choose a name','Original');observedEvents.responses++">Prompt</button>
     <script>window.observedEvents={responses:0,answer:null};</script>`,
    async (session) => {
      let firstDialog;
      await withFramebuffer(session, async (readFrame, viewer) => {
        await readFrame();
        viewerClick(viewer, 80, 40);
        firstDialog = await viewer.control("dialog");
        assert.equal(firstDialog.dialogType, "prompt");
        assert.equal(firstDialog.message, "Choose a name");
        assert.equal(firstDialog.defaultPrompt, "Original");
      });
      await withFramebuffer(session, async (readFrame, viewer) => {
        const dialog = await viewer.control("dialog");
        assert.equal(dialog.dialogId, firstDialog.dialogId);
        viewer.raw({
          type: "dialog",
          pageId: dialog.pageId,
          documentId: dialog.documentId,
          dialogId: dialog.dialogId,
          accept: true,
          promptText: "Chosen 👋",
        });
        await viewer.control("dialogClosed", (message) => message.dialogId === dialog.dialogId);
        let observed = await waitForObservation((value) => value.events.responses === 1);
        assert.deepEqual(observed.events, { responses: 1, answer: "Chosen 👋" });
        viewer.raw({
          type: "dialog",
          pageId: dialog.pageId,
          documentId: dialog.documentId,
          dialogId: dialog.dialogId,
          accept: true,
          promptText: "Replay",
        });
        assert.equal((await viewer.control("error")).dialogId, dialog.dialogId);
        observed = await observe();
        assert.deepEqual(observed.events, { responses: 1, answer: "Chosen 👋" });
        await readFrame();
        viewerClick(viewer, 80, 40);
        const cancelled = await viewer.control("dialog");
        viewer.raw({
          type: "dialog",
          pageId: cancelled.pageId,
          documentId: cancelled.documentId,
          dialogId: cancelled.dialogId,
          accept: false,
        });
        await viewer.control("dialogClosed", (message) => message.dialogId === cancelled.dialogId);
        assert.deepEqual(
          (await waitForObservation((value) => value.events.responses === 2)).events,
          { responses: 2, answer: null },
        );
      });
    },
  );
});

for (const kind of ["alert", "prompt"])
  test(
    `viewer-load-time-${kind}-can-be-answered-before-the-first-page-frame`,
    { timeout: 30000 },
    async () => {
      await withFixture(
        `<script>window.observedEvents={complete:false,answer:null};observedEvents.answer=${kind}('Initial ${kind}'${kind === "prompt" ? ",'Initial value'" : ""});observedEvents.complete=true;</script><button>Page ready</button>`,
        async (session, page) => {
          await withFramebuffer(session, async (readFrame, viewer) => {
            const dialog = await viewer.control("dialog");
            assert.equal(dialog.dialogType, kind);
            assert.equal(dialog.message, `Initial ${kind}`);
            assert.equal(dialog.pageId, page.pageId);
            viewer.raw({
              type: "dialog",
              pageId: dialog.pageId,
              documentId: dialog.documentId,
              dialogId: dialog.dialogId,
              accept: true,
              ...(kind === "prompt" ? { promptText: "Confirmed" } : {}),
            });
            await viewer.control("dialogClosed", (message) => message.dialogId === dialog.dialogId);
            const frame = await readFrame(
              (value) => value.pageId === page.pageId && value.documentId === dialog.documentId,
            );
            assert.equal(frame.width, 1280);
            assert.equal(frame.height, 800);
            const observed = await waitForObservation((value) => value.events.complete);
            assert.equal(observed.events.answer, kind === "prompt" ? "Confirmed" : undefined);
          });
        },
      );
    },
  );

test("viewer-select-bridge-applies-only-an-explicit-retained-option-and-cancels-cleanly", async () => {
  await withFixture(
    `<style>body{margin:0}select{position:absolute;left:20px;top:20px;width:220px;height:40px}</style>
     <select data-observe-value><option value="PRIVATE_RED">Red</option><option value="PRIVATE_BLUE">Blue</option><option value="PRIVATE_DISABLED" disabled>Unavailable</option></select>
     <script>window.observedEvents={input:0,change:0};document.querySelector('select').addEventListener('input',()=>observedEvents.input++);document.querySelector('select').addEventListener('change',()=>observedEvents.change++);</script>`,
    async (session) => {
      await withFramebuffer(session, async (readFrame, viewer) => {
        await readFrame();
        viewerClick(viewer, 80, 40);
        const picker = await viewer.control("select");
        assert.equal(
          JSON.stringify(picker).includes("PRIVATE_"),
          false,
          "Option values stay server-side",
        );
        assert.deepEqual(
          picker.options.map(({ label, disabled, selected }) => ({ label, disabled, selected })),
          [
            { label: "Red", disabled: false, selected: true },
            { label: "Blue", disabled: false, selected: false },
            { label: "Unavailable", disabled: true, selected: false },
          ],
        );
        assert.deepEqual((await observe()).values, ["PRIVATE_RED"]);
        const blue = picker.options.find((option) => option.label === "Blue");
        const answer = {
          type: "select",
          pageId: picker.pageId,
          documentId: picker.documentId,
          pickerId: picker.pickerId,
          optionId: blue.id,
        };
        viewer.raw(answer);
        await viewer.control("selectClosed", (message) => message.pickerId === picker.pickerId);
        assert.deepEqual((await observe()).values, ["PRIVATE_BLUE"]);
        assert.deepEqual((await observe()).events, { input: 1, change: 1 });
        viewer.raw(answer);
        assert.equal((await viewer.control("error")).pickerId, picker.pickerId);
        assert.deepEqual((await observe()).events, { input: 1, change: 1 });
        viewerClick(viewer, 80, 40);
        const cancel = await viewer.control("select");
        viewer.raw({
          type: "select",
          pageId: cancel.pageId,
          documentId: cancel.documentId,
          pickerId: cancel.pickerId,
          optionId: null,
        });
        await viewer.control("selectClosed", (message) => message.pickerId === cancel.pickerId);
        assert.deepEqual((await observe()).values, ["PRIVATE_BLUE"]);
        assert.deepEqual((await observe()).events, { input: 1, change: 1 });
      });
    },
  );
});
