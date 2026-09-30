import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname } from "node:path";
import { projects } from "./ci-changes.mjs";

export function testProjects(project = "all", cwd = process.cwd()) {
  if (project === "persistence")
    return globSync("tests/ClientApi.IntegrationTests/*.csproj", { cwd });
  const selected = project === "all" ? projects : [project];
  if (selected.some((name) => !projects.includes(name)))
    throw new Error(`Unknown project: ${project}`);
  return selected
    .flatMap((name) => globSync(`tests/${name}.*Tests/*.csproj`, { cwd }))
    .filter((path) => !path.includes(".IntegrationTests/"))
    .sort();
}

if (import.meta.main) {
  if (process.argv[2] === "persistence" && !process.env.ConnectionStrings__Database)
    throw new Error(
      "Set ConnectionStrings__Database to a PostgreSQL test connection with permission to create databases.",
    );
  const selected = testProjects(process.argv[2]);
  if (process.argv[2] === "persistence" && !selected.length)
    throw new Error("The persistence integration test project is missing.");
  if (!selected.length) console.log("No C# test projects are registered for this selection.");
  const dotnet = (...args) => execFileSync("dotnet", args, { stdio: "inherit" });
  if (selected.length) dotnet("tool", "restore");
  for (const project of selected) {
    dotnet("restore", project, "--locked-mode");
    dotnet("format", "style", project, "--no-restore", "--verify-no-changes");
    dotnet("csharpier", "check", dirname(project));
    dotnet(
      "test",
      project,
      "--no-restore",
      "--configuration",
      "Release",
      "-p:ContinuousIntegrationBuild=true",
    );
  }
  if (process.argv[2] === "persistence")
    dotnet("ef", "migrations", "has-pending-model-changes", "--project", "src/ClientApi");
}
