import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { checkOptions } from "./native-check.mjs";

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function fixture(t, environment = {}) {
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
    join(root, "tests/resolution/browser.test.mjs"),
    `
import {readFile, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
async function check(name, peer) {
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  assert.equal(process.env.OpenRouter__ApiKey, undefined);
  for (const name of ['XPATHED_BROWSER_URL','XPATHED_RESOLVER_URL'])
    assert.equal((await fetch(process.env[name] + '/health')).status, 200);
  const identity = {pid: process.pid, port: process.env.XPATHED_ORACLE_PORT};
  assert.equal(new URL(process.env.XPATHED_ORACLE_URL).port, identity.port);
  await writeFile('check-' + name, JSON.stringify(identity));
  let other;
  for (let attempt = 0; attempt < 100 && !other; attempt++) {
    other = await readFile('check-' + peer, 'utf8').then(JSON.parse).catch(() => undefined);
    if (!other) await delay(10);
  }
  assert.ok(other, 'Both workers must start before either finishes');
  assert.notEqual(identity.pid, other.pid);
  assert.notEqual(identity.port, other.port);
  console.log('native checks ready');
  assert.ok(!process.env.TEST_CHECK_FAIL || name !== 'capture');
  if (process.env.TEST_WAIT) setInterval(()=>{},1000);
}
test('capture-native browser checks', () => check('capture', 'xpath'));
test('xpath-native browser checks', () => check('xpath', 'capture'));
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
  const child = spawn(process.execPath, [join(root, "scripts/native-check.mjs")], {
    cwd: root,
    env,
    stdio: "pipe",
  });
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

test("native checks share services across isolated parallel workers, then stop every owner", async (t) => {
  const run = await fixture(t);
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 0, run.output());
  assert.match(run.output(), /native checks ready/);
  assert.doesNotMatch(run.output(), /private-application-key|private-direct-key|example.invalid/);
  const events = await run.events();
  assert.match(events, /build src\/Browser/);
  assert.match(events, /build src\/Resolver/);
  assert.match(events, /stop Browser/);
  assert.match(events, /stop Resolver/);
  assert.doesNotMatch(events, /ClientApi|fixture/);
  assert.doesNotMatch(events, /docker/);
});

test("interrupting a native check stops its detached test process and reports cancellation", async (t) => {
  const run = await fixture(t, { TEST_WAIT: "1" });
  await run.waitFor(() => run.output().includes("native checks ready"));
  const identities = await Promise.all(
    ["capture", "xpath"].map(async (name) =>
      JSON.parse(await readFile(join(run.root, `check-${name}`), "utf8")),
    ),
  );
  run.child.kill("SIGTERM");
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 130, run.output());
  for (const { pid } of identities) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.match(await run.events(), /stop Browser/);
});

test("a failed native build never starts downstream services", async (t) => {
  const run = await fixture(t, { TEST_BUILD_FAIL: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1);
  assert.doesNotMatch(await run.events(), /ready|Resolver/);
  assert.match(run.output(), /Build browser failed/);
});

test("a failed worker stops its peer and every service and returns failure", async (t) => {
  const run = await fixture(t, { TEST_CHECK_FAIL: "1", TEST_WAIT: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1, run.output());
  assert.match(run.output(), /Chromium browser checks 1 failed/);
  const { pid } = JSON.parse(await readFile(join(run.root, "check-xpath"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const events = await run.events();
  for (const name of ["Browser", "Resolver"]) assert.match(events, new RegExp(`stop ${name}`));
});

test("an unexpected service exit cancels its check and cleans up other owners", async (t) => {
  const run = await fixture(t, { TEST_SERVICE_FAIL: "Resolver", TEST_WAIT: "1" });
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 1, run.output());
  assert.match(run.output(), /resolver stopped/);
  assert.match(await run.events(), /stop Browser/);
});

test("unsupported check options fail before startup", () => {
  checkOptions([]);
  checkOptions(["--"]);
  for (const args of [["other"], ["--live"], ["--browser-only"]])
    assert.throws(() => checkOptions(args), /without options/);
});
