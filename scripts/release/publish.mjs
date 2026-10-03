import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { trustedReleasePR, requireCI } from "./ci.mjs";
import { verify } from "./bundle.mjs";
import { createHash } from "node:crypto";
import { releaseTag } from "./notes.mjs";
import { deploymentFiles, hash } from "./download.mjs";
import { retiredReleaseCommit } from "./baseline.mjs";
import { pipeline } from "node:stream/promises";

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

export async function publishAssets(
  { repository, tag, commit, testedCommit, notes, files },
  gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }),
) {
  const releases = JSON.parse(
    gh("api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`),
  ).flat();
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && existing.target_commitish !== commit)
    throw new Error("Release tag already belongs to another commit");
  if (!existing)
    gh(
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      commit,
      "--title",
      `xpathed ${tag}`,
      "--notes-file",
      notes,
      "--draft",
    );
  if (!existing || existing.draft) {
    gh("release", "upload", tag, "--repo", repository, "--clobber", ...files);
    gh("release", "edit", tag, "--repo", repository, "--notes-file", notes);
  }
  const uploaded = JSON.parse(gh("api", `repos/${repository}/releases/tags/${tag}`));
  for (const path of files) {
    const name = path.split("/").at(-1);
    const asset = uploaded.assets.find((asset) => asset.name === name);
    const digest = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (asset?.digest !== `sha256:${digest.digest("hex")}`)
      throw new Error(`Published asset integrity mismatch: ${name}`);
  }
  // Preserve the exact tested synthetic commit for future replay and monitoring.
  const refs = JSON.parse(
    gh("api", `repos/${repository}/git/matching-refs/tags/tested-${testedCommit}`),
  );
  if (!refs.length)
    gh(
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=refs/tags/tested-${testedCommit}`,
      "-f",
      `sha=${testedCommit}`,
    );
  else if (refs.length !== 1 || refs[0].object.sha !== testedCommit)
    throw new Error("Tested source tag differs");
  if (uploaded.draft) gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest");
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
      throw new Error("Publication requires a merged main to release PR");
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
    const directory = ".artifacts/release-publication";
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
    const receipt = JSON.parse(await readFile(`${directory}/receipt.json`, "utf8"));
    const merge = api(`repos/${repository}/git/commits/${pr.merge_commit_sha}`);
    verifyMerge(pr, receipt, merge.tree.sha);
    await requireCI(repository, receipt.sourceSha);
    if (merge.parents[0]?.sha !== receipt.baselineCommit)
      throw new Error("Release baseline changed after evaluation");
    const bundle = await verify(`${directory}/bundle`, receipt.bundleSha256);
    if (bundle.manifest.sourceSha !== receipt.sourceSha)
      throw new Error("Tested image source differs from the release receipt");
    const candidateBytes = await readFile(`${directory}/candidate.json`);
    if (createHash("sha256").update(candidateBytes).digest("hex") !== receipt.candidateSha256)
      throw new Error("Release evidence digest mismatch");
    const candidate = JSON.parse(candidateBytes);
    if (
      candidate.sourceSha !== receipt.sourceSha ||
      candidate.sourceTree !== receipt.sourceTree ||
      candidate.bundleSha256 !== receipt.bundleSha256
    )
      throw new Error("Release evidence differs from the evaluated merge");
    if (
      createHash("sha256")
        .update(await readFile(`${directory}/monitoring-baseline.json`))
        .digest("hex") !== receipt.monitoringSha256
    )
      throw new Error("Monitoring measurements differ from CI");
    const initialBaseline = receipt.baselineCommit === retiredReleaseCommit;
    if (
      receipt.initialBaseline !== initialBaseline ||
      (initialBaseline
        ? candidate.initialBaseline !== retiredReleaseCommit || candidate.comparison != null
        : candidate.comparison?.commit !== receipt.baselineCommit)
    )
      throw new Error("Release baseline transition does not match the CI evidence");
    const tag = initialBaseline ? "v1.0.0" : releaseTag(pr.merge_commit_sha);
    const release = {
      commit: pr.merge_commit_sha,
      testedCommit: receipt.sourceSha,
      tree: receipt.sourceTree,
      baselineCommit: receipt.baselineCommit,
      bundleSha256: receipt.bundleSha256,
      candidateSha256: receipt.candidateSha256,
      qualificationRun: latest.id,
      monitoringSha256: receipt.monitoringSha256,
      deploymentFiles: {},
    };
    const sources = [
      "docker/compose.release.yaml",
      "docker/browser/seccomp.json",
      "docker/release.env.example",
    ];
    for (const [index, name] of deploymentFiles.entries()) {
      const bytes = execFileSync("git", ["show", `${receipt.sourceSha}:${sources[index]}`]);
      await writeFile(`${directory}/${name}`, bytes);
      release.deploymentFiles[name] = hash(bytes);
    }
    await writeFile(`${directory}/release.json`, JSON.stringify(release, null, 2) + "\n");
    // GitHub assets are limited to 2 GiB; split the unchanged tested image archive.
    const gzip = spawn("gzip", ["-n", "-1c", `${directory}/bundle/images.tar`]);
    const split = spawn("split", [
      "-b",
      "1000000000",
      "-d",
      "-a",
      "4",
      "-",
      `${directory}/browser-resolver-images.tar.gz.part-`,
    ]);
    const completed = (child) =>
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("Image transport failed")),
        );
      });
    await Promise.all([completed(gzip), completed(split), pipeline(gzip.stdout, split.stdin)]);
    const parts = (await readdir(directory))
      .filter((name) => /^browser-resolver-images\.tar\.gz\.part-\d{4}$/.test(name))
      .sort();
    if (!parts.length) throw new Error("Image transport is empty");
    const notes =
      (await readFile(`${directory}/release-notes.md`, "utf8")).replace(
        /- Release identity: `[^`]+`/,
        `- Release identity: \`${tag}\``,
      ) + `\nReleased commit: ${pr.merge_commit_sha}\n`;
    await writeFile(`${directory}/release-notes.md`, notes);
    await publishAssets({
      repository,
      tag,
      commit: pr.merge_commit_sha,
      testedCommit: receipt.sourceSha,
      notes: `${directory}/release-notes.md`,
      files: [
        `${directory}/release.json`,
        `${directory}/monitoring-baseline.json`,
        `${directory}/bundle/manifest.json`,
        `${directory}/bundle/source.tar`,
        `${directory}/candidate.json`,
        `${directory}/release-evidence.json.gz`,
        ...deploymentFiles.map((name) => `${directory}/${name}`),
        ...parts.map((name) => `${directory}/${name}`),
      ],
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
