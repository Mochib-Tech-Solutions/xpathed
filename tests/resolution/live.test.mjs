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
test("actual OpenRouter route resolves plural mixed actions and legacy absence without the client or database", async () => {
  const session = await json(`${browser}/sessions`, "POST");
  const run = randomUUID();
  let totalCostUsd = 0;
  try {
    for (const [path, contractVersion, instruction, outcome] of [
      [
        "batch",
        "2",
        "Click all Approval buttons, fill Notes, and hover Contact. Also click Done after opening details.",
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
          5,
          "All intended plural and compound actions must be represented",
        );
        assert.deepEqual(
          result.actions.map((action) => action.action),
          ["click", "click", "fill", "hover", "click"],
        );
        assert.deepEqual(
          result.actions.map((action) => action.outcome),
          ["found", "found", "found", "not_found", "unsupported"],
        );
        assert.equal(result.actions[4].code, "current_state_dependency");
        assert.equal(result.summary.blocked, 2);
        assert.equal(result.summary.readinessUnknown, 1);
        assert.ok(
          result.actions.every(
            (action) => action.diagnosticsReference === result.attemptId && !action.diagnostics,
          ),
        );
        const xpaths = result.actions.flatMap((action) => action.target?.xpaths ?? []);
        const expected = result.actions
          .slice(0, 3)
          .flatMap((action, index) =>
            action.target.xpaths.map(() => [["approval-first", "approval-second", "notes"][index]]),
          );
        await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths });
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
