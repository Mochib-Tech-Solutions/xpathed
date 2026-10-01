import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedPaths, classifyChanges, projects } from "./ci-changes.mjs";
import { testProjects } from "./ci-dotnet-tests.mjs";

const none = {
  dotnet: [],
  web: false,
  tooling: false,
  docker: false,
  solution: false,
  persistence: false,
  browser: false,
};
const all = {
  dotnet: projects,
  web: true,
  tooling: true,
  docker: true,
  solution: true,
  persistence: true,
  browser: true,
};
const sharedDotnet = { ...none, dotnet: projects, persistence: true, browser: true };

test("Browser source changes require deterministic browser evaluation", () => {
  assert.equal(classifyChanges(["src/Browser/Sessions/BrowserSessions.cs"]).browser, true);
});

test("deterministic evaluation selects its runtime, fixture, and runner dependencies", () => {
  for (const path of [
    "evaluation/run.mjs",
    "evaluation/cases.json",
    "evaluation/fixtures.mjs",
    "scripts/evaluate.sh",
    "scripts/evaluate.test.mjs",
    "scripts/release-evaluate.mjs",
    "scripts/ci-browser.mjs",
    "tests/resolution/ready.mjs",
    "docker/compose.yaml",
    "docker/compose.evaluation.yaml",
    "docker/compose.sh",
    "docker/browser/seccomp.json",
    "docker/resolver/Dockerfile",
    ".dockerignore",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".node-version",
    ".nvmrc",
  ])
    assert.equal(classifyChanges([path]).browser, true, path);
});

for (const [path, expected] of [
  ["README.md", none],
  ["evaluation/run.mjs", { ...none, tooling: true, browser: true }],
  ["evaluation/grader.test.mjs", { ...none, tooling: true, browser: true }],
  ["evaluation/cases.json", { ...none, tooling: true, browser: true }],
  ["tests/resolution/pipeline.test.mjs", { ...none, tooling: true }],
  [
    "tests/Resolver.Tests/ResolutionContractTests.cs",
    { ...none, dotnet: ["Resolver"], browser: true },
  ],
  ["docs/runtime.md", none],
  ["src/Web/src/features/browser/App.tsx", { ...none, web: true }],
  ["src/Web/package.json", { ...none, web: true }],
  ["pnpm-lock.yaml", { ...none, web: true, tooling: true, browser: true }],
  ["pnpm-workspace.yaml", { ...none, web: true, tooling: true, browser: true }],
  [".npmrc", { ...none, web: true, tooling: true, browser: true }],
  ["src/Browser/Sessions/BrowserSessions.cs", { ...none, dotnet: ["Browser"], browser: true }],
  ["src/Resolver/Resolver.csproj", { ...none, dotnet: ["Resolver"], browser: true }],
  ["tests/ClientApi.Tests/SessionTests.cs", { ...none, dotnet: ["ClientApi"], persistence: true }],
  [
    "tests/ClientApi.IntegrationTests/PersistenceTests.cs",
    { ...none, dotnet: ["ClientApi"], persistence: true },
  ],
  [
    "src/ClientApi/Persistence/ClientDbContext.cs",
    { ...none, dotnet: ["ClientApi"], persistence: true },
  ],
  ["src/Common/Contracts/Session.cs", sharedDotnet],
  ["tests/Common.Tests/ContractTests.cs", sharedDotnet],
  ["Directory.Build.props", sharedDotnet],
  ["Xpathed.slnx", { ...sharedDotnet, solution: true }],
  ["Directory.Packages.props", sharedDotnet],
  ["tests/Directory.Build.props", sharedDotnet],
  ["global.json", { ...sharedDotnet, tooling: true }],
  [".editorconfig", { ...sharedDotnet, web: true, tooling: true }],
  [".config/dotnet-tools.json", { ...sharedDotnet, tooling: true }],
  [".csharpierignore", { ...sharedDotnet, tooling: true }],
  [".prettierrc.json", { ...none, web: true, tooling: true }],
  [".github/workflows/check.yml", all],
  [".github/actions/ci-receipt/action.yml", all],
  ["scripts/ci-changes.mjs", all],
  ["scripts/ci-gate.mjs", all],
  ["scripts/ci-gate.test.mjs", all],
  ["scripts/ci-dotnet-tests.mjs", { ...sharedDotnet, tooling: true }],
  ["package.json", all],
  ["scripts/format.sh", { ...sharedDotnet, web: true, tooling: true }],
  ["scripts/ci-docker.sh", { ...none, tooling: true, docker: true }],
  ["scripts/clean.mjs", { ...none, tooling: true }],
  ["docker/compose.dev.yaml", { ...none, tooling: true, docker: true }],
  ["docker/compose.yaml", { ...none, tooling: true, docker: true, browser: true }],
  ["docker/compose.sh", { ...none, tooling: true, docker: true, browser: true }],
  ["docker/browser/seccomp.json", { ...none, tooling: true, docker: true, browser: true }],
  ["docker/client-api/Dockerfile", { ...none, tooling: true, docker: true }],
  ["docker/resolver/Dockerfile", { ...none, tooling: true, docker: true, browser: true }],
  ["docker/web/nginx.conf", { ...none, tooling: true, docker: true }],
  ["docker/web/Dockerfile", { ...none, tooling: true, docker: true }],
  ["docker/browser/Dockerfile", { ...none, tooling: true, docker: true, browser: true }],
  [".dockerignore", { ...none, tooling: true, docker: true, browser: true }],
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
  assert.deepEqual(classifyChanges(changedPaths("push", { before: base, after: head }, cwd)), {
    ...none,
    dotnet: ["Browser", "Resolver"],
    web: true,
    browser: true,
  });
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
  for (const name of [
    "Browser.Tests",
    "Browser.IntegrationTests",
    "ClientApi.IntegrationTests",
    "Resolver.Tests",
  ]) {
    mkdirSync(join(cwd, "tests", name), { recursive: true });
    writeFileSync(join(cwd, "tests", name, `${name}.csproj`), "<Project />");
  }
  assert.deepEqual(testProjects("Browser", cwd), ["tests/Browser.Tests/Browser.Tests.csproj"]);
  assert.equal(testProjects("all", cwd).length, 2);
  assert.deepEqual(testProjects("ClientApi", cwd), []);
  assert.deepEqual(testProjects("Common", cwd), []);
  assert.deepEqual(testProjects("persistence", cwd), [
    "tests/ClientApi.IntegrationTests/ClientApi.IntegrationTests.csproj",
  ]);
  assert.throws(() => testProjects("../outside", cwd), /Unknown project/);
});

test("required service test projects cannot disappear from discovery", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "xpathed-ci-missing-tests-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const name of ["Browser", "Resolver"]) {
    assert.throws(() => testProjects(name, cwd), /required.*test project.*missing/i);
    mkdirSync(join(cwd, "tests", `${name}.Tests`), { recursive: true });
    assert.throws(() => testProjects(name, cwd), /required.*test project.*missing/i);
    writeFileSync(join(cwd, "tests", `${name}.Tests`, `${name}.Tests.csproj`), "<Project />");
  }
  rmSync(join(cwd, "tests", "Resolver.Tests"), { recursive: true });
  assert.throws(() => testProjects("all", cwd), /Resolver/);
});
