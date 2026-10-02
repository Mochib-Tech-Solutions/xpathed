import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, writeFile, rename, rmdir, cp } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readRun } from "../compare.mjs";
import { execute, configurationRecord, fingerprints } from "../run.mjs";
import { executeOffline } from "../datasets/offline.mjs";
import { gradeTrial } from "../grader.mjs";
import { summarizeQualification } from "../policy.mjs";
import { createBudgetProxy } from "../provider.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const files = (directory) =>
  readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
export const baselineId = (id) => hash(`${id}:baseline`).slice(0, 32);

// Completed failures are original outcomes, never retry candidates.
export function continuationPlan(manifest, trials, records, claimed = new Set()) {
  const byId = new Map(trials.map((trial) => [trial.id, trial]));
  assert.equal(byId.size, trials.length, "Duplicate trial identity");
  const attempted = new Set([...claimed, ...records.map((record) => record.attemptId)]);
  return manifest.plan.trials.flatMap((planned) => {
    const trial = byId.get(planned.id);
    const candidateDone = !!trial?.grade;
    const baselineDone = !!trial?.baseline?.grade;
    if (trial?.baseline) {
      assert.equal(trial.baseline.id, baselineId(planned.id), "Baseline attempt identity mismatch");
      assert.equal(trial.baseline.caseId, planned.caseId, "Baseline case mismatch");
      assert.equal(trial.baseline.profileId, "release-baseline", "Baseline profile mismatch");
    }
    for (const [id, done] of [
      [planned.id, candidateDone],
      [baselineId(planned.id), baselineDone],
    ])
      if (!done && attempted.has(id))
        throw new Error(`Unfinished attempted arm ${id}; preserve evidence, do not retry`);
    if (candidateDone && baselineDone) return [];
    return [{ planned, trial, candidateDone, baselineDone }];
  });
}

// A browser worker owns all live page setup; other workers only use isolated CLI processes.
export async function runWorkerQueues(tasks, concurrency, executeTask, shouldStop = () => false) {
  assert.ok(Number.isInteger(concurrency) && concurrency >= 2 && concurrency <= 8);
  const browser = tasks.filter((task) => !task.offline);
  const offline = tasks.filter((task) => task.offline);
  let error;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, workerId) => {
      while (!error && !shouldStop()) {
        const task = workerId === 0 ? (browser.shift() ?? offline.shift()) : offline.shift();
        if (!task) return;
        try {
          await executeTask(task, workerId);
        } catch (failure) {
          error ??= failure;
        }
      }
    }),
  );
  if (error) throw error;
}

