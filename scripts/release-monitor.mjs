import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { readState, saveState, verifyExposure } from "./release-state.mjs";
import { fetchRelease } from "./release-fetch.mjs";

async function main() {
  const forceFailure = process.argv.length === 3 && process.argv[2] === "--notification-test";
  if (!forceFailure && process.argv.length !== 2)
    throw new Error("Use release-monitor.mjs [--notification-test]");
  process.umask(0o077);
  const parent = resolve(".artifacts/monitoring");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, "run-"));
  const snapshot = readState();
  const selected = snapshot.state.current;
  const run = {
    version: 1,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    candidateSha256: selected?.candidateSha256 ?? null,
    notificationTest: forceFailure,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    defaultActivated: false,
  };
  saveState(
    snapshot,
    { ...snapshot.state, monitoring: run },
    "chore(monitoring): record started drift run",
  );
  try {
    if (forceFailure)
      throw new Error(
        "Controlled notification-delivery test; no provider calls or default changes",
      );
    if (!selected)
      throw new Error(
        "No approved release exists; refusing to substitute the application default or latest candidate",
      );
    const staged = await fetchRelease(
      snapshot.repo,
      selected.tag,
      selected.candidateSha256,
      directory,
    );
    if (!isDeepStrictEqual(selected, staged.release))
      throw new Error("Approved release metadata differs from verified evidence");
    verifyExposure(snapshot, staged.release);
    const output = ".artifacts/sentinel-run";
    execFileSync(
      process.execPath,
      [
        "scripts/release-evaluate.mjs",
        "--bundle",
        staged.candidate.bundle,
        "--sha256",
        staged.candidate.bundleSha256,
        "--mode",
        "live",
        "--profile",
        staged.candidate.profile,
        "--phase",
        "pilot",
        "--split",
        "development,regression",
        "--sentinels",
        "true",
        "--suite",
        staged.candidate.suite,
        "--output",
        output,
      ],
      {
        cwd: staged.source,
        stdio: "inherit",
        env: { ...process.env, XPATHED_ENV_FILE: "/dev/null" },
      },
    );
    const { readRun, summarizeMonitoring } = await import(
      pathToFileURL(join(staged.source, "evaluation/qualify.mjs"))
    );
    const observed = await readRun(join(staged.source, output));
    Object.assign(run, summarizeMonitoring(observed.manifest, observed.trials));
    await writeFile(join(directory, "monitoring.json"), JSON.stringify(run, null, 2) + "\n", {
      mode: 0o600,
    });
    if (run.status !== "passed")
      throw new Error(`Approved release monitoring failed: ${run.status}`);
  } catch (error) {
    if (run.status === "running") run.status = "infrastructure_failure";
    run.error = error.message;
    process.exitCode = 1;
  } finally {
    run.completedAt = new Date().toISOString();
    const latest = readState(snapshot.repo);
    if (!isDeepStrictEqual(latest.state.current, selected)) {
      run.status = "infrastructure_failure";
      run.error = "Approved release changed during monitoring";
      process.exitCode = 1;
    }
    await writeFile(join(directory, "monitoring.json"), JSON.stringify(run, null, 2) + "\n", {
      mode: 0o600,
    });
    saveState(
      latest,
      { ...latest.state, monitoring: run, lastCompletedMonitoring: run },
      "chore(monitoring): record completed drift run",
    );
    console.log(JSON.stringify(run, null, 2));
  }
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
