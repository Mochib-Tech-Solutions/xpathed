import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { checkOptions } from "./native-check.mjs";

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function fixture(t, environment = {}, args = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-check-test-")));
  for (const directory of ["scripts", "tests/resolution", "bin"])
    await mkdir(join(root, directory), { recursive: true });
  for (const name of ["native-check.mjs", "native.mjs", "service-process.mjs"])
    await cp(new URL(name, import.meta.url), join(root, "scripts", name));
  await writeFile(
    join(root, ".env"),
    `BROWSER_EXECUTABLE_PATH=${process.execPath}\nOPENROUTER_API_KEY=private-application-key\nOpenRouter__ApiKey=private-direct-key\nOPENROUTER_BASE_URL=https://example.invalid/\n`,
  );
  await writeFile(
    join(root, "bin/dotnet"),
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.equal(process.env.OPENROUTER_API_KEY, undefined);
if (args[0] === 'build') {
  assert.equal(process.env.OpenRouter__ApiKey, undefined);
  assert.ok(args.includes('--artifacts-path'));
  assert.ok(!args[args.indexOf('--artifacts-path') + 1].startsWith(process.cwd() + '/'));
  fs.appendFileSync('events', 'build ' + args[1] + '\n');
  process.exit(process.env.TEST_BUILD_FAIL ? 9 : 0);
} else {
  const name = require('node:path').basename(args[0], '.dll');
  assert.equal(process.env.OpenRouter__ApiKey, name === 'Resolver' ? 'deterministic-fixture-only' : undefined);
  if (name === 'Resolver') {
    const endpoint = new URL(process.env.OpenRouter__BaseUrl);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.equal(endpoint.pathname, '/api/v1/');
  }
  const port = new URL(process.env.ASPNETCORE_URLS).port;
  const server = require('node:http').createServer((req,res) => res.end('healthy'));
  server.listen(Number(port), '127.0.0.1', () => {
    fs.appendFileSync('events', 'ready ' + name + '\n');
    if (process.env.TEST_SERVICE_FAIL === name) setTimeout(() => process.exit(7), 100);
  });
  process.on('SIGTERM', () => server.close(() => { fs.appendFileSync('events', 'stop ' + name + '\n'); process.exit(0); }));
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "tests/resolution/server.mjs"),
    String.raw`
import {createServer} from 'node:http';
createServer((req,res)=>res.end('healthy')).listen(Number(process.env.XPATHED_FIXTURE_PORT), process.env.XPATHED_FIXTURE_HOST);
`,
  );
  await writeFile(
    join(root, "tests/resolution/browser.test.mjs"),
    `
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
test('native browser checks', async () => {
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  assert.equal(process.env.OpenRouter__ApiKey, undefined);
  for (const name of ['XPATHED_BROWSER_URL','XPATHED_RESOLVER_URL','XPATHED_FIXTURE_URL'])
    assert.equal((await fetch(process.env[name] + '/health')).status, 200);
  await writeFile('check-pid', String(process.pid));
  console.log('native checks ready');
  assert.ok(!process.env.TEST_CHECK_FAIL);
  if (process.env.TEST_WAIT) setInterval(()=>{},1000);
});
`,
  );
  await writeFile(
    join(root, "tests/resolution/pipeline.test.mjs"),
    `
import assert from 'node:assert/strict';
import test from 'node:test';
test('native pipeline checks', async () => {
  assert.equal((await fetch(process.env.XPATHED_CLIENT_API_URL + '/health')).status, 200);
  console.log('pipeline checks ready');
});
`,
  );
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...environment };
  for (const key of [
    "NODE_TEST_CONTEXT",
    "XPATHED_ENV_FILE",
    "BROWSER_EXECUTABLE_PATH",
    "OPENROUTER_API_KEY",
    "OpenRouter__ApiKey",
  ])
    delete env[key];
  const child = spawn(
    process.execPath,
    [join(root, "scripts/native-check.mjs"), "resolution", ...args],
    { cwd: root, env, stdio: "pipe" },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (!exited(child)) child.kill("SIGTERM");
    for (let attempt = 0; attempt < 100 && !exited(child); attempt++) await delay(50);
    await rm(root, { recursive: true, force: true });
  });
  const waitFor = async (check) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await delay(50);
    }
    assert.fail(output);
  };
  return {
    child,
    root,
    waitFor,
    output: () => output,
    events: () => readFile(join(root, "events"), "utf8").catch(() => ""),
  };
}

test("native checks build isolated services, run against loopback, then stop every owner", async (t) => {
  const run = await fixture(t);
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 0, run.output());
  assert.match(run.output(), /native checks ready/);
  assert.match(run.output(), /pipeline checks ready/);
  assert.doesNotMatch(run.output(), /private-application-key|private-direct-key|example.invalid/);
  const events = await run.events();
  assert.match(events, /build src\/Browser/);
  assert.match(events, /build src\/Resolver/);
  assert.match(events, /stop Browser/);
  assert.match(events, /stop Resolver/);
  assert.match(events, /build src\/ClientApi/);
  assert.match(events, /stop ClientApi/);
  assert.doesNotMatch(events, /docker/);
});

test("browser-only checks omit the client adapter and pipeline test", async (t) => {
  const run = await fixture(t, {}, ["--browser-only"]);
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 0, run.output());
  assert.match(run.output(), /native checks ready/);
  assert.doesNotMatch(run.output(), /pipeline checks ready/);
  assert.doesNotMatch(await run.events(), /ClientApi/);
});

test("interrupting a native check stops its detached test process and reports cancellation", async (t) => {
  const run = await fixture(t, { TEST_WAIT: "1" });
  await run.waitFor(() => run.output().includes("native checks ready"));
  const pid = Number(await readFile(join(run.root, "check-pid"), "utf8"));
  run.child.kill("SIGTERM");
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 130, run.output());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.match(await run.events(), /stop Browser/);
});

test("a failed native build never starts fixtures or downstream services", async (t) => {
  const run = await fixture(t, { TEST_BUILD_FAIL: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1);
  assert.doesNotMatch(await run.events(), /ready|Resolver/);
  assert.match(run.output(), /Build browser failed/);
});

test("a failed check stops every service and returns failure", async (t) => {
  const run = await fixture(t, { TEST_CHECK_FAIL: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1, run.output());
  assert.match(run.output(), /Chromium browser checks failed/);
  const events = await run.events();
  for (const name of ["Browser", "Resolver", "ClientApi"])
    assert.match(events, new RegExp(`stop ${name}`));
});

test("an unexpected service exit cancels its check and cleans up other owners", async (t) => {
  const run = await fixture(t, { TEST_SERVICE_FAIL: "Resolver", TEST_WAIT: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1, run.output());
  assert.match(run.output(), /resolver stopped/);
  assert.match(await run.events(), /stop Browser/);
});

test("unsupported check modes fail before startup", () => {
  for (const args of [
    [],
    ["other"],
    ["resolution", "--live"],
    ["resolution", "--browser-only", "--live"],
  ])
    assert.throws(() => checkOptions(args), /provider-free checks/);
});
