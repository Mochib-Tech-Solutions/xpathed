import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEvaluationSet, main } from "./evaluate-all.mjs";

test("evaluate runs both categories, retains a failed category and never hides missing evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluate-all-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = t.mock.method(console, "log", () => {});
  const calls = [];
  const output = join(root, "run");
  const code = await runEvaluationSet(output, async (args) => {
    calls.push(args);
    const path = args.at(-1);
    if (calls.length !== 2) {
      await mkdir(path);
      await writeFile(
        join(path, "summary.json"),
        JSON.stringify({
          passed: calls.length !== 1,
          plannedTrials: 2,
          completedTrials: 2,
          firstAttempt: { passed: calls.length === 1 ? 1 : 2 },
        }),
      );
    }
    return calls.length === 1 ? 1 : 0;
  });
  assert.equal(code, 1);
  assert.deepEqual(
    calls.map((args) => args.slice(0, -2)),
    [["--xpath"], ["--mode", "live"]],
  );
  const summary = JSON.parse(await readFile(join(output, "summary.json")));
  assert.deepEqual(
    summary.categories.map((item) => item.passed),
    [false, false],
  );
  assert.deepEqual(summary.pending, []);
  assert.equal(summary.categories[1].planned, null);
  assert.deepEqual(
    summary.categories.map((item) => item.category),
    ["xpath", "resolver"],
  );
  const displayed = log.mock.calls.map((call) => call.arguments[0]).join("\n");
  assert.match(
    displayed,
    /XPath construction and verification; inference mode: controlled provider-free/,
  );
  assert.match(displayed, /Live-browser Resolver; inference mode: live provider inference/);
  assert.match(displayed, /FAIL XPath construction and verification: 1\/2/);
});

test("evaluate stops further categories after an evidence-integrity failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluate-all-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, "log", () => {});
  let calls = 0;
  const output = join(root, "run");
  const code = await runEvaluationSet(output, async (args) => {
    calls++;
    const path = args.at(-1);
    await mkdir(path);
    await writeFile(
      join(path, "summary.json"),
      JSON.stringify({ passed: false, stopFurtherInference: true }),
    );
    return 1;
  });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  const summary = JSON.parse(await readFile(join(output, "summary.json")));
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.pending, ["resolver"]);
});

test("evaluate help and rejected options do not start evaluation", async (t) => {
  t.mock.method(console, "log", () => {});
  assert.equal(await main(["--help"]), 0);
  await assert.rejects(main(["--case", "save"]), /separate category commands/);
});
