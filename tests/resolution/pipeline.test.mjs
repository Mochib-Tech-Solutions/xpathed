import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const client = "http://client-api:8080";
const fixture = "http://resolution-fixture:8090";
async function json(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(
    response.status,
    200,
    `${method} ${url}: ${response.status} ${response.status === 200 ? "" : await response.text()}`,
  );
  return response.json();
}
test("instruction resolves through client, resolver, provider and managed browser to the independent fixture node", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "found" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click on About us.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.equal(result.pageId, session.pageId);
    assert.equal(result.documentId, page.documentId);
    assert.equal(result.action, "click");
    assert.ok(result.target.xpaths.length > 0);
    assert.match(result.target.xpaths[0], /@data-testid='about-us'/);
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.target.xpaths });
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await json(`${fixture}/observation?run=${run}`);
      if (observed) break;
      await delay(50);
    }
    assert.ok(observed, "Fixture oracle must independently observe the live selected node");
    assert.deepEqual(
      observed.matches,
      result.target.xpaths.map(() => ["expected-target"]),
    );
    assert.equal(observed.clicks, 0);
    assert.equal(observed.scrollY, 0);
    assert.equal(result.diagnostics.capture.complete, true);
    assert.equal(result.diagnostics.modelInputComplete, true);
    assert.equal(result.diagnostics.modelInputCount, result.diagnostics.capture.capturedCount);
    assert.equal(result.diagnostics.costEstimate.currency, "USD");
    assert.equal(result.diagnostics.costEstimate.inputPricePerMillion, 0.0749);
    assert.equal(result.diagnostics.costEstimate.outputPricePerMillion, 0.44);
    assert.equal(result.diagnostics.costEstimate.totalCost, 0.000022235);
    assert.equal(result.diagnostics.usage.cost, null);
    const providerRequest = await json(`${fixture}/provider-request`);
    assert.equal(providerRequest.provider.max_price, undefined);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("genuine absence is a semantic not_found after full capture and current-document validation", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "absent" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click the missing Contact button.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "not_found");
    assert.equal(result.target, null);
    assert.equal(result.diagnostics.capture.complete, true);
    assert.equal(result.diagnostics.modelInputComplete, true);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("ClientApi preserves disabled click and hover assessments and scopes hidden-only absence", async () => {
  const session = await json(`${client}/api/sessions`, "POST");
  try {
    for (const [path, action, outcome, status] of [
      ["state", "click", "found", "blocked"],
      ["state", "hover", "found", "unknown"],
      ["hidden-only", "click", "not_found", null],
    ]) {
      await json(`${fixture}/scenario`, "POST", {
        name: outcome === "not_found" ? "absent" : "found",
        action,
      });
      const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
        url: `${fixture}/${path}`,
      });
      const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
        instruction: `${action} About us`,
        documentId: page.documentId,
      });
      assert.equal(result.outcome, outcome, JSON.stringify(result));
      assert.equal(result.action, action);
      if (result.target) {
        assert.equal(result.target.interactability.status, status);
        assert.equal(result.target.interactability.action, action);
        assert.equal(result.target.state.version, "2");
        assert.equal(result.diagnostics.promptVersion, "2");
        assert.ok(result.target.xpaths.length > 0);
      } else assert.match(result.diagnostics.message, /eligible current-page scope/);
      const input = JSON.stringify(await json(`${fixture}/provider-request`));
      assert.doesNotMatch(input, /HIDDEN_DUPLICATE|PRIVATE_REFERENCE_VALUE/);
    }
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("a fabricated model candidate remains an operational error through the client pipeline", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "unknown" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click About us.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "error");
    assert.equal(result.target, null);
    assert.equal(result.diagnostics.code, "provider_unknown_candidate");
    assert.equal(result.diagnostics.modelCalls, 1);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("private form values and browser secrets never reach the model while Unicode labels survive", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "found" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/privacy?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click About us.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found");
    const providerInput = JSON.stringify(await json(`${fixture}/provider-request`));
    assert.doesNotMatch(providerInput, /PRIVATE_[A-Z]+_SENTINEL/);
    assert.match(providerInput, /Prénom/);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("duplicate test attributes and both quote types still yield unique same-node XPath alternatives", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "found" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/quotes?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click About us.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found");
    assert.ok(result.target.xpaths.some((xpath) => xpath.includes("concat(")));
    assert.ok(result.target.xpaths.every((xpath) => !xpath.includes("[@data-testid='shared'][1]")));
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.target.xpaths });
    let observation;
    for (let attempt = 0; attempt < 100; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (observation) break;
      await delay(50);
    }
    assert.ok(observation);
    assert.deepEqual(
      observation.matches,
      result.target.xpaths.map(() => ["expected-target"]),
    );
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("oversized capture returns an operational error before any provider call", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "found" });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/oversized?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
      instruction: "Click About us.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "error");
    assert.equal(result.diagnostics.capture.complete, false);
    assert.equal(result.diagnostics.modelCalls, 0);
    assert.equal(await json(`${fixture}/provider-request`), null);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("fixture oracle commands and observations belong to one test run", async () => {
  const owner = randomUUID();
  const unrelated = randomUUID();
  const command = { xpaths: ["//button"] };
  await json(`${fixture}/oracle?run=${owner}`, "POST", command);
  assert.equal(await json(`${fixture}/oracle?run=${unrelated}`), null);
  assert.deepEqual(await json(`${fixture}/oracle?run=${owner}`), command);
  await json(`${fixture}/observation?run=${owner}`, "POST", { matches: [["expected-target"]] });
  assert.equal(await json(`${fixture}/observation?run=${unrelated}`), null);
});

