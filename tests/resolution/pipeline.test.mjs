import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const client = "http://client-api:8080";
const fixture = "http://resolution-fixture:8090";

for (const [mutation, expected, readiness] of [
  ["carousel", "found", "ready"],
  ["carousel-replace", "found", "ready"],
  ["hidden-frame", "found", "ready"],
  ["visible-frame", "found", "ready"],
  ["duplicate", "found", "ready"],
  ["disabled", "found", "blocked"],
  ["rename", "stale_capture"],
  ["replace", "stale_capture"],
  ["offscreen", "stale_capture"],
]) {
  test(`scope-resolver-target-validation-${mutation}`, async () => {
    const run = randomUUID();
    await json(`${fixture}/scenario`, "POST", {
      name: "found",
      targetText: "Accept all",
      mutation,
      delayMs: 300,
      run,
    });
    const session = await json(`${client}/api/sessions`, "POST");
    try {
      const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
        url: `${fixture}/shadow?run=${run}&motion=1`,
      });
      const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
        instruction: "Click the Accept all button.",
        documentId: page.documentId,
      });
      assert.equal(result.diagnostics.modelCalls, 1);
      assert.equal(Object.hasOwn(result.diagnostics, "selectionRule"), false);
      if (expected === "found") {
        assert.equal(result.outcome, "found", JSON.stringify(result));
        const target = result.actions[0].target;
        assert.equal(target.interactability.status, readiness);
        await json(`${fixture}/oracle?run=${run}`, "POST", {
          targets: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
        });
        let observation;
        for (let attempt = 0; attempt < 100 && !observation; attempt++) {
          observation = await json(`${fixture}/observation?run=${run}`);
          if (!observation) await delay(50);
        }
        assert.deepEqual(observation?.matches, [["consent"]]);
        assert.equal(observation.mutationApplied, mutation);
        assert.equal(observation.clicks, 0);
        assert.equal(observation.scrollY, 0);
        const highlighted = await json(`${client}/api/pages/${page.pageId}/highlight`, "POST", {
          documentId: page.documentId,
          captureId: result.captureId,
          actionId: "a1",
        });
        assert.equal(highlighted.target.candidateId, target.candidateId);
      } else {
        assert.equal(result.outcome, "error", JSON.stringify(result));
        assert.equal(result.diagnostics.code, expected);
      }
      const provider = await json(`${fixture}/provider-request`);
      assert.deepEqual(Object.keys(provider.response_format.json_schema.schema.properties).sort(), [
        "actions",
        "complete",
      ]);
      assert.doesNotMatch(provider.messages[1].content, /PRIVATE_SHADOW_|data-oracle/);
    } finally {
      await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
    }
  });
}

