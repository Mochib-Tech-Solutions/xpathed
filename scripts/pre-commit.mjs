import { execFileSync } from "node:child_process";
import { classifyChanges } from "./ci-changes.mjs";

export function checkCommands(paths) {
  const selected = classifyChanges(paths);
  const commands = [];
  if (selected.dotnet.length) commands.push(["dotnet", "tool", "restore"]);
  if (selected.solution) commands.push(["pnpm", "build:dotnet"]);
  for (const project of selected.dotnet) {
    const path = `src/${project}/${project}.csproj`;
    commands.push(
      ["dotnet", "restore", path, "--locked-mode"],
      ["dotnet", "format", "style", path, "--no-restore", "--verify-no-changes"],
      ["dotnet", "csharpier", "check", `src/${project}`],
      [
        "dotnet",
        "build",
        path,
        "--no-restore",
        "--configuration",
        "Release",
        "-p:ContinuousIntegrationBuild=true",
      ],
      ["node", "scripts/ci-dotnet-tests.mjs", project],
    );
  }
  if (selected.web) commands.push(["pnpm", "check:web"]);
  if (selected.tooling) commands.push(["pnpm", "check:tooling"]);
  if (selected.docker) commands.push(["pnpm", "docker:check"]);
  return commands;
}

export function checkStaged(cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const paths = (output) => output.split("\0").filter(Boolean);
  const staged = paths(git("diff", "--cached", "--name-only", "--no-renames", "-z", "--"));
  const commands = checkCommands(staged);
  if (!commands.length) {
    console.log("No staged build or test inputs changed.");
    return;
  }
  const unstaged = paths(git("diff", "--name-only", "--no-renames", "-z", "--"));
  const untracked = paths(git("ls-files", "--others", "--exclude-standard", "-z"));
  const dirty = [...unstaged, ...untracked].filter((path) => checkCommands([path]).length);
  if (dirty.length)
    throw new Error(
      `Stage or set aside unstaged source/configuration before checking the commit:\n${dirty.join("\n")}\nNo files were changed or stashed.`,
    );
  const index = git("write-tree").trim();
  const env = { ...process.env };
  for (const key of git("rev-parse", "--local-env-vars").trim().split("\n")) delete env[key];
  for (const [command, ...args] of commands) {
    console.log(`\n> ${command} ${args.join(" ")}`);
    execFileSync(command, args, { cwd, env, stdio: "inherit" });
  }
  if (
    git("write-tree").trim() !== index ||
    paths(git("diff", "--name-only", "--no-renames", "-z", "--")).some(
      (path) => checkCommands([path]).length,
    ) ||
    paths(git("ls-files", "--others", "--exclude-standard", "-z")).some(
      (path) => checkCommands([path]).length,
    )
  )
    throw new Error("Source or index changed during checks; review, stage and retry the commit.");
  console.log("Staged checks passed. PostgreSQL and deterministic browser integration run in CI.");
}

if (import.meta.main) {
  try {
    checkStaged();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
