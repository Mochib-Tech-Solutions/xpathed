import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { profiles } from "../../evaluation/compare.mjs";
import { downloadRelease, repositoryName, releaseCommit } from "./download.mjs";
import { assertSameSourceTree } from "./baseline.mjs";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

async function main() {
  const parent = resolve(".artifacts/monitoring");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, "run-"));
  let source;
  const report = { startedAt: new Date().toISOString(), status: "running" };
  try {
    if (process.argv[2] === "--notification-test")
      throw new Error("Controlled notification-delivery test; no provider calls");
    if (process.argv.length !== 2) throw new Error("Use release:monitor without release selectors");
    const repository = repositoryName();
    const commit = releaseCommit(repository);
    report.commit = commit;
    const downloaded = await downloadRelease(repository, commit, join(directory, "release"));
    const receipt = downloaded.receipt;
    const baseline = JSON.parse(await readFile(join(downloaded.root, "monitoring-baseline.json")));
    if (
      baseline.sourceSha !== receipt.testedCommit ||
      !isDeepStrictEqual(baseline.profile, profiles[0])
    )
      throw new Error("Monitoring settings or source differ from the recorded measurements");
    // Authenticate only this command; credentials are not persisted into the checkout.
    git(
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "fetch",
      "origin",
      receipt.testedCommit,
    );
    assertSameSourceTree(commit, receipt.testedCommit);
    const checkout = join(directory, "source");
    git("worktree", "add", "--detach", checkout, receipt.testedCommit);
    source = checkout;
    const run = (script, args = []) =>
      execFileSync(process.execPath, [script, ...args], {
        cwd: source,
        stdio: "inherit",
        env: { ...process.env, XPATHED_ENV_FILE: "/dev/null" },
      });
    await mkdir(join(source, ".artifacts"), { recursive: true });
    await rename(downloaded.directory, join(source, ".artifacts/monitor-bundle"));
    const digest = receipt.bundleSha256;
    run("scripts/release/evaluate.mjs", [
      "--bundle",
      ".artifacts/monitor-bundle",
      "--sha256",
      digest,
      "--mode",
      "live",
      "--monitoring",
      "true",
      "--output",
      ".artifacts/monitor-run",
    ]);
    const { readRun: readRecorded, summarizeMonitoring: summarizeRecorded } = await import(
      pathToFileURL(join(source, "evaluation/compare.mjs"))
    );
    const observed = await readRecorded(join(source, ".artifacts/monitor-run"));
    Object.assign(report, summarizeRecorded(observed.manifest, observed.trials, baseline.entries));
    if (report.status !== "passed")
      throw new Error("Release monitoring found a regression or operational failure");
  } catch (error) {
    report.status = report.status === "running" ? "infrastructure_failure" : report.status;
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    await writeFile(join(directory, "monitoring.json"), JSON.stringify(report, null, 2) + "\n");
    if (source) {
      // Retain all original attempts before removing the temporary checkout and image archive.
      try {
        await rename(join(source, ".artifacts/monitor-run"), join(directory, "evaluation"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      git("worktree", "remove", "--force", source);
    }
  }
  console.log(JSON.stringify(report));
}
if (import.meta.main) await main();
