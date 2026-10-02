import assert from "node:assert/strict";
import test from "node:test";
import { nextCandidateTag, releaseNotes, phaseNotes } from "./release-notes.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("release candidates follow the package version and never overwrite a stable release", () => {
  assert.equal(nextCandidateTag("1.0.0", ["candidate-123-1"]), "v1.0.0-rc.1");
  assert.equal(nextCandidateTag("1.0.0", ["v1.0.0-rc.2", "v1.0.0-rc.9"]), "v1.0.0-rc.10");
  assert.throws(() => nextCandidateTag("1.0.0", ["v1.0.0"]), /Bump/);
  assert.throws(() => nextCandidateTag("01.0.0", []), /MAJOR/);
});

test("interrupted trial reporting retains provider records without a completed trial", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "xpathed-release-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "provider"));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ plan: { trials: [{ id: "trial" }] }, comparison: {} }),
  );
  await writeFile(
    join(directory, "provider", "paid.json"),
    JSON.stringify({ id: "paid", forwarded: true, reportedUsd: 0.002 }),
  );
  const phase = await phaseNotes(directory, "pilot", "deepseek");
  assert.equal(phase.calls.length, 1);
  assert.equal(phase.calls[0].reportedUsd, 0.002);
  assert.equal(phase.incompleteAccounting, true);
});

test("release notes show both arms, incomplete qualification and unknown charges honestly", () => {
  const input = {
    tag: "v1.0.0-rc.1",
    qualified: false,
    profile: {
      id: "deepseek",
      model: "deepseek/deepseek-v4.1-flash",
      provider: "wafer",
      variant: "baseline",
      reasoning: { enabled: false },
      maxTokens: 4096,
    },
    policy: { version: "5", latencyMargin: 0.05 },
    phases: [
      {
        name: "pilot",
        comparison: {
          candidate: { correct: 3, total: 5, p50: 979, p95: 1132 },
          baseline: { correct: 3, total: 5, p50: 967, p95: 1230 },
          reasons: ["median_latency_regression"],
        },
        calls: [{ reportedUsd: 0.001 }, { reportedUsd: null }],
      },
      { name: "confirmation" },
    ],
    changelog: "- Add baseline comparisons (#67)",
    sourceSha: "a".repeat(40),
    bundleSha: "b".repeat(64),
    runUrl: "https://example.test/run",
  };
  const notes = releaseNotes(input);
  for (const text of [
    "not approved",
    "deepseek/deepseek-v4.1-flash",
    "wafer",
    "3/5 (60.0%)",
    "979.0 ms",
    "1230.0 ms",
    "5%",
    "Not completed",
    "$0.00100000",
    "1 calls have unknown cost",
    "#67",
  ])
    assert.ok(notes.includes(text), text);
  const reportOnly = releaseNotes({ ...input, policy: { version: "6" } });
  assert.ok(reportOnly.includes("latency is reported and does not gate approval"));
  assert.ok(!reportOnly.includes("latency margin"));
  input.phases[0].comparison.gains = ["new-pass"];
  input.phases[0].comparison.regressions = ["lost-pass"];
  const overall = releaseNotes({ ...input, qualified: true, policy: { version: "7" } });
  assert.ok(overall.includes("Overall correctness must match or exceed the baseline"));
  assert.ok(overall.includes("new passes: `new-pass`"));
  assert.ok(overall.includes("lost baseline passes: `lost-pass`"));
  assert.ok(overall.includes("future policy change"));
});
