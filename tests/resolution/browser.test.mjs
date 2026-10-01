import assert from "node:assert/strict";
import { createServer } from "node:http";
import { on, once } from "node:events";
import test from "node:test";
import { networkInterfaces } from "node:os";

const browserUrl = process.env.XPATHED_BROWSER_URL ?? "http://browser:8080";
const fixtureAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address.family === "IPv4" && !address.internal)?.address;
const oracleCommands = new Map();
const oracleObservers = new Map();
const oracleScript = `<script>
    setInterval(async () => {
      const endpoint = '?page=' + encodeURIComponent(location.pathname);
      const response = await fetch('/oracle' + endpoint);
      if (response.status === 204) return;
      const { xpaths = [], replaceTarget, reload, click, open, focusPopup, close, cookie, scrollToY, slowFrame, mutateXpath, staleInput } = await response.json();
      if (staleInput) {
        const binding = Object.keys(window).find(key => key.startsWith('xpathedInput') && typeof window[key] === 'function');
        if (!binding) throw new Error('Missing input notification binding');
        await window[binding](0);
      }
      if (mutateXpath) window.mutateXpathFixture();
      if (slowFrame) {
        const frame = document.querySelector('iframe');
        const rect = frame.getBoundingClientRect.bind(frame);
        frame.getBoundingClientRect = () => { const end = performance.now() + 2100; while (performance.now() < end) {} return rect(); };
      }
      if (scrollToY !== undefined) scrollTo(0, scrollToY);
      if (cookie) document.cookie = cookie;
      if (click) document.querySelector(click).click();
      if (open) window.fixturePopup = window.open(open.url, open.name ?? '_blank', open.features ?? '');
      if (focusPopup) window.fixturePopup?.focus();
      if (replaceTarget) document.querySelector('#expected-target').outerHTML = '<button id="expected-target">Replacement</button>';
      const matches = xpaths.map(xpath => {
        const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: nodes.snapshotLength }, (_, index) => nodes.snapshotItem(index).getAttribute('data-oracle') ?? nodes.snapshotItem(index).id);
      });
      await fetch('/oracle-result' + endpoint, { method: 'POST', body: JSON.stringify({ matches, scrollY, clicks: document.querySelector('#expected-target')?.dataset.clicks ?? '0', nodeCount: document.querySelectorAll('*').length,
        cookie: document.cookie, openerPath: window.opener?.location.pathname ?? null, focused: document.hasFocus(),
        activeElement: document.activeElement?.id, events: window.observedEvents ?? {},
        targetMarkup: document.querySelector("#expected-target")?.outerHTML, values: [...document.querySelectorAll('[data-observe-value]')].map(element => element.value),
        innerWidth, innerHeight, outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height }) });
      if (close) window.close();
      if (reload === 'hash') location.hash = 'changed';
      else if (reload) location.reload();
    }, 30);
  </script>`;
const targetMarkup = `<section aria-label="Employee"><h2>Employee</h2>
  <button id="expected-target" data-testid="about-us" onclick="this.dataset.clicks = '1'">About us</button>
</section>`;

// RFB 3.8 client exercises rendered pixels and trusted input through the public viewer seam.
async function withFramebuffer(session, check) {
  const socket = new WebSocket(`${browserUrl.replace("http", "ws")}${session.viewPath}`, {
    headers: { Origin: process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081" },
  });
  socket.binaryType = "arraybuffer";
  const messages = on(socket, "message", { signal: AbortSignal.timeout(15000) });
  let buffered = Buffer.alloc(0);
  async function read(size) {
    while (buffered.length < size) {
      const {
        value: [message],
      } = await messages.next();
      buffered = Buffer.concat([buffered, Buffer.from(message.data)]);
    }
    const result = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return result;
  }
  try {
    assert.equal((await read(12)).toString(), "RFB 003.008\n");
    socket.send(Buffer.from("RFB 003.008\n"));
    const securityTypes = await read((await read(1))[0]);
    assert.ok(securityTypes.includes(1));
    socket.send(Uint8Array.of(1));
    assert.equal((await read(4)).readUInt32BE(), 0);
    socket.send(Uint8Array.of(1));
    const initialization = await read(24);
    const width = initialization.readUInt16BE(0),
      height = initialization.readUInt16BE(2);
    await read(initialization.readUInt32BE(20));
    socket.send(
      Uint8Array.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]),
    );
    socket.send(Uint8Array.from([2, 0, 0, 1, 0, 0, 0, 0]));
    let firstFrame = true;
    const pixels = Buffer.alloc(width * height * 4);
    await check(
      async () => {
        const update = Buffer.alloc(10);
        update[0] = 3;
        update[1] = firstFrame ? 0 : 1;
        firstFrame = false;
        update.writeUInt16BE(width, 6);
        update.writeUInt16BE(height, 8);
        socket.send(update);
        const header = await read(4);
        assert.equal(header[0], 0);
        for (let index = 0; index < header.readUInt16BE(2); index++) {
          const rectangle = await read(12);
          const x = rectangle.readUInt16BE(0),
            y = rectangle.readUInt16BE(2);
          const w = rectangle.readUInt16BE(4),
            h = rectangle.readUInt16BE(6);
          assert.equal(rectangle.readInt32BE(8), 0);
          const data = await read(w * h * 4);
          for (let row = 0; row < h; row++)
            data.copy(pixels, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
        }
        return { pixels, width, height };
      },
      {
        pointer(x, y, buttons = 0) {
          const event = Buffer.alloc(6);
          event[0] = 5;
          event[1] = buttons;
          event.writeUInt16BE(x, 2);
          event.writeUInt16BE(y, 4);
          socket.send(event);
        },
        key(key, down) {
          const event = Buffer.alloc(8);
          event[0] = 4;
          event[1] = down ? 1 : 0;
          event.writeUInt32BE(key, 4);
          socket.send(event);
        },
      },
    );
  } finally {
    await messages.return();
    socket.close();
  }
}

test(
  "Repeated session teardown releases display resources before reusing the slot",
  { timeout: 300000 },
  async () => {
    // The old forced x11vnc shutdown exhausted the default 4096 System V segments before 128 sessions.
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
  },
);

test("Viewer disconnect completes its WebSocket close handshake and can reconnect", async () => {
  await withFixture(targetMarkup, async (session) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const socket = new WebSocket(`${browserUrl.replace("http", "ws")}${session.viewPath}`, {
        headers: { Origin: process.env.XPATHED_VIEWER_ORIGIN ?? "http://localhost:8081" },
      });
      const [message] = await once(socket, "message", { signal: AbortSignal.timeout(5000) });
      assert.match(await message.data.text(), /^RFB /);
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
      socket.close(1000);
      const [event] = await closed;
      assert.equal(event.code, 1000);
      assert.equal(event.wasClean, true);
    }
  });
});

