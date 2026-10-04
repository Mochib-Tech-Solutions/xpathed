import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicObservation,
  normalizeActions,
  normalizeSelector,
  requestObservation,
} from "./stagehand.mjs";

test("normalizes document-relative nested frame XPath and rejects shadow/CSS paths", () => {
  assert.deepEqual(
    normalizeSelector(
      "xpath=/html[1]/body[1]/iframe[2]/html[1]/body[1]/iframe[1]/html[1]/body[1]/button[3]",
    ),
    {
      xpaths: ["/html[1]/body[1]/button[3]"],
      frame: {
        chain: [{ xpath: "/html[1]/body[1]/iframe[2]" }, { xpath: "/html[1]/body[1]/iframe[1]" }],
      },
    },
  );
  for (const path of [
    "css=#save",
    "xpath=/html[1]/body[1]/widget[1]//button[1]",
    "xpath=//button",
    "xpath=/html[1]/body[1]/button[0]",
  ])
    assert.throws(() => normalizeSelector(path));
});

test("singleton never skips the first suggestion; plural retains conversion failures", () => {
  const actions = [
    { selector: "css=#wrong", method: "click" },
    { selector: "xpath=/html[1]/body[1]/button[1]", method: "click" },
  ];
  assert.equal(normalizeActions(actions, "singleton").status, "unsupported");
  assert.equal(normalizeActions(actions, "singleton").targets.length, 0);
  const plural = normalizeActions(actions, "all");
  assert.equal(plural.targets.length, 1);
  assert.equal(plural.unsupported.length, 1);
  assert.equal(plural.selectedCount, 2);
  assert.equal(normalizeActions([], "all").status, "empty");
  assert.equal(normalizeActions([actions[1], actions[1]], "all").targets.length, 2);
});

test("deterministic plan selects only supplied snapshot labels and can return every match", () => {
  const params = {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "[0-1] button: Save\n[1-2] button: Save\n[0-3] link: Other",
        },
      },
    ],
  };
  assert.deepEqual(
    deterministicObservation(params, {
      elements: [{ label: "Save", role: "button", all: true }],
    }).structuredContent.elements.map((element) => element.elementId),
    ["0-1", "1-2"],
  );
  assert.deepEqual(
    deterministicObservation(params, { elements: [{ label: "Absent" }] }).structuredContent
      .elements,
    [],
  );
});

test("OpenRouter callback forwards Stagehand schema, route and bounded settings without retries", async () => {
  const params = {
    systemPrompt: "original",
    messages: [{ role: "user", content: { type: "text", text: "snapshot" } }],
    responseFormat: { name: "Observation", schema: { type: "object" } },
  };
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, "google/gemini-3.8-flash");
    assert.deepEqual(body.provider, {
      only: ["google-ai-studio"],
      order: ["google-ai-studio"],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.reasoning, { enabled: true, effort: "low", exclude: true });
    assert.deepEqual(body.response_format.json_schema.schema, params.responseFormat.schema);
    assert.equal(body.messages[0].content, "original");
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"elements":[]}' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    );
  };
  assert.equal(
    (await requestObservation(params, "http://gateway", { fetchImpl })).usage.totalTokens,
    6,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    requestObservation(params, "http://gateway", {
      fetchImpl: async () => {
        calls++;
        return new Response("", { status: 429 });
      },
    }),
    /model_http_429/,
  );
  assert.equal(calls, 2);
});
