import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFixtureServer } from "./server.mjs";
import { renderFixture } from "./fixtures.mjs";

test("derived fixtures escape page text and reject executable tags, attributes and URLs", () => {
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

test("controlled page content excludes the external oracle and case plan", async (t) => {
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
    body: JSON.stringify({ id: "trial-1", caseId: "basic-save" }),
  });
  assert.equal(trial.status, 200);
  const page = await fetch(`${base}/fixture?trial=trial-1`);
  const html = await page.text();
  assert.match(html, /Save changes/);
  assert.match(html, /src="\/oracle.js"/);
  assert.doesNotMatch(
    html,
    /expected-target|data-oracle|basic-save|expected|provider|oracleSentinels/,
  );
});

test("case families stay in one split and span declared evaluation risks without leaking labels", () => {
  const manifest = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
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

test("provider plans select captured labels and preserve isolated trial evidence", async (t) => {
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
  await post("/trial", { id: "first", caseId: "basic-save" });
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
  await post("/trial", { id: "second", caseId: "basic-save" });
  assert.equal(await (await fetch(base + "/provider-request?trial=second")).json(), null);
  assert.deepEqual(await (await fetch(base + "/observation?trial=first")).json(), {
    id: "observe-1",
    matches: true,
  });
});

test("provider doubles distinguish malformed output, invalid identities and upstream errors", async (t) => {
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
  for (const [fault, status] of [
    ["malformed", 200],
    ["unknown", 200],
    ["rate_limit", 429],
    ["timeout", 504],
  ]) {
    await post("/trial", { id: fault, caseId: `provider-${fault}` });
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
  }
  assert.equal((await fetch(base + "/cases.json?trial=unknown")).status, 404);
  assert.equal((await post("/trial", { id: "unknown", caseId: "basic-save" })).status, 400);
  const malformed = await fetch(base + "/trial", {
    method: "POST",
    body: '{"secret":"not-for-errors"',
  });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /not-for-errors/);
});
