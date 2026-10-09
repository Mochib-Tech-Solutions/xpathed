import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const exited = (child) => child.exitCode !== null || child.signalCode !== null;
async function fixture(t, environment = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-check-test-")));
  for (const directory of ["scripts", "evaluation/fixtures", "bin"])
    await mkdir(join(root, directory), { recursive: true });
  for (const name of ["native-check.mjs", "native.mjs", "service-process.mjs"])
    await cp(new URL(name, import.meta.url), join(root, "scripts", name));
  await cp(
    new URL("../evaluation/environment.mjs", import.meta.url),
    join(root, "evaluation/environment.mjs"),
  );
  await writeFile(
    join(root, ".env"),
    `BROWSER_EXECUTABLE_PATH=${process.execPath}\nOPENROUTER_API_KEY=private-application-key\nOPENROUTER_EVAL_API_KEY=private-evaluation-key\n`,
  );
  await writeFile(
    join(root, "bin/dotnet"),
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'build') {
  fs.appendFileSync('events', 'build ' + args[1] + '\n');
  process.exit(process.env.TEST_BUILD_FAIL ? 9 : 0);
} else {
  const name = require('node:path').basename(args[0], '.dll');
  const port = new URL(process.env.ASPNETCORE_URLS).port;
  const server = require('node:http').createServer((req,res) => res.end('healthy'));
  server.listen(Number(port), '127.0.0.1', () => fs.appendFileSync('events', 'ready ' + name + '\n'));
  process.on('SIGTERM', () => server.close(() => { fs.appendFileSync('events', 'stop ' + name + '\n'); process.exit(0); }));
}
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(root, "evaluation/fixtures/server.mjs"),
    String.raw`
import {createServer} from 'node:http';
createServer((req,res)=>res.end('healthy')).listen(Number(process.env.XPATHED_FIXTURE_PORT), process.env.XPATHED_FIXTURE_HOST);
`,
  );
  await writeFile(
    join(root, "evaluation/run.mjs"),
    `
export {parseOptions} from ${JSON.stringify(new URL("../evaluation/run.mjs", import.meta.url).href)};
if (import.meta.main) {
  const {writeFile} = await import('node:fs/promises');
  const assert = (await import('node:assert/strict')).default;
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
  assert.equal(process.env.OPENROUTER_EVAL_API_KEY, undefined);
  for (const name of ['XPATHED_BROWSER_URL','XPATHED_RESOLVER_URL','XPATHED_FIXTURE_URL'])
    assert.equal((await fetch(process.env[name] + '/health')).status, 200);
  await writeFile('evaluation-pid', String(process.pid));
  console.log('native checks ready');
  if (process.env.TEST_WAIT) setInterval(()=>{},1000);
}
`,
  );
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...environment };
  for (const key of [
    "XPATHED_ENV_FILE",
    "BROWSER_EXECUTABLE_PATH",
    "OPENROUTER_API_KEY",
    "OPENROUTER_EVAL_API_KEY",
  ])
    delete env[key];
  const child = spawn(process.execPath, [join(root, "scripts/native-check.mjs"), "evaluation"], {
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

test("native checks build isolated services, run against loopback, then stop every owner", async (t) => {
  const run = await fixture(t);
  await run.waitFor(() => exited(run.child));
  assert.equal(run.child.exitCode, 0, run.output());
  assert.match(run.output(), /native checks ready/);
  assert.doesNotMatch(run.output(), /private-application-key|private-evaluation-key/);
  const events = await run.events();
  assert.match(events, /build src\/Browser/);
  assert.match(events, /build src\/Resolver/);
  assert.match(events, /stop Browser/);
  assert.match(events, /stop Resolver/);
  assert.doesNotMatch(events, /ClientApi|docker/);
});

test("interrupting a native check stops its detached test process and reports cancellation", async (t) => {
  const run = await fixture(t, { TEST_WAIT: "1" });
  await run.waitFor(() => run.output().includes("native checks ready"));
  const pid = Number(await readFile(join(run.root, "evaluation-pid"), "utf8"));
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
