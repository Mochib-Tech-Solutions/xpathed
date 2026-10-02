import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { classifyChanges } from "./ci-changes.mjs";
import { validateEvent, validateMessage } from "./commit-policy.mjs";
import { installHooks } from "./install-hooks.mjs";
import { checkCommands, checkStaged, runCheckGroups } from "./pre-commit.mjs";

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-hooks-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Hook test");
  git("config", "user.email", "hooks@example.invalid");
  git("config", "commit.gpgSign", "false");
  const write = (path, text) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  write("README.md", "base\n");
  git("add", ".");
  git("commit", "-m", "legacy history is not rewritten");
  return { cwd, git, write };
}

test("local command selection reuses CI ownership and excludes integration/paid runs", () => {
  assert.deepEqual(checkCommands(["docs/runtime.md"]), []);
  assert.deepEqual(checkCommands(["src/Web/src/App.tsx"]), [["pnpm", "check:web"]]);
  assert.deepEqual(checkCommands([".githooks/commit-msg"]), [["pnpm", "check:tooling"]]);
  assert.equal(classifyChanges([".githooks/pre-commit"]).tooling, true);
  for (const [paths, expected] of [
    [["src/Resolver/Resolver.csproj"], ["Resolver"]],
    [["src/Common/Contracts.cs"], ["Common", "Browser", "ClientApi", "Resolver"]],
    [["tests/ClientApi.IntegrationTests/RecordTests.cs"], ["ClientApi"]],
  ]) {
    const commands = checkCommands(paths);
    assert.deepEqual(
      commands.filter((cmd) => cmd[1] === "scripts/ci-dotnet-tests.mjs").map((cmd) => cmd[2]),
      expected,
    );
    for (const project of expected)
      assert.ok(
        commands.some((cmd) => cmd[1] === "build" && cmd[2] === `src/${project}/${project}.csproj`),
      );
  }
  const all = checkCommands(["package.json"]);
  assert.ok(all.some((cmd) => cmd[1] === "build:dotnet"));
  assert.ok(all.some((cmd) => cmd[1] === "docker:check"));
  assert.ok(!JSON.stringify(all).match(/evaluate|test:persistence|test:resolution|--live/));
});

test("Conventional Commits covers optional scopes, breaking changes and rejects malformed headers", () => {
  for (const message of [
    "feat: add hooks",
    "fix(browser): preserve identity",
    "refactor(api)!: change contract\n\nBREAKING CHANGE: new response",
    "revert: remove obsolete behavior",
    "docs: explain café",
  ])
    assert.doesNotThrow(() => validateMessage(message));
  for (const message of [
    "",
    "Add hooks",
    "fix:",
    "fix: ",
    "feat(): title",
    "feat(a b): title",
    "feat: title ",
    "fixup! fix: title",
    'Merge branch "main"',
    "unknown: title",
    "feat: \nbody",
  ])
    assert.throws(() => validateMessage(message), /type\(scope\)/);
});

test("CI checks the PR title and all introduced commits without linting base history", (t) => {
  const { cwd, git } = repository(t);
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  git("commit", "--allow-empty", "-m", "feat: valid commit");
  const good = git("rev-parse", "HEAD");
  const event = (head, title = "feat: valid title") => ({
    pull_request: { title, base: { sha: base }, head: { sha: head } },
  });
  assert.doesNotThrow(() => validateEvent("pull_request", event(good), cwd));
  assert.throws(() => validateEvent("pull_request", event(good, "invalid title"), cwd), /PR title/);
  git("commit", "--allow-empty", "-m", "bad intermediate commit");
  const bad = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-m", "fix: valid tip");
  assert.throws(
    () => validateEvent("pull_request", event(git("rev-parse", "HEAD")), cwd),
    new RegExp(bad),
  );
  assert.doesNotThrow(() => validateEvent("push", { before: base, after: good }, cwd));
  assert.throws(() => validateEvent("push", { before: base, after: bad }, cwd), new RegExp(bad));
  assert.throws(
    () => validateEvent("push", { before: "--all", after: good }, cwd),
    /Invalid event/,
  );
  git("checkout", "-b", "verbatim", base);
  git("commit", "--allow-empty", "--cleanup=verbatim", "-m", "  fix: invalid leading spaces");
  assert.throws(
    () => validateEvent("push", { before: base, after: git("rev-parse", "HEAD") }, cwd),
    /type\(scope\)/,
  );
});