test("Target descriptions preserve roles and image names without substituting descendant content", async () => {
  await withFixture(
    `<input id="submit" type="submit" value="Search">
     <img id="photo" alt="Product photo" width="50" height="50">
     <img id="unnamed" role="img" tabindex="0" width="50" height="50">
     <div id="group" role="group">Unrelated descendant content</div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const before = await observe();
      for (const [tag, role, name, expectedId] of [
        ["input", "button", "Search", "submit"],
        ["img", "img", "Product photo", "photo"],
        ["img", "img", "", "unnamed"],
        ["div", "group", "", "group"],
      ]) {
        const candidate = capture.candidates.find(
          (entry) => entry.tag === tag && entry.role === role && entry.label === name,
        );
        assert.ok(candidate, expectedId);
        const body = {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        };
        const { target } = await request(`/pages/${page.pageId}/selection`, body);
        const batch = await request(`/pages/${page.pageId}/selections`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          actions: [{ actionId: "a1", candidateId: candidate.id, action: "inspect" }],
        });
        for (const selected of [target, batch.actions[0].target]) {
          assert.equal(selected.role, role);
          assert.equal(selected.accessibleName, name);
          assert.deepEqual((await verify(selected.xpaths)).matches, [[expectedId]]);
        }
      }
      const after = await observe();
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.clicks, before.clicks);
    },
  );
});

test("Browser captures labels containing comment nodes and validates each action target", async () => {
  await withFixture(
    `<section aria-label="Videos"><a id="expected-target" href="#first">First<!-- PRIVATE_COMMENT_SENTINEL --> video</a>
      <button aria-labelledby="video-name">Play</button><span id="video-name" hidden>Second<!-- comment --> video</span></section>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_COMMENT_SENTINEL"));
      const link = capture.candidates.find((candidate) => candidate.tag === "a");
      const button = capture.candidates.find((candidate) => candidate.tag === "button");
      assert.equal(link.label, "First video");
      assert.equal(button.label, "Second video");
      const selection = await request(`/pages/${page.pageId}/selections`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        actions: [{ actionId: "a1", candidateId: link.id, action: "click" }],
      });
      assert.deepEqual(
        (await verify(selection.actions[0].target.xpaths)).matches,
        selection.actions[0].target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("An action batch verifies distinct retained nodes and inspects one target without executing", async () => {
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

async function request(path, body, method = "POST") {
  const response = await fetch(`${browserUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.ok, true, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? undefined : response.json();
}

async function observe(command = {}, pagePath = "/fixture") {
  oracleCommands.set(pagePath, command);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      oracleObservers.delete(pagePath);
      reject(new Error(`Fixture oracle did not respond on ${pagePath}`));
    }, 5000);
    oracleObservers.set(pagePath, (value) => {
      clearTimeout(timeout);
      oracleObservers.delete(pagePath);
      resolve(value);
    });
  });
}

function verify(xpaths, replaceTarget = false, reload = false) {
  return observe({ xpaths, replaceTarget, reload });
}

async function waitForSession(sessionId, expected) {
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await request(`/sessions/${sessionId}`, undefined, "GET");
    if (expected(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Session state did not settle: ${JSON.stringify(state)}`);
}

function fillsDisplay(observation) {
  return (
    observation.innerWidth === observation.outerWidth &&
    observation.innerHeight === observation.outerHeight &&
    Math.abs(observation.outerWidth - observation.screenWidth) <= 1 &&
    Math.abs(observation.outerHeight - observation.screenHeight) <= 1
  );
}

async function observeFullscreen(pagePath) {
  let observation;
  for (let attempt = 0; attempt < 50; attempt++) {
    observation = await observe({}, pagePath);
    if (fillsDisplay(observation)) return observation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return observation;
}

async function expectError(path, body, status, code) {
  const response = await fetch(`${browserUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
}

async function withFixture(markup, check) {
  oracleCommands.clear();
  oracleObservers.clear();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://resolution-fixture:8070");
    const pagePath = url.searchParams.get("page");
    if (url.pathname === "/oracle") {
      const command = oracleCommands.get(pagePath);
      response.writeHead(command ? 200 : 204, { "Content-Type": "application/json" });
      response.end(command ? JSON.stringify(command) : "");
      oracleCommands.delete(pagePath);
      return;
    }
    if (url.pathname === "/oracle-result") {
      let body = "";
      for await (const chunk of request) body += chunk;
      oracleObservers.get(pagePath)?.(JSON.parse(body));
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const content = typeof markup === "function" ? markup(url.pathname) : markup;
    response.end(`<!doctype html><html><body>${content}${oracleScript}</body></html>`);
  });
  server.listen(8070, "0.0.0.0");
  await once(server, "listening");
  let session;
  try {
    session = await request("/sessions");
    const page = await request(`/pages/${session.pageId}/navigate`, {
      url: "http://resolution-fixture:8070/fixture",
    });
    await check(session, page);
  } finally {
    if (session) await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Browser captures and highlights the independently identified target without executing it", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    assert.equal(typeof page.documentId, "string");
    const capture = await request(`/pages/${session.pageId}/capture`, {
      documentId: page.documentId,
    });
    const candidate = capture.candidates.find(
      (entry) => entry.tag === "button" && entry.text === "About us",
    );
    assert.ok(candidate, "The rendered button must be captured");
    assert.equal(capture.coverage.complete, true);
    const before = await verify([]);
    const selection = await request(`/pages/${session.pageId}/selection`, {
      documentId: page.documentId,
      captureId: capture.captureId,
      candidateId: candidate.id,
      action: "click",
    });
    assert.deepEqual(selection.target.xpaths, ["//button[@data-testid='about-us']"]);
    const after = await verify(selection.target.xpaths);
    assert.deepEqual(
      after.matches,
      selection.target.xpaths.map(() => ["expected-target"]),
    );
    assert.equal(after.clicks, "0");
    assert.equal(after.scrollY, before.scrollY);
    assert.equal(after.nodeCount, before.nodeCount + 1, "Only the inert highlight host is added");
    assert.equal(after.targetMarkup, before.targetMarkup);
    assert.equal(selection.target.state.rendered, true);
    assert.equal(selection.target.state.enabled, true);
    assert.equal(selection.target.state.inViewport, true);
    assert.equal(selection.target.interactability.status, "ready");
    assert.equal(selection.target.interactability.checks.eventOutcome, "unknown");
  });
});

test("Disabled click and hover keep the same target with different action readiness", async () => {
  await withFixture(
    '<button id="expected-target" disabled>Disabled action</button>',
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.text === "Disabled action");
      for (const [action, status] of [
        ["click", "blocked"],
        ["hover", "ready"],
      ]) {
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action,
        });
        assert.equal(target.state.version, "2");
        assert.equal(target.interactability.version, "2");
        assert.equal(target.interactability.action, action);
        assert.equal(target.interactability.status, status);
        assert.equal(
          target.interactability.checks.enabled,
          action === "hover" ? "not_applicable" : "fail",
        );
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
        assert.deepEqual(
          (await verify(target.xpaths)).matches,
          target.xpaths.map(() => ["expected-target"]),
        );
      }
    },
  );
});

test("An offscreen target retains one verified path without moving the page and becomes ready after user scrolling", async () => {
  await withFixture(
    '<button id="expected-target" style="position:absolute;top:2200px;width:240px;height:100px">Footer gallery</button>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.label === "Footer gallery");
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      };
      const before = await observe();
      const { target } = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(target.xpaths.length, 1);
      assert.equal(target.state.inViewport, false);
      assert.equal(target.interactability.status, "blocked");
      assert.ok(target.interactability.reasons.includes("off_screen"));
      assert.equal((await observe()).scrollY, before.scrollY);
      const scrolled = await observe({ scrollToY: 2100, xpaths: target.xpaths });
      assert.ok(scrolled.scrollY > before.scrollY);
      assert.deepEqual(scrolled.matches, [["expected-target"]]);
      assert.equal(scrolled.nodeCount, before.nodeCount + 1);
      const current = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(current.target.state.inViewport, true);
      assert.equal(current.target.interactability.status, "ready");
      assert.equal((await observe()).scrollY, scrolled.scrollY);
    },
  );
});

test("The public viewer paints an offscreen target highlight after scrolling and clears it on a new capture", async () => {
  await withFixture(
    '<style>body { margin:0; background:white; height:3200px; } button { position:absolute; top:2200px; left:100px; width:240px; height:100px; background:white; border:0; }</style><button id="expected-target">Footer gallery</button>',
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
        const bluePixels = ({ pixels, width }, top) => {
          let count = 0;
          for (let y = top + 10; y < top + 40; y++)
            for (let x = 110; x < 330; x++) {
              const offset = (y * width + x) * 4;
              if (
                pixels[offset] > pixels[offset + 2] + 15 &&
                pixels[offset + 1] > pixels[offset + 2] + 5
              )
                count++;
            }
          return count;
        };
        assert.equal(bluePixels(await frame(), 100), 0);
        await observe({ scrollToY: 2100 });
        await new Promise((resolve) => setTimeout(resolve, 200));
        let highlighted = 0;
        for (let attempt = 0; attempt < 20 && highlighted < 500; attempt++) {
          highlighted = bluePixels(await frame(), 100);
          if (highlighted < 500) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(
          highlighted >= 500,
          `Expected blue target pixels after scrolling, got ${highlighted}`,
        );
        await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
        let remaining = highlighted;
        for (let attempt = 0; attempt < 20 && remaining; attempt++) {
          remaining = bluePixels(await frame(), 100);
          if (remaining) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(remaining, 0);
        assert.equal((await observe()).scrollY, 2100);
      });
    },
  );
});

function blueTargetPixels({ pixels, width }, left, top) {
  let count = 0;
  for (let y = top + 10; y < top + 40; y++)
    for (let x = left + 10; x < left + 230; x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset] > pixels[offset + 2] + 15 && pixels[offset + 1] > pixels[offset + 2] + 5)
        count++;
    }
  return count;
}

async function expectHighlights(frame, locations, visible) {
  let counts;
  for (let attempt = 0; attempt < 20; attempt++) {
    const image = await frame();
    counts = locations.map(([left, top]) => blueTargetPixels(image, left, top));
    if (counts.every((count) => (visible ? count >= 500 : count === 0))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    `Expected highlights ${visible ? "visible" : "cleared"} at ${JSON.stringify(locations)}; blue pixels: ${counts}`,
  );
}

async function waitForFixtureEvent(type) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await observe()).events[type]) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Viewer did not deliver trusted ${type}`);
}

const highlightFixture = `<style>body {margin:0;background:white} button {position:absolute;left:100px;top:100px;width:240px;height:100px;background:white;border:0} #second-target {left:500px}</style>
<button id="expected-target">First approval</button><button id="second-target">Second approval</button>
<script>window.observedEvents = {}; for (const type of ['pointermove','pointerdown','keydown']) addEventListener(type, event => { if(event.isTrusted) window.observedEvents[type] = (window.observedEvents[type] ?? 0) + 1; });</script>`;

async function selectHighlights(page, plural = false) {
  const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
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

test("Viewer highlights every selected target simultaneously", async () => {
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

test("Viewer preserves highlights on mouse movement and clears them on click or key input", async () => {
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
  test(`Viewer highlights main and ${crossOrigin ? "cross-origin" : "same-origin"} frame targets and clears all on frame input`, async () => {
    await withFixture(
      (path) =>
        path === "/fixture"
          ? `${highlightFixture}<iframe title="Approval frame" src="${crossOrigin ? `http://${fixtureAddress}:8070` : ""}/highlight-frame" style="position:absolute;left:100px;top:300px;width:800px;height:300px;border:0"></iframe>`
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
        });
      },
    );
  });

test("Input in an unsupported transformed frame invalidates main-document highlights", async () => {
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
  test(`Highlights paint above a transformed ${mode} without changing its state`, async () => {
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

test("Accessibility eligibility keeps exposed visual limitations and computes safe hidden names", async () => {
  await withFixture(
    `<style>.sr-only { position:absolute; width:1px; height:1px; clip:rect(0,0,0,0); overflow:hidden; }</style>
    <button id="expected-target" aria-labelledby="hidden-name" aria-label="Wrong name">Visible duplicate</button>
    <span id="hidden-name" hidden>Hidden name <input value="NAME_SECRET"><img alt="Icon"></span>
    <button hidden>Excluded hidden</button><div inert><button>Excluded inert</button></div>
    <div aria-hidden="true"><button aria-hidden="false">Excluded aria</button></div>
    <div style="display:none"><button>Excluded display</button></div>
    <div style="visibility:hidden"><button>Excluded visibility</button><button style="visibility:visible">Visibility override</button></div>
    <button hidden style="display:block">Hidden override</button>
    <button style="opacity:0">Transparent</button><button class="sr-only">Screen reader</button>
    <button style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero area</button>
    <button style="position:absolute;top:4000px">Offscreen exposed</button>
    <label hidden for="named-input">Native hidden label</label><input id="named-input" value="VALUE_SECRET">
    <details><summary>Closed disclosure</summary><button>Excluded disclosure</button></details>
    <input type="hidden" aria-label="Excluded hidden input">`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(
        capture.candidates.every(
          (entry) => !entry.text.startsWith("Excluded") && !entry.label.startsWith("Excluded"),
        ),
      );
      assert.doesNotMatch(JSON.stringify(capture), /SECRET/);
      const named = capture.candidates.find((entry) => entry.label === "Hidden name Icon");
      assert.ok(
        named,
        "aria-labelledby precedes aria-label and includes safe hidden reference text",
      );
      assert.ok(capture.candidates.some((entry) => entry.label === "Native hidden label"));
      for (const name of [
        "Visibility override",
        "Hidden override",
        "Transparent",
        "Screen reader",
        "Zero area",
        "Offscreen exposed",
      ]) {
        const candidate = capture.candidates.find((entry) => entry.text === name);
        assert.ok(candidate, name);
        assert.equal(candidate.state.accessibilityExposed, true);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "hover",
        });
        assert.ok(target.xpaths.length > 0, name);
        if (name === "Transparent" || name === "Zero area")
          assert.equal(target.state.rendered, false);
        if (name === "Zero area" || name === "Offscreen exposed")
          assert.equal(target.interactability.status, "blocked");
      }
      const selected = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: named.id,
        action: "click",
      });
      assert.deepEqual(
        (await verify(selected.target.xpaths)).matches,
        selected.target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("Action readiness explains readonly, incompatible, covered, pointer and custom controls without interaction", async () => {
  await withFixture(
    `<input aria-label="Readonly field" readonly value="PRIVATE_VALUE">
    <input type="checkbox" aria-label="Check choice"><input type="radio" aria-label="Radio choice">
    <select aria-label="Select country"><option>PRIVATE_OPTION</option></select>
    <div role="combobox" aria-label="Custom select" tabindex="0">Custom</div>
    <div role="textbox" aria-label="Custom editor" aria-readonly="true" tabindex="0"></div>
    <button aria-label="Blocked pointer" style="pointer-events:none">Pointer</button>
    <div style="position:relative;width:160px;height:40px"><button aria-label="Covered" style="width:160px;height:40px">Covered</button><div style="position:absolute;inset:0;background:black"></div></div>
    <button aria-label="Plain button">Plain</button>
    <script>window.observedEvents={};for(const name of ['click','input','change','focusin','mouseover','pointerover','scroll'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      for (const [name, action, status, reason] of [
        ["Readonly field", "fill", "blocked", "readonly"],
        ["Readonly field", "type", "blocked", "readonly"],
        ["Readonly field", "click", "ready", null],
        ["Plain button", "fill", "blocked", "incompatible_control"],
        ["Blocked pointer", "hover", "blocked", "pointer_events_none"],
        ["Covered", "click", "blocked", "obstructed_at_hit_point"],
        ["Select country", "select", "unknown", null],
        ["Check choice", "check", "ready", null],
        ["Check choice", "uncheck", "ready", null],
        ["Radio choice", "uncheck", "blocked", "incompatible_control"],
        ["Custom select", "select", "unsupported", "custom_control_unverified"],
        ["Custom editor", "fill", "blocked", "readonly"],
      ]) {
        const candidate = capture.candidates.find((entry) => entry.label === name);
        assert.ok(candidate, name);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action,
        });
        assert.equal(target.interactability.status, status, `${name}: ${action}`);
        if (reason)
          assert.ok(target.interactability.reasons.includes(reason), `${name}: ${reason}`);
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
      }
      const after = await observe();
      assert.deepEqual(after.events, before.events);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_/);
    },
  );
});

test("Chromium exposure exceptions preserve focus, modal controls and supported role fallback", async () => {
  await withFixture(
    `<div id="focused-parent"><button id="expected-target">Focused hidden exception</button></div>
    <input type="search" aria-label="Search"><div role="invalid textbox" aria-label="Role fallback" aria-readonly="true" tabindex="0"></div>
    <script>document.querySelector('#expected-target').focus();document.querySelector('#focused-parent').setAttribute('aria-hidden','true');</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Focused hidden exception"));
      assert.equal(capture.candidates.find((entry) => entry.label === "Search").role, "searchbox");
      const fallback = capture.candidates.find((entry) => entry.label === "Role fallback");
      assert.equal(fallback.role, "textbox");
      assert.equal(fallback.state.readonly, true);
      assert.equal((await observe()).activeElement, before.activeElement);
    },
  );
  await withFixture(
    `<button>Implicit inert background</button><section inert><dialog id="modal">
    <button id="expected-target">Modal exposed</button></dialog></section>
    <script>document.querySelector('#modal').showModal();</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Modal exposed"));
      assert.ok(capture.candidates.every((entry) => entry.text !== "Implicit inert background"));
      assert.equal((await observe()).activeElement, before.activeElement);
    },
  );
});

test("Native semantics retain normalized inputs, presentation conflicts and descendant names", async () => {
  await withFixture(
    `<input type="unknown" aria-label="Normalized text"><input readonly type="checkbox" aria-label="Readonly inapplicable">
    <input role="presentation" aria-label="Native presentation"><button id="expected-target"><span aria-label="Save"><span>Icon text</span></span></button>
    <button id="referenced-name"><span aria-labelledby="save-name">Icon</span></button><span id="save-name" hidden>Save reference<input value="PRIVATE_VALUE"></span>
    <button id="cyclic-name"><span id="cycle" aria-labelledby="cycle">Cycle</span></button>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(
        capture.candidates.find((entry) => entry.label === "Readonly inapplicable").state.readonly,
        false,
      );
      assert.equal(
        capture.candidates.find((entry) => entry.label === "Native presentation").role,
        "textbox",
      );
      const named = capture.candidates.find((entry) => entry.tag === "button");
      assert.equal(named.label, "Save");
      assert.ok(
        capture.candidates.some(
          (entry) => entry.label === "Save reference" && entry.tag === "button",
        ),
      );
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_VALUE/);
      assert.equal(capture.coverage.complete, true);
      const text = capture.candidates.find((entry) => entry.label === "Normalized text");
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: text.id,
        action: "fill",
      });
      assert.equal(target.interactability.checks.compatibleControl, "pass");
      assert.equal(target.interactability.status, "unknown");
    },
  );
});

test("The last opened modal determines exposure even in reverse DOM order", async () => {
  await withFixture(
    `<dialog id="first"><button>Active modal</button></dialog><dialog id="second"><button>Older modal</button></dialog>
    <script>document.querySelector('#second').showModal();document.querySelector('#first').showModal();</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(capture.candidates.some((entry) => entry.label === "Active modal"));
      assert.ok(capture.candidates.every((entry) => entry.text !== "Older modal"));
    },
  );
});

test("Capture preserves control labels, Unicode, scope and observed state without sending form values", async () => {
  await withFixture(
    `${targetMarkup}
    <fieldset><legend>Équipe القاهرة</legend>
      <label for="name">Nom prénom</label><input id="name" value="INPUT_SECRET" placeholder="Votre nom">
      <label for="password">Password</label><input id="password" type="password" value="PASSWORD_SECRET">
      <label>Notes<textarea>TEXTAREA_SECRET</textarea></label>
      <label>Country<select><option value="VALUE_SECRET" selected>SELECT_SECRET</option></select></label>
      <div contenteditable aria-label="Editor">EDITOR_SECRET</div>
      <div contenteditable aria-label="Empty editor" style="width:100px;height:30px"></div>
      <input id="checked" type="checkbox" checked aria-label="Remember me">
      <div role="checkbox" aria-label="Mixed choice" aria-checked="mixed">Mixed</div>
      <button disabled>Disabled</button>
      <a href="https://example.test/?token=URL_SECRET">Link</a>
      <span>Hover text</span>
    </fieldset>
    <button hidden>Hidden one</button><div style="display:none"><button>Hidden two</button></div>
    <div style="opacity:0"><button>Transparent three</button></div><button aria-hidden="true">Hidden four</button>
    <button style="position:absolute;top:4000px">Offscreen</button>
    <script>localStorage.setItem('credential', 'STORAGE_SECRET');document.cookie = 'session=COOKIE_SECRET';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const serialized = JSON.stringify(capture);
      for (const secret of [
        "INPUT_SECRET",
        "PASSWORD_SECRET",
        "TEXTAREA_SECRET",
        "SELECT_SECRET",
        "VALUE_SECRET",
        "EDITOR_SECRET",
        "URL_SECRET",
        "STORAGE_SECRET",
        "COOKIE_SECRET",
      ])
        assert.ok(!serialized.includes(secret), secret);
      const name = capture.candidates.find((candidate) => candidate.label === "Nom prénom");
      assert.ok(name);
      assert.equal(name.tag, "input");
      assert.equal(name.placeholder, "Votre nom");
      assert.equal(name.state.editable, true);
      assert.ok(name.scope.includes("Équipe القاهرة"));
      for (const label of ["Password", "Notes", "Country", "Editor", "Empty editor", "Remember me"])
        assert.ok(
          capture.candidates.some((candidate) => candidate.label === label),
          label,
        );
      const checkbox = capture.candidates.find((candidate) => candidate.label === "Remember me");
      assert.equal(checkbox.state.checked, null);
      const checkedSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: checkbox.id,
        action: "check",
      });
      assert.equal(checkedSelection.target.state.checked, true);
      assert.equal(
        capture.candidates.find((candidate) => candidate.label === "Mixed choice").state.checked,
        null,
      );
      assert.equal(
        capture.candidates.find((candidate) => candidate.text === "Disabled").state.enabled,
        false,
      );
      assert.equal(
        capture.candidates.find((candidate) => candidate.text === "Offscreen").state.inViewport,
        false,
      );
      assert.ok(capture.candidates.some((candidate) => candidate.text === "Hover text"));
      assert.ok(capture.candidates.every((candidate) => !candidate.text.startsWith("Hidden")));
      assert.equal(
        capture.candidates.find((candidate) => candidate.text === "Transparent three").state
          .rendered,
        false,
      );
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.capturedCount, capture.candidates.length);
    },
  );
});

test("The single preferred XPath escapes both quote types and uses meaningful context for duplicate attributes", async () => {
  await withFixture(
    `<section aria-label="Employee"><button data-oracle="expected-target" data-testid="shared">OK</button></section>
    <section aria-label="Other"><button data-testid="shared">OK</button></section>
    <button data-oracle="quoted-target" data-testid="He said &quot;don't&quot;">Quoted</button>
    <div id="app"><a href="#unique" data-oracle="unique-target">Unique gallery</a></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const employee = capture.candidates.find(
        (candidate) => candidate.tag === "button" && candidate.scope.includes("Employee"),
      );
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: employee.id,
        action: "click",
      });
      assert.ok(selection.target.xpaths[0].includes("Employee"));
      assert.equal(selection.target.xpaths.length, 1);
      assert.ok(
        selection.target.xpaths.every((xpath) => !xpath.includes("[@data-testid='shared'][1]")),
      );
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
      const quoted = capture.candidates.find((candidate) => candidate.text === "Quoted");
      const quotedSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: quoted.id,
        action: "click",
      });
      assert.ok(quotedSelection.target.xpaths[0].includes("concat("));
      assert.equal(quotedSelection.target.xpaths.length, 1);
      assert.deepEqual(
        (await verify(quotedSelection.target.xpaths)).matches,
        quotedSelection.target.xpaths.map(() => ["quoted-target"]),
      );
      const unique = capture.candidates.find((candidate) => candidate.tag === "a");
      const uniqueSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: unique.id,
        action: "click",
      });
      assert.deepEqual(uniqueSelection.target.xpaths, ["//a[normalize-space(.)='Unique gallery']"]);
      assert.deepEqual((await verify(uniqueSelection.target.xpaths)).matches, [["unique-target"]]);
    },
  );
});

test("Saved semantic XPaths survive generated IDs, wrappers and reordered duplicate controls", async () => {
  await withFixture(
    `<label for="a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6">Country</label><input id="a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6" data-oracle="country">
    <div id="contacts"><input name="contact" placeholder="Email" data-oracle="email"><input name="contact" placeholder="Phone"><input name="backup" placeholder="Email"></div>
    <table><tr><td>Alice</td><td><button data-oracle="alice">Approve</button></td></tr><tr><td>Bob</td><td><button>Approve</button></td></tr></table>
    <header><button>Help</button></header><footer><button data-oracle="footer">Help</button></footer>
    <button data-test-id="stable-save" data-oracle="save">Save</button>
    <script>window.mutateXpathFixture = () => {
      const country = document.querySelector('[data-oracle="country"]');
      country.id = 'new-generated-country'; document.querySelector('label').htmlFor = country.id;
      const tbody = document.querySelector('tbody'); tbody.prepend(tbody.lastElementChild);
      for (const selector of ['[data-oracle="country"]','[data-oracle="email"]','[data-oracle="footer"]','[data-oracle="save"]']) {
        const node = document.querySelector(selector), wrapper = document.createElement('div');
        node.before(wrapper); wrapper.append(node); node.className = 'changed-style';
      }
      document.querySelector('#contacts').prepend(document.querySelector('input[name="backup"]'));
      const extra = document.createElement('button'); extra.textContent = 'Help'; document.querySelector('header').prepend(extra);
      document.querySelector('[data-oracle="save"]').textContent = 'Save changes';
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const cases = [
        ["country", (candidate) => candidate.label === "Country"],
        ["email", (candidate) => candidate.tag === "input" && candidate.placeholder === "Email"],
        [
          "alice",
          (candidate) =>
            candidate.tag === "button" && candidate.scope.some((scope) => scope.includes("Alice")),
        ],
        ["footer", (candidate) => candidate.label === "Help" && candidate.scope.includes("footer")],
        ["save", (candidate) => candidate.label === "Save"],
      ];
      const paths = [];
      for (const [expected, matches] of cases) {
        const candidate = capture.candidates.find(matches);
        assert.ok(candidate, expected);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.equal(target.xpaths.length, 1);
        paths.push(target.xpaths[0]);
      }
      const expected = cases.map(([id]) => [id]);
      assert.deepEqual((await verify(paths)).matches, expected);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
    },
  );
});

test("Saved user-facing XPaths survive ID changes and scoped duplicates but reject changed meaning", async () => {
  await withFixture(
    `<section aria-label="Profile"><button id="save-profile" data-oracle="save">Save changes</button>
    <label for="country">Country</label><input id="country" data-oracle="country"></section>
    <script>let mutation = 0; window.mutateXpathFixture = () => {
      const save = document.querySelector('[data-oracle="save"]');
      if (++mutation === 1) {
        save.id = 'save-profile-updated';
        const duplicate = save.cloneNode(true); duplicate.id = 'other-save';
        duplicate.setAttribute('data-oracle', 'other-save'); document.body.prepend(duplicate);
        const country = document.querySelector('[data-oracle="country"]');
        country.id = 'country-updated'; document.querySelector('label').htmlFor = country.id;
        const wrapper = document.createElement('div'); save.before(wrapper); wrapper.append(save);
      } else {
        const replacement = save.cloneNode(true); replacement.textContent = 'Cancel replacement';
        replacement.setAttribute('data-oracle', 'replacement'); save.replaceWith(replacement);
      }
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const label of ["Save changes", "Country"]) {
        const candidate = capture.candidates.find((entry) => entry.label === label);
        assert.ok(candidate, label);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.equal(target.xpaths.length, 1);
        paths.push(target.xpaths[0]);
      }
      assert.deepEqual((await verify(paths)).matches, [["save"], ["country"]]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
        ["save"],
        ["country"],
      ]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
        [],
        ["country"],
      ]);
    },
  );
});

test("Positional XPath is a verified last fallback when identical elements have no distinguishing context", async () => {
  await withFixture(
    `<div><span data-oracle="expected-target">Same</span><span>Same</span></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.tag === "span");
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "hover",
      });
      assert.equal(selection.target.xpaths.length, 1);
      assert.ok(selection.target.xpaths[0].startsWith("/html/"));
      assert.deepEqual((await verify(selection.target.xpaths)).matches, [["expected-target"]]);
    },
  );
});

