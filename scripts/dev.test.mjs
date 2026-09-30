import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "xpathed-dev-")));
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGTERM");
    await delay(200);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "docker"));
  await mkdir(join(root, "bin"));
  await cp(new URL("./dev.mjs", import.meta.url), join(root, "scripts/dev.mjs"));
  await cp(new URL("../docker/compose.sh", import.meta.url), join(root, "docker/compose.sh"));
  await writeFile(join(root, ".env"), "POSTGRES_PASSWORD=keep-this\n");
  await writeFile(join(root, "database"), "keep-data");
  await writeFile(join(root, "scripts/setup.sh"), "#!/bin/sh\nprintf 'setup\\n' >> events\n", {
    mode: 0o755,
  });
  await writeFile(
    join(root, "bin/docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'ps') {
  if (process.env.TEST_DELAY_PS) { fs.appendFileSync('events', 'project-query\\n'); setTimeout(() => process.exit(0), 1000); }
  else { if (process.env.TEST_PROJECT_OWNER) console.log('fixture-container'); process.exit(0); }
  return;
}
if (args[0] === 'inspect') { console.log(process.env.TEST_PROJECT_OWNER); process.exit(0); }
const command = args.includes('up') ? 'up' : args.includes('down') ? 'down' : 'other';
if (command === 'up' && process.env.TEST_PLUGIN_CHILD && !process.env.TEST_IN_PLUGIN) {
  require('node:child_process').spawn(process.execPath, [__filename, ...args], { env: { ...process.env, TEST_IN_PLUGIN:'1' }, stdio:'inherit' });
  process.on('SIGINT', () => {});
  return;
}
fs.appendFileSync('events', command + ' ' + JSON.stringify(args) + '\\n');
if (command === 'down') { fs.rmSync('running', { force:true }); process.exit(0); }
if (command === 'up') {
  if (fs.existsSync('running')) fs.appendFileSync('events', 'overlap\\n');
  fs.writeFileSync('running', String(process.pid));
  const timer = setInterval(() => {
    if (!fs.existsSync('running') || fs.readFileSync('running', 'utf8') !== String(process.pid)) { fs.appendFileSync('events', 'exited ' + process.pid + '\\n'); clearInterval(timer); }
  }, 20);
  process.on('SIGINT', () => { fs.rmSync('running', { force:true }); process.exit(0); });
}
`,
    { mode: 0o755 },
  );
  const start = (extraEnv = {}, legacy = false) => {
    const child = spawn(
      legacy ? join(root, "docker/compose.sh") : process.execPath,
      legacy ? ["--dev", "up", "--build", "--watch"] : [join(root, "scripts/dev.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          COMPOSE_PROJECT_NAME: "dev-command-test",
          ...extraEnv,
        },
        stdio: "pipe",
      },
    );
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.output = () => output;
    return child;
  };
  async function waitFor(check) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail(children.map((child) => child.output()).join("\n"));
  }
  const events = () => readFile(join(root, "events"), "utf8").catch(() => "");
  const waitForUps = (count) =>
    waitFor(async () => (await events()).split("up ").length >= count + 1);
  return { root, start, events, waitFor, waitForUps };
}

test("dev replaces its previous owner and retains configuration and database data", async (t) => {
  const { root, start, events, waitFor, waitForUps } = await fixture(t);
  const first = start();
  await waitForUps(1);
  const second = start();
  await waitForUps(2);
  await waitFor(() => exited(first));
  assert.equal(second.exitCode, null);
  second.kill("SIGTERM");
  await waitFor(() => exited(second));
  assert.doesNotMatch(await events(), /--volumes|--remove-orphans|overlap/);
  assert.equal(await readFile(join(root, ".env"), "utf8"), "POSTGRES_PASSWORD=keep-this\n");
  assert.equal(await readFile(join(root, "database"), "utf8"), "keep-data");
});

test("concurrent dev invocations serialize setup and leave one owner", async (t) => {
  const { start, events, waitFor, waitForUps } = await fixture(t);
  const first = start();
  await waitForUps(1);
  const challengers = [start(), start()];
  await waitFor(() => exited(first) && challengers.filter((child) => !exited(child)).length === 1);
  await waitForUps(2);
  await delay(100);
  assert.doesNotMatch(await events(), /overlap/);
  const log = await events();
  assert.doesNotMatch(log.slice(log.lastIndexOf("up ")), /down /);
  challengers.find((child) => !exited(child)).kill("SIGTERM");
  await waitFor(() => challengers.every(exited));
});

test("a crashed owner is replaced and its orphaned Compose watcher retires", async (t) => {
  const { root, start, events, waitFor, waitForUps } = await fixture(t);
  const first = start();
  await waitForUps(1);
  const oldWatcher = await readFile(join(root, "running"), "utf8");
  first.kill("SIGKILL");
  await waitFor(() => exited(first));
  const second = start();
  await waitForUps(2);
  await waitFor(async () => (await events()).includes(`exited ${oldWatcher}`));
  assert.equal(second.exitCode, null);
  second.kill("SIGTERM");
  await waitFor(() => exited(second));
  assert.doesNotMatch(await events(), /overlap/);
});

test("a legacy attached Compose watcher retires before the new dev run", async (t) => {
  const { start, events, waitFor, waitForUps } = await fixture(t);
  const legacy = start({}, true);
  await waitForUps(1);
  const current = start();
  await waitForUps(2);
  await waitFor(() => exited(legacy));
  assert.equal(current.exitCode, null);
  current.kill("SIGTERM");
  await waitFor(() => exited(current));
  assert.doesNotMatch(await events(), /overlap/);
});

test("replacement stops the owned Docker Compose plugin child", async (t) => {
  const { start, events, waitFor, waitForUps } = await fixture(t);
  const first = start({ TEST_PLUGIN_CHILD: "1" });
  await waitForUps(1);
  const second = start();
  await waitForUps(2);
  await waitFor(() => exited(first));
  assert.equal(second.exitCode, null);
  assert.doesNotMatch(await events(), /overlap/);
  second.kill("SIGTERM");
  await waitFor(() => exited(second));
});

test("dev refuses a Compose project from another checkout before cleanup", async (t) => {
  const { root, start, events, waitFor } = await fixture(t);
  await mkdir(join(root, "other-checkout"));
  const current = start({ TEST_PROJECT_OWNER: join(root, "other-checkout") });
  await waitFor(() => exited(current));
  assert.equal(current.exitCode, 1);
  assert.match(current.output(), /belongs to another checkout/);
  assert.doesNotMatch(await events(), /down |up /);
});

test("interrupting project ownership checks cannot authorize cleanup", async (t) => {
  const { start, events, waitFor } = await fixture(t);
  const current = start({ TEST_DELAY_PS: "1" });
  await waitFor(async () => (await events()).includes("project-query"));
  current.kill("SIGTERM");
  await waitFor(() => exited(current));
  assert.doesNotMatch(await events(), /down |up /);
});

for (const method of ["end", "resetAndDestroy"])
  test(`dev fails safely when a foreign listener uses ${method} without identifying itself`, async (t) => {
    const { root, start, events, waitFor } = await fixture(t);
    const digest = createHash("sha256").update(`${root}\0dev-command-test`).digest("hex");
    const port = 30000 + (Number.parseInt(digest.slice(0, 8), 16) % 30000);
    const foreign = createServer((socket) => socket[method]());
    await new Promise((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => foreign.close(resolve)));
    const current = start();
    await waitFor(() => exited(current));
    assert.equal(current.exitCode, 1);
    assert.match(current.output(), /occupied by another process|ECONNRESET/);
    assert.equal(await events(), "");
  });
