import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

export const projects = ["Common", "Browser", "ClientApi", "Resolver"];

export function classifyChanges(paths) {
  const affected = new Set();
  let web = false;
  let tooling = false;
  let docker = false;
  let solution = false;
  let browser = false;
  for (const path of paths) {
    if (
      /^(\.github\/(workflows|actions)\/|scripts\/ci-(changes|gate)|scripts\/check\.sh$|package(-lock)?\.json$)/.test(
        path,
      )
    ) {
      projects.forEach((project) => affected.add(project));
      web = tooling = docker = solution = true;
    }
    if (path === "Xpathed.slnx") solution = true;
    if (
      path.startsWith("scripts/ci-dotnet-tests") ||
      path === "scripts/format.sh" ||
      path === ".config/dotnet-tools.json" ||
      path === ".csharpierignore"
    ) {
      projects.forEach((project) => affected.add(project));
      tooling = true;
    }
    if (path === "scripts/format.sh") web = true;
    if (
      /^(global\.json|Directory\..*\.(props|targets)|NuGet\.Config|nuget\.config|Xpathed\.slnx|\.editorconfig)$/.test(
        path,
      ) ||
      path.startsWith("src/Common/")
    ) {
      projects.forEach((project) => affected.add(project));
    }
    if (/^src\/Web\//.test(path)) web = true;
    if (path.startsWith("tests/resolution/")) tooling = true;
    if (
      /^(\.editorconfig|\.prettier(ignore|rc.*)|pnpm-(lock|workspace)\.yaml|\.npmrc|\.node-version|\.nvmrc)$/.test(
        path,
      )
    )
      web = tooling = true;
    if (
      /^(scripts\/|\.githooks\/|\.github\/workflows\/|package(-lock)?\.json$|global\.json$)/.test(
        path,
      )
    )
      tooling = true;
    if (
      /^(docker\/|\.dockerignore$|\.env\.example$)/.test(path) ||
      path === "scripts/ci-docker.sh"
    ) {
      docker = tooling = true;
    }
    for (const project of projects) {
      if (path.startsWith(`src/${project}/`) || path.startsWith(`tests/${project}.`)) {
        affected.add(project);
      }
    }
    if (/^tests\/Directory\..*\.(props|targets)$/.test(path))
      projects.forEach((project) => affected.add(project));
    if (path.startsWith("tests/Common.")) projects.forEach((project) => affected.add(project));
    if (
      /^(scripts\/(native[.-]|service-process[.])|tests\/resolution\/.*\.mjs$|scripts\/resolution-check\.sh$|docker\/(browser\/|resolver\/|compose\.(yaml|sh)$)|\.dockerignore$|pnpm-(lock|workspace)\.yaml$|\.npmrc$|\.node-version$|\.nvmrc$)/.test(
        path,
      )
    )
      browser = true;
  }
  return {
    dotnet: projects.filter((project) => affected.has(project)),
    web,
    tooling,
    docker,
    solution,
    browser:
      browser || ["Browser", "Resolver", "ClientApi"].some((project) => affected.has(project)),
  };
}

export function changedPaths(eventName, event, cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  let base;
  let head;
  if (eventName === "pull_request") {
    base = event.pull_request.base.sha;
    head = event.pull_request.head.sha;
  } else if (eventName === "push") {
    base = event.before;
    head = event.after;
  } else if (eventName === "merge_group") {
    base = event.merge_group.base_sha;
    head = event.merge_group.head_sha;
  } else {
    return [".github/workflows/check.yml"];
  }
  if (!/^[a-f\d]{40}$/.test(base) || !/^[a-f\d]{40}$/.test(head))
    throw new Error("Invalid event commit SHA");
  if (/^0+$/.test(base)) return [".github/workflows/check.yml"];
  if (eventName === "pull_request") base = git("merge-base", base, head).trim();
  // Treat renames as deletion + addition so both the old and new owners run.
  return git("diff", "--name-only", "--no-renames", "-z", base, head, "--")
    .split("\0")
    .filter(Boolean);
}

if (import.meta.main) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const result = classifyChanges(changedPaths(process.env.GITHUB_EVENT_NAME, event));
  console.log(JSON.stringify(result, null, 2));
  for (const [name, value] of Object.entries(result)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(value)}\n`);
  }
}
