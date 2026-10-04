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

if (import.meta.main) {
  try {
    if (process.argv[2] === "--edit" && process.argv.length === 4)
      validateMessage(readFileSync(process.argv[3], "utf8"));
    else throw new Error("Use --edit COMMIT_MESSAGE_FILE");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
