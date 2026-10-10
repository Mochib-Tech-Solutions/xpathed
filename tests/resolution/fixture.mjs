import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { networkInterfaces } from "node:os";

export const browserUrl = process.env.XPATHED_BROWSER_URL ?? "http://browser:8080";

export const resolverUrl = process.env.XPATHED_RESOLVER_URL ?? "http://resolver:8080";

export const serviceUrl = (path) => (/\/selections?$/u.test(path) ? resolverUrl : browserUrl);

export const fixturePort = Number(process.env.XPATHED_ORACLE_PORT ?? "8070");

export const fixtureUrl = process.env.XPATHED_ORACLE_URL ?? "http://resolution-fixture:8070";

export const fixtureAddress =
  process.env.XPATHED_CROSS_ORIGIN_HOST ??
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address.family === "IPv4" && !address.internal)?.address;

export const oracleCommands = new Map();

export const oracleObservers = new Map();

export const oracleScript = `<script>
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
        userAgent: navigator.userAgent, cookie: document.cookie, openerPath: window.opener?.location.pathname ?? null, focused: document.hasFocus(),
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

export const targetMarkup = `<section aria-label="Employee"><h2>Employee</h2>
  <button id="expected-target" data-testid="about-us" onclick="this.dataset.clicks = '1'">About us</button>
</section>`;

export async function waitForObservation(matches, path = "/fixture") {
  let last;
  for (let attempt = 0; attempt < 100; attempt++) {
    last = await observe({}, path);
    if (matches(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Page effect did not settle: ${JSON.stringify(last)}`);
}

export async function request(path, body, method = "POST") {
  const response = await fetch(`${serviceUrl(path)}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((cause) => {
    throw new Error(`${method} ${path} failed`, { cause });
  });
  assert.equal(response.ok, true, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? undefined : response.json();
}

export async function observe(command = {}, pagePath = "/fixture") {
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

export function verify(xpaths, replaceTarget = false, reload = false) {
  return observe({ xpaths, replaceTarget, reload });
}

export async function waitForSession(sessionId, expected) {
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = await request(`/sessions/${sessionId}`, undefined, "GET");
    if (expected(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Session state did not settle: ${JSON.stringify(state)}`);
}

export async function expectError(path, body, status, code) {
  const response = await fetch(`${serviceUrl(path)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
}

export async function withFixture(markup, check, sessionOptions) {
  oracleCommands.clear();
  oracleObservers.clear();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, fixtureUrl);
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
  server.listen(fixturePort, process.env.XPATHED_FIXTURE_HOST ?? "0.0.0.0");
  await once(server, "listening");
  let session;
  try {
    session = await request("/sessions", sessionOptions);
    const page = await request(`/pages/${session.pageId}/navigate`, {
      url: `${fixtureUrl}/fixture`,
    });
    await check(session, page);
  } finally {
    try {
      if (session) await request(`/sessions/${session.sessionId}`, undefined, "DELETE");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

export async function prepareExecution(session, page, action, label) {
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
