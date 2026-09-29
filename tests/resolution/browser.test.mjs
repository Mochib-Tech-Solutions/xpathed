import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

const browserUrl = process.env.XPATHED_BROWSER_URL ?? "http://browser:8080";
let oracleCommand;
let completeOracle;
const oracleScript = `<script>
    setInterval(async () => {
      const response = await fetch('/oracle');
      if (response.status === 204) return;
      const { xpaths, replaceTarget, reload } = await response.json();
      if (replaceTarget) document.querySelector('#expected-target').outerHTML = '<button id="expected-target">Replacement</button>';
      const matches = xpaths.map(xpath => {
        const nodes = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return Array.from({ length: nodes.snapshotLength }, (_, index) => nodes.snapshotItem(index).getAttribute('data-oracle') ?? nodes.snapshotItem(index).id);
      });
      await fetch('/oracle-result', { method: 'POST', body: JSON.stringify({ matches, scrollY, clicks: document.querySelector('#expected-target')?.dataset.clicks ?? '0', nodeCount: document.querySelectorAll('*').length }) });
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

async function verify(xpaths, replaceTarget = false, reload = false) {
  oracleCommand = { xpaths, replaceTarget, reload };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Fixture oracle did not respond")), 5000);
    completeOracle = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };
  });
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
  const server = createServer(async (request, response) => {
    if (request.url === "/oracle") {
      response.writeHead(oracleCommand ? 200 : 204, { "Content-Type": "application/json" });
      response.end(oracleCommand ? JSON.stringify(oracleCommand) : "");
      oracleCommand = undefined;
      return;
    }
    if (request.url === "/oracle-result") {
      let body = "";
      for await (const chunk of request) body += chunk;
      completeOracle?.(JSON.parse(body));
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body>${markup}${oracleScript}</body></html>`);
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
