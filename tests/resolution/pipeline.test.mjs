import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const client = "http://client-api:8080";
const fixture = "http://resolution-fixture:8090";

test("Client results preserve nested frame chains and expanded actions through the complete pipeline", async () => {
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
      contractVersion: "4",
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

test("A plural current-view prompt preserves found, blocked and missing targets", async () => {
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
      contractVersion: "4",
    });
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    assert.equal(result.contractVersion, "4");
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
    assert.equal(result.diagnostics.promptVersion, "10");
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

test("One click command resolves every confirmation in the requested list as separate targets", async () => {
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
      contractVersion: "4",
    });
    assert.equal(result.contractVersion, "4");
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

test("An independent plural oracle detects omitted actions despite valid returned XPaths", async () => {
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
      contractVersion: "4",
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

for (const contractVersion of ["4"])
  test(`genuine absence preserves its inspected scope through ClientApi (version ${contractVersion})`, async () => {
    await json(
      `${fixture}/scenario`,
      "POST",
      contractVersion === "4"
        ? {
            name: "batch",
            actions: [
              { step: 1, instruction: "Click Contact", action: "click", outcome: "not_found" },
            ],
          }
        : { name: "absent" },
    );
    const session = await json(`${client}/api/sessions`, "POST");
    const run = randomUUID();
    try {
      const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
        url: `${fixture}/fixture?run=${run}`,
      });
      const result = await json(`${client}/api/pages/${session.pageId}/resolve`, "POST", {
        instruction: "Click the missing Contact button.",
        contractVersion,
        documentId: page.documentId,
      });
      assert.equal(result.outcome, "not_found");
      assert.equal(result.target, null);
      const message =
        contractVersion === "4" ? result.actions[0].message : result.diagnostics.message;
      assert.equal(
        message,
        contractVersion === "4"
          ? "No matching element found in the current view."
          : "No matching element found in the eligible current-page scope.",
      );
      if (contractVersion === "4") {
        assert.equal(result.summary.notFound, 1);
        assert.equal(result.summary.found, 0);
      }
      assert.equal(result.diagnostics.capture.complete, true);
      assert.equal(result.diagnostics.modelInputComplete, true);
    } finally {
      await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
    }
  });

test("ClientApi preserves disabled, off-screen and hover assessments and scopes hidden-only absence", async () => {
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
        assert.equal(result.actions[0].target.state.version, "2");
        assert.equal(result.diagnostics.promptVersion, "10");
        assert.equal(result.actions[0].target.xpaths.length, 1);
      } else assert.match(result.actions[0].message, /current view/);
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

test("duplicate test attributes and both quote types still yield one unique same-node XPath", async () => {
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
