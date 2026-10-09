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
    let polling = false;
    setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
      const endpoint = '?page=' + encodeURIComponent(location.pathname);
      const response = await fetch('/oracle' + endpoint);
      if (response.status === 204) return;
      const { xpaths = [], locators = [], replaceTarget, reload, click, open, focusPopup, close, cookie, scrollToY, scrollElement, slowFrame, mutateXpath, staleInput } = await response.json();
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
      if (scrollElement) document.querySelector(scrollElement.selector).scrollTop = scrollElement.y;
      if (cookie) document.cookie = cookie;
      if (click) document.querySelector(click).click();
      if (open) window.fixturePopup = window.open(open.url, open.name ?? '_blank', open.features ?? '');
      if (focusPopup) window.fixturePopup?.focus();
      if (replaceTarget) document.querySelector('#expected-target').outerHTML = '<button id="expected-target">Replacement</button>';
      const shadowMatches = locators.map(({xpath, shadowChain = [], frame}) => {
        let doc = document, root = doc;
        const resolve = expression => doc.evaluate(expression, root === doc ? doc : root.firstElementChild,
          null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const enter = chain => {
          for (const host of chain ?? []) {
            const matches = resolve(host.xpath);
            if (matches.snapshotLength !== 1) throw new Error('Shadow host must be unique');
            root = matches.snapshotItem(0).shadowRoot;
          }
        };
        for (const owner of frame?.chain ?? []) {
          enter(owner.shadowChain);
          const matches = resolve(owner.xpath);
          if (matches.snapshotLength !== 1) throw new Error('Frame owner must be unique');
          doc = root = matches.snapshotItem(0).contentDocument;
        }
        enter(shadowChain);
        const matches = resolve(xpath);
        return Array.from({length:matches.snapshotLength}, (_,index) => matches.snapshotItem(index).getAttribute('data-oracle'));
      });
      const matches = xpaths.map(xpath => {
        const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: nodes.snapshotLength }, (_, index) => nodes.snapshotItem(index).getAttribute('data-oracle') ?? nodes.snapshotItem(index).id);
      });
      const observedTarget = document.querySelector('#expected-target') ?? document.querySelector('#consent-host')?.shadowRoot?.querySelector('#expected-target');
      await fetch('/oracle-result' + endpoint, { method: 'POST', body: JSON.stringify({ matches, shadowMatches, scrollY, clicks: observedTarget?.dataset.clicks ?? '0', nodeCount: document.querySelectorAll('*').length,
        userAgent: navigator.userAgent, cookie: document.cookie, openerPath: window.opener?.location.pathname ?? null, focused: CSS.supports("selector(:-moz-window-inactive)") ? !document.documentElement.matches(":-moz-window-inactive") : document.hasFocus(),
        activeElement: document.activeElement?.id, events: window.observedEvents ?? {},
        targetMarkup: observedTarget?.outerHTML, values: [...document.querySelectorAll('[data-observe-value]')].map(element => element.value),
        checked: [...document.querySelectorAll('input[type=checkbox]')].map(element => element.checked),
        inputTypes: [...document.querySelectorAll('input')].map(element => ({declared: element.getAttribute('type'), actual: element.type})),
        innerWidth, innerHeight, outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height }) });
      if (close) window.close();
      if (reload === 'hash') location.hash = 'changed';
      else if (reload) location.reload();
      } finally { polling = false; }
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

test("session-teardown-releases-display-before-slot-reuse", { timeout: 600000 }, async () => {
  // The old forced x11vnc shutdown exhausted the default 4096 System V segments before 128 sessions.
  // Allow the slower hosted Firefox runner to finish all 128 launches and cleanups.
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
});

test("session-concurrent-close-keeps-service-healthy", async () => {
  const session = await request("/sessions");
  await Promise.all([
    request(`/sessions/${session.sessionId}`, undefined, "DELETE"),
    request(`/sessions/${session.sessionId}`, undefined, "DELETE"),
  ]);
  assert.equal((await fetch(`${browserUrl}/health`)).status, 200);
  assert.equal((await fetch(`${browserUrl}/sessions/${session.sessionId}`)).status, 404);
});

test("viewer-disconnect-completes-close-handshake-and-allows-reconnect", async () => {
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

test("targeting-descriptions-preserve-roles-and-accessible-image-names", async () => {
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

test("capture-opt-in-image-masks-private-values-across-frames-and-shadow-roots", async () => {
  await withFixture(
    `${targetMarkup}<style>input,textarea,select,[contenteditable],[data-private],[data-sensitive]{display:block;width:200px;height:30px;margin:4px;border:1px solid black}iframe{width:250px;height:80px}</style>
      <input id="focused" aria-label="Email" value="PRIVATE_FIRST" data-observe-value>
      <input type="password" value="PRIVATE_FIRST"><input type="hidden" value="PRIVATE_HIDDEN">
      <textarea>PRIVATE_FIRST</textarea><select><option>PRIVATE_FIRST</option></select>
      <div contenteditable="true">PRIVATE_FIRST<span style="position:fixed;left:400px;top:200px">PRIVATE_FIRST</span></div>
      <div data-private>PRIVATE_FIRST</div><div data-sensitive>PRIVATE_FIRST</div><div id="shadow"></div>
      <iframe title="Private form" srcdoc="<input aria-label='Secret' value='PRIVATE_FIRST'>"></iframe>
      <script>
        const root = document.querySelector('#shadow').attachShadow({mode:'open'});
        root.innerHTML = '<input aria-label="Shadow secret" value="PRIVATE_FIRST"><div contenteditable>PRIVATE_FIRST</div>';
        const update = scope => {
          for (const element of scope.querySelectorAll('input,textarea')) element.value='PRIVATE_OTHER';
          for (const element of scope.querySelectorAll('option,[contenteditable],[contenteditable] span,[data-private],[data-sensitive]')) element.textContent='PRIVATE_OTHER';
        };
        window.mutateXpathFixture = () => { update(document); update(root); update(document.querySelector('iframe').contentDocument); };
        document.querySelector('#focused').focus();
      </script>`,
    async (_session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      assert.equal(capture.image.width, before.innerWidth);
      assert.equal(capture.image.height, before.innerHeight);
      const image = Buffer.from(capture.image.png, "base64");
      assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(!JSON.stringify(capture.candidates).includes("PRIVATE_"));
      const unchanged = await observe();
      assert.equal(unchanged.activeElement, before.activeElement);
      assert.equal(unchanged.scrollY, before.scrollY);
      assert.deepEqual(unchanged.values, before.values);
      await observe({ mutateXpath: true });
      const changed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        includeImage: true,
      });
      assert.equal(
        changed.image.png,
        capture.image.png,
        "Changing only private values must not change exported pixels",
      );
      assert.ok(!JSON.stringify(changed.candidates).includes("PRIVATE_"));
      const withoutImage = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(withoutImage.image, null);
    },
  );
});

test("targeting-labels-with-comment-nodes-retain-action-targets", async () => {
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

async function request(path, body, method = "POST") {
  if (
    path === "/sessions" &&
    method === "POST" &&
    body?.browserType === undefined &&
    process.env.XPATHED_TEST_BROWSER_TYPE
  ) {
    body = { ...body, browserType: process.env.XPATHED_TEST_BROWSER_TYPE };
  }
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

async function withFixture(markup, check, sessionOptions) {
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
    session = await request("/sessions", sessionOptions);
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

async function prepareExecution(session, page, action, label) {
  const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
  const candidate = capture.candidates.find((candidate) => candidate.label === label);
  assert.ok(candidate, `Missing controlled target ${label}`);
  await request(`/pages/${page.pageId}/selections`, {
    documentId: page.documentId,
    captureId: capture.captureId,
    actions: [{ actionId: "execute-1", candidateId: candidate.id, action }],
  });
  return {
    sessionId: session.sessionId,
    documentId: page.documentId,
    captureId: capture.captureId,
    actionId: "execute-1",
  };
}

test("execution-click-is-explicit-and-consumes-the-capture", async () => {
  await withFixture(
    '<button id="expected-target" onclick="this.dataset.clicks = String(Number(this.dataset.clicks ?? 0) + 1)">Save</button>',
    async (session, page) => {
      const execution = await prepareExecution(session, page, "click", "Save");
      assert.equal((await observe()).clicks, "0");
      await expectError(
        `/pages/${page.pageId}/execute`,
        { ...execution, sessionId: "different-session" },
        409,
        "stale_session",
      );
      const result = await request(`/pages/${page.pageId}/execute`, execution);
      assert.equal(result.status, "completed");
      assert.equal((await observe()).clicks, "1");
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
      assert.equal((await observe()).clicks, "1");
    },
  );
});

test("execution-rejects-a-replaced-retained-target", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const execution = await prepareExecution(session, page, "click", "About us");
    await observe({ replaceTarget: true });
    await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
    assert.equal((await observe()).clicks, "0");
  });
});

test("execution-rechecks-readiness-and-consumes-a-failed-attempt", async () => {
  await withFixture(
    `${targetMarkup}<button id="disable" onclick="document.querySelector('#expected-target').disabled = true">Disable</button>`,
    async (session, page) => {
      const execution = await prepareExecution(session, page, "click", "About us");
      await observe({ click: "#disable" });
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "action_not_ready");
      await expectError(`/pages/${page.pageId}/execute`, execution, 409, "stale_capture");
      assert.equal((await observe()).clicks, "0");
    },
  );
});

test("execution-edits-only-the-retained-input-with-explicit-values", async () => {
  await withFixture(
    '<label>Notes<input id="expected-target" data-observe-value></label><label>Other<input data-observe-value value="untouched"></label>',
    async (session, page) => {
      for (const [action, value, expected] of [
        ["fill", "private-test-value", "private-test-value"],
        ["type", " appended", "private-test-value appended"],
        ["clear", undefined, ""],
      ]) {
        const execution = await prepareExecution(session, page, action, "Notes");
        const result = await request(`/pages/${page.pageId}/execute`, {
          ...execution,
          ...(value === undefined ? {} : { value }),
        });
        assert.equal(result.status, "completed");
        assert.ok(!JSON.stringify(result).includes("private-test-value"));
        assert.deepEqual((await observe()).values, [expected, "untouched"]);
      }
    },
  );
});

test("execution-check-and-select-use-native-controls", async () => {
  await withFixture(
    '<label>Consent<input type="checkbox"></label><label>Color<select data-observe-value><option value="red">Red</option><option value="blue">Blue</option><option value="">No color</option><option value="disabled" disabled>Unavailable</option><optgroup label="Unavailable group" disabled><option value="grouped">Grouped</option></optgroup><option value="duplicate">First duplicate</option><option value="duplicate">Second duplicate</option></select></label>',
    async (session, page) => {
      for (const [action, expected] of [
        ["check", true],
        ["uncheck", false],
      ]) {
        const execution = await prepareExecution(session, page, action, "Consent");
        assert.equal(
          (await request(`/pages/${page.pageId}/execute`, execution)).status,
          "completed",
        );
        assert.deepEqual((await observe()).checked, [expected]);
      }
      const selection = await prepareExecution(session, page, "select", "Color");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...selection, value: "blue" })).status,
        "completed",
      );
      assert.deepEqual((await observe()).values, ["blue"]);
      for (const value of ["disabled", "grouped", "duplicate"]) {
        const rejected = await prepareExecution(session, page, "select", "Color");
        await expectError(
          `/pages/${page.pageId}/execute`,
          { ...rejected, value },
          409,
          "invalid_action_value",
        );
        assert.deepEqual((await observe()).values, ["blue"]);
        await expectError(
          `/pages/${page.pageId}/execute`,
          { ...rejected, value: "red" },
          409,
          "stale_capture",
        );
      }
      const empty = await prepareExecution(session, page, "select", "Color");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...empty, value: "" })).status,
        "completed",
      );
      assert.deepEqual((await observe()).values, [""]);
    },
  );
});