test("Hundreds of multilingual controls retain complete capture and a verified target", async () => {
  await withFixture(
    Array.from(
      { length: 500 },
      (_, index) => `<button data-oracle="control-${index}">حالة الطقس ${index}</button>`,
    ).join(""),
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.length, 500);
      const target = capture.candidates.find((candidate) => candidate.text === "حالة الطقس 499");
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: target.id,
        action: "click",
      });
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["control-499"]),
      );
    },
  );
});

test("Incomplete captures report operating-budget errors instead of returning truncated candidates", async () => {
  for (const markup of [
    "<button>Target</button>".repeat(2001),
    "<div></div>".repeat(20001),
    `<button>${"長".repeat(65000)}</button>`,
    `<button>${"長".repeat(15000)}</button>`.repeat(6),
  ]) {
    await withFixture(markup, async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, false);
      assert.equal(capture.coverage.errorCode, "capture_budget_exceeded");
      assert.equal(capture.coverage.capturedCount, 0);
      assert.deepEqual(capture.candidates, []);
      assert.ok(capture.coverage.scannedCount > 0);
    });
  }
});

test("Superseded captures, fabricated candidates, replaced nodes and manual reloads cannot validate a result", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const capturePath = `/pages/${session.pageId}/capture`;
    const selectionPath = `/pages/${session.pageId}/selection`;
    const oldCapture = await request(capturePath, { documentId: page.documentId });
    const capture = await request(capturePath, { documentId: page.documentId });
    const candidate = capture.candidates.find((entry) => entry.tag === "button");
    const selection = {
      documentId: page.documentId,
      captureId: capture.captureId,
      candidateId: candidate.id,
      action: "click",
    };
    await expectError(
      selectionPath,
      { ...selection, captureId: oldCapture.captureId },
      409,
      "stale_capture",
    );
    await expectError(
      selectionPath,
      { ...selection, candidateId: "fabricated" },
      409,
      "unknown_candidate",
    );
    await verify([], true);
    await expectError(selectionPath, selection, 409, "stale_capture");
    await expectError(selectionPath, { ...selection, candidateId: null }, 409, "stale_capture");
    await verify([], false, true);
    let current = page;
    for (let attempt = 0; attempt < 30 && current.documentId === page.documentId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      current = await request(`/pages/${session.pageId}`, undefined, "GET");
    }
    assert.notEqual(current.documentId, page.documentId);
    await expectError(selectionPath, selection, 409, "stale_document");
    await expectError(capturePath, { documentId: page.documentId }, 409, "stale_document");
    const fresh = await request(capturePath, { documentId: current.documentId });
    assert.equal(fresh.documentId, current.documentId);
    const freshTarget = fresh.candidates.find((entry) => entry.tag === "button");
    await request(selectionPath, {
      documentId: current.documentId,
      captureId: fresh.captureId,
      candidateId: freshTarget.id,
      action: "click",
    });
    await verify([], false, "hash");
    let hashPage = current;
    for (let attempt = 0; attempt < 30 && hashPage.documentId === current.documentId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      hashPage = await request(`/pages/${session.pageId}`, undefined, "GET");
    }
    assert.notEqual(hashPage.documentId, current.documentId);
    await expectError(
      selectionPath,
      {
        documentId: hashPage.documentId,
        captureId: fresh.captureId,
        candidateId: freshTarget.id,
        action: "click",
      },
      409,
      "stale_capture",
    );
  });
});

