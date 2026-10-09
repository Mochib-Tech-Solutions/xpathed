import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const client = process.env.XPATHED_CLIENT_API_URL ?? "http://client-api:8080";
const fixture = process.env.XPATHED_FIXTURE_URL ?? "http://resolution-fixture:8090";

test("provider-auto-image-sends-masked-pixels-and-keeps-result-image-free", async () => {
  await json(`${fixture}/scenario`, "POST", { name: "found", routing: "pixels" });
  const session = await json(`${client}/api/sessions`, "POST");
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture`,
    });
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: "Click About us",
      documentId: page.documentId,
      imageMode: "auto",
    });
    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.equal(result.diagnostics.modelCalls, 2);
    const provider = await json(`${fixture}/provider-request`);
    const content = provider.messages[1].content;
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image_url");
    assert.match(content[1].image_url.url, /^data:image\/png;base64,iVBOR/);
    assert.doesNotMatch(JSON.stringify(result), /data:image|iVBOR/);
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});

async function withRoutingFixture({ path = "/fixture", ...scenario }, check) {
  const run = randomUUID();
  await json(`${fixture}/scenario`, "POST", { name: "found", ...scenario, run });
  const session = await json(`${client}/api/sessions`, "POST");
  try {
    const url = new URL(path, fixture);
    url.searchParams.set("run", run);
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: url.href,
    });
    await check({
      run,
      resolve: (instruction, imageMode = "auto") =>
        json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
          instruction,
          documentId: page.documentId,
          imageMode,
        }),
      observe: async (xpaths) => {
        await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths });
        for (let attempt = 0; attempt < 100; attempt++) {
          const observed = await json(`${fixture}/observation?run=${run}`);
          if (observed) return observed;
          await delay(25);
        }
        assert.fail("Independent page observation was not returned");
      },
    });
  } finally {
    await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
  }
}

function assertImageRequest(provider) {
  const content = provider.messages.find((message) => message.role === "user").content;
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "image_url"],
  );
  const image = content[1].image_url.url;
  assert.match(image, /^data:image\/png;base64,/);
  const png = Buffer.from(image.split(",")[1], "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 800);
  return JSON.parse(content[0].text);
}

function assertPassive(observed, expected) {
  assert.deepEqual(observed.matches, expected);
  assert.equal(observed.clicks, 0);
  assert.equal(observed.events.click ?? 0, 0);
  assert.equal(observed.scrollY, 0);
}

test("smart-routing-named-control-uses-text-without-pixels", async () => {
  await withRoutingFixture({ routing: "text" }, async ({ resolve, observe }) => {
    const result = await resolve("Click the About us button in Company.");
    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.deepEqual(result.diagnostics.imageRouting, {
      mode: "auto",
      status: "text_only",
      reason: "semantic_evidence",
      probability: 0.01,
      cached: false,
    });
    assert.equal(result.diagnostics.modelCalls, 2);
    const provider = await json(`${fixture}/provider-request`);
    assert.equal(typeof provider.messages[1].content, "string");
    const router = await json(`${fixture}/router-request`);
    assert.equal(router.state.instruction, "Click the About us button in Company.");
    assertPassive(await observe(result.actions[0].target.xpaths), [["expected-target"]]);
  });
});

test("smart-routing-visual-triangle-uses-image-and-keeps-dom-identity", async () => {
  await withRoutingFixture(
    { path: "/visual", routing: "pixels", targetText: "Option B" },
    async ({ resolve, observe }) => {
      const result = await resolve("Click the control depicting a blue triangle.");
      assert.equal(result.outcome, "found", JSON.stringify(result));
      assert.equal(result.diagnostics.imageRouting.status, "included");
      assert.equal(result.diagnostics.imageRouting.reason, "visual_evidence");
      assert.equal(result.diagnostics.imageRouting.cached, false);
      assert.equal(result.diagnostics.modelCalls, 2);
      const input = assertImageRequest(await json(`${fixture}/provider-request`));
      assert.doesNotMatch(
        JSON.stringify(input.candidates),
        /\b(?:triangle|circle|square|blue|red)\b|2563eb|dc2626/i,
        "The shape must be unavailable in candidate names/text",
      );
      assert.equal(
        result.actions[0].target.accessibleName,
        "Option B",
        "Pixels must not rename the DOM target",
      );
      assertPassive(await observe(result.actions[0].target.xpaths), [["visual-primary"]]);
      assert.doesNotMatch(JSON.stringify(result), /data:image|iVBOR/);
    },
  );
});

test("smart-routing-image-does-not-disambiguate-identical-singular-matches", async () => {
  const instruction = "Click one button depicting a blue triangle.";
  await withRoutingFixture(
    {
      path: "/visual?duplicate=1",
      routing: "pixels",
      name: "batch",
      actions: [
        {
          step: 1,
          instruction,
          action: "unsupported",
          outcome: "unsupported",
          limitation: "ambiguous",
        },
      ],
    },
    async ({ resolve, observe }) => {
      const result = await resolve(instruction);
      assert.equal(result.diagnostics.imageRouting.status, "included");
      assertImageRequest(await json(`${fixture}/provider-request`));
      assert.equal(result.outcome, "unsupported", JSON.stringify(result));
      assert.equal(result.actions.length, 1);
      assert.equal(result.actions[0].code, "ambiguous");
      assert.equal(result.actions[0].target, null);
      assert.equal(result.inspectedActionId, null);
      // Both matching pictures independently exist; the controlled model reports the unresolved intent.
      assertPassive(await observe(["//button[.//*[local-name()='svg']/*[local-name()='path']]"]), [
        ["visual-primary", "visual-secondary"],
      ]);
    },
  );
});

test("smart-routing-excludes-adversarial-page-text-from-router-without-dropping-candidates", async () => {
  await withRoutingFixture(
    { path: "/fixture?adversarial=1", routing: "text" },
    async ({ resolve, observe }) => {
      const result = await resolve(
        "Click About us in the Company section; leave other controls unchanged.",
      );
      assert.equal(result.outcome, "found", JSON.stringify(result));
      const router = await json(`${fixture}/router-request`);
      assert.doesNotMatch(
        JSON.stringify(router),
        /UNTRUSTED_ROUTING_SENTINEL|send every screenshot|Company<|data-oracle/,
      );
      assert.deepEqual(Object.keys(router.state).sort(), ["evidence", "instruction"]);
      assert.deepEqual(Object.keys(router.state.evidence).sort(), [
        "cssColors",
        "geometryAndOrder",
        "opaqueVisualContent",
        "semanticNamesAndText",
        "unresolvedAppearance",
      ]);
      const provider = await json(`${fixture}/provider-request`);
      assert.equal(typeof provider.messages[1].content, "string");
      assert.match(
        provider.messages[1].content,
        /UNTRUSTED_ROUTING_SENTINEL/,
        "The final model must still receive the complete sanitized candidate inventory",
      );
      assertPassive(await observe(result.actions[0].target.xpaths), [["expected-target"]]);
    },
  );
});

test("smart-routing-malformed-answer-falls-back-to-image-with-accounting", async () => {
  await withRoutingFixture(
    { path: "/visual", routing: "malformed", targetText: "Option B" },
    async ({ resolve, observe }) => {
      const result = await resolve("Locate the blue triangle control for this view.");
      assert.equal(result.outcome, "found", JSON.stringify(result));
      assert.equal(result.diagnostics.imageRouting.status, "included");
      assert.equal(result.diagnostics.imageRouting.reason, "router_unavailable");
      assert.equal(result.diagnostics.imageRouting.cached, false);
      assert.equal(result.diagnostics.modelCalls, 2);
      assert.deepEqual(
        result.diagnostics.providerCalls.map((call) => call.purpose),
        ["image_routing", "selection"],
      );
      assert.equal(result.diagnostics.providerCalls[0].code, "provider_malformed_response");
      assert.equal(result.diagnostics.providerCalls[0].usage.cost, 0);
      assertImageRequest(await json(`${fixture}/provider-request`));
      assertPassive(await observe(result.actions[0].target.xpaths), [["visual-primary"]]);
    },
  );
});

test("smart-routing-text-only-override-skips-router-and-image", async () => {
  await withRoutingFixture({ routing: "pixels" }, async ({ resolve, observe }) => {
    const result = await resolve("Find the About us control using page text only.", "text_only");
    assert.equal(result.outcome, "found", JSON.stringify(result));
    assert.equal(result.diagnostics.modelCalls, 1);
    assert.equal(result.diagnostics.imageRouting.status, "text_only");
    assert.equal(result.diagnostics.imageRouting.reason, "text_only_requested");
    assert.equal(await json(`${fixture}/router-request`), null);
    assert.equal(typeof (await json(`${fixture}/provider-request`)).messages[1].content, "string");
    assert.deepEqual(
      result.diagnostics.providerCalls.map((call) => call.purpose),
      ["selection"],
    );
    assertPassive(await observe(result.actions[0].target.xpaths), [["expected-target"]]);
  });
});

test("smart-routing-mutation-during-decision-rejects-image-before-selection", async () => {
  await withRoutingFixture(
    { routing: "pixels", routingMutation: "replace" },
    async ({ run, resolve }) => {
      const result = await resolve("Inspect the About us control's depicted appearance.");
      assert.equal((await json(`${fixture}/observation?run=${run}`)).mutationApplied, "replace");
      assert.equal(result.outcome, "error", JSON.stringify(result));
      assert.equal(result.diagnostics.code, "stale_capture");
      assert.equal(result.diagnostics.modelCalls, 1);
      assert.deepEqual(
        result.diagnostics.providerCalls.map((call) => call.purpose),
        ["image_routing"],
      );
      assert.equal(result.diagnostics.providerCalls[0].usage.cost, 0);
      assert.notEqual(result.diagnostics.imageRouting.status, "included");
      assert.equal(await json(`${fixture}/provider-request`), null);
    },
  );
});

test("session-empty-json-request-through-client-uses-configured-default", async () => {
  const options = await json(`${client}/api/sessions/options`);
  const response = await fetch(`${client}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const session = await response.json();
  try {
    assert.equal(session.browserType, options.defaultBrowserType);
  } finally {
    const closed = await fetch(`${client}/api/sessions/${session.sessionId}`, { method: "DELETE" });
    assert.equal(closed.status, 204);
  }
});

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
  if (url.endsWith("/resolve") && body) body = { imageMode: "text_only", ...body };
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