test("execution-focus-press-and-blur-stay-on-the-selected-control", async () => {
  await withFixture(
    '<label>Notes<input id="expected-target" onkeydown="window.observedEvents = { key: event.key }"></label>',
    async (session, page) => {
      let execution = await prepareExecution(session, page, "focus", "Notes");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).activeElement, "expected-target");
      execution = await prepareExecution(session, page, "press", "Notes");
      assert.equal(
        (await request(`/pages/${page.pageId}/execute`, { ...execution, value: "ArrowRight" }))
          .status,
        "completed",
      );
      assert.equal((await observe()).events.key, "ArrowRight");
      execution = await prepareExecution(session, page, "blur", "Notes");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).activeElement, "");
      execution = await prepareExecution(session, page, "press", "Notes");
      await expectError(
        `/pages/${page.pageId}/execute`,
        { ...execution, value: "Control+L" },
        400,
        "invalid_action_value",
      );
    },
  );
});

test("execution-keeps-frame-and-shadow-target-identity", async () => {
  await withFixture(
    (path) =>
      path === "/child"
        ? '<button id="expected-target" onclick="this.dataset.clicks = \'1\'">Child Save</button>'
        : '<iframe src="/child" title="Child" style="width:400px;height:200px"></iframe><div id="consent-host"></div><script>document.querySelector("#consent-host").attachShadow({mode:"open"}).innerHTML = `<button id="expected-target" onclick="this.dataset.clicks = 1">Shadow Save</button>`;</script>',
    async (session, page) => {
      let execution = await prepareExecution(session, page, "click", "Child Save");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe({}, "/child")).clicks, "1");
      assert.equal((await observe()).clicks, "0");
      execution = await prepareExecution(session, page, "click", "Shadow Save");
      assert.equal((await request(`/pages/${page.pageId}/execute`, execution)).status, "completed");
      assert.equal((await observe()).clicks, "1");
    },
  );
});

test("capture-rendering-boundary-rechecks-new-private-ancestors-and-targets", async () => {
  await withFixture(
    `<button id="expected-target" aria-labelledby="private-reference">Keep me</button>
    <span id="private-reference" data-private hidden aria-label="Private marker reference"></span>
    <button style="position:absolute;top:1600px">Offscreen</button>
    <section id="private-group" aria-label="Private marker context">
      <h2>Private marker heading</h2><input placeholder="Private marker placeholder">
      <button aria-label="Private marker name">Private marker text</button>
    </section>
    <button id="private-direct" aria-label="Private marker direct">Private marker direct text</button>
    <div id="sensitive-host"></div>
    <script>
      document.querySelector('#sensitive-host').attachShadow({mode:'open'}).innerHTML = '<button aria-label="Private marker shadow">Private marker shadow text</button>';
      const NativeObserver = window.IntersectionObserver;
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) {
          super(callback, options);
          requestAnimationFrame(() => {
            document.querySelector('#private-group').setAttribute('data-private', '');
            document.querySelector('#private-direct').setAttribute('data-private', '');
            document.querySelector('#sensitive-host').setAttribute('data-sensitive', '');
          });
        }
      };
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!JSON.stringify(capture.candidates).includes("Private marker"));
      assert.deepEqual(
        capture.candidates.map((candidate) => candidate.label),
        ["Keep me"],
      );
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.eligibleCount, 2);
      assert.equal(capture.coverage.capturedCount, 1);
      assert.equal(capture.coverage.excludedOffscreenCount, 1);
      const observation = await verify(["//*[@id='private-group' and @data-private]"]);
      assert.deepEqual(observation.matches, [["private-group"]]);
      assert.equal(observation.clicks, "0");
    },
  );
});

test("targeting-private-label-references-exclude-values-and-preserve-hidden-public-names", async () => {
  await withFixture(
    `<span id="public-hidden" hidden aria-label="Hidden public name"></span>
    <div data-sensitive><span id="private-label" aria-label="Private reference name"></span></div>
    <img id="private-alt" data-private alt="Private reference image">
    <button aria-labelledby="private-label">Label fallback</button>
    <button aria-labelledby="private-alt">Image fallback</button>
    <button aria-labelledby="public-hidden">Public text</button>
    <label for="public-input" data-private aria-label="Private reference associated"></label>
    <input id="public-input" placeholder="Public input">`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!JSON.stringify(capture.candidates).includes("Private reference"));
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Label fallback", "Image fallback", "Hidden public name"],
      );
      const input = capture.candidates.find((candidate) => candidate.tag === "input");
      assert.equal(input.label, "");
      assert.equal(input.placeholder, "Public input");
    },
  );
});

test("capture-image-wait-rechecks-private-name-sources-before-returning", async () => {
  await withFixture(
    `<span id="source" hidden aria-label="Private marker screenshot"></span>
    <button aria-labelledby="source">Public fallback</button>
    <script>
      new MutationObserver(records => {
        if (records.some(record => [...record.addedNodes].some(node => node.nodeName === 'STYLE' && node.textContent.includes('data-sensitive'))))
          document.querySelector('#source').setAttribute('data-private', '');
      }).observe(document.documentElement, {childList:true});
    </script>`,
    async (session, page) => {
      const body = { documentId: page.documentId };
      const withoutImage = await request(`/pages/${page.pageId}/capture`, body);
      assert.ok(
        withoutImage.candidates.some(
          (candidate) => candidate.label === "Private marker screenshot",
        ),
      );
      await expectError(
        `/pages/${page.pageId}/capture`,
        { ...body, includeImage: true },
        409,
        "stale_capture",
      );
      const observation = await verify(["//*[@id='source' and @data-private]"]);
      assert.deepEqual(observation.matches, [["source"]]);
    },
  );
});

for (const source of [
  "frame-owner",
  "referenced-name",
  "associated-label",
  "scope-text",
  "unrelated",
  "offscreen",
]) {
  test(`frames-private-source-changed-during-child-capture-${source}`, async () => {
    const controls = {
      "frame-owner": `<button>Keep me</button><iframe id="source" src="/child" title="Child"></iframe>`,
      "referenced-name": `<span id="source" hidden aria-label="Private marker reference"></span><button aria-labelledby="source">Keep me</button>`,
      "associated-label": `<label id="source" for="public-input">Private marker associated</label><input id="public-input">`,
      "scope-text": `<section><h2 id="source">Private marker scope</h2><button>Keep me</button></section>`,
      unrelated: `<span id="source" hidden>Unrelated hidden text</span><button>Keep me</button>`,
      offscreen: `<div style="position:absolute;top:1600px"><article><h2 id="source">Offscreen first</h2><button>View</button></article><article><h2>Offscreen second</h2><button>View</button></article></div><button>Keep me</button>`,
    };
    await withFixture(
      (path) =>
        path === "/child"
          ? `<button>Child control</button><script>
            const NativeObserver = window.IntersectionObserver;
            window.IntersectionObserver = class extends NativeObserver {
              constructor(callback, options) {
                super(callback, options);
                requestAnimationFrame(() => parent.document.querySelector('#source').setAttribute('data-private', ''));
              }
            };
          </script>`
          : `${controls[source]}${source === "frame-owner" ? "" : '<iframe src="/child" title="Child"></iframe>'}`,
      async (session, page) => {
        const requestBody = { documentId: page.documentId };
        if (["unrelated", "offscreen"].includes(source)) {
          const capture = await request(`/pages/${page.pageId}/capture`, requestBody);
          assert.equal(capture.coverage.complete, true);
          assert.ok(capture.candidates.some((candidate) => candidate.label === "Keep me"));
          assert.ok(capture.candidates.some((candidate) => candidate.label === "Child control"));
        } else {
          await expectError(`/pages/${page.pageId}/capture`, requestBody, 409, "stale_capture");
        }
        const observation = await verify(["//*[@id='source' and @data-private]"]);
        assert.deepEqual(observation.matches, [["source"]]);
      },
    );
  });
}

test("capture-caches-refresh-ancestor-privacy-disabled-state-and-scope", async () => {
  await withFixture(
    `<section id="group" aria-label="Original context">
      <div id="state-host"><button id="expected-target">Save</button></div>
      <div id="private-host"><button>Private later</button></div>
    </section>
    <script>window.mutateXpathFixture = () => {
      document.querySelector('#group').setAttribute('aria-label', 'Updated context');
      document.querySelector('#state-host').setAttribute('aria-disabled', 'true');
      document.querySelector('#private-host').setAttribute('data-private', '');
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const save = capture.candidates.find((candidate) => candidate.label === "Save");
      const privateTarget = capture.candidates.find(
        (candidate) => candidate.label === "Private later",
      );
      assert.ok(save.scope.includes("Original context"));
      assert.ok(privateTarget);
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: save.id,
        action: "click",
      };
      assert.equal(
        (await request(`/pages/${page.pageId}/selection`, selection)).target.state.enabled,
        true,
      );
      await observe({ mutateXpath: true });
      const changed = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(changed.target.state.enabled, false);
      assert.ok(changed.target.interactability.reasons.includes("disabled"));
      await expectError(
        `/pages/${page.pageId}/selection`,
        { ...selection, candidateId: privateTarget.id },
        409,
        "stale_capture",
      );
      const refreshed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const current = refreshed.candidates.find((candidate) => candidate.label === "Save");
      assert.ok(current.scope.includes("Updated context"));
      assert.ok(!current.scope.includes("Original context"));
      assert.equal(current.state.enabled, false);
      assert.ok(!JSON.stringify(refreshed.candidates).includes("Private later"));
      assert.equal((await observe()).clicks, "0");
    },
  );
});