test("Native date and time controls support passive fill and clear without typing or mutation", async () => {
  const types = [
    ["date", "2030-06-15"],
    ["month", "2030-06"],
    ["week", "2030-W24"],
    ["time", "12:30"],
    ["datetime-local", "2030-06-15T12:30"],
  ];
  const markup =
    types
      .flatMap(([type, value]) =>
        [false, true].map(
          (readonly) =>
            `<input type="${type}" aria-label="${type} ${readonly ? "readonly" : "writable"}" value="${value}" data-observe-value ${readonly ? "readonly" : ""}>`,
        ),
      )
      .join("") +
    `<script>window.observedEvents={};for(const name of ['click','input','change','focusin','keydown','keyup'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`;
  await withFixture(markup, async (session, page) => {
    const before = await observe();
    const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
    for (const [type] of types)
      for (const readonly of [false, true]) {
        const candidate = capture.candidates.find(
          (entry) => entry.label === `${type} ${readonly ? "readonly" : "writable"}`,
        );
        assert.ok(candidate);
        for (const action of ["fill", "clear", "type"]) {
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(
            target.interactability.checks.compatibleControl,
            action === "type" ? "fail" : "pass",
            `${type}: ${action}`,
          );
          assert.equal(target.interactability.checks.keyboard, "unknown");
          assert.equal(target.state.editable, !readonly);
          assert.equal(target.interactability.checks.writable, readonly ? "fail" : "pass");
          assert.equal(
            target.interactability.status,
            action === "type" || readonly ? "blocked" : "unknown",
          );
        }
      }
    const after = await observe();
    assert.deepEqual(after.values, before.values);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.activeElement, before.activeElement);
    assert.equal(after.scrollY, before.scrollY);
  });
});

