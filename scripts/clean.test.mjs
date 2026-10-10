import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("clean removes only build outputs and rejects parent symlinks outside the repo", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "xpathed-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "repo/scripts"), { recursive: true });
  const script = join(root, "repo/scripts/clean.mjs");
  await cp(new URL("./clean.mjs", import.meta.url), script);
  for (const directory of [
    "repo/src/Web/dist",
    "repo/src/ClientApi/bin",
    "repo/tests/Browser.Tests/obj",
    "repo/node_modules",
    "repo/.artifacts/python-tools",
    "outside/dist",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "result"), "output");
  }
  await writeFile(join(root, "repo/.env"), "keep");
  await writeFile(join(root, "repo/src/Web/source.ts"), "keep");
  const run = promisify(execFile);
  await run(process.execPath, [script]);
  for (const output of [
    "src/Web/dist/result",
    "src/ClientApi/bin/result",
    "tests/Browser.Tests/obj/result",
  ]) {
    await assert.rejects(readFile(join(root, "repo", output)), { code: "ENOENT" });
  }
  assert.equal(await readFile(join(root, "repo/.env"), "utf8"), "keep");
  assert.equal(await readFile(join(root, "repo/src/Web/source.ts"), "utf8"), "keep");
  assert.equal(await readFile(join(root, "repo/node_modules/result"), "utf8"), "output");
  await run(process.execPath, [script, "--cache"]);
  await assert.rejects(readFile(join(root, "repo/node_modules/result")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "repo/.artifacts/python-tools/result")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(join(root, "repo/.env"), "utf8"), "keep");
  await rm(join(root, "repo/src/Web"), { recursive: true });
  await symlink(join(root, "outside"), join(root, "repo/src/Web"));
  await assert.rejects(run(process.execPath, [script]), /Refusing to clean outside/);
  assert.equal(await readFile(join(root, "outside/dist/result"), "utf8"), "output");
});