test("session-empty-creation-uses-configured-default", async () => {
  const options = await request("/sessions/options", undefined, "GET");
  const response = await fetch(`${browserUrl}/sessions`, { method: "POST" });
  assert.equal(response.status, 200);
  const session = await response.json();
  try {
    assert.equal(session.browserType, options.defaultBrowserType);
  } finally {
    await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
  }
});

test("session-selected-engine-owns-viewer-and-capture", async () => {
  await withFixture(targetMarkup, async (session, page) => {
    const expected = process.env.XPATHED_TEST_BROWSER_TYPE ?? "chromium";
    assert.equal(session.browserType, expected);
    const state = await request(`/sessions/${session.sessionId}`, undefined, "GET");
    assert.equal(state.browserType, expected);
    const observed = await observe();
    assert.match(observed.userAgent, expected === "firefox" ? /Firefox\// : /Chrome\//);
    const capture = await request(`/pages/${page.pageId}/capture`, { documentId: page.documentId });
    assert.ok(capture.candidates.some((candidate) => candidate.label === "About us"));
    await withFramebuffer(session, async (readFrame) => {
      const frame = await readFrame();
      assert.equal(frame.width, 1280);
      assert.equal(frame.height, 800);
    });
  });
});

for (const [width, height] of [
  [1024, 768],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1920, 1080],
]) {
  test(`session-resolution-${width}x${height}-matches-viewer-and-current-view`, async () => {
    const resolution = `${width}x${height}`;
    await withFixture(
      `<style>html { background: rgb(12, 34, 56); }</style>${targetMarkup}`,
      async (session, page) => {
        assert.equal(session.resolution, resolution);
        const observed = await observe();
        assert.equal(observed.innerWidth, width);
        assert.equal(observed.innerHeight, height);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          includeImage: true,
        });
        assert.ok(capture.candidates.some((candidate) => candidate.label === "About us"));
        assert.equal(capture.image.width, width);
        assert.equal(capture.image.height, height);
        await withFramebuffer(session, async (readFrame) => {
          const frame = await readFrame();
          assert.equal(frame.width, width);
          assert.equal(frame.height, height);
          assert.deepEqual([...frame.pixels.subarray(-4, -1)], [56, 34, 12]);
        });
        const next = await request(`/sessions/${session.sessionId}/pages`);
        assert.equal(next.resolution, resolution);
        await request(`/pages/${next.activePageId}/navigate`, {
          url: "http://resolution-fixture:8070/new",
        });
        const newTab = await observe({}, "/new");
        assert.equal(newTab.innerWidth, width);
        assert.equal(newTab.innerHeight, height);
      },
      { resolution },
    );
  });
}

test("scope-unrelated-carousel-replacement-preserves-a-fixed-target", async () => {
  await withFixture(
    `<button id="expected-target" style="position:fixed;top:20px;left:20px">Login</button>
    <div id="carousel" style="position:absolute;top:200px;overflow:hidden;width:200px"><img alt="Partner A" width="200" height="40"></div>
    <script>window.mutateXpathFixture = () => document.querySelector('#carousel').innerHTML='<img alt="Partner B" width="200" height="40">';</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Login");
      assert.ok(candidate);
      await observe({ mutateXpath: true });
      const selected = await request(`/pages/${session.pageId}/selections`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        actions: [{ actionId: "a1", candidateId: candidate.id, action: "click" }],
      });
      assert.deepEqual((await verify(selected.actions[0].target.xpaths)).matches, [
        ["expected-target"],
      ]);
      assert.equal(selected.actions[0].target.interactability.status, "ready");
      const after = await observe();
      assert.equal(after.clicks, before.clicks);
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
    },
  );
});

for (const visibility of ["hidden", "offscreen", "visible"]) {
  for (const mutation of ["attach", "navigate", "detach"]) {
    test(`scope-unrelated-${visibility}-frame-${mutation}-preserves-target`, async () => {
      const style =
        visibility === "hidden"
          ? "display:none"
          : visibility === "offscreen"
            ? "position:absolute;top:1800px"
            : "";
      await withFixture(
        `<button id="expected-target">Login</button>
        ${mutation === "attach" ? "" : `<iframe id="changing-frame" style="${style}" srcdoc="<p>Unrelated content</p>"></iframe>`}
        <script>window.mutateXpathFixture = () => {
          ${mutation === "attach" ? `const frame = document.createElement('iframe'); frame.id='changing-frame'; frame.style='${style}'; frame.srcdoc='<button>Login</button>'; document.body.append(frame);` : mutation === "navigate" ? `document.querySelector('#changing-frame').srcdoc='<button>Login</button>';` : `document.querySelector('#changing-frame').remove();`}
        };</script>`,
        async (session, page) => {
          const before = await observe();
          const capture = await request(`/pages/${session.pageId}/capture`, {
            documentId: page.documentId,
          });
          const candidate = capture.candidates.find((c) => c.label === "Login");
          const body = {
            documentId: page.documentId,
            captureId: capture.captureId,
            actions: [{ actionId: "a1", candidateId: candidate.id, action: "click" }],
          };
          await request(`/pages/${session.pageId}/selections`, body);
          await observe({ mutateXpath: true });
          await new Promise((resolve) => setTimeout(resolve, 100));
          const result = await request(`/pages/${session.pageId}/highlight`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            actionId: "a1",
          });
          assert.deepEqual((await verify(result.target.xpaths)).matches, [["expected-target"]]);
          assert.equal(result.target.interactability.status, "ready");
          const after = await observe();
          assert.equal(after.scrollY, before.scrollY);
          assert.equal(after.clicks, before.clicks);
          assert.equal(after.activeElement, before.activeElement);
        },
      );
    });
  }
}

test("targeting-independent-target-is-captured-and-highlighted-without-execution", async () => {
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
    assert.deepEqual(selection.target.xpaths, ["//*[@data-testid='about-us']"]);
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

test("context-repeated-cards-retain-whole-item-identity-and-child-controls", async () => {
  await withFixture(
    `<style>#catalogue{display:grid;grid-template-columns:300px 300px;gap:20px}
    .card{height:180px;border:1px solid;display:flex;flex-direction:column}
    #shirt{order:2}#backpack{order:0}#lamp{order:1}</style>
    <main aria-label="Catalogue"><div id="catalogue">
      <div class="card" id="shirt"><a href="#">Shirt</a><p>Soft cotton</p><button id="shirt-cart">Add to cart</button><input data-observe-value value="PRIVATE_CARD_VALUE"><span hidden>PRIVATE_HIDDEN_CARD_TEXT</span></div>
      <div class="card" id="backpack"><a href="#">Backpack</a><p>Travel bag</p><button>Add to cart</button><input value="PRIVATE_OTHER_VALUE"><span hidden>PRIVATE_OTHER_TEXT</span></div>
      <div class="card" id="lamp"><a href="#">Lamp</a><p>Desk light</p><button disabled>Add to cart</button><input><span hidden>Hidden</span></div>
    </div></main><script>window.mutateXpathFixture=()=>document.querySelector('#backpack').style.order='3'</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_"));
      const shirt = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Shirt Soft cotton Add to cart",
      );
      const backpack = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Backpack Travel bag Add to cart",
      );
      const lamp = capture.candidates.find(
        (c) => c.tag === "div" && c.text === "Lamp Desk light Add to cart",
      );
      assert.ok(shirt && backpack && lamp, "Plain repeated cards must be selectable");
      assert.ok(shirt.geometry.y > backpack.geometry.y);
      assert.equal(lamp.geometry.y, backpack.geometry.y);
      assert.ok(lamp.geometry.x > backpack.geometry.x);
      assert.equal(capture.candidates.filter((c) => c.tag === "button").length, 3);
      assert.equal(capture.candidates.filter((c) => c.tag === "a").length, 3);
      assert.equal(capture.candidates.filter((c) => c.tag === "input").length, 3);
      const button = capture.candidates.find((c) => c.tag === "button" && c.parentId === shirt.id);
      assert.ok(button, "Item membership must survive unnamed layout wrappers");
      for (const candidate of capture.candidates) {
        if (candidate.parentId)
          assert.ok(capture.candidates.some((c) => c.id === candidate.parentId));
      }
      for (const [candidate, expected] of [
        [shirt, "shirt"],
        [button, "shirt-cart"],
      ]) {
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        const observed = await verify(target.xpaths);
        assert.deepEqual(observed.matches, [[expected]]);
        assert.equal(observed.scrollY, before.scrollY);
        assert.equal(observed.activeElement, before.activeElement);
        assert.deepEqual(observed.values, before.values);
        assert.equal(target.interactability.status, "ready");
      }
      await observe({ mutateXpath: true });
      const retained = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: shirt.id,
        action: "click",
      });
      assert.deepEqual((await verify(retained.target.xpaths)).matches, [["shirt"]]);
    },
  );
});