for (const framed of [false, true])
  test(`Expanded action observations preserve identity, selected state and never execute (${framed ? "iframe" : "main"})`, async () => {
    const markup = `<input id="expected-target" aria-label="Notes" readonly value="PRIVATE_VALUE">
     <input type="file" aria-label="Upload document"><input type="file" hidden aria-label="Hidden upload">
     <select aria-label="Countries" multiple><option selected>PRIVATE_SELECTION</option><option selected>PRIVATE_OTHER</option></select>
     <div role="tab" tabindex="0" aria-selected="true" aria-label="Overview"></div>
     <button disabled aria-label="Disabled"><span>Inside button</span></button>
     <p id="help">Text help</p><svg><circle aria-label="Diagram node" cx="20" cy="20" r="10"/></svg>`;
    await withFixture(
      (path) =>
        framed && path === "/fixture"
          ? '<iframe title="Controls" src="/matrix" style="width:900px;height:650px"></iframe>'
          : markup,
      async (session, page) => {
        if (framed) await observe({}, "/matrix");
        const before = await observe();
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_|Hidden upload/);
        for (const [label, action, status, check, value] of [
          ["Notes", "clear", "blocked", "writable", "fail"],
          ["Notes", "press", "unknown", "keyboard", "unknown"],
          ["Overview", "focus", "unknown", "keyboard", "unknown"],
          ["Overview", "blur", "unknown", "keyboard", "unknown"],
          ["Upload document", "upload", "unknown", "compatibleControl", "pass"],
          ["Notes", "upload", "blocked", "compatibleControl", "fail"],
          ["Disabled", "double_click", "blocked", "enabled", "fail"],
          ["Disabled", "right_click", "blocked", "enabled", "fail"],
          ["Disabled", "inspect", "ready", "enabled", "not_applicable"],
          ["Text help", "hover", "ready", "enabled", "not_applicable"],
          ["Diagram node", "inspect", "ready", "enabled", "not_applicable"],
          ["Countries", "select", "unknown", "compatibleControl", "pass"],
        ]) {
          const candidate = capture.candidates.find(
            (candidate) => (candidate.label || candidate.text) === label,
          );
          assert.ok(candidate, label);
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(target.interactability.status, status, `${label}: ${action}`);
          assert.equal(target.interactability.checks[check], value);
          assert.equal(target.xpaths.length, 1);
          if (label === "Countries") assert.equal(target.state.selectedOptionCount, 2);
          if (label === "Overview") assert.equal(target.state.selected, true);
          if (label === "Diagram node") assert.match(target.xpaths[0], /local-name\(\)/);
        }
        const after = await observe();
        assert.equal(after.activeElement, before.activeElement);
        assert.equal(after.clicks, before.clicks);
        assert.equal(after.scrollY, before.scrollY);
      },
    );
  });

