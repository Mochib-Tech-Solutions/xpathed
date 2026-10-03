import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function startOfflineWorker(state, docker) {
  const concurrency = state.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Saved-page selection concurrency must be between 1 and 8");
  let stopped = false,
    failure;
  const pending = new Set();
  const activeWorkers = new Set();
  const directory = join(state.output, "offline");
  const completed = new Set();
  async function execute(id, input, prepare, workerId) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        "docker",
        [
          "exec",
          "-i",
          ...(workerId === undefined
            ? []
            : ["-e", `OpenRouter__ApiKey=evaluation-worker-${workerId}`]),
          id,
          "dotnet",
          "Resolver.dll",
          "--evaluate-offline",
          "/dev/stdin",
          ...(prepare ? ["--prepare-only"] : []),
        ],
        {
          env: { ...process.env, DOCKER_HOST: state.dockerHost, DOCKER_CONTEXT: "" },
          timeout: 65000,
          maxBuffer: 2_000_000,
        },
        (error, stdout) => {
          try {
            if (error?.killed || !stdout.trim())
              throw new Error("Saved-page selection worker execution failed");
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    });
  }
  async function processRequest(file) {
    const path = join(directory, file);
    let response,
      prepared,
      worker,
      ownsWorker = false;
    try {
      const request = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof request.expectedPreparedInputHash !== "string" ||
        !/^[a-f\d]{64}$/.test(request.expectedPreparedInputHash)
      )
        throw Object.assign(
          new Error("Invalid Saved-page selection request: missing reviewed prepared input hash"),
          { code: "unreviewed_prepared_input" },
        );
      if (
        typeof request.baseline !== "boolean" ||
        !request.input ||
        (request.workerId !== undefined &&
          (!Number.isInteger(request.workerId) || request.workerId < 0 || request.workerId > 15)) ||
        (request.baseline && !state.comparison)
      )
        throw new Error("Invalid Saved-page selection request");
      worker = request.workerId ?? "legacy";
      if (activeWorkers.has(worker))
        throw new Error("Saved-page selection worker already has an active request");
      activeWorkers.add(worker);
      ownsWorker = true;
      const service = request.baseline ? "resolver-baseline" : state.service;
      const id = (
        await docker([
          "ps",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.docker.compose.project=${state.project}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
        ])
      ).trim();
      if (!/^[a-f\d]{64}$/.test(id)) throw new Error("Expected exactly one Resolver container");
      const [container] = JSON.parse(await docker(["inspect", id]));
      const artifact = request.baseline ? state.comparison.artifact : state.artifact;
      if (
        container.Image !== artifact.images[1].id ||
        container.Config?.Labels?.["com.docker.compose.project.working_dir"] !== state.directory
      )
        throw new Error("Saved-page selection Resolver artifact mismatch");
      prepared = await execute(id, request.input, true, request.workerId);
      if (prepared.outcome === "error")
        throw new Error("Resolver rejected Saved-page selection input");
      const preparedInputHash = createHash("sha256")
        .update(JSON.stringify(JSON.parse(prepared.modelInput)))
        .digest("hex");
      if (preparedInputHash !== request.expectedPreparedInputHash)
        throw Object.assign(
          new Error("Prepared model input does not match the reviewed input hash"),
          { code: "unreviewed_prepared_input" },
        );
      const start = performance.now();
      const result = await execute(id, request.input, false, request.workerId);
      response = { prepared, result, elapsedMs: performance.now() - start };
    } catch (error) {
      response = {
        ...(prepared === undefined ? {} : { prepared }),
        error: error.message,
        ...(error.code === "unreviewed_prepared_input" ? { errorCode: error.code } : {}),
      };
    } finally {
      if (ownsWorker) activeWorkers.delete(worker);
    }
    await writeFile(`${path}.partial`, JSON.stringify(response), { flag: "wx", mode: 0o600 });
    await rename(`${path}.partial`, path.replace(".request.json", ".response.json"));
    await rm(path);
  }
  const running = (async () => {
    try {
      while (!stopped) {
        const files = await readdir(directory).catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        for (const file of files) {
          if (stopped || pending.size >= concurrency) break;
          if (!/^[a-f\d]{32}\.request\.json$/.test(file) || completed.has(file)) continue;
          completed.add(file);
          const task = processRequest(file)
            .catch((error) => {
              failure ??= error;
              stopped = true;
            })
            .finally(() => pending.delete(task));
          pending.add(task);
        }
        if (!stopped) await delay(100);
      }
    } finally {
      await Promise.allSettled(pending);
    }
    if (failure) throw failure;
  })();
  void running.catch(() => {});
  return async () => {
    stopped = true;
    await running;
  };
}