test("hook installation is idempotent and isolated to a linked worktree", (t) => {
  const { cwd, git } = repository(t);
  const linked = join(cwd, "linked");
  git("worktree", "add", "-b", "feature", linked);
  installHooks(linked);
  installHooks(linked);
  assert.equal(git("-C", linked, "config", "get", "core.hooksPath"), ".githooks");
  assert.equal(git("config", "get", "--default", "absent", "core.hooksPath"), "absent");
  git("config", "--worktree", "core.hooksPath", "custom-hooks");
  assert.throws(() => installHooks(cwd), /Existing core.hooksPath/);
  assert.equal(git("config", "get", "core.hooksPath"), "custom-hooks");
});

test("real Git hooks block invalid commits, failed checks and partial staging without touching work", (t) => {
  const { cwd, git, write } = repository(t);
  for (const path of [".githooks", "scripts"]) mkdirSync(join(cwd, path), { recursive: true });
  cpSync(resolve(".githooks"), join(cwd, ".githooks"), { recursive: true });
  for (const name of ["pre-commit.mjs", "commit-policy.mjs", "ci-changes.mjs"])
    cpSync(resolve("scripts", name), join(cwd, "scripts", name));
  write("src/Web/old name.ts", "staged\n");
  write(".gitignore", "fake-bin/\ncommands.log\n");
  git("add", ".");
  git("commit", "-m", "test: prepare hooks");
  installHooks(cwd);
  const bin = join(cwd, "fake-bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> commands.log\nif [ -f src/Web/fail.ts ]; then exit 1; fi\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const commit = (message) =>
    spawnSync("git", ["commit", "-m", message], { cwd, env, encoding: "utf8" });
  write("README.md", "docs only\n");
  git("add", "README.md");
  assert.notEqual(commit("invalid title").status, 0);
  assert.notEqual(commit("# invalid header\nfix: valid second line").status, 0);
  assert.notEqual(commit("  fix: invalid leading spaces").status, 0);
  assert.equal(commit("docs: valid title").status, 0);
  assert.equal(spawnSync("test", ["-e", join(cwd, "commands.log")]).status, 1);
  write("src/Web/old name.ts", "new staged value\n");
  git("add", "src/Web/old name.ts");
  write("src/Web/old name.ts", "unstaged value\n");
  const index = git("write-tree");
  const rejected = commit("fix: partial staging");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Stage or set aside/);
  assert.equal(git("write-tree"), index);
  assert.equal(readFileSync(join(cwd, "src/Web/old name.ts"), "utf8"), "unstaged value\n");
  git("add", "src/Web/old name.ts");
  write("src/Web/untracked.ts", "untracked\n");
  assert.notEqual(commit("fix: missing staged file").status, 0);
  git("add", "src/Web/untracked.ts");
  write("src/Web/fail.ts", "fail\n");
  git("add", "src/Web/fail.ts");
  assert.notEqual(commit("fix: failing checks").status, 0);
  rmSync(join(cwd, "src/Web/fail.ts"));
  git("add", "-A");
  assert.equal(commit("fix(web): passing checks").status, 0);
  renameSync(join(cwd, "src/Web/old name.ts"), join(cwd, "src/Web/new name.ts"));
  rmSync(join(cwd, "src/Web/untracked.ts"));
  git("add", "-A");
  assert.equal(commit("refactor(web): rename and delete").status, 0);
  assert.deepEqual(readFileSync(join(cwd, "commands.log"), "utf8").trim().split("\n"), [
    "check:web",
    "check:web",
    "check:web",
  ]);
});

test("empty index needs no build tools", async (t) => {
  const { cwd } = repository(t);
  await assert.doesNotReject(() => checkStaged(cwd));
});

test("independent check groups overlap, preserve dependency order and report failures after completion", async (t) => {
  const { cwd } = repository(t);
  const cmd = (body) => [process.execPath, "--input-type=module", "-e", body];
  await assert.rejects(
    runCheckGroups(
      [
        [
          cmd(
            'import { writeFileSync, existsSync } from "node:fs"; writeFileSync("a", ""); while (!existsSync("b")) { await new Promise(r => setTimeout(r, 10)); }',
          ),
          cmd("process.exit(7)"),
        ],
        [
          cmd(
            'import { writeFileSync, existsSync } from "node:fs"; writeFileSync("b", ""); while (!existsSync("a")) { await new Promise(r => setTimeout(r, 10)); } writeFileSync("completed", "");',
          ),
        ],
      ],
      { cwd, timeout: 5000 },
    ),
    /failed/,
  );
  assert.equal(readFileSync(join(cwd, "completed"), "utf8"), "");
});