// Keep BaseUrl unchanged: it contributes to Resolver configuration identity.
export function workerRouter(ports) {
  return createServer((incoming, outgoing) => {
    const token = /^Bearer (.+)$/i.exec(incoming.headers.authorization ?? "")?.[1];
    const match = /^evaluation-worker-(\d+)$/.exec(token ?? "");
    const workerId = match ? Number(match[1]) : 0;
    if ((!match && token !== "qualification-proxy-only") || !Number.isInteger(ports[workerId])) {
      outgoing.writeHead(403);
      outgoing.end();
      return;
    }
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: ports[workerId],
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
}

export async function continueComparison(output, { concurrency = 8, source } = {}) {
  output = resolve(output);
  if (source) {
    source = resolve(source);
    assert.notEqual(source, output, "Source and continuation output must differ");
    assert.ok(
      !(await files(join(source, "offline"))).some(
        (name) => name.endsWith(".request.json") || name.endsWith(".partial"),
      ),
      "Original offline attempts must be drained before copying",
    );
    assert.ok(
      !(await files(join(source, "trials"))).some((name) => name.endsWith(".partial")),
      "Original trial writes must be drained before copying",
    );
    await mkdir(output, { recursive: true, mode: 0o700 });
    const copied = [];
    for (const name of ["manifest.json", "trials", "provider", "offline", "continuations"]) {
      if (!(await files(source)).includes(name)) continue;
      await cp(join(source, name), join(output, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      copied.push(name);
    }
    await save(join(output, "continuation-source.json"), {
      source,
      copied,
      originalManifestSha256: hash(await readFile(join(source, "manifest.json"), "utf8")),
    });
    await mkdir(join(output, "prior-phase"), { recursive: true, mode: 0o700 });
    for (const name of ["run-error.json", "summary.json"])
      if ((await files(source)).includes(name))
        await cp(join(source, name), join(output, "prior-phase", name), {
          force: false,
          errorOnExist: true,
        });
  }
  assert.ok(Number.isInteger(concurrency) && concurrency >= 2 && concurrency <= 8);
  assert.equal(
    process.env.XPATHED_RESEARCH_CONTINUATION,
    "true",
    "Research continuation must be explicit",
  );
  const { manifest, trials } = await readRun(output);
  assert.equal(manifest.mode, "live");
  assert.ok(manifest.comparison && !manifest.monitoring, "Paired research comparison required");
  assert.deepEqual(
    JSON.parse(process.env.XPATHED_RELEASE_ARTIFACT_JSON ?? "null"),
    manifest.qualification.artifact,
    "Candidate image attestation must match the original run",
  );
  assert.deepEqual(
    JSON.parse(process.env.XPATHED_RELEASE_COMPARISON_JSON ?? "null"),
    manifest.comparison,
    "Baseline image attestation must match the original run",
  );
  const records = await Promise.all(
    (await files(join(output, "provider")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => read(join(output, "provider", name))),
  );
  const claimed = new Set();
  for (const file of await files(join(output, "offline"))) {
    const match = /^([a-f\d]{32})\.(?:request|response)\.json$/.exec(file);
    if (match) claimed.add(match[1]);
  }
  const continuations = join(output, "continuations");
  for (const name of await files(continuations))
    for (const file of await files(join(continuations, name, "claims")))
      if (/^[a-f\d]{32}\.json$/.test(file)) claimed.add(file.slice(0, 32));
  const tasks = continuationPlan(manifest, trials, records, claimed).map((task) => ({
    ...task,
    spec: manifest.cases.find((spec) => spec.id === task.planned.caseId),
  }));
  for (const task of tasks) {
    assert.ok(task.spec);
    task.offline = task.spec.track === "offline-selection";
  }
  const generations = new Map();
  let stopReason;
  const inspect = (record) => {
    if (record.identityValid === false || record.responseCacheHit)
      stopReason ??= "Provider identity or response reuse invalid";
    const generation = record.observedIdentity?.generationId;
    if (generation) {
      if (generations.has(generation) && generations.get(generation) !== record.id)
        stopReason ??= "Provider generation reused across attempts";
      generations.set(generation, record.id);
    }
  };
  records.forEach(inspect);
  assert.equal(stopReason, undefined, "Original provider integrity is invalid");
  const lock = join(output, ".parallel-continuation.lock");
  await mkdir(lock);
  const phaseId = randomUUID();
  const phase = join(continuations, phaseId);
  const proxies = [];
  let router;
  const stop = () => {
    stopReason ??= "Stop requested; active attempts drained";
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await mkdir(join(phase, "claims"), { recursive: true, mode: 0o700 });
    const execution = {
      version: 1,
      kind: "research-parallel-continuation",
      phaseId,
      createdAt: new Date().toISOString(),
      originalManifestHash: manifest.contentHash,
      runner: await fingerprints(),
      concurrency,
      maxBrowserPairs: 1,
      latencyCohort: "parallel-continuation",
      armOrder: "candidate-then-baseline",
      releaseApproval: false,
      completedPairsBefore: trials.filter((trial) => trial.grade && trial.baseline?.grade).length,
      tasks: tasks.map((task) => ({
        id: task.planned.id,
        candidateDone: task.candidateDone,
        baselineDone: task.baselineDone,
      })),
    };
    execution.contentHash = hash(execution);
    await save(join(phase, "manifest.json"), execution);
    await save(join(output, "continuation.json"), execution);
    const inferenceProfiles = [
      ...manifest.profiles,
      {
        ...manifest.comparison.profile,
        id: "release-baseline",
        resolver: "http://resolver-baseline:8080",
      },
    ];
    for (let workerId = 0; workerId < concurrency; workerId++) {
      const proxy = await createBudgetProxy({
        profiles: inferenceProfiles,
        ledgerPath: join(phase, `worker-${workerId}-ledger.json`),
        githubRepository: "",
        githubToken: "",
        onRecord: async (record) => {
          try {
            await writeFile(
              join(output, "provider", `${record.id}.json`),
              JSON.stringify(record, null, 2) + "\n",
              { mode: 0o600 },
            );
            inspect(record);
          } catch (error) {
            stopReason ??= "Provider evidence persistence failed";
            throw error;
          }
        },
      });
      proxies.push(proxy);
      proxy.server.listen(0, "127.0.0.1");
      await once(proxy.server, "listening");
    }
    router = workerRouter(proxies.map((proxy) => proxy.server.address().port));
    router.listen(8091, "0.0.0.0");
    await once(router, "listening");
    await save(
      join(phase, "route-metadata.json"),
      proxies.map((proxy, workerId) => ({ workerId, profiles: proxy.profiles })),
    );
    const options = { ...manifest.plan, mode: manifest.mode, concurrency: 1 };
    const persistTrial = async (trial) => {
      const path = join(output, "trials", `${trial.id}.json`);
      await writeFile(`${path}.partial`, JSON.stringify(trial, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(`${path}.partial`, path);
    };
    const runArm = async (task, workerId, baseline) => {
      const planned = {
        ...task.planned,
        ...(baseline ? { id: baselineId(task.planned.id), profileId: "release-baseline" } : {}),
      };
      const trial = {
        ...planned,
        mode: "live",
        createdAt: new Date().toISOString(),
        result: null,
        evidence: null,
        execution: { phaseId, workerId, concurrency, latencyCohort: "parallel-continuation" },
      };
      await save(join(phase, "claims", `${trial.id}.json`), {
        attemptId: trial.id,
        caseId: trial.caseId,
        workerId,
        createdAt: trial.createdAt,
      });
      const proxy = proxies[workerId];
      const profile = inferenceProfiles.find((profile) => profile.id === trial.profileId);
      proxy.beginAttempt(trial.id, profile.id);
      if (task.offline)
        await executeOffline(task.spec, trial, output, options.timeoutMs, baseline, workerId);
      else
        await execute(task.spec, trial, options, {
          browser: baseline
            ? "http://browser-baseline:8080"
            : (process.env.XPATHED_BROWSER_URL ?? "http://browser:8080"),
          fixture: process.env.XPATHED_FIXTURE_URL ?? "http://evaluation-fixture:8090",
          resolver: profile.resolver,
        });
      trial.configuration = configurationRecord(trial);
      await proxy.awaitIdle();
      const calls = proxy.records.filter((record) => record.attemptId === trial.id);
      trial.provider = calls.map(({ request, response, ...metadata }) => metadata);
      trial.evidence = { ...trial.evidence, provider: calls };
      trial.grade = gradeTrial(task.spec, trial);
      return trial;
    };
    try {
      await runWorkerQueues(
        tasks,
        concurrency,
        async (task, workerId) => {
          let trial = task.trial;
          if (!task.candidateDone) {
            trial = await runArm(task, workerId, false);
            await persistTrial(trial);
            const existing = trials.findIndex((saved) => saved.id === trial.id);
            if (existing === -1) trials.push(trial);
            else trials[existing] = trial;
          }
          if (!task.baselineDone && !stopReason) {
            trial.baseline = await runArm(task, workerId, true);
            await persistTrial(trial);
          }
          console.log(
            `PAIR ${trial.id} worker=${workerId} candidate=${trial.grade.passed} baseline=${trial.baseline?.grade?.passed ?? "pending"}`,
          );
        },
        () => !!stopReason,
      );
    } catch (error) {
      stopReason ??= error.message;
    }
    await Promise.all(proxies.map((proxy) => proxy.awaitIdle()));
    const summary = summarizeQualification(manifest, trials, manifest.policy);
    const complete =
      trials.length === manifest.plan.trials.length &&
      trials.every((trial) => trial.grade && trial.baseline?.grade);
    summary.qualifiedCandidates = [];
    summary.researchOnly = true;
    summary.releaseApproval = false;
    summary.execution = {
      complete,
      phaseId,
      concurrency,
      mixedExecutionCohorts: true,
      stopReason: stopReason ?? null,
    };
    await save(join(output, "summary.json"), summary);
    await save(join(phase, "summary.json"), {
      complete,
      stopReason: stopReason ?? null,
      releaseApproval: false,
      mixedExecutionCohorts: true,
      summary,
    });
    await save(
      join(phase, "accounting.json"),
      proxies.map((proxy, workerId) => ({ workerId, budget: proxy.budget })),
    );
    console.log(
      `Research continuation: ${trials.filter((trial) => trial.grade && trial.baseline?.grade).length}/${manifest.plan.trials.length} pairs; ${complete ? "complete" : (stopReason ?? "incomplete")}`,
    );
    return complete && !stopReason ? 0 : 1;
  } finally {
    if (router) await new Promise((resolve) => router.close(resolve));
    await Promise.all(proxies.map((proxy) => proxy.close()));
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert.ok(
      ["--source", "--output", "--concurrency"].includes(name) &&
        args[index + 1] &&
        !Object.hasOwn(values, name),
      "Invalid continuation option",
    );
    values[name] = args[index + 1];
  }
  assert.ok(
    values["--output"],
    "Usage: parallel-comparison.mjs --source ORIGINAL_RUN --output RUN_DIRECTORY --concurrency 8",
  );
  process.exitCode = await continueComparison(values["--output"], {
    source: values["--source"],
    concurrency: Number(values["--concurrency"] ?? "8"),
  });
}
