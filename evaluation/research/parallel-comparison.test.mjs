import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  baselineId,
  continuationPlan,
  runWorkerQueues,
  workerRouter,
} from "./parallel-comparison.mjs";

const planned = {
  id: "a".repeat(32),
  caseId: "case",
  profileId: "deepseek",
  attempt: 1,
  repetition: 1,
};
const manifest = { comparison: {}, plan: { trials: [planned] } };
test("continuation skips failed completed arms and only schedules missing baseline", () => {
  const trial = { ...planned, grade: { passed: false } };
  const tasks = continuationPlan(manifest, [trial], [{ attemptId: planned.id, forwarded: true }]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].candidateDone, true);
  assert.equal(tasks[0].baselineDone, false);
  trial.baseline = {
    ...planned,
    id: baselineId(planned.id),
    profileId: "release-baseline",
    grade: { passed: false },
  };
  assert.deepEqual(continuationPlan(manifest, [trial], []), []);
});
test("continuation refuses orphan provider evidence and durable claims", () => {
  assert.throws(
    () => continuationPlan(manifest, [], [{ attemptId: planned.id, forwarded: true }]),
    /Unfinished attempted arm/,
  );
  assert.throws(
    () => continuationPlan(manifest, [], [], new Set([planned.id])),
    /Unfinished attempted arm/,
  );
});
test("worker queues isolate browser serially, bound workers and drain failures", async () => {
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: i, offline: i >= 3 }));
  let active = 0,
    peak = 0,
    browser = 0,
    browserPeak = 0;
  const seen = [];
  await runWorkerQueues(tasks, 3, async (task, worker) => {
    active++;
    peak = Math.max(peak, active);
    if (!task.offline) {
      browser++;
      browserPeak = Math.max(browserPeak, browser);
      assert.equal(worker, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(task.id);
    active--;
    if (!task.offline) browser--;
  });
  assert.equal(peak, 3);
  assert.equal(browserPeak, 1);
  assert.equal(new Set(seen).size, 12);
  let finished = 0;
  await assert.rejects(
    runWorkerQueues(tasks, 3, async (_, worker) => {
      await new Promise((resolve) => setTimeout(resolve, worker ? 10 : 1));
      finished++;
      if (!worker) throw new Error("integrity");
    }),
    /integrity/,
  );
  assert.equal(finished, 3);
});
test("token router sends concurrent requests to their own proxy and rejects unknown worker", async () => {
  const servers = [0, 1].map((id) =>
    createServer((req, res) => {
      res.end(String(id));
    }),
  );
  let router;
  try {
    for (const server of servers) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    router = workerRouter(
      servers.map((server) => server.address().port),
      { "qualification-proxy-only": 0, "comparison-only": 1 },
    );
    router.listen(0, "127.0.0.1");
    await once(router, "listening");
    const url = `http://127.0.0.1:${router.address().port}/api/v1/chat/completions`;
    assert.deepEqual(
      await Promise.all(
        [0, 1].map(async (id) =>
          (
            await fetch(url, { headers: { authorization: `Bearer evaluation-worker-${id}` } })
          ).text(),
        ),
      ),
      ["0", "1"],
    );
    assert.equal(
      (await fetch(url, { headers: { authorization: "Bearer evaluation-worker-9" } })).status,
      403,
    );
    assert.equal(
      await (await fetch(url, { headers: { authorization: "Bearer comparison-only" } })).text(),
      "1",
    );
    assert.equal((await fetch(url)).status, 403);
    assert.equal(
      (await fetch(url, { headers: { authorization: "qualification-proxy-only" } })).status,
      403,
    );
    assert.equal(
      (await fetch(url, { headers: { authorization: "Bearer unexpected" } })).status,
      403,
    );
    assert.equal(
      await (
        await fetch(url, { headers: { authorization: "Bearer qualification-proxy-only" } })
      ).text(),
      "0",
    );
  } finally {
    await Promise.all(
      [...servers, router]
        .filter(Boolean)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
});
