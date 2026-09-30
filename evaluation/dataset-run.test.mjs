import assert from "node:assert/strict";
import test from "node:test";
import { reserveCharge, makeCase, lexicalSelection } from "./dataset-run.mjs";
import { gradeTrial } from "./grader.mjs";

test("the shared spending ceiling includes reservations and refuses the next unaffordable call", () => {
  const ledger = {
    ceilingUsd: 5,
    entries: [
      { reservedUsd: 1, reportedUsd: null },
      { reservedUsd: 3, reportedUsd: 2 },
    ],
  };
  assert.equal(reserveCharge(ledger, 1.5, "attempt"), 1.5);
  assert.equal(ledger.entries.length, 3);
  assert.throws(() => reserveCharge(ledger, 0.6, "next"), /budget/i);
  assert.equal(ledger.entries.length, 3);
  assert.throws(() => reserveCharge(ledger, NaN, "invalid"), /charge/i);
});

test("source-only labels measure target identity without inventing annotated actions or browser state", () => {
  const spec = makeCase({
    id: "page-1",
    dataset: "phrasenode",
    split: "train",
    family: "page",
    instruction: "The Save button",
    inputKey: "abc",
    oracle: { candidateId: "n2" },
    provenance: { revision: "source" },
  });
  const selection = lexicalSelection({
    instruction: spec.instruction,
    candidates: [
      { id: "n1", tag: "button", label: "Cancel" },
      { id: "n2", tag: "button", label: "Save" },
    ],
  });
  assert.equal(selection.actions[0].candidateId, "n2");
  assert.equal(spec.expected.actions[0].action, undefined);
  const grade = gradeTrial(spec, {
    result: {
      contractVersion: "offline-1",
      outcome: "found",
      action: "inspect",
      actions: [
        {
          actionId: "a1",
          order: 1,
          step: 1,
          action: "inspect",
          outcome: "found",
          target: { candidateId: "n2" },
        },
      ],
    },
  });
  assert.equal(grade.passed, true);
  assert.equal(grade.metrics.actionsExpected, 0);
  assert.equal(grade.metrics.readinessExpected, 0);
});

test("dataset CLI preserves train-only selection, exact input integrity and replayable reports", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "xpathed-dataset-run-"));
  try {
    const imported = join(root, "import");
    await mkdir(join(imported, "inputs"), { recursive: true });
    const text = JSON.stringify({ candidates: [{ id: "n1", tag: "button", text: "Save" }] }) + "\n";
    const key = createHash("sha256").update(text).digest("hex");
    await writeFile(join(imported, "inputs", `${key}.json`), text);
    const item = {
      id: "train-save",
      status: "offline-eligible",
      dataset: "phrasenode",
      split: "train",
      family: "train-page",
      instruction: "Save",
      inputKey: key,
      oracle: { candidateId: "n1" },
      provenance: { revision: "fixture" },
    };
    for (const [file, data] of Object.entries({
      "cases.json": [item, { ...item, id: "test-save", split: "test", family: "test-page" }],
      "inventory.json": { imported: 2 },
      "manifest.json": { version: 1, revision: "fixture" },
    }))
      await writeFile(join(imported, file), JSON.stringify(data));
    const sha = (value) => createHash("sha256").update(value).digest("hex");
    await writeFile(
      join(imported, "manifest.json"),
      JSON.stringify({
        version: 1,
        revision: "fixture",
        casesSha256: sha(await readFile(join(imported, "cases.json"))),
        inventorySha256: sha(await readFile(join(imported, "inventory.json"))),
      }),
    );
    const output = join(root, "run");
    const run = (...args) =>
      spawnSync(process.execPath, ["evaluation/dataset-run.mjs", ...args], { encoding: "utf8" });
    const result = run("--import", imported, "--output", output);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json")));
    assert.deepEqual(
      manifest.cases.map((item) => item.id),
      ["train-save"],
    );
    const summary = JSON.parse(await readFile(join(output, "summary.json")));
    const replayed = run("--replay", output);
    assert.equal(replayed.status, 0, replayed.stderr);
    assert.deepEqual(JSON.parse(replayed.stdout), summary);
    assert.equal(summary.modelQualityMeasured, false);
    assert.equal(summary.firstAttempt.metrics.actionAccuracy, null);
    await writeFile(join(imported, "inputs", `${key}.json`), text.trimEnd());
    const tampered = join(root, "tampered");
    assert.equal(run("--import", imported, "--output", tampered).status, 1);
    const bad = JSON.parse(await readFile(join(tampered, "summary.json")));
    assert.equal(bad.firstAttempt.metrics.operationalError, 1);
    assert.equal(bad.completedTrials, 1);
    assert.equal(bad.firstAttempt.metrics.targetsCorrect, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