test("Nested frame targets retain document XPath identity and main viewport geometry", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0;height:3000px}iframe{position:absolute;left:100px;top:80px;width:600px;height:400px;border:0}</style><button>Approval</button><iframe title="Employee" src="/outer"></iframe>`
        : path === "/outer"
          ? `<style>body{margin:0}iframe{position:absolute;left:30px;top:40px;width:400px;height:240px;border:0}</style><iframe title="Payroll" src="/inner"></iframe>`
          : `<style>body{margin:0;height:1600px}button{position:absolute;left:20px;top:30px;width:120px;height:40px}</style><button id="expected-target">Approval</button>`,
    async (session, page) => {
      await observe({}, "/inner");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      assert.equal(buttons.length, 2);
      assert.ok(
        capture.candidates.every(
          (candidate) =>
            candidate.frame?.id &&
            candidate.frame.documentId &&
            Array.isArray(candidate.frame.chain),
        ),
      );
      const candidate = buttons.find((candidate) => candidate.frame?.chain.length === 2);
      assert.ok(candidate, "Nested document candidates carry their frame chain");
      assert.deepEqual(
        candidate.frame.chain.map((frame) => frame.label),
        ["Employee", "Payroll"],
      );
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.frame.id, candidate.frame.id);
      assert.deepEqual(target.xpaths, ["//button[@id='expected-target']"]);
      assert.deepEqual(target.geometry, { x: 150, y: 150, width: 120, height: 40 });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/inner")).matches, [
        ["expected-target"],
      ]);
      assert.equal((await observe({}, "/fixture")).scrollY, 0);
      assert.equal((await observe({}, "/inner")).clicks, "0");
      await withFramebuffer(session, async (frame) => {
        let blue = 0;
        for (let attempt = 0; attempt < 20 && blue < 200; attempt++) {
          const { pixels, width } = await frame();
          blue = 0;
          for (let y = 150; y < 190; y++)
            for (let x = 150; x < 270; x++) {
              const offset = (y * width + x) * 4;
              if (
                pixels[offset] > pixels[offset + 2] + 10 &&
                pixels[offset + 1] > pixels[offset + 2] + 5
              )
                blue++;
            }
          if (blue < 200) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(
          blue >= 200,
          `Expected nested target overlay at main viewport coordinates, got ${blue} blue pixels`,
        );
      });
      await observe({ scrollToY: 20 }, "/inner");
      await observe({ scrollToY: 50 }, "/fixture");
      const moved = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "hover",
      });
      assert.equal(moved.target.geometry.y, 80);
      assert.equal((await observe({}, "/inner")).scrollY, 20);
      assert.equal((await observe({}, "/fixture")).scrollY, 50);
    },
  );
});

test("Cross-origin frame clipping and ancestor obstruction remain passive and frame navigation invalidates capture", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0}#clip{position:absolute;left:100px;top:100px;width:200px;height:100px;overflow:hidden}iframe{width:400px;height:300px;border:0}#cover{position:absolute;left:100px;top:100px;width:160px;height:80px;background:black;z-index:2}</style>
        <div id="clip"><iframe title="External" src="http://${fixtureAddress}:8070/external"></iframe></div><div id="cover"></div>`
        : `<style>body{margin:0}button{position:absolute;left:20px;top:20px;width:120px;height:40px}#below{top:180px}</style><button id="expected-target">Covered child</button><button id="below">Clipped child</button>`,
    async (session, page) => {
      await observe({}, "/external");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const covered = capture.candidates.find((candidate) => candidate.label === "Covered child");
      const clipped = capture.candidates.find((candidate) => candidate.label === "Clipped child");
      assert.ok(covered);
      assert.ok(clipped);
      const body = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: covered.id,
        action: "click",
      };
      const { target } = await request(`/pages/${page.pageId}/selection`, body);
      assert.equal(target.state.inViewport, true);
      assert.equal(target.interactability.status, "blocked");
      assert.ok(target.interactability.reasons.includes("ancestor_frame_obstructed"));
      const other = await request(`/pages/${page.pageId}/selection`, {
        ...body,
        candidateId: clipped.id,
      });
      assert.equal(other.target.state.accessibilityExposed, true);
      assert.equal(other.target.state.inViewport, false);
      assert.equal(other.target.interactability.status, "blocked");
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/external")).matches, [
        ["expected-target"],
      ]);
      await observe({ reload: true }, "/external");
      await observe({}, "/external");
      await expectError(`/pages/${page.pageId}/selection`, body, 409, "stale_capture");
    },
  );
});