test("shadow-client-response-resolves-fixed-consent-with-native-root-context", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "found",
    targetText: "Accept all",
    action: "click",
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/shadow?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click the Accept all button.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found", JSON.stringify(result));
    const target = result.actions[0].target;
    assert.equal(target.accessibleName, "Accept all");
    assert.equal(target.shadowChain.length, 1);
    assert.equal(target.interactability.status, "ready");
    assert.equal(result.diagnostics.modelCalls, 1);
    await json(`${fixture}/oracle?run=${run}`, "POST", {
      targets: [{ xpath: target.xpaths[0], shadowChain: target.shadowChain }],
    });
    let observation;
    for (let attempt = 0; attempt < 100 && !observation; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (!observation) await delay(50);
    }
    assert.deepEqual(observation?.matches, [["consent"]]);
    assert.equal(observation.clicks, 0);
    assert.equal(observation.scrollY, 0);
    const provider = await json(`${fixture}/provider-request`);
    assert.doesNotMatch(
      provider.messages[1].content,
      /PRIVATE_SHADOW_|data-oracle|consent-host|\/\/div/,
    );
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("frames-client-response-preserves-nested-frame-chains-and-actions", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [
      {
        step: 1,
        instruction: "Click Approval in Payroll",
        action: "click",
        outcome: "found",
        label: "Approval",
        frameLabel: "Payroll",
      },
      {
        step: 1,
        instruction: "Click the disabled Approval",
        action: "click",
        outcome: "found",
        label: "Approval",
        index: 1,
        tag: "button",
        frameLabel: "Payroll",
      },
    ],
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/frames?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click both Approval buttons in Payroll.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.equal(Object.hasOwn(result, "evidence"), false);
    assert.deepEqual(
      result.actions.map((action) => action.outcome),
      ["found", "found"],
    );
    assert.deepEqual(
      result.actions[0].target.frame.chain.map((frame) => frame.label),
      ["Employee", "Payroll"],
    );
    assert.equal(result.actions[0].frameId, result.actions[0].target.frame.id);
    assert.equal(result.actions[1].target.interactability.status, "blocked");
    assert.equal(result.diagnostics.modelCalls, 1);
    const targets = result.actions.slice(0, 2).map((action) => ({
      xpath: action.target.xpaths[0],
      frameXpaths: action.target.frame.chain.map((frame) => frame.xpath),
    }));
    await json(`${fixture}/oracle?run=${run}`, "POST", { targets });
    let observation;
    for (let attempt = 0; attempt < 100 && !observation; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (!observation) await delay(50);
    }
    assert.deepEqual(observation?.matches, [["frame-approval-first"], ["frame-approval-second"]]);
    assert.equal(observation.clicks, 0);
    assert.equal(observation.scrollY, 0);
    const provider = await json(`${fixture}/provider-request`);
    assert.doesNotMatch(
      provider.messages[1].content,
      /PRIVATE_FRAME_VALUE|frame-notes|frame-approval-first|\/\/iframe/,
    );
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("cardinality-client-response-preserves-found-blocked-and-missing-targets", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [
      {
        step: 1,
        instruction: "Click Approval",
        action: "click",
        outcome: "found",
        label: "Approval",
        index: 1,
      },
      {
        step: 1,
        instruction: "Click Approval",
        action: "click",
        outcome: "found",
        label: "Approval",
        index: 0,
      },
      { step: 2, instruction: "Click Contact", action: "click", outcome: "not_found" },
    ],
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/batch?run=${run}`,
    });
    const before = await observeXpaths(run, []);
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click all Approval buttons and Contact.",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    assert.deepEqual(
      result.actions.map((action) => action.actionId),
      ["a1", "a2", "a3"],
    );
    assert.deepEqual(
      result.actions.map((action) => action.outcome),
      ["found", "found", "not_found"],
    );
    assert.equal(result.actions[1].target.interactability.status, "blocked");
    assert.deepEqual(result.summary, {
      processingComplete: true,
      semanticCompleteness: "unverified",
      total: 3,
      found: 2,
      notFound: 1,
      unsupported: 0,
      errors: 0,
      blocked: 1,
      readinessUnknown: 0,
      assessmentUnsupported: 0,
    });
    assert.equal(result.diagnostics.modelCalls, 1);
    assert.ok(
      result.actions.every(
        (action) =>
          action.diagnosticsReference === result.attemptId &&
          action.frameId === "main" &&
          action.diagnostics === undefined,
      ),
    );
    const xpaths = result.actions.flatMap((action) => action.target?.xpaths ?? []);
    const expected = result.actions
      .slice(0, 2)
      .flatMap((action, index) =>
        action.target.xpaths.map(() => [["approval-first", "approval-second", "notes"][index]]),
      );
    const observed = await observeXpaths(run, xpaths);
    assert.deepEqual(observed?.matches, expected);
    assert.equal(observed.clicks, 0);
    assert.equal(observed.scrollY, 0);
    assert.deepEqual(observed.events, before.events);
    const inspected = await json(`${client}/api/pages/${page.pageId}/highlight`, "POST", {
      documentId: page.documentId,
      captureId: result.captureId,
      actionId: "a2",
    });
    assert.equal(inspected.target.candidateId, result.actions[1].target.candidateId);
    for (const actionId of ["a2", null]) {
      const spotlight = await fetch(`${client}/api/pages/${page.pageId}/spotlight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: page.documentId,
          captureId: result.captureId,
          actionId,
        }),
      });
      assert.equal(spotlight.status, 204);
    }
    assert.deepEqual((await observeXpaths(run, [])).events, before.events);
    const provider = await json(`${fixture}/provider-request`);
    assert.equal(provider.max_tokens, 4096);
    assert.doesNotMatch(
      JSON.stringify(provider),
      /PRIVATE_NOTE_VALUE|HIDDEN_APPROVAL|approval-first|approval-second/,
    );
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

