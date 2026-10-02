import assert from "node:assert/strict";
import { test } from "node:test";
import { assertParity, selectCases, normalizeStagehand, summarizePairs, main } from "./compare.mjs";
import { prune } from "../run.mjs";
import { mkdtemp, writeFile, readFile, mkdir, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("comparison uses current single-action cases and preserves explicit plural cardinality", () => {
  const cases = selectCases();
  assert.ok(cases.length > 5);
  for (const item of cases) {
    assert.equal(item.contractVersion, "3");
    assert.equal(new Set(item.expected.actions.map((a) => a.action)).size, 1);
    assert.equal(item.mutation, undefined);
  }
  assert.equal(selectCases("single-action-plural-confirmations")[0].cardinality, "all");
  assert.throws(() => selectCases("plural-partial"), /comparison case/);
});

test("missing attempts stay in stratum denominators and partial errors and unknown charges remain visible", () => {
  const manifest = {
    mode: "live",
    cases: [
      { id: "a", cardinality: "singleton" },
      { id: "b", cardinality: "all" },
    ],
    plan: {
      trials: [
        { caseId: "a", repetition: 1 },
        { caseId: "a", repetition: 2 },
        { caseId: "b", repetition: 1 },
      ],
    },
  };
  const report = summarizePairs(manifest, [
    {
      caseId: "a",
      repetition: 1,
      strategy: "custom",
      cardinality: "singleton",
      result: { outcome: "partial" },
      grade: { passed: false, metrics: { unsupported: true, operationalError: true } },
      provider: [{ forwarded: true, reservedUsd: null, reportedUsd: null, usage: null }],
    },
  ]);
  assert.equal(report.strategies.custom.singleton.total, 2);
  assert.equal(report.strategies.stagehand.plural.total, 1);
  assert.equal(report.strategies.custom.errors, 1);
  assert.equal(report.strategies.custom.unsupported, 1);
  assert.equal(report.strategies.custom.reportedUsd, null);
  assert.equal(report.strategies.custom.knownReportedUsd, 0);
  assert.equal(report.strategies.custom.usage.prompt_tokens, null);
  assert.equal(report.commonCoverage, 0);
  assert.equal(report.passed, false);
});

test("replay retains missing trials and rejects a changed runner; pruning removes raw provider snapshots", async (t) => {
  t.mock.method(console, "log", () => {});
  const directory = await mkdtemp(join(tmpdir(), "xpathed-comparison-"));
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const manifest = {
    version: "1",
    id: "test",
    mode: "deterministic",
    createdAt: "2026-08-01T00:00:00Z",
    code: { revision: "test" },
    cases: selectCases("basic-save"),
    plan: { trials: [{ id: "attempt", caseId: "basic-save", repetition: 1 }] },
    graderHash: sha(await readFile(new URL("./grade.mjs", import.meta.url))),
    runnerHash: sha(await readFile(new URL("./compare.mjs", import.meta.url))),
  };
  const persist = () =>
    writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({ ...manifest, contentHash: sha(JSON.stringify(manifest)) }),
    );
  try {
    await persist();
    assert.equal(await main(["--replay", directory]), 1);
    manifest.runnerHash = "changed";
    await persist();
    await assert.rejects(main(["--replay", directory]), /integrity mismatch/);
    await mkdir(join(directory, "trials"));
    await writeFile(
      join(directory, "trials", "attempt.json"),
      JSON.stringify({ evidence: { input: "private" }, result: { outcome: "found" } }),
    );
    await mkdir(join(directory, "provider"));
    await writeFile(join(directory, "provider", "request.json"), "private provider input");
    assert.equal(await prune(directory, new Date("2026-09-01T00:00:00Z")), "evidence_deleted");
    await assert.rejects(access(join(directory, "provider")));
    assert.equal(
      JSON.parse(await readFile(join(directory, "trials", "attempt.json"), "utf8")).evidence,
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment mismatches stop comparison before inference", () => {
  const baseline = {
    viewport: { width: 1280, height: 800 },
    userAgent: "Chrome/123",
    language: "en-US",
    languages: ["en-US"],
    timeZone: "UTC",
    initialState: [{ scroll: [0, 0] }],
    documentChecksum: ["fnv1a32-utf16:abcdabcd"],
  };
  assert.doesNotThrow(() => assertParity(baseline, structuredClone(baseline)));
  for (const key of Object.keys(baseline)) {
    assert.throws(() => assertParity(baseline, { ...baseline, [key]: null }), /parity/);
  }
  assert.throws(() => assertParity({}, {}), /parity/);
});

test("adapter methods are normalized without inventing an action or successful unsupported target", () => {
  assert.equal(normalizeStagehand({ status: "not_found", targets: [] }).outcome, "not_found");
  const result = normalizeStagehand({
    status: "found",
    targets: [{ method: "fill", xpaths: ["//input"], frame: { chain: [] } }],
  });
  assert.equal(result.actions[0].action, "fill");
  assert.equal(result.actions[0].target.xpaths[0], "//input");
  assert.equal(
    normalizeStagehand({ status: "unsupported", targets: [], unsupported: [{}] }).outcome,
    "unsupported",
  );
  assert.equal(
    normalizeStagehand({ status: "found", targets: [{ method: "invented" }] }).actions[0].action,
    "unsupported",
  );
});

test("direct strategy comparison rejects parallel execution before starting services", async () => {
  await assert.rejects(() => main(["--concurrency", "2"]), /Comparison requires concurrency 1/);
});
