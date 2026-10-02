import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readCollection } from "./collection.mjs";

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
    input,
    expected: { actions: [{ target: { candidateId: "c1" } }] },
    review: {
      caseId: "source-case",
      providerSubmission: true,
      status: "reviewed",
      inputHash: hash(JSON.stringify(input)),
    },
  };
  const collection = { version: 1, cases: [spec] };
  const write = (value, overrides = {}) => {
    const bytes = gzipSync(JSON.stringify(value));
    writeFileSync(packagePath, bytes);
    writeFileSync(
      configPath,
      JSON.stringify({
        path: "reviewed.json.gz",
        sha256: hash(bytes),
        cases: value.cases.length,
        ...overrides,
      }),
    );
  };
  write(collection);
  assert.deepEqual(readCollection(configPath, directory), [spec]);

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
  write({ version: 1, cases: [spec, spec] });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
  write(collection, { cases: 2 });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
  write({ version: 1, cases: [] });
  assert.throws(() => readCollection(configPath, directory), /inventory mismatch/);
});
