import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { projects } from "./ci-changes.mjs";

export function testProjects(project = "all", cwd = process.cwd()) {
  const selected = project === "all" ? projects : [project];
  if (selected.some((name) => !projects.includes(name)))
    throw new Error(`Unknown project: ${project}`);
  return selected.flatMap((name) => globSync(`tests/${name}.*Tests/*.csproj`, { cwd })).sort();
}

if (import.meta.main) {
  const selected = testProjects(process.argv[2]);
  if (!selected.length) console.log("No C# test projects are registered for this selection.");
  for (const project of selected) {
    const dotnet = (...args) => execFileSync("dotnet", args, { stdio: "inherit" });
    dotnet("restore", project, "--locked-mode");
    dotnet("format", project, "--no-restore", "--verify-no-changes");
    dotnet(
      "test",
      project,
      "--no-restore",
      "--configuration",
      "Release",
      "-p:ContinuousIntegrationBuild=true",
    );
  }
}