test("scope-capture-retains-partial-and-blocked-targets-with-safe-layout-evidence", async () => {
  await withFixture(
    `<style>body{margin:0}button{width:100px;height:30px;background:rgb(255,0,0);color:rgb(255,255,255);border:2px solid rgb(0,0,0)}
    #partial{position:fixed;top:790px;left:10px}#edge{position:fixed;top:800px}#covered{position:absolute;top:100px;left:0}
    #overlay{position:absolute;top:100px;left:0;width:100px;height:30px;background:white;z-index:2}
    #reordered{display:flex;flex-direction:column}#above{order:0}#red{order:1}</style>
    <span id="safe-label" hidden>Named safely<input value="PRIVATE_LABEL_VALUE"></span>
    <button id="named" aria-labelledby="safe-label" disabled></button><input aria-label="Readonly notes" readonly>
    <button id="covered">Covered</button><div id="overlay"></div>
    <button id="partial">Partial</button><button id="edge">Edge only</button>
    <section aria-label="Approval list"><h2>Approval heading</h2><div id="reordered"><button id="red">Red anchor</button><button id="above" style="background:rgb(0,0,255)">Above anchor</button></div></section>
    <button hidden>Hidden target</button><button id="offscreen" style="position:absolute;top:2000px">Outside view</button>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.scope, "current_view");
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.excludedOffscreenCount, 2);
      const named = capture.candidates.find((c) => c.label === "Named safely");
      const partial = capture.candidates.find((c) => c.label === "Partial");
      const covered = capture.candidates.find((c) => c.label === "Covered");
      assert.ok(named && partial && covered);
      assert.equal(named.state.enabled, false);
      assert.ok(capture.candidates.some((c) => c.label === "Readonly notes" && c.state.readonly));
      assert.ok(!JSON.stringify(capture).includes("PRIVATE_LABEL_VALUE"));
      assert.ok(
        !capture.candidates.some((c) =>
          ["Outside view", "Edge only", "Hidden target"].includes(c.label),
        ),
      );
      const red = capture.candidates.find((c) => c.label === "Red anchor");
      const above = capture.candidates.find((c) => c.label === "Above anchor");
      assert.deepEqual(red.appearance, {
        backgroundColor: "rgb(255, 0, 0)",
        textColor: "rgb(255, 255, 255)",
        borderColor: "rgb(0, 0, 0)",
        limitations: [],
      });
      assert.equal(above.appearance.backgroundColor, "rgb(0, 0, 255)");
      assert.ok(above.geometry.y < red.geometry.y);
      assert.ok(capture.candidates.some((c) => c.text === "Approval heading"));
      for (const [candidate, reason] of [
        [named, "disabled"],
        [covered, "obstructed_at_hit_point"],
        [partial, null],
      ]) {
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        assert.equal(target.state.inViewport, true);
        if (reason) assert.ok(target.interactability.reasons.includes(reason));
        const observation = await verify(target.xpaths);
        assert.deepEqual(observation.matches, [
          [candidate === named ? "named" : candidate === covered ? "covered" : "partial"],
        ]);
        assert.equal(observation.scrollY, before.scrollY);
        assert.equal(observation.activeElement, before.activeElement);
      }
    },
  );
});

test("scope-large-lists-retain-every-visible-candidate-and-exclude-offscreen-targets", async () => {
  await withFixture(
    `<button id="expected-target">Visible approval</button><div style="position:absolute;top:2000px">${"<button>Outside approval</button>".repeat(2200)}</div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.eligibleCount, 2201);
      assert.equal(capture.coverage.excludedOffscreenCount, 2200);
      assert.equal(capture.coverage.capturedCount, 1);
      assert.equal(capture.candidates[0].label, "Visible approval");
    },
  );
  await withFixture(
    `<style>button{position:fixed;left:0;top:0}</style>${"<button>Visible approval</button>".repeat(2001)}`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.coverage.capturedCount, 2001);
      assert.equal(capture.candidates.length, 2001);
    },
  );
});

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

test("scope-scroll-change-preserves-a-visible-fixed-target", async () => {
  await withFixture(
    `<style>body{height:2400px}#expected-target{position:fixed;left:10px;top:10px}</style><button id="expected-target">Approval</button><button style="position:absolute;top:850px">Another approval</button>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      const candidate = capture.candidates.find((c) => c.label === "Approval");
      await observe({ scrollToY: 150 });
      const result = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.deepEqual((await verify(result.target.xpaths)).matches, [["expected-target"]]);
      assert.equal((await observe()).scrollY, 150);
    },
  );
});

test("scope-nested-scroll-outside-view-invalidates-selected-target", async () => {
  await withFixture(
    `<div id="list" style="height:100px;overflow:auto"><button id="expected-target">Approval</button><div style="height:150px"></div><button>Another approval</button></div>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      const candidate = capture.candidates.find((c) => c.label === "Approval");
      await observe({ scrollElement: { selector: "#list", y: 100 } });
      await expectError(
        `/pages/${page.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        },
        409,
        "stale_capture",
      );
    },
  );
});

for (const change of ["leave", "enter", "insert"])
  test(`scope-absence-retains-captured-evidence-after-${change}`, async () => {
    await withFixture(
      `<style>body{min-height:3000px}</style><button id="expected-target" style="position:absolute;top:${change === "leave" ? 10 : 2000}px">Approval</button>
      <script>window.mutateXpathFixture = () => {
        ${change === "insert" ? 'const node = document.createElement("button"); node.textContent = "New approval"; document.body.append(node);' : `document.querySelector('#expected-target').style.top = '${change === "leave" ? 2000 : 10}px';`}
      };</script>`,
      async (session, page) => {
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        assert.equal(capture.coverage.complete, true);
        assert.equal(capture.candidates.length, change === "leave" ? 1 : 0);
        const before = await observe();
        await observe({ mutateXpath: true });
        const result = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: null,
          action: "click",
        });
        assert.equal(result.target, null);
        const after = await observe();
        assert.equal(after.scrollY, before.scrollY);
        assert.equal(after.activeElement, before.activeElement);
      },
    );
  });

test("xpath-offscreen-duplicates-preserve-document-wide-uniqueness", async () => {
  await withFixture(
    `<style>body{min-height:3000px}</style>
    <section aria-label="Profile"><button id="expected-target">Save</button></section>
    <section aria-label="Other" style="position:absolute;top:2000px"><button>Save</button></section>
    <script>window.mutateXpathFixture = () => {
      const other = document.querySelector('[aria-label="Other"]');
      other.className = 'new-style'; other.append(other.firstElementChild.cloneNode(true));
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      const candidate = capture.candidates.find((c) => c.label === "Save");
      assert.equal(capture.candidates.filter((c) => c.label === "Save").length, 1);
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      };
      const { target } = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(target.state.inViewport, true);
      assert.deepEqual((await verify(target.xpaths)).matches, [["expected-target"]]);
      const after = await observe({ mutateXpath: true, xpaths: target.xpaths });
      assert.deepEqual(after.matches, [["expected-target"]]);
      assert.equal(after.scrollY, 0);
      const revalidated = await request(`/pages/${page.pageId}/selection`, selection);
      assert.equal(revalidated.target.state.inViewport, true);
    },
  );
});

for (const location of ["main", "scroll-container", "frame"])
  test(`scope-target-outside-clipped-viewport-invalidates-selection-${location}`, async () => {
    const content = `<style>body{margin:0;min-height:3000px}</style>
      ${location === "scroll-container" ? '<div style="height:80px;overflow:hidden">' : ""}
      <input id="expected-target" aria-label="Notes" style="display:block;margin-top:10px" value="UNCHANGED">
      ${location === "scroll-container" ? "</div>" : ""}
      <script>window.mutateXpathFixture = () => document.querySelector('input').style.marginTop = '2000px';</script>`;
    await withFixture(
      (path) =>
        location === "frame" && path === "/fixture"
          ? `<iframe title="Editor" src="/editor" style="height:100px"></iframe>`
          : content,
      async (session, page) => {
        const path = location === "frame" ? "/editor" : "/fixture";
        await observe({}, path);
        const capture = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        const candidate = capture.candidates.find((c) => c.label === "Notes");
        assert.ok(candidate);
        const body = {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "fill",
        };
        const { target } = await request(`/pages/${page.pageId}/selection`, body);
        assert.equal(target.state.inViewport, true);
        assert.deepEqual((await observe({ xpaths: target.xpaths }, path)).matches, [
          ["expected-target"],
        ]);
        await observe({ mutateXpath: true }, path);
        await expectError(`/pages/${page.pageId}/selection`, body, 409, "stale_capture");
        const fresh = await request(`/pages/${page.pageId}/capture`, {
          documentId: page.documentId,
          scope: "current_view",
        });
        assert.ok(!fresh.candidates.some((c) => c.label === "Notes"));
        assert.equal((await observe({}, path)).scrollY, 0);
      },
    );
  });

test("scope-target-validation-does-not-rescan-unrelated-frame-dom", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? '<iframe title="First" src="/first"></iframe><iframe title="Second" src="/second"></iframe>'
        : `<style>body{min-height:3000px}</style><button>Approval</button><div id="outside" style="position:absolute;top:2000px"></div>
         <script>window.mutateXpathFixture = () => document.querySelector('#outside').innerHTML = '<i></i>'.repeat(10500);</script>`,
    async (session, page) => {
      await observe({}, "/first");
      await observe({}, "/second");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      await observe({ mutateXpath: true }, "/first");
      const selection = {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: null,
        action: "click",
      };
      assert.equal((await request(`/pages/${page.pageId}/selection`, selection)).target, null);
      await observe({ mutateXpath: true }, "/second");
      assert.equal((await request(`/pages/${page.pageId}/selection`, selection)).target, null);
      const candidate = capture.candidates.find(
        (c) => c.frame.chain[0]?.label === "First" && c.label === "Approval",
      );
      assert.ok(candidate);
      const result = await request(`/pages/${page.pageId}/selection`, {
        ...selection,
        candidateId: candidate.id,
      });
      assert.equal(result.target.candidateId, candidate.id);
      assert.equal(result.target.interactability.status, "ready");
    },
  );
});

