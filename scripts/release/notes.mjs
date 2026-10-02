import { execFileSync } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export function nextCandidateTag(version, tags) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Release version must be MAJOR.MINOR.PATCH");
  if (tags.includes(`v${version}`))
    throw new Error("Bump the package version after a stable release");
  const prefix = `v${version}-rc.`;
  const numbers = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length));
  const last = Math.max(0, ...numbers.filter((n) => /^[1-9]\d*$/.test(n)).map(Number));
  if (!Number.isSafeInteger(last + 1)) throw new Error("Release candidate number is invalid");
  return `${prefix}${last + 1}`;
}

const ms = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : "Unavailable");
const score = (value) =>
  value?.total
    ? `${value.correct}/${value.total} (${((100 * value.correct) / value.total).toFixed(1)}%)`
    : "Unavailable";

export function releaseNotes({
  tag,
  profile,
  policy,
  phases,
  qualified,
  mode = "live",
  changelog,
  caseChanges,
  sourceSha,
  bundleSha,
  runUrl,
}) {
  const lines = [
    mode === "deterministic"
      ? "**Deterministic checks only. Live model qualification and approval are pending.**"
      : qualified
        ? "**Qualification passed — awaiting explicit release approval.**"
        : "**Qualification did not pass. This candidate is not approved.**",
    "",
    "## Model and configuration",
    "",
    `- Release version: \`${tag}\``,
    `- Model: \`${profile.model}\``,
    `- Provider: \`${profile.provider}\` through OpenRouter`,
    `- Profile: \`${profile.id}\`; prompt variant: \`${profile.variant}\``,
    `- Reasoning: \`${JSON.stringify(profile.reasoning)}\`; output limit: ${profile.maxTokens} tokens`,
    "- Acceptance: preserve every baseline pass; latency and cost are informational.",
    "",
    "## Evaluation results",
    "",
    "| Group | Arm | Correct cases | Median latency | p95 latency |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const phase of phases) {
    if (!phase.comparison) {
      lines.push(`| ${phase.name} | — | Not completed | — | — |`);
      continue;
    }
    for (const group of phase.groups ?? [phase]) {
      for (const arm of ["candidate", "baseline"]) {
        const stats = group.comparison?.[arm];
        lines.push(
          `| ${group.name} | ${arm} | ${score(stats)} | ${ms(stats?.p50)} | ${ms(stats?.p95)} |`,
        );
      }
    }
  }
  if (caseChanges) {
    lines.push("", "### Case collection changes", "");
    for (const [key, label] of [
      ["added", "Added"],
      ["removed", "Removed"],
      ["changed", "Changed inputs or assertions"],
    ]) {
      const cases = caseChanges[key] ?? [];
      lines.push(
        `- ${label}: ${cases.length}${cases.length && cases.length <= 20 ? ` (${cases.map((id) => `\`${id}\``).join(", ")})` : ""}.`,
      );
    }
    lines.push(
      "Full case IDs are retained in `case-changes.json` with this run. Both arms use the same current cases and grader.",
    );
  }
  const calls = phases.flatMap((phase) => phase.calls ?? []);
  const known = calls.filter((call) => Number.isFinite(call.reportedUsd));
  lines.push(
    "",
    `Retained provider calls: **${calls.length}** across both arms. Known reported subtotal: **$${known.reduce((sum, call) => sum + call.reportedUsd, 0).toFixed(8)} USD**; ${calls.length - known.length} calls have unknown cost.`,
  );
  for (const phase of phases) {
    const reasons = phase.comparison?.reasons ?? [];
    for (const [key, label] of [
      ["gains", "New passes"],
      ["regressions", "Lost baseline passes"],
    ]) {
      const cases = phase.comparison?.[key] ?? [];
      if (cases.length)
        lines.push(
          `- ${phase.name} ${label.toLowerCase()}: ${cases.map((id) => `\`${id}\``).join(", ")}.`,
        );
    }
    if (reasons.length)
      lines.push(`- ${phase.name}: ${reasons.map((reason) => `\`${reason}\``).join(", ")}.`);
    if (phase.error) lines.push(`- ${phase.name}: ${phase.error}`);
    if (phase.incompleteAccounting)
      lines.push(
        `- ${phase.name}: accounting inventory is incomplete; the authoritative ledger retains pending attempts. The subtotal is not a complete charge total.`,
      );
  }
  lines.push(
    "",
    "Browser cases grade the complete Resolver response, including independently labelled targets, actions and verified XPath. Offline cases grade selection from saved candidates; they cannot establish live browser or XPath correctness. Browser latency covers the complete Resolver HTTP response; offline latency covers the inference process. Setup, preparation and independent grading are excluded. These regression results are not an unseen-data accuracy estimate.",
    "",
    "## Changelog",
    "",
    changelog.trim() || "No merged changes since the previous candidate.",
    "",
    "## Verification and artifacts",
    "",
    `- [Qualification run and retained evidence](${runUrl})`,
    `- Source: \`${sourceSha}\``,
    `- Bundle SHA-256: \`${bundleSha}\``,
    "- Browser and Resolver images are pinned in `manifest.json`; credentials and database data are excluded.",
    "- Restore instructions: [release runbook](https://github.com/Mochib-Tech-Solutions/xpathed/blob/main/docs/releases.md).",
    "",
  );
  return lines.join("\n");
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function phaseNotes(directory, name, profileId) {
  const manifest = await optionalJson(join(directory, "manifest.json"));
  const summary = await optionalJson(join(directory, "summary.json"));
  let files = [];
  try {
    files = await readdir(join(directory, "provider"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const records = new Map();
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    const record = await optionalJson(join(directory, "provider", file));
    if (!record?.id || records.has(record.id)) throw new Error("Invalid provider record inventory");
    records.set(record.id, record);
  }
  const calls = [...records.values()].filter((record) => record.forwarded);
  const comparison = summary?.profiles?.[profileId]?.qualification?.comparison;
  const groups = Object.entries(comparison?.groups ?? {}).map(([track, comparison]) => ({
    name: track === "browser" ? "Browser resolver" : "Offline selection",
    comparison,
  }));
  return {
    ...(groups.length ? { groups } : {}),
    name,
    calls,
    comparison,
    error: (await optionalJson(join(directory, "run-error.json")))?.message,
    incompleteAccounting:
      Boolean(manifest) &&
      calls.length !== manifest.plan.trials.length * (manifest.comparison ? 2 : 1),
  };
}

async function main() {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) throw new Error("Use release-notes.mjs RUN_DIRECTORY");
  const gh = (...args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const releases = JSON.parse(gh("release", "list", "--limit", "1000", "--json", "tagName"));
  const refs = JSON.parse(
    gh("api", `repos/${process.env.GITHUB_REPOSITORY}/git/matching-refs/tags/v${version}`),
  );
  const tag = nextCandidateTag(version, [
    ...releases.map((release) => release.tagName),
    ...refs.map(({ ref }) => ref.slice("refs/tags/".length)),
  ]);
  const preflight = JSON.parse(await readFile(join(root, "preflight.json"), "utf8"));
  const { profile } = JSON.parse(await readFile(join(root, "bundle/configuration.json"), "utf8"));
  const policy = JSON.parse(await readFile("evaluation/policy.json", "utf8"));
  const phases = [];
  for (const name of ["evaluation"])
    phases.push(await phaseNotes(join(root, name), name, profile.id));
  const generated = JSON.parse(
    gh(
      "api",
      `repos/${process.env.GITHUB_REPOSITORY}/releases/generate-notes`,
      "--method",
      "POST",
      "-f",
      `tag_name=${tag}`,
      "-f",
      `target_commitish=${preflight.sourceSha}`,
      ...(releases[0] ? ["-f", `previous_tag_name=${releases[0].tagName}`] : []),
    ),
  );
  const qualified =
    (await optionalJson(join(root, "candidate.json")))?.status ===
    "artifact-bound-evidence-verified";
  const notes = releaseNotes({
    tag,
    profile,
    policy,
    phases,
    qualified,
    mode: preflight.mode,
    changelog: generated.body,
    caseChanges: await optionalJson(join(root, "case-changes.json")),
    sourceSha: preflight.sourceSha,
    bundleSha: (await readFile(join(root, "bundle-sha256.txt"), "utf8")).trim(),
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  await writeFile(join(root, "release-tag.txt"), `${tag}\n`, { mode: 0o600 });
  await writeFile(join(root, "release-notes.md"), notes, { mode: 0o600 });
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
