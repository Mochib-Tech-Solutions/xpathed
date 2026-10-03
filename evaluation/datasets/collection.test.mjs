import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readCollection, labelExclusions, validateLabelReview } from "./collection.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("reviewed collection binds package bytes, inventory, and each submitted input", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xpathed-reviewed-collection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "collection.json");
  const packagePath = join(directory, "reviewed.json.gz");
  const input = {
    instruction: "Click Save",
    candidates: [{ id: "c1", tag: "button", label: "Save" }],
  };
  const spec = {
    id: "source-case",
    instruction: input.instruction,
    input,
    expected: { actions: [{ outcome: "found", target: { candidateId: "c1" } }] },
    review: {
      caseId: "source-case",
      providerSubmission: true,
      status: "reviewed",
      inputHash: hash(JSON.stringify(input)),
    },
  };
  const labelReview = {
    caseId: spec.id,
    inputHash: hash(JSON.stringify(input)),
    labelHash: hash(JSON.stringify(spec.expected)),
    disposition: "validated",
    reason: "Unique named button matches the instruction and source target.",
    reviewer: "fixture-source-review",
    reviewedAt: "2026-10-03T00:00:00Z",
  };
  const collection = { version: 1, cases: [spec] };
  const write = (value, overrides = {}, reviews = [labelReview]) => {
    const bytes = gzipSync(JSON.stringify(value));
    writeFileSync(packagePath, bytes);
    const auditBytes = Buffer.from(
      JSON.stringify({ version: 1, archiveSha256: hash(bytes), cases: reviews }),
    );
    writeFileSync(join(directory, "labels.json"), auditBytes);
    writeFileSync(
      configPath,
      JSON.stringify({
        path: "reviewed.json.gz",
        sha256: hash(bytes),
        cases: value.cases.length,
        labelReview: { path: "labels.json", sha256: hash(auditBytes) },
        ...overrides,
      }),
    );
  };
  write(collection);
  assert.deepEqual(readCollection(configPath, directory), [{ ...spec, labelReview }]);

  writeFileSync(packagePath, gzipSync(JSON.stringify({ ...collection, version: 2 })));
  assert.throws(() => readCollection(configPath, directory), /package digest mismatch/);

  for (const [name, change] of [
    ["changed input", (value) => (value.cases[0].input.instruction = "Click Delete")],
    ["changed review hash", (value) => (value.cases[0].review.inputHash = "0".repeat(64))],
    ["submission not approved", (value) => (value.cases[0].review.providerSubmission = false)],
    ["review incomplete", (value) => (value.cases[0].review.status = "pending")],
    ["review missing", (value) => delete value.cases[0].review],
  ]) {
    const changed = structuredClone(collection);
    change(changed);
    write(changed);
    assert.throws(() => readCollection(configPath, directory), /submission review/, name);
  }
  write({ ...collection, cases: [{ ...spec, labelReview }] }, {}, [
    { ...labelReview, caseId: "wrong" },
  ]);
  assert.throws(() => readCollection(configPath, directory), /label review inventory/);
  assert.deepEqual(labelExclusions([{ ...spec, labelReview }], "other"), [
    { caseId: spec.id, reason: "case filter" },
  ]);
  const changedLabel = structuredClone(collection);
  changedLabel.cases[0].expected.actions[0].target.candidateId = "wrong";
  write(changedLabel);
  assert.throws(() => readCollection(configPath, directory), /label review/);
  write(collection, { labelReview: undefined });
  assert.throws(() => readCollection(configPath, directory), /semantic label review/);
  write(collection);
  writeFileSync(join(directory, "labels.json"), "{}");
  assert.throws(() => readCollection(configPath, directory), /label review digest/);
  const ambiguous = {
    ...spec,
    labelReview: { ...labelReview, disposition: "ambiguous", reason: "Two controls match." },
  };
  assert.deepEqual(labelExclusions([ambiguous]), [
    { caseId: spec.id, reason: "label ambiguous: Two controls match." },
  ]);
  for (const mutation of [
    { inputHash: "0".repeat(64) },
    { labelHash: "0".repeat(64) },
    { caseId: "other" },
    { disposition: "guessed" },
    { reviewer: "" },
    { reviewedAt: null },
  ])
    assert.throws(() => validateLabelReview(spec, { ...labelReview, ...mutation }), /label review/);
  const missingIds = {
    ...spec,
    input: { instruction: spec.instruction, candidates: [{}] },
    expected: { actions: [{ outcome: "found", target: {} }] },
  };
  assert.throws(
    () =>
      validateLabelReview(missingIds, {
        ...labelReview,
        inputHash: hash(JSON.stringify(missingIds.input)),
        labelHash: hash(JSON.stringify(missingIds.expected)),
      }),
    /label review/,
  );
  write({ version: 1, cases: [spec, spec] });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
  write(collection, { cases: 2 });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
  write({ version: 1, cases: [] });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
});