test("Exposed frames are captured while hidden frames and shadow contents stay excluded", async () => {
  await withFixture(
    `${targetMarkup}<iframe srcdoc="<button>FRAME_SECRET</button>"></iframe>
    <iframe hidden srcdoc="<button>HIDDEN_FRAME</button>"></iframe><div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SECRET</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.unsupportedBoundaryCount, 1);
      assert.equal(capture.frameId, "main");
      assert.equal(capture.coverage.complete, true);
      assert.ok(capture.candidates.some((candidate) => candidate.text === "FRAME_SECRET"));
      assert.doesNotMatch(JSON.stringify(capture.candidates), /HIDDEN_FRAME|SHADOW_SECRET/);
      const absence = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: null,
        action: "unsupported",
      });
      assert.equal(absence.target, null);
    },
  );
});

test("Scaled clipping and section context survive iframe boundaries while reflections stay unsupported", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<style>body{margin:0}#clip{position:absolute;left:10px;top:10px;width:200px;height:100px;overflow:hidden;transform:scale(2);transform-origin:top left}#scaled{position:absolute;left:150px;top:20px;width:40px;height:30px}</style>
      <div id="clip"><button id="scaled">Scaled target</button></div>
      <section aria-label="Employee" style="margin-top:240px"><iframe src="/employee"></iframe></section>
      <section aria-label="Customer"><iframe src="/customer"></iframe></section>
      <iframe style="scale:-1 1" src="/reflected"></iframe><div style="scale:-1 1"><iframe src="/ancestor-reflected"></iframe></div>`
        : "<button>OK</button>",
    async (session, page) => {
      await observe({}, "/customer");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const scaled = capture.candidates.find((candidate) => candidate.label === "Scaled target");
      assert.equal(scaled.state.inViewport, true);
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: scaled.id,
        action: "click",
      });
      assert.deepEqual(target.geometry, { x: 310, y: 50, width: 80, height: 60 });
      assert.equal(target.interactability.status, "ready");
      const buttons = capture.candidates.filter((candidate) => candidate.label === "OK");
      assert.equal(buttons.length, 2);
      assert.ok(buttons[0].scope.includes("Employee"));
      assert.ok(buttons[1].scope.includes("Customer"));
      assert.equal(capture.unsupportedBoundaryCount, 2);
    },
  );
});

for (const [name, ancestorStyle, position, modal, visible] of [
  ["fixed control escapes static overflow", "", "fixed", false, true],
  ["absolute control escapes static overflow", "", "absolute", false, true],
  [
    "fixed control stays clipped by transformed ancestor",
    "transform:translateX(0)",
    "fixed",
    false,
    false,
  ],
  [
    "absolute control stays clipped by positioned ancestor",
    "position:relative",
    "absolute",
    false,
    false,
  ],
  [
    "modal escapes ancestor clipping in the top layer",
    "transform:translateX(0)",
    "fixed",
    true,
    true,
  ],
]) {
  test(`Native viewport observations: ${name}`, async () => {
    await withFixture(
      `<div style="overflow:hidden;width:0;height:0;${ancestorStyle}">
        ${modal ? "<dialog>" : `<header style="position:${position};left:20px;top:20px">`}
        <button id="expected-target">Search</button>${modal ? "</dialog>" : "</header>"}</div>
      <script>${modal ? "document.querySelector('dialog').showModal();" : ""}
        const button = document.querySelector('#expected-target'); const rect = button.getBoundingClientRect();
        window.observedEvents = { receivesPointer: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button };
        for (const type of ['click', 'input', 'change']) button.addEventListener(type, () => window.observedEvents[type] = true);</script>`,
      async (session, page) => {
        const before = await observe();
        assert.equal(before.events.receivesPointer, visible);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.equal(capture.coverage.complete, true);
        const candidate = capture.candidates.find((candidate) => candidate.label === "Search");
        assert.ok(candidate);
        assert.equal(candidate.state.inViewport, visible);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        assert.equal(target.state.inViewport, visible);
        assert.equal(target.interactability.status, visible ? "ready" : "blocked");
        assert.equal(target.interactability.checks.pointerReception, visible ? "pass" : "unknown");
        assert.deepEqual(target.interactability.reasons, visible ? [] : ["off_screen"]);
        const after = await verify(target.xpaths);
        assert.deepEqual(after.matches, [["expected-target"]]);
        assert.deepEqual(after.events, before.events);
        assert.equal(after.scrollY, before.scrollY);
        assert.equal(after.activeElement, before.activeElement);
      },
    );
  });
}

