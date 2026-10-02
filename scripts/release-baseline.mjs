import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchApprovedRelease } from "./release-fetch.mjs";

export async function prepareBaseline(snapshot, destination, policy) {
  if (snapshot.state.current) {
    const staged = await fetchApprovedRelease(snapshot, destination);
    return {
      bundle: join(staged.source, staged.candidate.bundle),
      digest: staged.candidate.bundleSha256,
      approval: snapshot.state.current.candidateSha256,
    };
  }
  const source = resolve(destination, "source");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", process.cwd(), source], {
    stdio: "inherit",
  });
  execFileSync(
    "git",
    ["-C", source, "checkout", "--quiet", "--detach", policy.bootstrap.sourceSha],
    { stdio: "inherit" },
  );
  const bundle = join(source, ".artifacts/baseline");
  execFileSync(
    process.execPath,
    [
      "scripts/release-bundle.mjs",
      "create",
      "--profile",
      policy.bootstrap.profileId,
      "--source-sha",
      policy.bootstrap.sourceSha,
      "--output",
      bundle,
    ],
    { cwd: source, stdio: "inherit" },
  );
  return {
    bundle,
    digest: createHash("sha256")
      .update(await readFile(join(bundle, "manifest.json")))
      .digest("hex"),
    approval: "none",
  };
}

export function assertLatestBaseline(comparison, current, policy) {
  const expected = current
    ? { sourceSha: current.sourceSha, profileId: current.profile }
    : policy.bootstrap;
  if (
    !comparison ||
    comparison.approval !== (current?.candidateSha256 ?? "none") ||
    comparison.artifact?.sourceSha !== expected.sourceSha ||
    comparison.artifact?.profileId !== expected.profileId ||
    (current && comparison.artifact.bundleManifestSha256 !== current.bundleSha256)
  )
    throw new Error(
      "Qualification baseline differs from the latest approved release or pinned bootstrap",
    );
}
