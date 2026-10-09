import { createServer } from "node:net";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../evaluation/run.mjs";
import { readEvaluationKey } from "../evaluation/environment.mjs";
import {
  browserExecutable,
  developmentConfig,
  loadEnvironment,
  ManagedProcesses,
  waitForHealth,
} from "./native.mjs";

export function checkOptions(args) {
  const [kind, ...input] = args.filter((value) => value !== "--");
  if (kind === "resolution") {
    if (
      input.length > 1 ||
      (input[0] && !["--deterministic", "--browser-only", "--live"].includes(input[0]))
    )
      throw new Error("Use --deterministic, --browser-only or --live.");
    return {
      kind,
      mode: input[0] === "--live" ? "live" : "deterministic",
      browserOnly: input[0] === "--browser-only",
    };
  }
  if (kind !== "evaluation") throw new Error("Choose resolution or evaluation checks.");
  let xpath = false,
    suite;
  const forwarded = [];
  for (let index = 0; index < input.length; index++) {
    if (input[index] === "--xpath" && !xpath) xpath = true;
    else if (
      input[index] === "--suite" &&
      !suite &&
      input[index + 1] &&
      !input[index + 1].startsWith("--")
    )
      suite = input[++index];
    else forwarded.push(input[index]);
  }
  const options = parseOptions(forwarded);
  if (options.replay || options.prune) throw new Error("Use evaluate:replay for saved results.");
  if (xpath && options.mode !== "deterministic")
    throw new Error("XPath checks use controlled provider-free selections.");
  if (suite && options.mode !== "deterministic")
    throw new Error("Custom suites support controlled provider-free evaluation only.");
  return { kind, mode: options.mode, xpath, suite, args: forwarded };
}

export async function checkEnvironment(root, options, inherited = process.env) {
  const env = await loadEnvironment(root, inherited);
  if (options.suite) {
    const path = await realpath(resolve(root, options.suite));
    const rel = relative(await realpath(root), path);
    const info = await stat(path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !info.isFile() || info.size > 10000000)
      throw new Error("Suite must be a JSON file under this checkout, at most 10 MB.");
    env.XPATHED_EVALUATION_SUITE = path;
  } else delete env.XPATHED_EVALUATION_SUITE;
  if (options.mode === "live") {
    const key =
      options.kind === "evaluation"
        ? await readEvaluationKey({
            ...env,
            XPATHED_ENV_FILE: resolve(root, inherited.XPATHED_ENV_FILE || ".env"),
          })
        : env.OPENROUTER_API_KEY;
    if (!key?.trim())
      throw new Error(
        `Set ${options.kind === "evaluation" ? "OPENROUTER_EVAL_API_KEY" : "OPENROUTER_API_KEY"} for live checks.`,
      );
    env.OPENROUTER_API_KEY = key.trim();
    if (options.kind === "resolution") {
      env.OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
      env.OPENROUTER_PROVIDER = "wafer";
    }
    env.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/";
  } else {
    env.OPENROUTER_API_KEY = "deterministic-fixture-only";
    env.OPENROUTER_MODEL = "deepseek/deepseek-v4.1-flash";
    env.OPENROUTER_PROVIDER = "wafer";
  }
  Object.assign(env, {
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
  const options = checkOptions(args);
  const env = await checkEnvironment(root, options);
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
    if (options.mode !== "live") env.OPENROUTER_BASE_URL = `${fixture}/api/v1/`;
    const config = developmentConfig(root, env, ports.slice(0, 4));
    const publicEnv = {
      ...config.services[0].env,
      XPATHED_BROWSER_URL: config.urls.browser,
      XPATHED_RESOLVER_URL: config.urls.resolver,
      XPATHED_CLIENT_API_URL: config.urls["client-api"],
      XPATHED_FIXTURE_URL: fixture,
      XPATHED_FIXTURE_PORT: String(ports[4]),
      XPATHED_FIXTURE_HOST: "127.0.0.1",
      XPATHED_ORACLE_PORT: String(ports[5]),
      XPATHED_ORACLE_URL: `http://127.0.0.1:${ports[5]}`,
      XPATHED_CROSS_ORIGIN_HOST: "localhost",
      XPATHED_VIEWER_ORIGIN: config.urls.browser,
      XPATHED_WORKSPACE: root,
    };
    const services = config.services.filter(
      (service) =>
        service.name !== "web" &&
        (service.name !== "client-api" ||
          (options.kind === "resolution" && !options.browserOnly && options.mode !== "live")),
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
    await new Promise((done) => reservations[4].close(done));
    processes.start({
      name: "fixture",
      command: process.execPath,
      args: [
        options.kind === "evaluation"
          ? "evaluation/fixtures/server.mjs"
          : "tests/resolution/server.mjs",
      ],
      env: publicEnv,
    });
    await waitForHealth(`${fixture}/health`, abort.signal);
    for (const service of services) {
      abort.signal.throwIfAborted();
      const index = config.services.findIndex((item) => item.name === service.name);
      await new Promise((done) => reservations[index + 1].close(done));
      processes.start(service);
      await waitForHealth(service.health, abort.signal);
    }
    await new Promise((done) => reservations[5].close(done));
    const run = (name, args, environment = publicEnv) =>
      processes.run({ name, command: process.execPath, args, env: environment });
    if (options.kind === "evaluation") {
      await run("Evaluation", [
        options.xpath ? "evaluation/xpath.mjs" : "evaluation/run.mjs",
        ...options.args,
      ]);
    } else if (options.mode === "live") {
      await run("Live checks", [
        "--test",
        "tests/resolution/live.test.mjs",
        "tests/resolution/cardinality.live.test.mjs",
      ]);
    } else {
      const files = [
        "tests/resolution/browser.test.mjs",
        ...(!options.browserOnly ? ["tests/resolution/pipeline.test.mjs"] : []),
      ];
      await run("Chromium browser checks", ["--test", ...files], publicEnv);
    }
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
