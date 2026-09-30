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
test("actual OpenRouter route resolves a known target and genuine absence without the client or database", async () => {
  const session = await json(`${browser}/sessions`, "POST");
  const run = randomUUID();
  let totalCostUsd = 0;
  try {
    const page = await json(`${browser}/pages/${session.pageId}/navigate`, "POST", {
      url: `${fixture}/fixture?run=${run}`,
    });
    for (const [instruction, outcome] of [
      ["Click on About us.", "found"],
      ["Click the Contact button. Return not_found if it does not exist.", "not_found"],
    ]) {
      const result = await json(`${resolver}/pages/${session.pageId}/resolve`, "POST", {
        instruction,
        documentId: page.documentId,
      });
      console.log(
        JSON.stringify({
          outcome: result.outcome,
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
      assert.equal(result.sessionId, session.sessionId);
      assert.equal(result.pageId, session.pageId);
      assert.equal(result.documentId, page.documentId);
      if (outcome === "found") {
        assert.ok(result.target.xpaths.length > 0, "Found requires verified XPath alternatives");
        await json(`${fixture}/oracle?run=${run}`, "POST", { xpaths: result.target.xpaths });
        let observed;
        for (let attempt = 0; attempt < 100; attempt++) {
          observed = await json(`${fixture}/observation?run=${run}`);
          if (observed) break;
          await delay(50);
        }
        assert.ok(observed, "Live selection must be checked by independent fixture oracle");
        assert.deepEqual(
          observed.matches,
          result.target.xpaths.map(() => ["expected-target"]),
        );
        assert.equal(observed.clicks, 0);
        assert.equal(observed.scrollY, 0);
      } else assert.equal(result.target, null);
    }
    console.log(JSON.stringify({ requests: 2, totalCostUsd }));
  } finally {
    await fetch(`${browser}/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});
