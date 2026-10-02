import assert from "node:assert/strict";
import test from "node:test";
import { nextCandidateTag, releaseNotes } from "./release-notes.mjs";

test("release candidates follow the package version and never overwrite a stable release", () => {
  assert.equal(nextCandidateTag("1.0.0", ["candidate-123-1"]), "v1.0.0-rc.1");
  assert.equal(nextCandidateTag("1.0.0", ["v1.0.0-rc.2", "v1.0.0-rc.9"]), "v1.0.0-rc.10");
  assert.throws(() => nextCandidateTag("1.0.0", ["v1.0.0"]), /Bump/);
  assert.throws(() => nextCandidateTag("01.0.0", []), /MAJOR/);
});

test("release notes show both arms, incomplete qualification and unknown charges honestly", () => {
  const notes = releaseNotes({
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
  });
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
});
