import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveXPathTrial, selectXPathCases } from "./xpath.mjs";
import { gradeTrial } from "./grader.mjs";
import { loadCases } from "./cases/load.mjs";

test("xpath-selection-retains-mutations-and-excludes-cases-without-verifiable-targets", () => {
  const { cases, exclusions } = selectXPathCases(loadCases().cases);
  assert.ok(cases.some((item) => item.mutation));
  assert.ok(exclusions.some((item) => item.caseId === "scope-capture-budget-exhaustion-is-error"));
  assert.ok(cases.every((item) => !item.provider.fault && !item.expected.summary));
  assert.ok(
    cases.every((item) => item.expected.actions.some((action) => action.outcome === "found")),
  );
});

test("xpath-browser-verification-rejects-unique-match-for-wrong-node", async (t) => {
  const spec = selectXPathCases(loadCases().cases).cases.find(
    (item) => item.id === "targeting-save-button-by-name",
  );
  const requests = [];
  let observation,
    wrongNode = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const path = new URL(req.url, "http://localhost").pathname;
    requests.push(path);
    let value;
    if (path === "/pages/page/capture")
      value = {
        pageId: "page",
        documentId: "document",
        captureId: "capture",
        scope: "current_view",
        candidates: [
          { id: "selected", tag: "button", label: "Save changes", frame: { id: "main" } },
        ],
      };
    else if (path === "/pages/page/selections") {
      assert.equal(body.actions[0].candidateId, "selected");
      assert.equal(body.actions[0].action, "click");
      value = {
        actions: [
          {
            actionId: "a1",
            target: {
              candidateId: "selected",
              frame: { id: "main" },
              xpaths: ["//button"],
              state: {
                rendered: true,
                inViewport: true,
                enabled: true,
                editable: false,
                accessibilityExposed: true,
                readonly: false,
                ...spec.expected.actions[0].state,
              },
              interactability: {
                version: "2",
                action: "click",
                ...spec.expected.actions[0].interactability,
              },
            },
          },
        ],
      };
    } else if (path === "/command") {
      observation = {
        id: body.id,
        viewport: spec.viewport,
        passiveStateUnchanged: true,
        actions: [{ matches: [{ count: 1, intended: !wrongNode }] }],
      };
      value = {};
    } else if (path === "/observation") value = observation;
    else {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const incorrect of [false, true]) {
    wrongNode = incorrect;
    const trial = { id: "trial" };
    await resolveXPathTrial(
      spec,
      trial,
      { pageId: "page" },
      { documentId: "document" },
      { timeoutMs: 1000 },
      { browser: url, fixture: url, resolver: "http://must-not-call.invalid" },
      "trial",
    );
    assert.equal(trial.error, undefined);
    const grade = gradeTrial(spec, trial);
    assert.equal(grade.passed, !incorrect, JSON.stringify(grade.failures));
    assert.equal(trial.result.diagnostics.modelCalls, 0);
    assert.ok(trial.evidence.browserValidation);
  }
  assert.ok(
    requests.every((path) =>
      ["/pages/page/capture", "/pages/page/selections", "/command", "/observation"].includes(path),
    ),
  );
});
