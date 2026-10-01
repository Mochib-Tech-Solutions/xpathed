import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function installHooks(cwd = process.cwd()) {
  if (!existsSync(`${cwd}/.git`)) return;
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const config = (key) => git("config", "get", "--default", "", key);
  const hooks = config("core.hooksPath");
  if (hooks && hooks !== ".githooks")
    throw new Error(
      `Existing core.hooksPath (${hooks}); integrate or unset it before installing repository hooks.`,
    );
  if (config("extensions.worktreeConfig") !== "true") {
    if (config("core.bare") === "true" || config("core.worktree"))
      throw new Error(
        "Migrate core.bare/core.worktree before enabling worktree configuration; see git-worktree documentation.",
      );
    git("config", "--local", "extensions.worktreeConfig", "true");
  }
  git("config", "--worktree", "core.hooksPath", ".githooks");
  console.log("Installed pre-commit and commit-msg hooks for this worktree.");
}

if (import.meta.main && !process.env.CI) installHooks();
