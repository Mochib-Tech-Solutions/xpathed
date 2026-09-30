import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

const browserUrl = process.env.XPATHED_BROWSER_URL ?? "http://browser:8080";
const oracleCommands = new Map();
const oracleObservers = new Map();
const oracleScript = `<script>
    setInterval(async () => {
      const endpoint = '?page=' + encodeURIComponent(location.pathname);
      const response = await fetch('/oracle' + endpoint);
      if (response.status === 204) return;
      const { xpaths = [], replaceTarget, reload, click, open, close, cookie } = await response.json();
      if (cookie) document.cookie = cookie;
      if (click) document.querySelector(click).click();
      if (open) { const popup = window.open(open.url, open.name ?? '_blank', open.features ?? ''); if (open.focus) popup?.focus(); }
      if (replaceTarget) document.querySelector('#expected-target').outerHTML = '<button id="expected-target">Replacement</button>';
      const matches = xpaths.map(xpath => {
        const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: nodes.snapshotLength }, (_, index) => nodes.snapshotItem(index).getAttribute('data-oracle') ?? nodes.snapshotItem(index).id);
      });
      await fetch('/oracle-result' + endpoint, { method: 'POST', body: JSON.stringify({ matches, scrollY, clicks: document.querySelector('#expected-target')?.dataset.clicks ?? '0', nodeCount: document.querySelectorAll('*').length,
        cookie: document.cookie, openerPath: window.opener?.location.pathname ?? null, focused: document.hasFocus(),
        innerWidth, innerHeight, outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height }) });
      if (close) window.close();
      if (reload === 'hash') location.hash = 'changed';
      else if (reload) location.reload();
    }, 30);
  </script>`;
const targetMarkup = `<section aria-label="Employee"><h2>Employee</h2>
  <button id="expected-target" data-testid="about-us" onclick="this.dataset.clicks = '1'">About us</button>
</section>`;

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
    assert.ok(selection.target.xpaths.length > 0);
    const after = await verify(selection.target.xpaths);
    assert.deepEqual(
      after.matches,
      selection.target.xpaths.map(() => ["expected-target"]),
    );
    assert.equal(after.clicks, "0");
    assert.equal(after.scrollY, before.scrollY);
    assert.equal(after.nodeCount, before.nodeCount);
    assert.equal(selection.target.state.rendered, true);
    assert.equal(selection.target.state.enabled, true);
    assert.equal(selection.target.state.inViewport, true);
  });
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
    <div style="opacity:0"><button>Hidden three</button></div><button aria-hidden="true">Hidden four</button>
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
      assert.equal(capture.coverage.complete, true);
      assert.equal(capture.coverage.capturedCount, capture.candidates.length);
    },
  );
});

test("XPath alternatives escape both quote types and use meaningful context for duplicate attributes", async () => {
  await withFixture(
    `<section aria-label="Employee"><button data-oracle="expected-target" data-testid="shared">OK</button></section>
    <section aria-label="Other"><button data-testid="shared">OK</button></section>
    <button data-oracle="quoted-target" data-testid="He said &quot;don't&quot;">Quoted</button>`,
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
      assert.deepEqual(
        (await verify(quotedSelection.target.xpaths)).matches,
        quotedSelection.target.xpaths.map(() => ["quoted-target"]),
      );
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

test("Incomplete captures report operating-budget errors instead of returning truncated candidates", async () => {
  for (const markup of [
    "<button>Target</button>".repeat(2001),
    "<div></div>".repeat(20001),
    `<button>${"長".repeat(25000)}</button>`,
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

test("Visible frame and open shadow boundaries are reported and never enter main-document candidates", async () => {
  await withFixture(
    `${targetMarkup}<iframe srcdoc="<button>FRAME_SECRET</button>"></iframe>
    <iframe hidden srcdoc="<button>HIDDEN_FRAME</button>"></iframe><div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>SHADOW_SECRET</button>';</script>`,
    async (session, page) => {
      const capture = await request(`/pages/${session.pageId}/capture`, {
        documentId: page.documentId,
      });
      assert.equal(capture.unsupportedBoundaryCount, 2);
      assert.equal(capture.frameId, "main");
      assert.equal(capture.coverage.complete, true);
      assert.ok(!JSON.stringify(capture.candidates).includes("SECRET"));
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
          focus: true,
        },
      });
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
