import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { trustedReleasePR, requireCI } from "./ci.mjs";
import { readState } from "./state.mjs";

export function verifyMerge(pr, receipt, tree) {
  if (
    !pr?.merged ||
    !Number.isSafeInteger(pr.number) ||
    pr.number !== receipt?.pr ||
    !/^[a-f\d]{40}$/.test(receipt.sourceSha ?? "") ||
    !/^[a-f\d]{40}$/.test(receipt.sourceTree ?? "") ||
    !/^[a-f\d]{40}$/.test(receipt.headSha ?? "") ||
    pr.head?.sha !== receipt.headSha ||
    tree !== receipt.sourceTree
  )
    throw new Error("Merged source differs from the evaluated release PR; run a new comparison");
}

if (import.meta.main) {
  try {
    const repository = process.env.GITHUB_REPOSITORY;
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (
      process.env.GITHUB_EVENT_NAME !== "pull_request" ||
      !trustedReleasePR(event, repository) ||
      !event.pull_request.merged
    )
      throw new Error("Approval requires a merged main to release PR");
    const pr = event.pull_request;
    const api = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
    const runs = api(
      `repos/${repository}/actions/workflows/release-qualification.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`,
    ).workflow_runs;
    const latest = runs
      .filter((run) => run.pull_requests.some((item) => item.number === pr.number))
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.conclusion !== "success")
      throw new Error("Latest release comparison did not succeed");
    const directory = ".artifacts/approval-request";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    execFileSync(
      "gh",
      [
        "run",
        "download",
        String(latest.id),
        "--repo",
        repository,
        "--name",
        "release-candidate",
        "--dir",
        directory,
      ],
      { stdio: "inherit" },
    );
    const receipt = JSON.parse(await readFile(`${directory}/approval-request.json`, "utf8"));
    const merge = api(`repos/${repository}/git/commits/${pr.merge_commit_sha}`);
    verifyMerge(pr, receipt, merge.tree.sha);
    await requireCI(repository, receipt.sourceSha);
    const state = readState(repository);
    execFileSync(
      process.execPath,
      [
        "scripts/release/control.mjs",
        "promote",
        "--tag",
        receipt.tag,
        "--sha256",
        receipt.candidateSha256,
        "--expected-current",
        state.state.current?.candidateSha256 ?? "none",
        "--pull-request",
        String(pr.number),
        "--reason",
        `Merged release PR #${pr.number}`,
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
