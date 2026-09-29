import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedPaths, classifyChanges, projects } from "./ci-changes.mjs";
import { testProjects } from "./ci-dotnet-tests.mjs";

const none = { dotnet: [], web: false, tooling: false, docker: false, solution: false };
const all = { dotnet: projects, web: true, tooling: true, docker: true, solution: true };

for (const [path, expected] of [
  ["README.md", none],
  ["docs/runtime.md", none],
  ["src/Web/src/features/browser/App.tsx", { ...none, web: true }],
  ["src/Web/package.json", { ...none, web: true }],
  ["pnpm-lock.yaml", { ...none, web: true, tooling: true }],
  ["pnpm-workspace.yaml", { ...none, web: true, tooling: true }],
  [".npmrc", { ...none, web: true, tooling: true }],
  ["src/Browser/Sessions/BrowserSessions.cs", { ...none, dotnet: ["Browser"] }],
  ["src/Resolver/Resolver.csproj", { ...none, dotnet: ["Resolver"] }],
  ["tests/ClientApi.Tests/SessionTests.cs", { ...none, dotnet: ["ClientApi"] }],
  ["src/Common/Contracts/Session.cs", { ...none, dotnet: projects }],
  ["tests/Common.Tests/ContractTests.cs", { ...none, dotnet: projects }],
  ["Directory.Build.props", { ...none, dotnet: projects }],
  ["Xpathed.slnx", { ...none, dotnet: projects, solution: true }],
  ["Directory.Packages.props", { ...none, dotnet: projects }],
  ["tests/Directory.Build.props", { ...none, dotnet: projects }],
  ["global.json", { ...none, dotnet: projects, tooling: true }],
  [".editorconfig", { ...none, dotnet: projects, web: true, tooling: true }],
  [".prettierrc.json", { ...none, web: true, tooling: true }],
  [".github/workflows/check.yml", all],
  ["scripts/ci-changes.mjs", all],
  ["scripts/ci-dotnet-tests.mjs", { ...none, dotnet: projects, tooling: true }],
  ["package.json", all],
  ["scripts/format.sh", { ...none, dotnet: projects, web: true, tooling: true }],
  ["scripts/ci-docker.sh", { ...none, tooling: true, docker: true }],
  ["scripts/clean.mjs", { ...none, tooling: true }],
  ["compose.dev.yaml", { ...none, tooling: true, docker: true }],
  ["infra/nginx.conf", { ...none, tooling: true, docker: true }],
  ["src/Web/Dockerfile", { ...none, tooling: true, docker: true }],
  ["src/Browser/Dockerfile", { ...none, tooling: true, docker: true }],
  [".dockerignore", { ...none, tooling: true, docker: true }],
]) {
  test(`selects relevant jobs for ${path}`, () =>
    assert.deepEqual(classifyChanges([path]), expected));
}

test("Git event ranges include deletions and both rename owners, and PRs use merge-base", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-ci-changes-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "CI test");
  git("config", "user.email", "ci@example.invalid");
  for (const project of ["Browser", "Resolver", "Web"])
    mkdirSync(join(cwd, "src", project), { recursive: true });
  writeFileSync(join(cwd, "src/Browser/Original.cs"), "moved source");
  writeFileSync(join(cwd, "src/Web/removed.ts"), "deleted source");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature");
  renameSync(join(cwd, "src/Browser/Original.cs"), join(cwd, "src/Resolver/Renamed.cs"));
  rmSync(join(cwd, "src/Web/removed.ts"));
  git("add", "-A");
  git("commit", "-m", "rename and delete");
  const head = git("rev-parse", "HEAD");
  const expected = ["src/Browser/Original.cs", "src/Resolver/Renamed.cs", "src/Web/removed.ts"];
  assert.deepEqual(changedPaths("push", { before: base, after: head }, cwd).sort(), expected);
  git("checkout", "main");
  writeFileSync(join(cwd, "unrelated-main-change"), "main moved");
  git("add", ".");
  git("commit", "-m", "main change");
  assert.deepEqual(
    changedPaths(
      "pull_request",
      { pull_request: { base: { sha: git("rev-parse", "HEAD") }, head: { sha: head } } },
      cwd,
    ).sort(),
    expected,
  );
  assert.deepEqual(
    changedPaths("merge_group", { merge_group: { base_sha: base, head_sha: head } }, cwd).sort(),
    expected,
  );
  assert.deepEqual(
    classifyChanges(changedPaths("push", { before: "0".repeat(40), after: head }, cwd)),
    all,
  );
  assert.deepEqual(classifyChanges(changedPaths("workflow_dispatch", {}, cwd)), all);
  assert.throws(
    () => changedPaths("push", { before: "--unsafe", after: head }, cwd),
    /Invalid event/,
  );
});

test("test discovery selects only the owning service test projects", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-ci-tests-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const name of ["Browser.Tests", "Browser.IntegrationTests", "Resolver.Tests"]) {
    mkdirSync(join(cwd, "tests", name), { recursive: true });
    writeFileSync(join(cwd, "tests", name, `${name}.csproj`), "<Project />");
  }
  assert.deepEqual(testProjects("Browser", cwd), [
    "tests/Browser.IntegrationTests/Browser.IntegrationTests.csproj",
    "tests/Browser.Tests/Browser.Tests.csproj",
  ]);
  assert.equal(testProjects("all", cwd).length, 3);
  assert.deepEqual(testProjects("ClientApi", cwd), []);
  assert.throws(() => testProjects("../outside", cwd), /Unknown project/);
});
