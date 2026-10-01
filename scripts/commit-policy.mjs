import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const header =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^()\s]+\))?!?: \S.*$/;

export function validateMessage(message, label = "Commit") {
  const subject = message.split(/\r?\n/, 1)[0];
  if (!header.test(subject) || subject !== subject.trimEnd())
    throw new Error(
      `${label}: use type(scope): description, for example "fix(browser): preserve target identity". Allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test. Scope and ! are optional.`,
    );
}

export function validateEvent(eventName, event, cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  let base;
  let head;
  if (eventName === "pull_request") {
    validateMessage(event.pull_request.title, "PR title");
    base = event.pull_request.base.sha;
    head = event.pull_request.head.sha;
  } else if (eventName === "push") {
    base = event.before;
    head = event.after;
    if (/^0{40}$/.test(head)) return;
  } else {
    throw new Error(`Unsupported commit policy event: ${eventName}`);
  }
  if (![base, head].every((sha) => /^[a-f\d]{40}$/.test(sha)))
    throw new Error("Invalid event commit SHA");
  // Check only commits introduced by this PR/push, never existing main history.
  const range = /^0{40}$/.test(base) ? [head] : [`${base}..${head}`];
  const commits = git("rev-list", ...range)
    .split("\n")
    .filter(Boolean);
  for (const sha of commits) validateMessage(git("show", "-s", "--format=%B", sha), sha);
  console.log(
    `Conventional Commits: ${commits.length} commits${eventName === "pull_request" ? " and PR title" : ""} passed.`,
  );
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--edit" && process.argv.length === 4)
      validateMessage(readFileSync(process.argv[3], "utf8"));
    else if (process.argv[2] === "--event" && process.argv.length === 3)
      validateEvent(
        process.env.GITHUB_EVENT_NAME,
        JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      );
    else throw new Error("Use --edit COMMIT_MESSAGE_FILE or --event");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
