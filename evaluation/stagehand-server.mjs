import { createServer } from "node:http";
import { readdir, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deterministicObservation,
  normalizeActions,
  requestObservation,
  stagehandVersion,
} from "./stagehand.mjs";
import {
  localBrowser,
  Stagehand,
} from "./stagehand/node_modules/@browserbasehq/stagehand/dist/index.mjs";

let browser;
let stagehand;
let page;
let activeRequest;
let providerCalls = 0;
let modelCalls = 0;
let modelInputs = [];
let busy = false;
let browserBinarySha256;
let browserProfile;

async function reset() {
  try {
    await stagehand?.close();
  } finally {
    await browser?.close();
    if (browserProfile) await rm(browserProfile, { recursive: true, force: true });
    browserProfile = undefined;
    browser = stagehand = page = undefined;
  }
}

async function prepare({ url, viewport = { width: 1279, height: 799 } }) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid_fixture_url");
  // Evaluation fixtures only: never attach this adapter to a user's browser.
  const fixtureOrigin = new URL(
    process.env.STAGEHAND_FIXTURE_ORIGIN ?? "http://evaluation-fixture:8090",
  );
  if (parsed.origin !== fixtureOrigin.origin) throw new Error("invalid_fixture_origin");
  await reset();
  const directory = (await readdir("/ms-playwright")).find((name) => /^chromium-\d+$/.test(name));
  const architecture = process.arch === "arm64" ? "arm64" : "64";
  const executablePath = `/ms-playwright/${directory}/chrome-linux-${architecture}/chrome`;
  if (!browserBinarySha256) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
    browserBinarySha256 = hash.digest("hex");
  }
  browserProfile = await mkdtemp(join(tmpdir(), "stagehand-evaluation-"));
  await mkdir(join(browserProfile, "Default"));
  await writeFile(
    join(browserProfile, "Default", "Preferences"),
    JSON.stringify({ intl: { accept_languages: "en-US,en", selected_languages: "en-US,en" } }),
  );
  browser = await localBrowser.launch({
    executablePath,
    userDataDir: browserProfile,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      "--kiosk",
      "--window-position=0,0",
      "--accept-lang=en-US,en",
      "--disable-features=ReduceAcceptLanguage",
    ],
  });
  stagehand = await Stagehand.create({
    browser,
    cache: false,
    selfHeal: false,
    logging: { level: "off" },
    telemetry: { traces: { endpoint: "http://127.0.0.1:8092/v1/traces" } },
    model: {
      generate: async (params) => {
        modelCalls++;
        modelInputs.push(params);
        if (activeRequest?.mode === "live") {
          providerCalls++;
          return requestObservation(
            params,
            process.env.STAGEHAND_MODEL_URL ??
              "http://comparison-runner:8091/api/v1/chat/completions",
          );
        }
        return deterministicObservation(params, activeRequest?.deterministic);
      },
    },
  });
  page = (await browser.context.pages())[0] ?? (await browser.context.newPage());
  // Match the Browser arm's measured content viewport before fixture setup/inference.
  await page.setViewportSize(viewport.width, viewport.height);
  await page.goto(url);
  const environment = await page.evaluate(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    userAgent: navigator.userAgent,
    languages: [...navigator.languages],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  return { ready: true, stagehandVersion, browserBinarySha256, ...environment };
}

async function observe(body) {
  if (!page) throw new Error("prepare_required");
  if (typeof body.instruction !== "string" || body.instruction.length > 10000)
    throw new Error("invalid_instruction");
  if (!["singleton", "all"].includes(body.cardinality)) throw new Error("invalid_cardinality");
  if (![undefined, "deterministic", "live"].includes(body.mode)) throw new Error("invalid_mode");
  activeRequest = body;
  providerCalls = 0;
  modelCalls = 0;
  modelInputs = [];
  const started = performance.now();
  try {
    const result = await stagehand.observe(body.instruction, {
      page,
      cache: false,
      timeout: 60000,
    });
    return {
      ...normalizeActions(result.data, body.cardinality),
      rawActions: result.data,
      metadata: result.metadata,
      usage: result.metadata.usage,
      providerCalls,
      modelCalls,
      modelInputs,
      elapsedMs: performance.now() - started,
      stagehandVersion,
    };
  } catch (error) {
    return {
      status: "error",
      error: error.message,
      targets: [],
      rawActions: [],
      unsupported: [],
      providerCalls,
      modelCalls,
      modelInputs,
      elapsedMs: performance.now() - started,
      stagehandVersion,
    };
  } finally {
    activeRequest = undefined;
  }
}

const server = createServer(async (request, response) => {
  const send = (status, result) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  };
  if (request.method === "GET" && request.url === "/health")
    return send(200, { ready: true, stagehandVersion });
  if (request.method === "POST" && request.url === "/v1/traces") {
    request.resume();
    return send(200, {});
  }
  if (busy) return send(409, { error: "adapter_busy" });
  busy = true;
  try {
    if (request.method !== "POST") return send(405, { error: "method_not_allowed" });
    let data = "";
    for await (const chunk of request) {
      data += chunk;
      if (data.length > 100000) throw new Error("request_too_large");
    }
    const body = JSON.parse(data || "{}");
    if (request.url === "/prepare") return send(200, await prepare(body));
    if (request.url === "/observe") return send(200, await observe(body));
    if (request.url === "/reset") {
      await reset();
      return send(200, { ready: true });
    }
    return send(404, { error: "not_found" });
  } catch (error) {
    return send(400, { error: error.message });
  } finally {
    busy = false;
  }
});
server.listen(8092, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await reset();
    server.close();
  });
