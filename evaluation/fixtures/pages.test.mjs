import { loadCases } from "../cases/load.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFixtureServer } from "./server.mjs";
import { renderFixture } from "./pages.mjs";
import { validateCases } from "../run.mjs";

test("fixtures-reviewed-cases-preserve-family-boundaries-without-oracle-instructions", () => {
  const suite = loadCases(new URL("../cases/index.json", import.meta.url));
  const cases = validateCases(suite);
  const exposed = cases.filter((c) => c.previousSplit === "held-out");
  assert.ok(new Set(exposed.map((c) => c.family)).size >= 10);
  assert.ok(
    exposed.some((c) => c.expected.actions.filter((a) => a.outcome === "found").length > 1),
  );
  for (const spec of exposed) {
    assert.equal(spec.split, "regression");
    assert.ok(spec.exposureRunId);
    assert.ok(Number.isFinite(Date.parse(spec.exposedAt)));
  }
  for (const spec of cases) {
    assert.equal(spec.review.status, "reviewed");
    const html = renderFixture(spec.fixture, "fixture-test");
    assert.ok(html.startsWith("<!doctype html>"));
    for (const sentinel of spec.oracleSentinels ?? []) assert.ok(!html.includes(sentinel));
  }
});

test("fixtures-derived-pages-escape-text-and-reject-executable-content", () => {
  const fixture = {
    kind: "derived-static-dom",
    tree: { tag: "a", attributes: { href: "#" }, text: '<script>alert("secret")</script>' },
  };
  const html = renderFixture(fixture, "trial");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.throws(
    () => renderFixture({ ...fixture, tree: { tag: "script", text: "alert(1)" } }, "trial"),
    /Unsafe/,
  );
  assert.throws(
    () =>
      renderFixture(
        { ...fixture, tree: { tag: "a", attributes: { href: "https://example.test" } } },
        "trial",
      ),
    /Unsafe/,
  );
  assert.throws(
    () =>
      renderFixture(
        { ...fixture, tree: { tag: "button", attributes: { onclick: "alert(1)" } } },
        "trial",
      ),
    /Unsafe/,
  );
});

test("fixtures-case-names-and-mutation-identities-preserve-the-reviewed-meaning", () => {
  const cases = loadCases().cases;
  const mutations = new Map();
  for (const spec of cases) {
    if (spec.id.endsWith("-is-ready"))
      assert.ok(
        spec.expected.actions.every((action) => action.interactability?.status === "ready"),
        spec.id,
      );
    if (!spec.mutation) continue;
    const key = JSON.stringify({
      fixture: spec.fixture,
      instruction: spec.instruction,
      viewport: spec.viewport,
      setup: spec.setup,
      kind: spec.mutation.kind,
      target: spec.mutation.target,
    });
    assert.equal(
      mutations.has(key),
      false,
      `Duplicate mutation: ${spec.id} and ${mutations.get(key)}`,
    );
    mutations.set(key, spec.id);
  }
  for (const kind of [
    "wrapper-insertion",
    "sibling-insertion",
    "class-change",
    "id-change",
    "duplicate-insertion",
    "rerender",
  ]) {
    const former = `locators-${kind}-preserves-target-identity`;
    const matches = cases.filter((spec) => spec.sourceIds?.includes(former));
    assert.equal(matches.length, 1, former);
    assert.equal(matches[0].expected.actions[0].state.inViewport, true);
    assert.equal(matches[0].mutation.afterExpected.actions[0].state.inViewport, true);
  }
});

test("fixtures-page-content-excludes-oracle-labels-and-case-plan", async (t) => {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const trial = await fetch(`${base}/trial`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "trial-1", caseId: "targeting-save-button-by-name" }),
  });
  assert.equal(trial.status, 200);
  const page = await fetch(`${base}/fixture?trial=trial-1`);
  const html = await page.text();
  assert.match(html, /Save changes/);
  assert.match(html, /src="\/oracle.js"/);
  assert.doesNotMatch(
    html,
    /expected-target|data-oracle|targeting-save-button-by-name|expected|provider|oracleSentinels/,
  );
});