async function observeXpaths(run, xpaths) {
  await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths });
  for (let attempt = 0; attempt < 100; attempt++) {
    const observed = await json(`${fixture}/observation?run=${run}`);
    if (observed) return observed;
    await delay(50);
  }
  assert.fail("Independent fixture observation did not arrive");
}

test("cardinality-one-click-command-resolves-every-confirmation-in-list", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [1, 0].map((index) => ({
      step: 1,
      instruction: "Click all confirmation buttons in Pending requests",
      action: "click",
      outcome: "found",
      label: "Confirm",
      scope: "Pending requests",
      index,
    })),
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/confirmations?run=${run}`,
    });
    const before = await observeXpaths(run, []);
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click all confirmation buttons in the Pending requests list",
      documentId: page.documentId,
    });
    assert.equal(result.action, "click");
    assert.equal(result.actions.length, 2);
    assert.ok(result.actions.every((item) => item.action === "click" && item.outcome === "found"));
    assert.equal(result.summary.found, 2);
    assert.equal(result.summary.blocked, 1);
    assert.equal(result.diagnostics.modelCalls, 1);
    const observed = await observeXpaths(
      run,
      result.actions.map((item) => item.target.xpaths[0]),
    );
    assert.deepEqual(observed.matches, [["confirmation-first"], ["confirmation-second"]]);
    assert.equal(observed.clicks, 0);
    assert.deepEqual(observed.events, before.events);
    const provider = await json(`${fixture}/provider-request`);
    assert.doesNotMatch(JSON.stringify(provider), /confirmation-first|confirmation-second/);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("cardinality-independent-oracle-rejects-omitted-targets-despite-valid-xpaths", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [
      {
        step: 1,
        instruction: "Click Approval",
        action: "click",
        outcome: "found",
        label: "Approval",
        index: 0,
      },
    ],
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/batch?run=${run}`,
    });
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click all Approval buttons",
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found");
    assert.equal(result.summary.semanticCompleteness, "unverified");
    const observed = await observeXpaths(
      run,
      result.actions.map((action) => action.target.xpaths[0]),
    );
    assert.throws(
      () => assert.deepEqual(observed.matches, [["approval-first"], ["approval-second"]]),
      assert.AssertionError,
    );
    assert.equal(observed.clicks, 0);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});
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
test("targeting-complete-pipeline-resolves-independently-labelled-node", async () => {
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
    assert.equal(result.actions[0].target.xpaths.length, 1);
    assert.match(result.actions[0].target.xpaths[0], /@data-testid='about-us'/);
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.actions[0].target.xpaths });
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      observed = await json(`${fixture}/observation?run=${run}`);
      if (observed) break;
      await delay(50);
    }
    assert.ok(observed, "Fixture oracle must independently observe the live selected node");
    assert.deepEqual(
      observed.matches,
      result.actions[0].target.xpaths.map(() => ["expected-target"]),
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

test(`scope-client-response-preserves-current-view-absence`, async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [{ step: 1, instruction: "Click Contact", action: "click", outcome: "not_found" }],
  });
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
    const message = result.actions[0].message;
    assert.equal(message, "No matching element found in the current view.");
    {
      assert.equal(result.summary.notFound, 1);
      assert.equal(result.summary.found, 0);
    }
    assert.equal(result.diagnostics.capture.complete, true);
    assert.equal(result.diagnostics.modelInputComplete, true);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("state-client-response-preserves-readiness-and-scoped-absence", async () => {
  const session = await json(`${client}/api/sessions`, "POST");
  try {
    for (const [path, action, outcome, status] of [
      ["state", "click", "found", "blocked"],
      ["state", "hover", "found", "ready"],
      ["offscreen", "click", "not_found", null],
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
      if (result.actions[0].target) {
        assert.equal(result.actions[0].target.interactability.status, status);
        assert.equal(result.actions[0].target.interactability.action, action);
        assert.equal(result.actions[0].target.xpaths.length, 1);
      } else assert.match(result.actions[0].message, /current view/);
      const input = JSON.stringify(await json(`${fixture}/provider-request`));
      assert.doesNotMatch(input, /HIDDEN_DUPLICATE|PRIVATE_REFERENCE_VALUE/);
    }
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("robustness-fabricated-model-candidate-remains-operational-error", async () => {
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

test("robustness-model-input-excludes-secrets-and-preserves-unicode-labels", async () => {
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

test("xpath-duplicate-attributes-and-quotes-retain-unique-same-node-match", async () => {
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
    assert.ok(result.actions[0].target.xpaths.some((xpath) => xpath.includes("concat(")));
    assert.ok(
      result.actions[0].target.xpaths.every(
        (xpath) => !xpath.includes("[@data-testid='shared'][1]"),
      ),
    );
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.actions[0].target.xpaths });
    let observation;
    for (let attempt = 0; attempt < 100; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (observation) break;
      await delay(50);
    }
    assert.ok(observation);
    assert.deepEqual(
      observation.matches,
      result.actions[0].target.xpaths.map(() => ["expected-target"]),
    );
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

test("scope-oversized-capture-fails-before-provider-call", async () => {
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

test("fixtures-oracle-commands-and-observations-remain-isolated-by-run", async () => {
  const owner = randomUUID();
  const unrelated = randomUUID();
  const command = { xpaths: ["//button"] };
  await json(`${fixture}/oracle?run=${owner}`, "POST", command);
  assert.equal(await json(`${fixture}/oracle?run=${unrelated}`), null);
  assert.deepEqual(await json(`${fixture}/oracle?run=${owner}`), command);
  await json(`${fixture}/observation?run=${owner}`, "POST", { matches: [["expected-target"]] });
  assert.equal(await json(`${fixture}/observation?run=${unrelated}`), null);
});

test("tabs-client-routes-preserve-active-page-resolution-and-stable-viewer", async () => {
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
    assert.equal(result.actions[0].target.label, targetText);
    assert.equal(result.actions[0].target.xpaths.length, 1);
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.actions[0].target.xpaths });
    let observation;
    for (let attempt = 0; attempt < 100; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (observation) break;
      await delay(50);
    }
    assert.ok(observation);
    assert.deepEqual(
      observation.matches,
      result.actions[0].target.xpaths.map(() => ["expected-target"]),
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

for (const [instruction, missing] of [
  ["cilck on the 3 buttons", true],
  ["Click all buttons", false],
]) {
  test(`cardinality-explicit-count-${missing ? "preserves-missing-target" : "all-covers-visible-targets"}`, async () => {
    const run = randomUUID();
    const actions = [
      { step: 1, instruction: "Click Save", action: "click", outcome: "found", label: "Save" },
      {
        step: missing ? 2 : 1,
        instruction: "Click Cancel",
        action: "click",
        outcome: "found",
        label: "Cancel",
      },
    ];
    if (missing)
      actions.push({
        step: 3,
        instruction: "Click the third requested button",
        action: "click",
        outcome: "not_found",
      });
    await json(`${fixture}/scenario`, "POST", { name: "batch", actions });
    const session = await json(`${client}/api/sessions`, "POST");
    try {
      const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
        url: `${fixture}/two-buttons?run=${run}`,
      });
      const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
        instruction,
        documentId: page.documentId,
      });
      assert.equal(result.outcome, missing ? "partial" : "found");
      assert.equal(result.actions.length, missing ? 3 : 2);
      assert.equal(result.summary.found, 2);
      assert.equal(result.summary.notFound, missing ? 1 : 0);
      assert.equal(result.diagnostics.modelCalls, 1);
      if (missing) assert.equal(result.actions[2].target, null);
      await json(`${fixture}/oracle?run=${run}`, "POST", {
        xpaths: result.actions
          .filter((action) => action.target)
          .map((action) => action.target.xpaths[0]),
      });
      let observed;
      for (let attempt = 0; attempt < 100 && !observed; attempt++) {
        observed = await json(`${fixture}/observation?run=${run}`);
        if (!observed) await delay(50);
      }
      assert.deepEqual(observed?.matches, [["first-button"], ["second-button"]]);
      assert.equal(observed.clicks, 0);
    } finally {
      await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
    }
  });
}
