import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const browser = process.env.XPATHED_BROWSER_URL ?? "http://browser:8080";
const resolver = process.env.XPATHED_RESOLVER_URL ?? "http://resolver:8080";
const fixture = process.env.XPATHED_FIXTURE_URL ?? "http://resolution-fixture:8090";
async function json(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("cardinality-live-singular-login-is-ambiguous-and-plural-login-enumerates", async () => {
  const session = await json(`${browser}/sessions`, {});
  const run = randomUUID();
  let knownReportedCostUsd = 0;
  let estimatedCostUsd = 0;
  let unknownChargeCount = 0;
  const failures = [];
  const cases = [
    ["click on login", null],
    ["Click the Log in button.", null],
    ["Click the Log in button in the header.", ["header-login"]],
    ["Click all Log in buttons.", ["header-login", "sidebar-login"]],
    ["Click the login buttons.", ["header-login", "sidebar-login"]],
    ["Click Log in in Get responses tailored to you.", ["sidebar-login"]],
    ["click on login", null, true],
    ["Click all Log in buttons.", ["header-login", "sidebar-login"], true],
  ];
  try {
    for (const [instruction, expected, covered = false] of cases) {
      const page = await json(`${browser}/pages/${session.pageId}/navigate`, {
        url: `${fixture}/login?run=${run}${covered ? "&covered=1" : ""}`,
      });
      const result = await json(`${resolver}/pages/${session.pageId}/resolve`, {
        instruction,
        documentId: page.documentId,
      });
      knownReportedCostUsd += result.diagnostics.usage?.cost ?? 0;
      estimatedCostUsd += result.diagnostics.costEstimate?.totalCost ?? 0;
      if (result.diagnostics.usage?.cost == null) unknownChargeCount++;
      console.log(
        JSON.stringify({
          instruction,
          covered,
          outcome: result.outcome,
          actions: result.actions,
          model: result.diagnostics.model,
          provider: result.diagnostics.provider,
          generationId: result.diagnostics.generationId,
          usage: result.diagnostics.usage,
          costEstimate: result.diagnostics.costEstimate,
          timingsMs: result.diagnostics.timingsMs,
          modelInputBytes: result.diagnostics.modelInputBytes,
        }),
      );
      try {
        assert.equal(result.diagnostics.modelCalls, 1);
        assert.equal(result.diagnostics.model, "deepseek/deepseek-v4.1-flash");
        assert.equal(result.diagnostics.provider?.toLowerCase(), "wafer");
        if (expected === null) {
          assert.equal(result.outcome, "unsupported");
          assert.equal(result.actions.length, 1);
          assert.equal(result.actions[0].code, "ambiguous");
          assert.equal(result.actions[0].target, null);
        } else {
          assert.equal(result.outcome, "found");
          assert.equal(result.actions.length, expected.length);
          assert.equal(result.summary.blocked, covered ? 1 : 0);
          await json(`${fixture}/oracle?run=${run}`, {
            xpaths: result.actions.map((action) => action.target.xpaths[0]),
          });
          let observation;
          for (let poll = 0; poll < 100; poll++) {
            observation = await json(`${fixture}/observation?run=${run}`);
            if (observation) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.deepEqual(
            observation?.matches,
            expected.map((id) => [id]),
          );
          assert.equal(observation.clicks, 0);
          assert.equal(observation.scrollY, 0);
        }
      } catch (error) {
        failures.push(`${instruction} (covered=${covered}): ${error.message}`);
      }
    }
    console.log(
      JSON.stringify({
        requests: cases.length,
        knownReportedCostUsd,
        estimatedCostUsd,
        unknownChargeCount,
      }),
    );
    assert.deepEqual(failures, []);
  } finally {
    await fetch(`${browser}/sessions/${session.sessionId}`, { method: "DELETE" });
  }
});