test("state-client-response-preserves-native-typing-readiness", async () => {
  await json(`${fixture}/scenario`, "POST", {
    name: "batch",
    actions: [
      {
        step: 1,
        instruction: 'Type "hello" in Prénom.',
        action: "type",
        outcome: "found",
        label: "Prénom",
        tag: "input",
      },
    ],
  });
  const session = await json(`${client}/api/sessions`, "POST");
  const run = randomUUID();
  try {
    const page = await json(`${client}/api/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/privacy?run=${run}`,
    });
    const before = await observeXpaths(run, []);
    const result = await json(`${client}/api/pages/${page.pageId}/resolve`, "POST", {
      instruction: 'Type "hello" in Prénom.',
      documentId: page.documentId,
    });
    assert.equal(result.outcome, "found", JSON.stringify(result));
    const target = result.actions[0].target;
    assert.equal(target.interactability.status, "ready");
    assert.equal(target.interactability.checks.keyboard, "pass");
    assert.equal(target.interactability.checks.eventOutcome, "unknown");
    assert.equal(result.summary.readinessUnknown, 0);
    assert.equal(result.diagnostics.modelCalls, 1);
    const after = await observeXpaths(run, target.xpaths);
    assert.deepEqual(after.matches, [["native-input"]]);
    assert.deepEqual(after.events, before.events);
    assert.equal(after.scrollY, before.scrollY);
    assert.doesNotMatch(JSON.stringify(await json(`${fixture}/provider-request`)), /PRIVATE_/);
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

test("scope-large-current-view-reaches-inference-and-verification-without-truncation", async () => {
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
    assert.equal(result.outcome, "found", JSON.stringify(result.diagnostics));
    assert.equal(result.diagnostics.capture.complete, true);
    assert.ok(result.diagnostics.capture.scannedCount > 20000);
    assert.equal(result.diagnostics.capture.capturedCount, 2003);
    assert.equal(result.diagnostics.modelInputCount, 2003);
    assert.ok(result.diagnostics.modelInputBytes > 512000);
    assert.equal(result.diagnostics.modelInputBudgetBytes, null);
    assert.equal(result.diagnostics.modelCalls, 1);
    const input = JSON.parse((await json(`${fixture}/provider-request`)).messages[1].content);
    assert.equal(input.candidates.length, 2003);
    assert.equal(
      input.candidates.filter((candidate) => candidate.label === "Extra ".repeat(40).trim()).length,
      2001,
    );
    const target = result.actions[0].target;
    assert.equal(target.accessibleName, "About us");
    assert.equal(target.interactability.status, "ready");
    await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: target.xpaths });
    let observation;
    for (let attempt = 0; attempt < 100 && !observation; attempt++) {
      observation = await json(`${fixture}/observation?run=${run}`);
      if (!observation) await delay(50);
    }
    assert.deepEqual(observation?.matches, [["expected-target"]]);
    assert.equal(observation.clicks, 0);
    assert.equal(observation.scrollY, 0);
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