test("Slow frame geometry reports explicit capture and validation budget failures", async () => {
  await withFixture(
    '<button>Save</button><iframe srcdoc="<button>Child</button>"></iframe>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Child");
      await observe({ slowFrame: true });
      await expectError(
        `/pages/${page.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        },
        409,
        "validation_budget_exceeded",
      );
      const incomplete = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(incomplete.coverage.complete, false);
      assert.equal(incomplete.coverage.errorCode, "capture_budget_exceeded");
      assert.deepEqual(incomplete.candidates, []);
    },
  );
});

test("Frame exposure, unsupported transforms and aggregate budgets preserve honest capture coverage", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div aria-hidden="true"><iframe src="/hidden" title="Hidden"></iframe></div>
        <div inert><iframe src="/inert"></iframe></div>
        <iframe src="/rotated" style="transform:rotate(15deg)"></iframe>
        <iframe src="/exposed" style="opacity:0" title="Transparent"></iframe>`
        : `<button>${path}</button>`,
    async (session, page) => {
      await observe({}, "/exposed");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.unsupportedBoundaryCount, 1);
      assert.doesNotMatch(JSON.stringify(capture.candidates), /\/hidden|\/inert|\/rotated/);
      const target = capture.candidates.find((candidate) => candidate.text === "/exposed");
      assert.equal(target.state.accessibilityExposed, true);
      assert.equal(target.state.rendered, false);
    },
  );
  await withFixture(
    (path) =>
      path === "/fixture"
        ? '<iframe src="/large-one"></iframe><iframe src="/large-two"></iframe><iframe src="/large-three"></iframe>'
        : "<button>Ordinary target</button>".repeat(750),
    async (session, page) => {
      await observe({}, "/large-three");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, false);
      assert.equal(capture.coverage.errorCode, "capture_budget_exceeded");
      assert.equal(capture.candidates.length, 0);
      assert.equal(capture.coverage.capturedCount, 0);
    },
  );
});

test("Relational scope distinguishes table rows and header/footer duplicates without values", async () => {
  await withFixture(
    '<header><button>Help</button></header><table><tr><td>Employee Alice</td><td><button>Approve</button><input value="ROW_SECRET"></td></tr><tr><td>Employee Bob</td><td><button>Approve</button></td></tr></table><footer style="margin-top:2000px"><button>Help</button></footer>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      assert.ok(buttons[0].scope.includes("header"));
      assert.ok(buttons[1].scope.some((scope) => scope.includes("Employee Alice")));
      assert.ok(buttons[2].scope.some((scope) => scope.includes("Employee Bob")));
      assert.ok(buttons[3].scope.includes("footer"));
      assert.equal(buttons[3].state.inViewport, false);
      assert.doesNotMatch(JSON.stringify(capture), /ROW_SECRET/);
    },
  );
});

test("Native input button labels are captured while editable input values remain private", async () => {
  await withFixture(
    `<input type="submit" value="Save changes" data-oracle="expected-target">
    <input type="button" value="Preview"><input type="reset" value="Clear form">
    <input type="image" alt="Submit form" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-oracle="image-submit">
    <input value="EDITABLE_SECRET"><input type="password" value="PASSWORD_SECRET">
    <input type="checkbox" value="CHECKBOX_SECRET"><input type="radio" value="RADIO_SECRET">`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const save = capture.candidates.find((candidate) => candidate.label === "Save changes");
      assert.ok(save);
      assert.equal(save.role, "button");
      const image = capture.candidates.find((candidate) => candidate.label === "Submit form");
      assert.ok(image);
      assert.equal(image.role, "button");
      assert.equal(image.state.editable, false);
      for (const label of ["Preview", "Clear form"])
        assert.ok(capture.candidates.some((candidate) => candidate.label === label));
      assert.ok(!JSON.stringify(capture).includes("SECRET"));
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: save.id,
        action: "click",
      });
      assert.ok(selection.target.xpaths[0].includes("Save changes"));
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
      const imageSelection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: image.id,
        action: "click",
      });
      assert.equal(imageSelection.target.state.editable, false);
      assert.deepEqual(
        (await verify(imageSelection.target.xpaths)).matches,
        imageSelection.target.xpaths.map(() => ["image-submit"]),
      );
    },
  );
});

test("Icon buttons and labelled images remain identifiable without visible text", async () => {
  await withFixture(
    `<button title="Download" style="width:40px;height:30px"></button>
    <img alt="Logo" width="50" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" data-oracle="expected-target">
    <div aria-label="Status" style="width:20px;height:20px"></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(
        capture.candidates.some(
          (candidate) => candidate.tag === "button" && candidate.label === "Download",
        ),
      );
      assert.ok(capture.candidates.some((candidate) => candidate.label === "Status"));
      const image = capture.candidates.find(
        (candidate) => candidate.tag === "img" && candidate.label === "Logo",
      );
      assert.ok(image);
      const selection = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: image.id,
        action: "hover",
      });
      assert.deepEqual(
        (await verify(selection.target.xpaths)).matches,
        selection.target.xpaths.map(() => ["expected-target"]),
      );
    },
  );
});

test("Simultaneous workspaces have unique sessions and closing one preserves the other", async () => {
  await withFixture(targetMarkup, async (first, firstPage) => {
    const second = await request("/sessions");
    let replacement;
    try {
      const secondPage = await request(`/pages/${second.pageId}/navigate`, {
        url: "http://resolution-fixture:8070/second",
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

test("Closing all tabs releases the session for repeated fresh captures and selections", async () => {
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
            url: "http://resolution-fixture:8070/fixture",
          });
        }
      }
    } finally {
      await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
    }
  });
});

test("Browser tabs create, activate, close and replace the last page without changing the viewer", async () => {
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

test("Native new-window links and feature popups become fullscreen tabs with their opener and shared cookies", async () => {
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
      const reused = await waitForSession(
        session.sessionId,
        (state) =>
          state.activePageId === popupId &&
          state.pages.some((entry) => entry.pageId === popupId && entry.url.endsWith("?reused=1")),
      );
      assert.equal(reused.pages.length, 3);
      assert.equal((await observe({}, "/feature-popup")).focused, true);
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

test("Only the active tab can capture or validate, and switching away invalidates its previous capture", async () => {
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
        url: "http://resolution-fixture:8070/second",
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

test("Tab limits reject extra pages and popups, and closing a tab releases capacity", async () => {
  await withFixture(targetMarkup, async (session, first) => {
    const sessionPath = `/sessions/${session.sessionId}`;
    let state;
    for (let count = 1; count < 8; count++) state = await request(`${sessionPath}/pages`);
    assert.equal(state.pages.length, 8);
    await expectError(`${sessionPath}/pages`, undefined, 409, "tab_limit");
    const activeId = state.activePageId;
    const page = await request(`/pages/${activeId}/navigate`, {
      url: "http://resolution-fixture:8070/limit",
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
