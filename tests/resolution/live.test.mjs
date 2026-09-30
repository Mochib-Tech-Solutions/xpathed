import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const browser = "http://browser:8080";
const resolver = "http://resolver:8080";
const fixture = "http://resolution-fixture:8090";
async function json(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 200, `Service returned HTTP ${response.status}`);
  return response.json();
}
test("actual OpenRouter route resolves scoped frames, offscreen context, expanded actions and legacy absence", async () => {
  const session = await json(`${browser}/sessions`, "POST");
  const run = randomUUID();
  let totalCostUsd = 0;
  try {
    for (const [path, contractVersion, instruction, outcome] of [
      [
        "frames",
        "2",
        "Click all Approval buttons inside the Payroll frame, clear Notes in Payroll, and hover Help in the footer. Also pause for two seconds, navigate to example.com, and drag the first Approval button onto Help.",
        "partial",
      ],
      [
        "fixture",
        "1",
        "Click the Contact button. Return not_found if it does not exist.",
        "not_found",
      ],
    ]) {
      const page = await json(`${browser}/pages/${session.pageId}/navigate`, "POST", {
        url: `${fixture}/${path}?run=${run}`,
      });
      const result = await json(`${resolver}/pages/${session.pageId}/resolve`, "POST", {
        instruction,
        documentId: page.documentId,
        contractVersion,
      });
      console.log(
        JSON.stringify({
          outcome: result.outcome,
          summary: result.summary,
          actions: result.actions?.map((action) => ({
            instruction: action.instruction,
            action: action.action,
            outcome: action.outcome,
            code: action.code,
            frame: action.target?.frame?.id,
          })),
          code: result.diagnostics.code,
          configurationId: result.configurationId,
          capture: result.diagnostics.capture,
          modelInputCount: result.diagnostics.modelInputCount,
          modelInputBytes: result.diagnostics.modelInputBytes,
          model: result.diagnostics.model,
          provider: result.diagnostics.provider,
          generationId: result.diagnostics.generationId,
          finishReason: result.diagnostics.finishReason,
          usage: result.diagnostics.usage,
          costEstimate: result.diagnostics.costEstimate,
          timingsMs: result.diagnostics.timingsMs,
        }),
      );
      assert.equal(
        result.outcome,
        outcome,
        `Live route failed: ${result.diagnostics.code ?? result.outcome}`,
      );
      assert.equal(result.diagnostics.modelCalls, 1);
      assert.equal(result.diagnostics.modelInputComplete, true);
      assert.match(result.diagnostics.generationId ?? "", /^gen-/);
      assert.equal(result.diagnostics.model, "deepseek/deepseek-v4.1-flash");
      assert.equal(result.diagnostics.provider?.toLowerCase(), "wafer");
      const cost = result.diagnostics.usage?.cost;
      assert.ok(
        Number.isFinite(cost) && cost >= 0 && cost <= 0.005,
        "Stop if reported cost is unavailable or exceeds half a cent",
      );
      totalCostUsd += cost;
      assert.ok(totalCostUsd < 0.01, "The two-call smoke check must cost less than one cent");
      const estimate = result.diagnostics.costEstimate;
      assert.equal(
        estimate?.currency,
        "USD",
        "Live cost estimate must use the actual model/provider rates",
      );
      assert.ok(Number.isFinite(estimate.totalCost) && estimate.totalCost >= 0);
      assert.ok(
        Math.abs(
          estimate.totalCost - estimate.inputCost - estimate.outputCost - estimate.requestCost,
        ) < 1e-12,
      );
      assert.equal(result.sessionId, session.sessionId);
      assert.equal(result.pageId, session.pageId);
      assert.equal(result.documentId, page.documentId);
      if (contractVersion === "2") {
        assert.equal(result.contractVersion, "2");
        assert.equal(
          result.actions.length,
          7,
          "All intended plural and compound actions must be represented",
        );
        assert.deepEqual(
          result.actions.map((action) => action.action),
          ["click", "click", "clear", "hover", "unsupported", "unsupported", "unsupported"],
        );
        assert.deepEqual(
          result.actions.map((action) => action.outcome),
          ["found", "found", "found", "found", "unsupported", "unsupported", "unsupported"],
        );
        assert.ok(result.actions.slice(4).every((action) => action.code === "unsupported_action"));
        assert.ok(
          result.actions.slice(0, 3).every((action) => action.target.frame.chain.length === 2),
        );
        assert.equal(result.actions[3].target.frame.id, "main");
        assert.equal(result.actions[3].target.state.inViewport, false);
        assert.equal(result.summary.blocked, 3);
        assert.equal(result.summary.readinessUnknown, 0);
        assert.ok(
          result.actions.every(
            (action) => action.diagnosticsReference === result.attemptId && !action.diagnostics,
          ),
        );
        const targets = result.actions.flatMap((action) =>
          action.target
            ? action.target.xpaths.map((xpath) => ({
                xpath,
                frameXpaths: action.target.frame.chain.map((frame) => frame.xpath),
              }))
            : [],
        );
        const expected = [
          ["frame-approval-first"],
          ["frame-approval-second"],
          ["frame-notes"],
          ["footer-help"],
        ];
        await json(`${fixture}/oracle?run=${run}`, "POST", { targets });
        let observed;
        for (let attempt = 0; attempt < 100; attempt++) {
          observed = await json(`${fixture}/observation?run=${run}`);
          if (observed) break;
          await delay(50);
        }
        assert.ok(observed, "Live selection must be checked by independent fixture oracle");
        assert.deepEqual(observed.matches, expected);
        assert.equal(observed.clicks, 0);
        assert.equal(observed.scrollY, 0);
      } else {
        assert.equal(result.contractVersion, "1");
        assert.equal(result.target, null);
      }
    }
    console.log(JSON.stringify({ requests: 2, totalCostUsd }));
  } finally {
    await fetch(`${browser}/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});