test("fixtures-cases-preserve-splits-and-behavior-coverage-without-label-leakage", () => {
  const manifest = loadCases(new URL("../cases/index.json", import.meta.url));
  assert.equal(manifest.version, "1");
  const families = new Map();
  const ids = new Set();
  for (const entry of manifest.cases) {
    assert.ok(!ids.has(entry.id), `Duplicate case ${entry.id}`);
    ids.add(entry.id);
    assert.ok(["development", "regression"].includes(entry.split));
    if (families.has(entry.family)) assert.equal(entry.split, families.get(entry.family));
    families.set(entry.family, entry.split);
    assert.deepEqual(entry.viewport, { width: 1280, height: 800, tolerance: 1 });
    assert.equal(entry.review.status, "reviewed");
    assert.ok(entry.review.reviewer);
    assert.ok(Number.isFinite(Date.parse(entry.review.reviewedAt)));
    const html = renderFixture(entry.fixture, "private-trial");
    assert.doesNotMatch(html, /data-oracle|expected-target|oracleSentinels|reviewedBy/);
    for (const sentinel of entry.oracleSentinels ?? []) assert.ok(!html.includes(sentinel));
    assert.ok(Array.isArray(entry.expected.actions));
  }
  for (const category of [
    "language",
    "context",
    "semantics",
    "state",
    "geometry",
    "locator",
    "absence",
    "size",
    "trust",
    "provider-failure",
    "integration",
  ])
    assert.ok(
      manifest.cases.some((entry) => entry.category === category),
      `Missing ${category}`,
    );
  assert.deepEqual(
    new Set(manifest.cases.flatMap((entry) => (entry.mutation ? [entry.mutation.kind] : []))),
    new Set([
      "wrapper",
      "sibling",
      "class",
      "id",
      "duplicate",
      "rerender",
      "remove",
      "replacement",
    ]),
  );
});

test("provider-controlled-selection-preserves-labels-and-trial-isolation", async (t) => {
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  await post("/trial", { id: "first", caseId: "targeting-save-button-by-name" });
  const input = {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          candidates: [
            { id: "c9", label: "Cancel", tag: "button" },
            { id: "c2", label: "Save changes", tag: "button" },
          ],
        }),
      },
    ],
  };
  const result = await (await post("/api/v1/chat/completions", input)).json();
  assert.equal(JSON.parse(result.choices[0].message.content).actions[0].candidateId, "c2");
  assert.deepEqual(await (await fetch(base + "/provider-request?trial=first")).json(), input);
  await post("/command?trial=first", { id: "observe-1", kind: "observe" });
  assert.deepEqual(await (await fetch(base + "/command?trial=first")).json(), {
    id: "observe-1",
    kind: "observe",
  });
  assert.equal(await (await fetch(base + "/command?trial=first")).json(), null);
  await post("/observation?trial=first", { id: "observe-1", matches: true });
  await post("/trial", { id: "second", caseId: "targeting-save-button-by-name" });
  assert.equal(await (await fetch(base + "/provider-request?trial=second")).json(), null);
  assert.deepEqual(await (await fetch(base + "/observation?trial=first")).json(), {
    id: "observe-1",
    matches: true,
  });
});

