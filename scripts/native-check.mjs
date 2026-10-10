import { createServer } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserExecutable,
  developmentConfig,
  loadEnvironment,
  ManagedProcesses,
  waitForHealth,
} from "./native.mjs";

export function checkOptions(args) {
  if (args.some((value) => value !== "--"))
    throw new Error("Use pnpm test:browser without options.");
}

export async function checkEnvironment(root, inherited = process.env) {
  const env = await loadEnvironment(root, inherited);
  for (const key of Object.keys(env))
    if (/^(OPENROUTER_|OpenRouter__)/iu.test(key)) delete env[key];
  Object.assign(env, {
    OPENROUTER_API_KEY: "deterministic-fixture-only",
    OPENROUTER_MODEL: "deepseek/deepseek-v4.1-flash",
    OPENROUTER_PROVIDER: "wafer",
    API_REQUESTS_PER_MINUTE: "100000",
    API_CONCURRENT_REQUESTS: "32",
    MODEL_CALLS_PER_MINUTE: "100000",
    MODEL_CALLS_PER_DAY: "100000",
    MODEL_CONCURRENT_CALLS: "32",
  });
  return env;
}

export async function main(args = process.argv.slice(2)) {
  const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  checkOptions(args);
  const env = await checkEnvironment(root);
  env.BROWSER_EXECUTABLE_PATH = await browserExecutable(env);
  const abort = new AbortController();
  let failure;
  let interrupted = false;
  let processes;
  const stop = (error) => {
    if (abort.signal.aborted) return;
    if (error instanceof Error) failure = error;
    abort.abort();
    void processes?.stop();
  };
  processes = new ManagedProcesses(root, stop);
  const reservations = [];
  const temporary = await mkdtemp(join(tmpdir(), "xpathed-native-check-"));
  const interrupt = () => {
    interrupted = true;
    stop();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    // Hold ephemeral ports until each owner starts; other checkouts can run independently.
    for (let index = 0; index < 6; index++) {
      const server = createServer();
      await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
      });
      reservations.push(server);
    }
    const ports = reservations.map((server) => server.address().port);
    const fixture = `http://127.0.0.1:${ports[4]}`;
    env.OPENROUTER_BASE_URL = `${fixture}/api/v1/`;
    const config = developmentConfig(root, env, ports.slice(0, 4));
    const publicEnv = {
      ...config.services[0].env,
      XPATHED_BROWSER_URL: config.urls.browser,
      XPATHED_RESOLVER_URL: config.urls.resolver,
      XPATHED_FIXTURE_HOST: "127.0.0.1",
      XPATHED_CROSS_ORIGIN_HOST: "localhost",
      XPATHED_VIEWER_ORIGIN: config.urls.browser,
      XPATHED_WORKSPACE: root,
    };
    const services = config.services.filter(
      (service) => service.name === "browser" || service.name === "resolver",
    );
    const artifacts = join(temporary, "build");
    publicEnv.XPATHED_RUNTIME_ARTIFACTS = artifacts;
    for (const service of services) {
      abort.signal.throwIfAborted();
      const project = service.args[3];
      await processes.run({
        name: `Build ${service.name}`,
        command: "dotnet",
        args: [
          "build",
          project,
          "--configuration",
          "Release",
          "--artifacts-path",
          artifacts,
          "-p:RestoreLockedMode=true",
          "--disable-build-servers",
          "--nologo",
        ],
        env: publicEnv,
      });
      service.command = "dotnet";
      service.args = [
        join(artifacts, "bin", project.split("/")[1], "release", `${project.split("/")[1]}.dll`),
      ];
    }
    abort.signal.throwIfAborted();
    for (const service of services) {
      abort.signal.throwIfAborted();
      const index = config.services.findIndex((item) => item.name === service.name);
      await new Promise((done) => reservations[index + 1].close(done));
      processes.start(service);
      await waitForHealth(service.health, abort.signal);
    }
    for (const server of reservations.slice(4)) await new Promise((done) => server.close(done));
    // Complementary filters cover every case; separate processes isolate fixture state.
    const pattern = "^(session|viewer|targeting|capture)-";
    await Promise.all(
      ["name", "skip"].map((filter, index) =>
        processes.run({
          name: `Chromium browser checks ${index + 1}`,
          command: process.execPath,
          args: [
            "--test",
            `--test-${filter}-pattern=${pattern}`,
            "tests/resolution/browser.test.mjs",
          ],
          env: {
            ...publicEnv,
            XPATHED_ORACLE_PORT: String(ports[index + 4]),
            XPATHED_ORACLE_URL: `http://127.0.0.1:${ports[index + 4]}`,
          },
        }),
      ),
    );
  } catch (error) {
    if (!abort.signal.aborted) failure = error;
  } finally {
    stop();
    await processes.stop();
    await Promise.all(
      reservations
        .filter((server) => server.listening)
        .map((server) => new Promise((done) => server.close(done))),
    );
    await rm(temporary, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (failure) throw failure;
  return interrupted ? 130 : 0;
}

if (import.meta.main)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
