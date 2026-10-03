import assert from "node:assert/strict";
import test from "node:test";
import { releaseTag, releaseNotes, phaseNotes } from "./notes.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("release identity is the merged Git commit", () => {
  assert.equal(releaseTag("a".repeat(40)), `release-${"a".repeat(40)}`);
  assert.throws(() => releaseTag("1.0.0"), /commit/);
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
    policy: { version: "current" },
    phases: [
      {
        name: "Browser",
        comparison: {
          candidate: { correct: 3, total: 5, p50: 979, p95: 1132 },
          baseline: { correct: 3, total: 5, p50: 967, p95: 1230 },
          reasons: ["correctness_regression"],
        },
        calls: [{ reportedUsd: 0.001 }, { reportedUsd: null }],
      },
      { name: "Offline selection" },
    ],
    caseChanges: { added: ["new-case"], removed: [], changed: ["fixed-label"] },
    changelog: "- Add baseline comparisons (#67)",
    sourceSha: "a".repeat(40),
    bundleSha: "b".repeat(64),
    runUrl: "https://example.test/run",
  };
  const notes = releaseNotes(input);
  for (const text of [
    "did not pass",
    "deepseek/deepseek-v4.1-flash",
    "wafer",
    "3/5 (60.0%)",
    "979.0 ms",
    "1230.0 ms",
    "preserve every baseline pass",
    "Not completed",
    "$0.00100000",
    "1 calls have unknown cost",
    "#67",
    "Added: 1 (`new-case`)",
    "Changed inputs or assertions: 1 (`fixed-label`)",
    "case-changes.json",
  ])
    assert.ok(notes.includes(text), text);
  assert.ok(notes.includes("latency and cost are informational"));
  input.phases[0].comparison.gains = ["new-pass"];
  input.phases[0].comparison.regressions = ["lost-pass"];
  const overall = releaseNotes(input);
  assert.ok(overall.includes("new passes: `new-pass`"));
  assert.ok(overall.includes("lost baseline passes: `lost-pass`"));
  input.phases[0].groups = [
    {
      name: "Browser resolver",
      comparison: { candidate: { correct: 2, total: 3 }, baseline: { correct: 1, total: 3 } },
    },
    {
      name: "Offline selection",
      comparison: { candidate: { correct: 1, total: 2 }, baseline: { correct: 2, total: 2 } },
    },
  ];
  const grouped = releaseNotes(input);
  assert.ok(grouped.includes("| Browser resolver | candidate | 2/3"));
  assert.ok(grouped.includes("| Offline selection | baseline | 2/2"));
  assert.ok(grouped.includes("Retained provider calls: **2**"));
});
