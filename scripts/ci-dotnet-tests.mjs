import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname } from "node:path";
import { projects } from "./ci-changes.mjs";

export function testProjects(project = "all", cwd = process.cwd()) {
  const selected = project === "all" ? projects : [project];
  if (selected.some((name) => !projects.includes(name)))
    throw new Error(`Unknown project: ${project}`);
  return selected
    .flatMap((name) => {
      const paths = globSync(`tests/${name}.*Tests/*.csproj`, { cwd });
      if (
        ["Browser", "ClientApi", "Resolver"].includes(name) &&
        !paths.includes(`tests/${name}.Tests/${name}.Tests.csproj`)
      )
        throw new Error(`The required ${name} unit test project is missing.`);
      return paths;
    })
    .filter((path) => !path.includes(".IntegrationTests/"))
    .sort();
}

if (import.meta.main) {
  const selected = testProjects(process.argv[2]);
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
}
