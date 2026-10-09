import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkEnvironment, checkOptions } from "./native-check.mjs";
import { developmentConfig } from "./native.mjs";

async function fixture(t, content) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xpathed-check-config-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env"), content);
  return root;
}

test("live evaluation requires its dedicated key and never uses the application key", async (t) => {
  const root = await fixture(
    t,
    "OPENROUTER_API_KEY=app-private\nOPENROUTER_EVAL_API_KEY=eval-private\n",
  );
  const options = checkOptions(["evaluation", "--mode", "live"]);
  const env = await checkEnvironment(root, options, {});
  assert.equal(env.OPENROUTER_API_KEY, "eval-private");
  const config = developmentConfig(root, env);
  assert.equal(config.services[1].env.OpenRouter__ApiKey, "eval-private");
  assert.doesNotMatch(JSON.stringify(config.services[0]), /eval-private|app-private/);
  await writeFile(join(root, ".env"), "OPENROUTER_API_KEY=app-private\n");
  await assert.rejects(checkEnvironment(root, options, {}), /Set OPENROUTER_EVAL_API_KEY/);
});

test("controlled checks exclude live provider keys and preserve browser concurrency limits", async (t) => {
  const root = await fixture(
    t,
    "OPENROUTER_API_KEY=app-private\nOPENROUTER_EVAL_API_KEY=eval-private\n",
  );
  const options = checkOptions(["evaluation", "--concurrency", "4"]);
  const env = await checkEnvironment(root, options, {});
  assert.equal(env.OPENROUTER_API_KEY, "deterministic-fixture-only");
  env.OPENROUTER_BASE_URL = "http://127.0.0.1:18090/api/v1/";
  const resolver = developmentConfig(root, env).services[1];
  assert.equal(resolver.env.OpenRouter__BaseUrl, env.OPENROUTER_BASE_URL);
  assert.doesNotMatch(JSON.stringify(resolver), /app-private|eval-private/);
  for (const args of [
    ["--concurrency", "0"],
    ["--concurrency", "5"],
    ["--mode", "live", "--concurrency", "2"],
  ])
    assert.throws(() => checkOptions(["evaluation", ...args]), /concurrency/i);
});

test("custom suites remain confined to controlled checks inside the checkout", async (t) => {
  const root = await fixture(t, "");
  const outside = await fixture(t, "");
  await writeFile(join(root, "suite.json"), "{}");
  await writeFile(join(outside, "suite.json"), "{}");
  const options = checkOptions(["evaluation", "--suite", "suite.json"]);
  assert.equal(
    (await checkEnvironment(root, options, {})).XPATHED_EVALUATION_SUITE,
    join(root, "suite.json"),
  );
  await assert.rejects(
    checkEnvironment(root, { ...options, suite: join(outside, "suite.json") }, {}),
    /under this checkout/,
  );
  assert.throws(
    () => checkOptions(["evaluation", "--mode", "live", "--suite", "suite.json"]),
    /controlled provider-free/,
  );
});

test("removed comparison options and conflicting modes fail before startup", () => {
  for (const args of [
    ["--qualification"],
    ["--monitoring", "run"],
    ["--profile", "configured"],
    ["--xpath", "--xpath"],
  ])
    assert.throws(() => checkOptions(["evaluation", ...args]), /evaluation option/);
  assert.throws(() => checkOptions(["evaluation", "--xpath", "--mode", "live"]), /provider-free/);
  assert.throws(() => checkOptions(["resolution", "--live", "--browser-only"]), /Use/);
  assert.throws(() => checkOptions(["evaluation", "--replay", "old-run"]), /evaluate:replay/);
  assert.equal(checkOptions(["resolution", "--browser-only"]).browserOnly, true);
});

test("explicit live resolution checks retain the cheap route and application key", async (t) => {
  const root = await fixture(
    t,
    "OPENROUTER_API_KEY=app-private\nOPENROUTER_MODEL=other/model\nOPENROUTER_PROVIDER=other\n",
  );
  const env = await checkEnvironment(root, checkOptions(["resolution", "--live"]), {});
  assert.equal(env.OPENROUTER_API_KEY, "app-private");
  assert.equal(env.OPENROUTER_MODEL, "deepseek/deepseek-v4.1-flash");
  assert.equal(env.OPENROUTER_PROVIDER, "wafer");
});
