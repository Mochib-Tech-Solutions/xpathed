import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { renderFixture } from "./pages.mjs";
import { controlledActions } from "./selection.mjs";

import { loadCases } from "../cases/load.mjs";
const manifest = loadCases(
  process.env.XPATHED_EVALUATION_SUITE || new URL("../cases/index.json", import.meta.url),
);

export function createFixtureServer({
  cases = manifest.cases,
  oraclePath = new URL("./oracle.js", import.meta.url),
} = {}) {
  const trials = new Map();
  let activeTrial;
  const traceTrials = new Map();
  return createServer(async (request, response) => {
    const send = (status, value, type = "application/json") => {
      response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(request.url, "http://fixture");
      if (url.pathname === "/health") return send(200, { ready: true });
      if (url.pathname === "/trial" && request.method === "POST") {
        const { id, caseId, traceId } = JSON.parse(await readBody(request));
        const entry = cases.find((item) => item.id === caseId || item.sourceIds?.includes(caseId));
        if (
          !/^[a-zA-Z0-9_-]{1,100}$/.test(id ?? "") ||
          !entry ||
          trials.has(id) ||
          (traceId !== undefined && (!/^[a-f0-9]{32}$/.test(traceId) || traceTrials.has(traceId)))
        )
          return send(400, { code: "invalid_trial" });
        trials.set(id, { entry, traceId, command: null, observation: null, providerRequest: null });
        if (traceId) traceTrials.set(traceId, id);
        activeTrial = id;
        return send(200, { id });
      }
      if (url.pathname === "/oracle.js")
        return send(200, readFileSync(oraclePath, "utf8"), "text/javascript");
      if (url.pathname.startsWith("/api/v1/models/") && url.pathname.endsWith("/endpoints"))
        return send(200, {
          data: {
            endpoints: [
              {
                provider_name: "Wafer",
                pricing: { prompt: "0.0000000749", completion: "0.00000044" },
              },
            ],
          },
        });
      if (url.pathname === "/api/v1/chat/completions" && request.method === "POST") {
        const traceId = request.headers.traceparent?.split("-")[1];
        // Legacy research runners register serial trials without a trace binding.
        const trialId =
          traceTrials.get(traceId) ?? (!trials.get(activeTrial)?.traceId ? activeTrial : undefined);
        const current = trials.get(trialId);
        if (!current) return send(409, { code: "trial_required" });
        const body = JSON.parse(await readBody(request));
        current.providerRequest = body;
        const fault = current.entry.provider.fault;
        if (fault === "rate_limit")
          return send(429, { error: { message: "Controlled rate limit" } });
        if (fault === "timeout")
          return send(504, { error: { message: "Controlled provider timeout" } });
        const input = JSON.parse(body.messages.find((message) => message.role === "user").content);
        const candidates = input.candidates ?? [];
        const actions = controlledActions(current.entry.provider, candidates, input.context);
        return send(200, {
          id: `deterministic-${trialId}`,
          model: body.model ?? "deepseek/deepseek-v4.1-flash",
          provider: "Wafer",
          choices: [
            {
              finish_reason: fault === "truncated" ? "length" : "stop",
              message: {
                role: "assistant",
                ...(fault === "refusal" ? { refusal: "Controlled refusal" } : {}),
                content:
                  fault === "malformed"
                    ? "{incomplete"
                    : fault === "empty"
                      ? ""
                      : JSON.stringify({ complete: true, actions }),
              },
            },
          ],
          ...(fault === "missing_usage"
            ? {}
            : { usage: { prompt_tokens: 150, completion_tokens: 25, total_tokens: 175 } }),
        });
      }
      const trial = trials.get(url.searchParams.get("trial"));
      if (!trial) return send(404, { code: "trial_not_found" });
      if (url.pathname === "/fixture" || url.pathname === "/frame")
        return send(
          200,
          renderFixture(
            trial.entry.fixture,
            url.searchParams.get("trial"),
            url.searchParams.get("name"),
          ),
          "text/html; charset=utf-8",
        );
      if (url.pathname === "/provider-request") return send(200, trial.providerRequest);
      if (url.pathname === "/command") {
        if (request.method === "POST") {
          trial.command = JSON.parse(await readBody(request));
          trial.observation = null;
          return send(200, { queued: true });
        }
        const command = trial.command;
        trial.command = null;
        return send(200, command);
      }
      if (url.pathname === "/observation") {
        if (request.method === "POST") trial.observation = JSON.parse(await readBody(request));
        return send(200, trial.observation);
      }
      return send(404, { code: "not_found" });
    } catch {
      return send(400, { code: "invalid_fixture_request" });
    }
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) createFixtureServer().listen(8090, "0.0.0.0");