test("provider-controlled-failures-preserve-distinct-response-outcomes", async (t) => {
  const baseline = loadCases(new URL("../cases/index.json", import.meta.url));
  const providerCaseId = (fault) => baseline.cases.find((c) => c.provider?.fault === fault).id;
  const extra = ["refusal", "empty", "truncated", "missing_usage"].map((fault) => ({
    ...baseline.cases.find((c) => c.id === "targeting-save-button-by-name"),
    id: providerCaseId(fault),
    provider: {
      ...baseline.cases.find((c) => c.id === "targeting-save-button-by-name").provider,
      fault,
    },
  }));
  const server = createFixtureServer({ cases: [...baseline.cases, ...extra] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const [fault, status] of [
    ["malformed", 200],
    ["unknown", 200],
    ["rate_limit", 429],
    ["timeout", 504],
    ["refusal", 200],
    ["empty", 200],
    ["truncated", 200],
    ["missing_usage", 200],
  ]) {
    await post("/trial", { id: fault, caseId: providerCaseId(fault) });
    const response = await post("/api/v1/chat/completions", {
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            candidates: [{ id: "candidate-1", label: "Save changes", tag: "button" }],
          }),
        },
      ],
    });
    assert.equal(response.status, status);
    const result = await response.json();
    if (fault === "malformed") assert.throws(() => JSON.parse(result.choices[0].message.content));
    if (fault === "unknown")
      assert.equal(
        JSON.parse(result.choices[0].message.content).actions[0].candidateId,
        "unknown-candidate",
      );
    if (fault === "refusal") assert.equal(result.choices[0].message.refusal, "Controlled refusal");
    if (fault === "empty") assert.equal(result.choices[0].message.content, "");
    if (fault === "truncated") assert.equal(result.choices[0].finish_reason, "length");
    if (fault === "missing_usage") assert.equal(result.usage, undefined);
  }
  assert.equal((await fetch(base + "/cases.json?trial=unknown")).status, 404);
  assert.equal(
    (await post("/trial", { id: "unknown", caseId: "targeting-save-button-by-name" })).status,
    400,
  );
  const malformed = await fetch(base + "/trial", {
    method: "POST",
    body: '{"secret":"not-for-errors"',
  });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /not-for-errors/);
});

test("selection-default-suite-covers-reviewed-current-view-behaviors", async () => {
  const suite = loadCases(new URL("../cases/index.json", import.meta.url));
  const cases = suite.cases.filter((entry) => true);
  for (const fixture of ["viewport-clipped", "viewport-plural", "offscreen", "appearance-color"])
    assert.ok(
      cases.some((entry) => entry.fixture === fixture),
      `Missing current-view ${fixture}`,
    );
  for (const entry of cases) assert.equal(entry.review.status, "reviewed");
});

test("provider-concurrent-calls-preserve-trace-ownership-for-fresh-mutations", async (t) => {
  const cases = loadCases(new URL("../cases/index.json", import.meta.url)).cases;
  const server = createFixtureServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const traceA = "a".repeat(32),
    traceB = "b".repeat(32);
  assert.equal(
    (
      await post("/trial", {
        id: "first",
        caseId: "targeting-save-button-by-name",
        traceId: traceA,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("/trial", {
        id: "second",
        caseId: "robustness-provider-rate-limit-is-error",
        traceId: traceB,
      })
    ).status,
    200,
  );
  assert.equal(
    (await post("/trial", { id: "duplicate", caseId: cases[0].id, traceId: traceA })).status,
    400,
  );
  const input = {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          candidates: [{ id: "c1", label: "Save changes", tag: "button" }],
        }),
      },
    ],
  };
  const call = (trace) =>
    post("/api/v1/chat/completions", input, { traceparent: `00-${trace}-0123456789abcdef-01` });
  const results = await Promise.all([call(traceA), call(traceB), call(traceA)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 429, 200],
  );
  for (const response of [results[0], results[2]]) {
    const result = await response.json();
    assert.equal(result.id, "deterministic-first");
    assert.equal(JSON.parse(result.choices[0].message.content).actions[0].candidateId, "c1");
  }
  assert.equal((await call("c".repeat(32))).status, 409);
  assert.equal((await post("/api/v1/chat/completions", input)).status, 409);
  assert.deepEqual(await (await fetch(base + "/provider-request?trial=first")).json(), input);
  assert.deepEqual(await (await fetch(base + "/provider-request?trial=second")).json(), input);
});