test("ClientApi tab routes preserve active-page resolution and one stable session viewer", async () => {
  const session = await json(`${client}/api/sessions`, "POST");
  const sessionUrl = `${client}/api/sessions/${session.sessionId}`;
  const firstRun = randomUUID();
  const secondRun = randomUUID();
  async function resolveAndVerify(page, targetText, run) {
    await json(`${fixture}/scenario`, "POST", { name: "found", targetText });
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: `Click ${targetText}.`,
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found");
    assert.equal(result.sessionId, session.sessionId);
    assert.equal(result.pageId, page.pageId);
    assert.equal(result.documentId, page.documentId);
    assert.equal(result.target.label, targetText);
    assert.ok(result.target.xpaths.length > 0);
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.target.xpaths });
    let observation;
    for (let attempt = 0; attempt < 100; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (observation) break;
      await delay(50);
    }
    assert.ok(observation);
    assert.deepEqual(
      observation.matches,
      result.target.xpaths.map(() => ["expected-target"]),
    );
    assert.equal(observation.clicks, 0);
    assert.equal(observation.scrollY, 0);
  }
  try {
    const first = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture?run=${firstRun}`,
    });
    const initial = await json(sessionUrl);
    assert.equal(initial.activePageId, first.pageId);
    assert.equal(initial.viewPath, session.viewPath);
    await resolveAndVerify(first, "About us", firstRun);

    const added = await json(`${sessionUrl}/pages`, "POST");
    assert.equal(added.pages.length, 2);
    assert.notEqual(added.activePageId, first.pageId);
    assert.equal(added.viewPath, initial.viewPath);
    await json(`${fixture}/scenario`, "POST", { name: "found" });
    const inactive = await json(`${client}/api/pages/${first.pageId}/resolve`, "POST", {
      instruction: "Click About us.",
      documentId: first.documentId,
    });
    assert.equal(inactive.outcome, "error");
    assert.equal(inactive.diagnostics.code, "inactive_page");
    assert.equal(inactive.diagnostics.modelCalls, 0);
    assert.equal(await json(`${fixture}/provider-request`), null);

    const second = await json(`${client}/api/pages/${added.activePageId}/navigate`, "POST", {
      url: `${fixture}/second?run=${secondRun}`,
    });
    await resolveAndVerify(second, "Second page", secondRun);
    const switched = await json(`${client}/api/pages/${first.pageId}/activate`, "POST");
    assert.equal(switched.activePageId, first.pageId);
    assert.ok(switched.activationVersion > initial.activationVersion);
    await resolveAndVerify(first, "About us", firstRun);

    const closed = await json(`${client}/api/pages/${second.pageId}`, "DELETE");
    assert.equal(closed.activePageId, first.pageId);
    assert.deepEqual(
      closed.pages.map((page) => page.pageId),
      [first.pageId],
    );
    const replacement = await json(`${client}/api/pages/${first.pageId}`, "DELETE");
    assert.equal(replacement.pages.length, 1);
    assert.equal(replacement.pages[0].url, "about:blank");
    assert.equal(replacement.activePageId, replacement.pages[0].pageId);
    assert.notEqual(replacement.activePageId, first.pageId);
    assert.equal(replacement.viewPath, initial.viewPath);
  } finally {
    await fetch(sessionUrl, { method: "DELETE" });
  }
});