test("frames-offscreen-content-is-excluded-and-ancestor-appearance-limits-are-retained", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div style="opacity:.5"><iframe src="/visible-child"></iframe></div><iframe style="position:absolute;top:2000px" src="/outside-child"></iframe>`
        : `<button id="expected-target" style="background:red">${path === "/visible-child" ? "Visible child" : "OFFSCREEN_CHILD_CONTENT"}</button>`,
    async (session, page) => {
      await observe({}, "/visible-child");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.length, 1);
      assert.equal(capture.candidates[0].label, "Visible child");
      assert.equal(capture.candidates[0].appearance.backgroundColor, null);
      assert.ok(capture.candidates[0].appearance.limitations.includes("complex_effects"));
      assert.ok(!JSON.stringify(capture).includes("OFFSCREEN_CHILD_CONTENT"));
    },
  );
});

test("state-static-text-does-not-claim-enabled-control-readiness", async () => {
  await withFixture(
    `<h1><span id="expected-target">Where should we begin?</span></h1>
    <h2 id="heading">Welcome</h2><p id="paragraph">Instructions</p><div id="container">Content</div>
    <img id="image" alt="Logo" width="24" height="24"><input id="input" type="email" aria-label="Email address">
    <button id="native">Continue</button><span id="custom" role="button">Custom action</span>
    <a id="link" href="#">Help</a><span id="declared" aria-disabled="false">Declared state</span>
    <div aria-disabled="true"><span id="disabled">Disabled text</span></div>
    <script>window.observedEvents = { click: 0, focus: 0 };
    document.addEventListener('click', () => window.observedEvents.click++);
    document.addEventListener('focusin', () => window.observedEvents.focus++);</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      for (const [text, id, enabled] of [
        ["Where should we begin?", "expected-target", "not_applicable"],
        ["Welcome", "heading", "not_applicable"],
        ["Instructions", "paragraph", "not_applicable"],
        ["Content", "container", "not_applicable"],
        ["Logo", "image", "not_applicable"],
        ["Email address", "input", "pass"],
        ["Continue", "native", "pass"],
        ["Custom action", "custom", "pass"],
        ["Help", "link", "pass"],
        ["Declared state", "declared", "pass"],
        ["Disabled text", "disabled", "fail"],
      ]) {
        const candidate = capture.candidates.find((entry) => (entry.text || entry.label) === text);
        assert.ok(candidate, text);
        for (const action of ["click", "double_click", "right_click"]) {
          const { target } = await request(`/pages/${page.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action,
          });
          assert.equal(target.interactability.checks.enabled, enabled, `${id}/${action}`);
          assert.equal(target.interactability.status, enabled === "fail" ? "blocked" : "ready");
          assert.equal(target.interactability.checks.viewport, "pass");
          assert.equal(target.interactability.checks.pointerReception, "pass");
          assert.equal(target.interactability.checks.eventOutcome, "unknown");
          assert.deepEqual((await verify(target.xpaths)).matches, [[id]]);
        }
      }
      const after = await observe();
      assert.deepEqual(after.events, before.events);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.scrollY, before.scrollY);
    },
  );
});

test("state-disabled-target-has-distinct-click-and-hover-readiness", async () => {
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

test("scope-offscreen-target-requires-manual-scroll-and-recapture", async () => {
  await withFixture(
    '<style>body{height:3200px}</style><button id="expected-target" style="position:absolute;top:2200px;width:240px;height:100px">Footer gallery</button>',
    async (session, page) => {
      const initial = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.ok(!initial.candidates.some((candidate) => candidate.label === "Footer gallery"));
      assert.equal((await observe()).scrollY, 0);
      await observe({ scrollToY: 2100 });
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (candidate) => candidate.label === "Footer gallery",
      );
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual((await observe({ xpaths: target.xpaths })).matches, [["expected-target"]]);
      assert.equal((await observe()).scrollY, 2100);
    },
  );
});

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

function outlineColumns({ pixels, width }, left, top) {
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

async function expectHighlights(frame, locations, visible) {
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

async function selectHighlights(page, plural = false, scope = "current_view") {
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

async function expectSpotlightPixels(frame, samples, outlines = []) {
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
    <button>Readable target</button><button aria-label="Tiny target"></button>
    <script>const nativeMatchMedia = matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? {matches:true} : nativeMatchMedia(query);</script>`,
    async (session, page) => {
      await withFramebuffer(session, async (frame) => {
        const initial = await frame();
        const before = Buffer.from(initial.pixels);
        await selectHighlights(page, true);
        const after = await expectHighlights(frame, [[100, 100]], true);
        for (const [left, top, width, height] of [
          [100, 100, 240, 100],
          [340, 100, 8, 8],
        ]) {
          for (let y = top; y < top + height; y++) {
            const start = (y * after.width + left) * 4;
            const end = start + width * 4;
            assert.deepEqual(
              after.pixels.subarray(start, end),
              before.subarray(start, end),
              `Target row ${y} stays unchanged`,
            );
          }
        }
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

for (const crossOrigin of [false, true])
  test(`highlights-main-and-${crossOrigin ? "cross-origin" : "same-origin"}-frame-targets-clear-on-frame-input`, async () => {
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

test("scope-accessibility-exposure-preserves-visual-limits-and-safe-hidden-names", async () => {
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
      for (const name of ["Screen reader", "Zero area", "Offscreen exposed"])
        assert.ok(!capture.candidates.some((entry) => entry.text === name), name);
      for (const name of ["Visibility override", "Hidden override", "Transparent"]) {
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
        if (name === "Transparent") assert.equal(target.state.rendered, false);
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

for (const focused of [false, true])
  test(`state-native-email-keyboard-readiness-is-passive-${focused ? "focused" : "unfocused"}`, async () => {
    await withFixture(
      `<label for="expected-target">Email address</label><input id="expected-target" type="email" data-observe-value value="PRIVATE_EMAIL">
    <script>${focused ? "document.querySelector('#expected-target').focus();" : ""}window.observedEvents={};for(const name of ['input','change','focusin','focusout','keydown'])document.addEventListener(name,()=>window.observedEvents[name]=(window.observedEvents[name]??0)+1,true);</script>`,
      async (session, page) => {
        const before = await observe();
        assert.equal(before.activeElement, focused ? "expected-target" : "");
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((entry) => entry.label === "Email address");
        assert.ok(candidate);
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "type",
        });
        assert.equal(target.interactability.checks.keyboard, "pass");
        assert.equal(target.interactability.status, "ready");
        assert.equal(target.interactability.checks.eventOutcome, "unknown");
        const after = await verify(target.xpaths);
        assert.deepEqual(after.matches, [["expected-target"]]);
        assert.equal(after.activeElement, before.activeElement);
        assert.deepEqual(after.events, before.events);
        assert.deepEqual(after.values, before.values);
        assert.equal(after.scrollY, before.scrollY);
        assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_EMAIL/);
      },
    );
  });

test("state-readiness-reports-control-limitations-without-interaction", async () => {
  await withFixture(
    `<input aria-label="Readonly field" readonly value="PRIVATE_VALUE">
    <input aria-label="Disabled field" disabled><textarea aria-label="Native notes"></textarea>
    <div contenteditable aria-label="Native editor" style="height:30px"></div>
    <div role="textbox" aria-label="Custom writable editor" tabindex="0" style="height:30px"></div>
    <input type="checkbox" aria-label="Check choice"><input type="radio" aria-label="Radio choice">
    <select aria-label="Select country"><option>PRIVATE_OPTION</option></select>
    <div role="combobox" aria-label="Custom select" tabindex="0">Custom</div>
    <div role="textbox" aria-label="Custom editor" aria-readonly="true" tabindex="0" style="height:30px"></div>
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
        ["Disabled field", "type", "blocked", "disabled"],
        ["Native notes", "fill", "ready", null],
        ["Native editor", "type", "ready", null],
        ["Native editor", "clear", "ready", null],
        ["Custom writable editor", "type", "unsupported", "custom_control_unverified"],
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

test("scope-accessibility-exceptions-preserve-focus-modal-controls-and-role-fallback", async () => {
  await withFixture(
    `<div id="focused-parent"><button id="expected-target">Focused hidden exception</button></div>
    <input type="search" aria-label="Search"><div role="invalid textbox" aria-label="Role fallback" aria-readonly="true" tabindex="0" style="height:30px"></div>
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

test("targeting-native-semantics-preserve-normalized-inputs-and-descendant-names", async () => {
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
      assert.equal(target.interactability.status, "ready");
    },
  );
});

test("scope-last-opened-modal-controls-exposure-independent-of-dom-order", async () => {
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

test("robustness-capture-preserves-unicode-labels-and-state-without-form-values", async () => {
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
      assert.ok(!capture.candidates.some((candidate) => candidate.text === "Offscreen"));
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

test("locators-target-test-contracts-survive-language-tag-and-id-changes", async () => {
  const attributes = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  await withFixture(
    attributes
      .map(
        (attribute, index) =>
          `<button ${attribute}="identity-${index}" id=":r${index}:" data-oracle="target-${index}">Save ${index}</button>`,
      )
      .join("") +
      `<script>window.mutateXpathFixture = () => {
      for (const button of document.querySelectorAll('button[data-oracle]')) {
        const link = document.createElement('a');
        for (const attribute of button.attributes) link.setAttribute(attribute.name, attribute.value);
        link.id = 'changed-generated-' + button.getAttribute('data-oracle'); link.href = '#saved'; link.textContent = 'حفظ';
        const wrapper = document.createElement('span'); button.replaceWith(wrapper); wrapper.append(link);
      }
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const [index, attribute] of attributes.entries()) {
        const candidate = capture.candidates.find(
          (candidate) => candidate.label === `Save ${index}`,
        );
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual(target.xpaths, [`//*[@${attribute}='identity-${index}']`]);
        paths.push(target.xpaths[0]);
      }
      const expected = attributes.map((_, index) => [`target-${index}`]);
      assert.deepEqual((await verify(paths)).matches, expected);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
    },
  );
});

test("locators-test-scopes-survive-translation-wrappers-and-generated-ids", async () => {
  const attributes = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa"];
  await withFixture(
    attributes
      .map(
        (attribute, index) =>
          `<div ${attribute}="scope-${index}"><h2>Account ${index}</h2><button id=":r${index}:" data-oracle="target-${index}">Log in ${index}</button></div>`,
      )
      .join("") +
      `<script>window.mutateXpathFixture = () => {
      const labels = ['Se connecter', 'تسجيل الدخول', '登录', 'Anmelden', 'Iniciar sesión'];
      for (const [index, button] of [...document.querySelectorAll('button[data-oracle]')].entries()) {
        const container = button.parentElement, section = document.createElement('section');
        for (const attribute of container.attributes) section.setAttribute(attribute.name, attribute.value);
        container.replaceWith(section); section.append(...container.childNodes);
        section.querySelector('h2').textContent = labels[index]; button.textContent = labels[index];
        button.id = 'changed-generated-' + index;
        const wrapper = document.createElement('span'); button.before(wrapper); wrapper.append(button);
      }
      const distractor = document.createElement('button'); distractor.textContent = 'Log in 0'; document.body.prepend(distractor);
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const [index, attribute] of attributes.entries()) {
        const candidate = capture.candidates.find(
          (candidate) => candidate.label === `Log in ${index}`,
        );
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.deepEqual(target.xpaths, [`//*[@${attribute}='scope-${index}']//button`]);
        paths.push(target.xpaths[0]);
      }
      const expected = attributes.map((_, index) => [`target-${index}`]);
      assert.deepEqual((await verify(paths)).matches, expected);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, expected);
    },
  );
});

test("locators-test-scopes-retain-semantics-for-multiple-and-offscreen-children", async () => {
  await withFixture(
    `<div data-testid="account"><button data-oracle="save">Save</button><button>Cancel</button></div>
    <section aria-label="Employee"><div data-testid="repeated"><button data-oracle="employee">Approve</button></div></section>
    <section aria-label="Other" style="position:absolute;top:2000px"><div data-testid="repeated"><button>Approve</button></div></section>
    <script>window.mutateXpathFixture = () => {
      document.querySelector('[data-oracle="save"]').textContent = 'Delete';
    };</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const paths = [];
      for (const name of ["Save", "Approve"]) {
        const candidate = capture.candidates.find((candidate) => candidate.label === name);
        assert.ok(candidate);
        const { target } = await request(`/pages/${page.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "inspect",
        });
        assert.match(target.xpaths[0], /normalize-space/);
        if (name === "Approve") assert.match(target.xpaths[0], /Employee/);
        paths.push(target.xpaths[0]);
      }
      assert.deepEqual((await verify(paths)).matches, [["save"], ["employee"]]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [
        [],
        ["employee"],
      ]);
    },
  );
});

test("locators-namespace-collisions-preserve-same-node-and-reject-replacement", async () => {
  await withFixture(
    `<svg width="120" height="80"><g role="button" aria-label="Diagram node" data-oracle="svg-target"><rect width="100" height="60"/></g></svg>
    <script>
      const foreign = document.createElementNS('urn:fixture:other', 'g');
      foreign.setAttribute('role', 'button'); foreign.setAttribute('aria-label', 'Diagram node');
      foreign.setAttribute('data-oracle', 'foreign-target'); document.querySelector('svg').append(foreign);
      window.mutateXpathFixture = () => document.querySelector('[data-oracle="svg-target"]').remove();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find(
        (candidate) => candidate.tag === "g" && candidate.label === "Diagram node",
      );
      assert.ok(candidate);
      const { target } = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "inspect",
      });
      assert.match(target.xpaths[0], /namespace-uri\(\)/);
      assert.deepEqual((await verify(target.xpaths)).matches, [["svg-target"]]);
      assert.deepEqual((await observe({ xpaths: target.xpaths, mutateXpath: true })).matches, [[]]);
    },
  );
});

for (const scope of ["current_view"])
  test(`xpath-quotes-are-escaped-and-duplicate-attributes-use-context-${scope}`, async () => {
    await withFixture(
      `<section aria-label="Employee"><button data-oracle="expected-target" data-testid="shared">OK</button></section>
    <section aria-label="Other"><button data-testid="shared">OK</button></section>
    <button data-oracle="quoted-target" data-testid="He said &quot;don't&quot;">Quoted</button>
    <div id="app"><a href="#unique" data-oracle="unique-target">Unique gallery</a></div>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          scope,
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
        assert.deepEqual(uniqueSelection.target.xpaths, [
          "//a[normalize-space(.)='Unique gallery']",
        ]);
        assert.deepEqual((await verify(uniqueSelection.target.xpaths)).matches, [
          ["unique-target"],
        ]);
      },
    );
  });

for (const scope of ["current_view"])
  test(`locators-semantic-xpath-survives-generated-ids-wrappers-and-reordering-${scope}`, async () => {
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
          scope,
          documentId: page.documentId,
        });
        const cases = [
          ["country", (candidate) => candidate.label === "Country"],
          ["email", (candidate) => candidate.tag === "input" && candidate.placeholder === "Email"],
          [
            "alice",
            (candidate) =>
              candidate.tag === "button" &&
              candidate.scope.some((scope) => scope.includes("Alice")),
          ],
          [
            "footer",
            (candidate) => candidate.label === "Help" && candidate.scope.includes("footer"),
          ],
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

for (const scope of ["current_view"])
  test(`locators-user-facing-xpath-survives-id-changes-and-rejects-changed-meaning-${scope}`, async () => {
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
          scope,
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

test("locators-hidden-text-fragments-survive-wrappers-and-reject-added-label-text", async () => {
  await withFixture(
    `<button data-oracle="save"><span style="display:none">PRIVATE_CSS_VALUE</span>Save <em>changes</em><textarea>PRIVATE_TEXTAREA_VALUE</textarea></button>
    <script>let mutation = 0; window.mutateXpathFixture = () => {
      const target = document.querySelector('button');
      if (++mutation === 1) {
        const wrapper = document.createElement('div'); target.before(wrapper); wrapper.append(target);
        const labelWrapper = document.createElement('span');
        const label = target.childNodes[1]; label.before(labelWrapper); labelWrapper.append(label);
      } else target.append(' and delete account');
    };</script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((entry) => entry.tag === "button");
      assert.equal(candidate.label, "Save changes");
      const selection = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.doesNotMatch(JSON.stringify({ capture, selection }), /PRIVATE_/);
      assert.equal(selection.target.xpaths.length, 1);
      const paths = selection.target.xpaths;
      const initial = await verify(paths);
      assert.deepEqual(initial.matches, [["save"]]);
      assert.equal(initial.scrollY, before.scrollY);
      assert.equal(initial.activeElement, before.activeElement);
      assert.deepEqual(initial.values, before.values);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [["save"]]);
      assert.deepEqual((await observe({ xpaths: paths, mutateXpath: true })).matches, [[]]);
    },
  );
});

for (const scope of ["current_view"])
  test(`xpath-indistinguishable-elements-use-verified-positional-fallback-${scope}`, async () => {
    await withFixture(
      `<div><span data-oracle="expected-target">Same</span><span>Same</span></div>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          scope,
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

test("targeting-large-multilingual-capture-retains-complete-set-and-verified-target", async () => {
  await withFixture(
    Array.from(
      { length: 500 },
      (_, index) =>
        `<button style="position:absolute;left:${(index % 20) * 60}px;top:${Math.floor(index / 20) * 28}px;width:60px;height:28px" data-oracle="control-${index}">حالة الطقس ${index}</button>`,
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

test("scope-large-captures-have-no-candidate-scan-text-or-byte-ceiling", async () => {
  for (const [markup, count, label] of [
    [
      "<style>button{position:fixed;left:0;top:0}</style>" + "<button>Target</button>".repeat(2001),
      2001,
      "Target",
    ],
    ["<div></div>".repeat(20001) + "<button>Last target</button>", 1, "Last target"],
    [
      `<button style="position:fixed;left:0;top:0;width:100px;height:40px;overflow:hidden">${"長".repeat(65000)}</button>`,
      1,
      "長".repeat(65000),
    ],
    [
      `<button style="position:fixed;left:0;top:0;width:100px;height:40px;overflow:hidden">${"長".repeat(15000)}</button>`.repeat(
        6,
      ),
      6,
      "長".repeat(15000),
    ],
  ]) {
    await withFixture(markup, async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.coverage.capturedCount, count);
      assert.equal(capture.candidates.length, count);
      assert.ok(capture.candidates.every((candidate) => candidate.label === label));
    });
  }
});

test("scope-stale-captures-fabricated-candidates-and-replaced-nodes-are-rejected", async () => {
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
    assert.equal((await request(selectionPath, { ...selection, candidateId: null })).target, null);
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

test("state-native-date-and-time-fill-and-clear-remain-passive", async () => {
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
        const textFallback = session.browserType === "firefox" && ["month", "week"].includes(type);
        assert.ok(
          before.inputTypes.some(
            (input) => input.declared === type && input.actual === (textFallback ? "text" : type),
          ),
        );
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
            action === "type" && !textFallback ? "fail" : "pass",
            `${type}: ${action}`,
          );
          assert.equal(
            target.interactability.checks.keyboard,
            action === "type" && !textFallback ? "unknown" : "pass",
          );
          assert.equal(target.state.editable, !readonly);
          assert.equal(target.interactability.checks.writable, readonly ? "fail" : "pass");
          assert.equal(
            target.interactability.status,
            (action === "type" && !textFallback) || readonly ? "blocked" : "ready",
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
  test(`state-action-observations-preserve-identity-and-selected-state-${framed ? "iframe" : "main"}`, async () => {
    const markup = `<input id="expected-target" aria-label="Notes" readonly value="PRIVATE_VALUE">
     <input type="file" aria-label="Upload document"><input type="file" hidden aria-label="Hidden upload">
     <select aria-label="Countries" multiple><option selected>PRIVATE_SELECTION</option><option selected>PRIVATE_OTHER</option></select>
     <div role="tab" tabindex="0" aria-selected="true" aria-label="Overview" style="height:30px"></div>
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

test("frames-nested-target-retains-document-xpath-and-viewport-geometry", async () => {
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
      assert.equal(target.xpaths.length, 1);
      assert.deepEqual(target.geometry, { x: 150, y: 150, width: 120, height: 40 });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/inner")).matches, [
        ["expected-target"],
      ]);
      assert.equal((await observe({}, "/fixture")).scrollY, 0);
      assert.equal((await observe({}, "/inner")).clicks, "0");
      await withFramebuffer(session, async (frame) => {
        await expectHighlights(frame, [[150, 150]], true);
      });
      await observe({ scrollToY: 20 }, "/inner");
      await observe({ scrollToY: 50 }, "/fixture");
      const retained = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "hover",
      });
      assert.equal(retained.target.geometry.y, 80);
      assert.deepEqual((await observe({ xpaths: retained.target.xpaths }, "/inner")).matches, [
        ["expected-target"],
      ]);
      const refreshed = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const recaptured = refreshed.candidates.find(
        (entry) => entry.frame?.chain.length === 2 && entry.tag === "button",
      );
      const moved = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: refreshed.captureId,
        candidateId: recaptured.id,
        action: "hover",
      });
      assert.equal(moved.target.geometry.y, 80);
      assert.equal((await observe({}, "/inner")).scrollY, 20);
      assert.equal((await observe({}, "/fixture")).scrollY, 50);
    },
  );
});

test("frames-cross-origin-clipping-and-obstruction-are-passive-and-navigation-invalidates-capture", async () => {
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
      assert.equal(clipped, undefined);
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
      assert.deepEqual((await observe({ xpaths: target.xpaths }, "/external")).matches, [
        ["expected-target"],
      ]);
      const current = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
        scope: "current_view",
      });
      assert.equal(current.coverage.complete, true);
      assert.equal(current.coverage.excludedOffscreenCount, 1);
      assert.ok(!current.candidates.some((candidate) => candidate.label === "Clipped child"));
      const visible = current.candidates.find((candidate) => candidate.label === "Covered child");
      assert.ok(visible);
      const selected = await request(`/pages/${page.pageId}/selection`, {
        ...body,
        captureId: current.captureId,
        candidateId: visible.id,
      });
      assert.ok(selected.target.interactability.reasons.includes("ancestor_frame_obstructed"));
      assert.deepEqual((await observe({ xpaths: selected.target.xpaths }, "/external")).matches, [
        ["expected-target"],
      ]);
      await observe({ reload: true }, "/external");
      await observe({}, "/external");
      await expectError(`/pages/${page.pageId}/selection`, body, 409, "stale_capture");
    },
  );
});

test("shadow-dynamic-fixed-content-is-detected-without-a-host-box", async () => {
  await withFixture(
    `${targetMarkup}<button id="show">Show consent</button><div id="shadow"></div>
    <script>
      const host = document.querySelector('#shadow');
      const root = host.attachShadow({mode:'open'});
      document.querySelector('#show').onclick = () => {
        root.innerHTML = '<div style="position:fixed;left:20px;bottom:20px"><button data-oracle="consent">Accept all</button></div>';
        window.observedEvents = {hostHeight:host.getBoundingClientRect().height,
          buttonVisible:root.querySelector('button').getBoundingClientRect().height > 0};
      };
    </script>`,
    async (session, page) => {
      const before = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(before.unsupportedBoundaryCount, 0);
      const observation = await observe({ click: "#show" });
      assert.equal(observation.events.hostHeight, 0);
      assert.equal(observation.events.buttonVisible, true);
      const capturedAbsence = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: before.captureId,
        candidateId: null,
        action: "click",
      });
      assert.equal(capturedAbsence.target, null);
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.unsupportedBoundaryCount, 0);
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.equal(target.shadowChain.length, 1);
      assert.deepEqual(
        (
          await observe({
            locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
          })
        ).shadowMatches,
        [["consent"]],
      );
      assert.equal((await observe()).clicks, "0");
    },
  );
});

for (const [name, markup, expected] of [
  [
    "display-contents",
    '<div style="display:contents"><button data-oracle="consent">Accept all</button></div>',
    1,
  ],
  ["nested", '<div id="nested"></div>', 1],
  [
    "hidden",
    '<div hidden><button style="position:fixed;left:20px;bottom:20px">Accept all</button></div>',
    0,
  ],
  ["offscreen", '<button style="position:absolute;top:2000px">Accept all</button>', 0],
  [
    "clipped",
    '<div style="width:0;height:0;overflow:hidden"><button data-oracle="consent">Accept all</button></div>',
    0,
  ],
]) {
  test(`shadow-${name}-content-respects-current-view-boundaries`, async () => {
    await withFixture(
      `${targetMarkup}<div id="shadow" style="display:contents"></div>
      <script>
        const root = document.querySelector('#shadow').attachShadow({mode:'open'});
        root.innerHTML = ${JSON.stringify(markup)};
        const nested = root.querySelector('#nested')?.attachShadow({mode:'open'});
        if (nested) nested.innerHTML = '<button data-oracle="consent">Accept all</button>';
      </script>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        assert.equal(capture.coverage.complete, true);
        assert.equal(capture.unsupportedBoundaryCount, 0);
        const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
        assert.equal(Boolean(candidate), Boolean(expected));
        if (candidate) {
          const { target } = await request(`/pages/${session.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "click",
          });
          assert.equal(target.interactability.status, "ready");
          assert.equal(target.shadowChain.length, name === "nested" ? 2 : 1);
          assert.deepEqual(
            (
              await observe({
                locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
              })
            ).shadowMatches,
            [["consent"]],
          );
        }
      },
    );
  });
}

test("shadow-labels-slots-and-private-values-preserve-native-semantics", async () => {
  await withFixture(
    `${targetMarkup}<div id="host" aria-label="Preferences"></div>
    <div id="slot-host" role="button"><span slot="name">Slotted choice</span></div>
    <script>
      document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
        '<span id="name" hidden>Accept all</span><button aria-labelledby="name" data-oracle="consent">Wrong name</button>' +
        '<input type="password" value="PRIVATE_SHADOW_PASSWORD"><textarea>PRIVATE_SHADOW_VALUE</textarea>' +
        '<span aria-hidden="true">PRIVATE_SHADOW_HIDDEN</span>';
      document.querySelector('#slot-host').attachShadow({mode:'open'}).innerHTML = '<slot name="name"></slot>';
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.doesNotMatch(JSON.stringify(capture), /PRIVATE_SHADOW_/);
      const targetCandidate = capture.candidates.find(
        (candidate) => candidate.tag === "button" && candidate.label === "Accept all",
      );
      assert.ok(targetCandidate);
      assert.ok(targetCandidate.scope.includes("Preferences"));
      const slotted = capture.candidates.find(
        (candidate) => candidate.role === "button" && candidate.label === "Slotted choice",
      );
      assert.ok(slotted);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: slotted.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.equal(target.shadowChain, undefined);
    },
  );
});

for (const [attribute, captured, status] of [
  ['aria-hidden="true"', false, null],
  ["inert", false, null],
  ['aria-disabled="true"', true, "blocked"],
]) {
  test(`shadow-host-${attribute.split("=")[0]}-applies-to-descendants`, async () => {
    await withFixture(
      `<div id="host" ${attribute}></div><script>
      document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
        '<button style="position:fixed;left:20px;top:20px">Accept all</button>';
      </script>`,
      async (session, page) => {
        const capture = await request(`/pages/${session.pageId}/capture`, {
          documentId: page.documentId,
        });
        const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
        assert.equal(Boolean(candidate), captured);
        if (candidate) {
          const { target } = await request(`/pages/${session.pageId}/selection`, {
            documentId: page.documentId,
            captureId: capture.captureId,
            candidateId: candidate.id,
            action: "click",
          });
          assert.equal(target.interactability.status, status);
          assert.ok(target.interactability.reasons.includes("disabled"));
        }
      },
    );
  });
}

test("shadow-duplicate-labels-have-distinct-verified-host-contexts", async () => {
  await withFixture(
    `<div id="first"></div><div id="second"></div>
    <button id="replace">Replace first</button><script>
      for (const id of ['first','second']) document.getElementById(id).attachShadow({mode:'open'}).innerHTML =
        '<button data-oracle="' + id + '">Accept all</button>';
      document.querySelector('#replace').onclick = () => document.querySelector('#first').outerHTML = '<div id="first"></div>';
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidates = capture.candidates.filter((candidate) => candidate.label === "Accept all");
      assert.equal(candidates.length, 2);
      const targets = [];
      for (const candidate of candidates) {
        const { target } = await request(`/pages/${session.pageId}/selection`, {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidate.id,
          action: "click",
        });
        targets.push(target);
      }
      assert.equal(targets[0].xpaths[0], targets[1].xpaths[0]);
      assert.notDeepEqual(targets[0].shadowChain, targets[1].shadowChain);
      assert.deepEqual(
        (
          await observe({
            locators: targets.map((target) => ({
              xpath: target.xpaths[0],
              shadowChain: target.shadowChain,
            })),
          })
        ).shadowMatches,
        [["first"], ["second"]],
      );
      await observe({ click: "#replace" });
      await expectError(
        `/pages/${session.pageId}/selection`,
        {
          documentId: page.documentId,
          captureId: capture.captureId,
          candidateId: candidates[0].id,
          action: "click",
        },
        409,
        "stale_capture",
      );
    },
  );
});

test("shadow-overlay-blocks-the-inner-hit-point", async () => {
  await withFixture(
    `<div id="host"></div><div style="position:fixed;inset:0;background:white;z-index:99">Cover</div>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
      '<button style="position:fixed;left:20px;top:20px">Accept all</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "blocked");
      assert.ok(target.interactability.reasons.includes("obstructed_at_hit_point"));
    },
  );
});

test("shadow-native-modal-excludes-outside-candidates", async () => {
  await withFixture(
    `${targetMarkup}<div id="host"></div><script>
    const root=document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML='<dialog><button>Accept all</button></dialog>';
    root.querySelector('dialog').showModal();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Accept all"],
      );
    },
  );
});

test("shadow-frame-owners-and-target-roots-retain-separate-context", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? `<div id="outer-host"></div><script>document.querySelector('#outer-host').attachShadow({mode:'open'}).innerHTML =
      '<iframe title="Preferences" src="/inner" style="width:600px;height:300px"></iframe>';</script>`
        : `<div id="inner-host"></div><script>document.querySelector('#inner-host').attachShadow({mode:'open'}).innerHTML =
      '<button data-oracle="framed-consent">Accept all</button>';</script>`,
    async (session, page) => {
      await observe({}, "/inner");
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      assert.equal(candidate.frame.chain.length, 1);
      assert.equal(candidate.frame.chain[0].shadowChain.length, 1);
      assert.equal(candidate.shadowChain.length, 1);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.interactability.status, "ready");
      assert.deepEqual(
        (
          await observe({
            locators: [
              { xpath: target.xpaths[0], shadowChain: target.shadowChain, frame: target.frame },
            ],
          })
        ).shadowMatches,
        [["framed-consent"]],
      );
    },
  );
});

test("shadow-modal-exposure-survives-cleared-focus", async () => {
  await withFixture(
    `${targetMarkup}<div id="host"></div><script>
    const root=document.querySelector('#host').attachShadow({mode:'open'});
    root.innerHTML='<dialog><button>Accept all</button></dialog>';
    root.querySelector('dialog').showModal();root.querySelector('button').blur();
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.deepEqual(
        capture.candidates
          .filter((candidate) => candidate.tag === "button")
          .map((candidate) => candidate.label),
        ["Accept all"],
      );
    },
  );
});

test("shadow-large-dom-retains-visible-targets-after-a-complete-scan", async () => {
  await withFixture(
    `<div id="host"></div><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<span>Entry</span>'.repeat(20100);
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.ok(capture.coverage.scannedCount > 20100);
      assert.ok(capture.candidates.length > 0);
      assert.ok(capture.candidates.every((candidate) => candidate.text === "Entry"));
    },
  );
});

test("targeting-dynamic-light-dom-button-resolves-after-insertion", async () => {
  await withFixture(
    `<button id="show">Show consent</button><script>
    document.querySelector('#show').onclick=()=>{
      const button=document.createElement('button');button.textContent='Accept all';button.dataset.oracle='consent';
      document.body.append(button);
    };</script>`,
    async (session, page) => {
      await observe({ click: "#show" });
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      const { target } = await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      assert.equal(target.shadowChain, undefined);
      assert.deepEqual((await observe({ locators: [{ xpath: target.xpaths[0] }] })).shadowMatches, [
        ["consent"],
      ]);
    },
  );
});

test("shadow-highlights-preserve-target-pixels-and-passive-state", async () => {
  await withFixture(
    `<div id="host"></div><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML =
      '<button style="position:fixed;left:60px;top:100px;width:160px;height:80px;border:0;background:rgb(21,80,200);color:white" data-oracle="consent">Accept all</button>';
    </script>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      const candidate = capture.candidates.find((candidate) => candidate.label === "Accept all");
      assert.ok(candidate);
      await request(`/pages/${session.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      await withFramebuffer(session, async (frame) => {
        const image = await frame();
        const pixel = (x, y) => [
          ...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3),
        ];
        assert.deepEqual(pixel(70, 140), [200, 80, 21]);
        assert.ok(pixel(140, 93).every((channel) => channel < 30));
        assert.ok(pixel(140, 95).every((channel) => channel > 225));
      });
      const after = await observe();
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.clicks, before.clicks);
    },
  );
});

test("frames-exposed-frame-and-open-shadow-content-is-captured-and-hidden-content-is-excluded", async () => {
  await withFixture(
    `${targetMarkup}<iframe srcdoc="<button>FRAME_SECRET</button>"></iframe>
    <iframe hidden srcdoc="<button>HIDDEN_FRAME</button>"></iframe><div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SECRET</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.unsupportedBoundaryCount, 0);
      assert.equal(capture.frameId, "main");
      assert.equal(capture.coverage.complete, true);
      assert.ok(capture.candidates.some((candidate) => candidate.text === "FRAME_SECRET"));
      assert.doesNotMatch(JSON.stringify(capture.candidates), /HIDDEN_FRAME/);
      assert.ok(capture.candidates.some((candidate) => candidate.label === "SHADOW_SECRET"));
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

test("frames-scaled-clipping-preserves-section-context-and-reflections-are-unsupported", async () => {
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
  test(`scope-native-viewport-observation-${name}`, async () => {
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
        assert.equal(Boolean(candidate), visible);
        if (!visible) {
          assert.deepEqual((await observe()).events, before.events);
          return;
        }
        assert.equal(candidate.state.inViewport, true);
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

test("frames-slow-capture-completes-while-target-validation-keeps-its-budget", async () => {
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
      const complete = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(complete.coverage.complete, true);
      assert.equal(complete.coverage.errorCode, null);
      assert.ok(complete.candidates.some((candidate) => candidate.label === "Child"));
    },
  );
});

test("frames-exposure-and-transforms-preserve-complete-large-captures", async () => {
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
        : '<button style="position:fixed;left:0;top:0">Ordinary target</button>'.repeat(750),
    async (session, page) => {
      await observe({}, "/large-three");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.errorCode, null);
      assert.equal(capture.candidates.length, 2250);
      assert.equal(capture.coverage.capturedCount, 2250);
    },
  );
});

test("frames-capture-retains-visible-targets-beyond-64-documents", async () => {
  await withFixture(
    (path) =>
      path === "/fixture"
        ? Array.from(
            { length: 65 },
            (_, index) =>
              `<iframe style="position:fixed;left:0;top:0;width:100px;height:50px" src="/frame-${index + 1}"></iframe>`,
          ).join("")
        : `<style>body{margin:0}</style><button data-oracle="frame-target">${path.slice(1)}</button>`,
    async (session, page) => {
      await observe({}, "/frame-65");
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.candidates.filter((candidate) => candidate.tag === "button").length, 65);
      const candidate = capture.candidates.find((candidate) => candidate.label === "frame-65");
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      const target = selected.target;
      const observed = await observe({
        locators: [{ xpath: target.xpaths[0], frame: target.frame }],
      });
      assert.deepEqual(observed.shadowMatches, [["frame-target"]]);
      assert.equal(target.interactability.status, "ready");
      assert.equal(observed.scrollY, 0);
    },
  );
});

test("shadow-capture-retains-targets-beyond-63-hosts", async () => {
  await withFixture(
    `<div id="host"></div><script>
    let host=document.querySelector('#host');
    for(let index=0;index<65;index++) {
      const root=host.attachShadow({mode:'open'});
      if(index===64) root.innerHTML='<button data-oracle="deep-target">Deep target</button>';
      else { root.innerHTML='<div></div>';host=root.firstElementChild; }
    }
    </script>`,
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true);
      const candidate = capture.candidates.find((candidate) => candidate.label === "Deep target");
      assert.equal(candidate.shadowChain.length, 65);
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: candidate.id,
        action: "click",
      });
      const target = selected.target;
      const observed = await observe({
        locators: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
      });
      assert.deepEqual(observed.shadowMatches, [["deep-target"]]);
      assert.equal(target.interactability.status, "ready");
      assert.equal(observed.scrollY, 0);
    },
  );
});

test("context-nested-layout-tables-retain-own-row-without-repeating-the-page", async () => {
  const rows = Array.from({ length: 24 }, (_, index) => {
    const title = `Story ${index + 1} about browser testing`;
    return `<tr><td>${title}</td><td>${Array.from({ length: 6 }, (_, link) => `<a href="#story-${index}-${link}">Discussion link number ${link + 1}</a>`).join(" ")}</td></tr>`;
  }).join("");
  await withFixture(
    `<style>table{font:10px Arial;white-space:nowrap}</style>
    <section aria-label="News"><table><tr><td><table><tr><td><a id="expected-target" href="#new">new</a></td></tr></table></td></tr>
    <tr><td><table>${rows}</table></td></tr></table></section>`,
    async (session, page) => {
      const before = await observe();
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.coverage.complete, true, JSON.stringify(capture.coverage));
      const links = capture.candidates.filter((candidate) => candidate.tag === "a");
      assert.equal(links.length, 145);
      for (const link of links) {
        assert.ok(link.scope.includes("News"));
        assert.ok(
          !link.scope.some(
            (context) => context.includes("Story 1 about") && context.includes("Story 2 about"),
          ),
        );
      }
      const discussion = links.find((candidate) => candidate.label === "Discussion link number 1");
      assert.ok(
        discussion.scope.some((context) => context.includes("Story 1 about browser testing")),
      );
      const target = links.find((candidate) => candidate.label === "new");
      const selected = await request(`/pages/${page.pageId}/selection`, {
        documentId: page.documentId,
        captureId: capture.captureId,
        candidateId: target.id,
        action: "click",
      });
      const after = await verify(selected.target.xpaths);
      assert.deepEqual(after.matches, [["expected-target"]]);
      assert.equal(selected.target.interactability.status, "ready");
      assert.equal(after.scrollY, before.scrollY);
      assert.equal(after.activeElement, before.activeElement);
      assert.equal(after.clicks, "0");
    },
  );
});

test("context-table-rows-and-header-footer-scopes-distinguish-duplicates", async () => {
  await withFixture(
    '<header><button>Help</button></header><table><tr><td>Employee Alice</td><td><button>Approve</button><input value="ROW_SECRET"></td></tr><tr><td>Employee Bob</td><td><button>Approve</button></td></tr></table><footer><button>Help</button></footer>',
    async (session, page) => {
      const capture = await request(`/pages/${page.pageId}/capture`, {
        documentId: page.documentId,
      });
      const buttons = capture.candidates.filter((candidate) => candidate.tag === "button");
      assert.ok(buttons[0].scope.includes("header"));
      assert.ok(buttons[1].scope.some((scope) => scope.includes("Employee Alice")));
      assert.ok(buttons[2].scope.some((scope) => scope.includes("Employee Bob")));
      assert.ok(buttons[3].scope.includes("footer"));
      assert.equal(buttons[3].state.inViewport, true);
      assert.doesNotMatch(JSON.stringify(capture), /ROW_SECRET/);
    },
  );
});

test("robustness-input-button-labels-are-captured-without-editable-values", async () => {
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

test("targeting-icon-buttons-and-labelled-images-are-found-without-visible-text", async () => {
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

test("session-concurrent-workspaces-remain-isolated-after-one-closes", async () => {
  await withFixture(targetMarkup, async (first, firstPage) => {
    const second = await request("/sessions", {
      browserType: first.browserType === "chromium" ? "firefox" : "chromium",
    });
    assert.notEqual(second.browserType, first.browserType);
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

test("session-close-all-tabs-allows-fresh-captures-and-selections", async () => {
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
      // Firefox can decline page-script focus; routing must follow the actual native window.
      if (session.browserType === "chromium")
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

test("tabs-limits-reject-excess-pages-and-closing-restores-capacity", async () => {
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
