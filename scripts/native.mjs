import { fork } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export async function loadEnvironment(root, inherited = process.env) {
  const file = resolve(root, inherited.XPATHED_ENV_FILE || ".env");
  const content = await readFile(file, "utf8").catch((error) => {
    if (error.code === "ENOENT" && !inherited.XPATHED_ENV_FILE) return "";
    throw error;
  });
  return { ...parseEnv(content), ...inherited };
}

export async function browserExecutable(env, platform = process.platform) {
  if (!["darwin", "linux"].includes(platform))
    throw new Error("Native development supports macOS and Linux.");
  const explicit = env.BROWSER_EXECUTABLE_PATH;
  const candidates = explicit
    ? [resolve(explicit)]
    : [
        ...(platform === "darwin"
          ? [
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Chromium.app/Contents/MacOS/Chromium",
              join(env.HOME || "/", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            ]
          : []),
        ...(env.PATH || "")
          .split(":")
          .filter(Boolean)
          .flatMap((path) =>
            ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((name) =>
              join(path, name),
            ),
          ),
      ];
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK)
        .then(() => stat(candidate))
        .then(
          (info) => info.isFile(),
          () => false,
        )
    )
      return candidate;
  }
  throw new Error(
    explicit
      ? "BROWSER_EXECUTABLE_PATH must name an installed executable."
      : "Install Google Chrome or Chromium, or set BROWSER_EXECUTABLE_PATH to its executable.",
  );
}

export function developmentConfig(root, env, assignedPorts) {
  const value = env.XPATHED_PORT || "8080";
  const base = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(base) || base < 1024 || base > 65532)
    throw new Error("XPATHED_PORT must be an integer from 1024 to 65532 (four consecutive ports).");
  const ports = assignedPorts ?? [base, base + 1, base + 2, base + 3];
  const urls = Object.fromEntries(
    ["web", "browser", "resolver", "client-api"].map((name, index) => [
      name,
      `http://127.0.0.1:${ports[index]}`,
    ]),
  );
  const shared = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/^(OPENROUTER_|OpenRouter__|DEPLOY_|XPATHED_DEPLOY_)/iu.test(key),
    ),
  );
  Object.assign(shared, {
    ASPNETCORE_ENVIRONMENT: "Development",
    DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER: "1",
    DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH: "1",
    DOTNET_WATCH_RESTART_ON_RUDE_EDIT: "1",
    Logging__LogLevel__Default: "Warning",
    RateLimits__RequestsPerMinute: env.API_REQUESTS_PER_MINUTE || "120",
    RateLimits__ConcurrentRequests: env.API_CONCURRENT_REQUESTS || "8",
  });
  const services = [
    {
      name: "browser",
      project: "Browser",
      environment: {
        BrowserExecutablePath: env.BROWSER_EXECUTABLE_PATH,
        ViewerOrigins: [urls.web, `http://localhost:${ports[0]}`, urls.browser].join(","),
      },
    },
    {
      name: "resolver",
      project: "Resolver",
      environment: {
        BrowserUrl: urls.browser,
        OpenRouter__ApiKey: env.OPENROUTER_API_KEY || "",
        OpenRouter__Model: env.OPENROUTER_MODEL || "deepseek/deepseek-v4.1-flash",
        OpenRouter__Provider: env.OPENROUTER_PROVIDER || "inference-net/fp8",
        OpenRouter__BaseUrl: env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1/",
        OpenRouter__TimeoutSeconds: env.OPENROUTER_TIMEOUT_SECONDS || "30",
        ModelUsage__CallsPerMinute: env.MODEL_CALLS_PER_MINUTE || "20",
        ModelUsage__CallsPerDay: env.MODEL_CALLS_PER_DAY || "1000",
        ModelUsage__ConcurrentCalls: env.MODEL_CONCURRENT_CALLS || "2",
      },
    },
    {
      name: "client-api",
      project: "ClientApi",
      environment: {
        BrowserUrl: urls.browser,
        ResolverUrl: urls.resolver,
      },
    },
  ].map(({ name, project, environment }) => ({
    name,
    command: "dotnet",
    args: [
      "watch",
      "--non-interactive",
      "--project",
      `src/${project}/${project}.csproj`,
      "--artifacts-path",
      join(root, ".artifacts/dev", name),
      "--no-launch-profile",
    ],
    env: { ...shared, ...environment, ASPNETCORE_URLS: urls[name] },
    health: `${urls[name]}/health`,
  }));
  services.push({
    name: "web",
    command: "pnpm",
    args: [
      "--filter",
      "xpathed",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(ports[0]),
      "--strictPort",
    ],
    env: { ...shared, XPATHED_URL: urls["client-api"], XPATHED_BROWSER_URL: urls.browser },
    health: urls.web,
  });
  return { urls, ports, services };
}

export class ManagedProcesses {
  #children = new Set();
  #root;
  #failed;
  constructor(root, failed) {
    this.#root = root;
    this.#failed = failed;
  }
  start({ name, command, args, env }, finite = false) {
    const child = fork(new URL("./service-process.mjs", import.meta.url), [], {
      cwd: this.#root,
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const done = new Promise((resolveDone) => {
      child.once("error", () => this.#failed(new Error(`${name} could not start.`)));
      child.once("exit", (code, signal) => {
        this.#children.delete(entry);
        resolveDone({ code, signal });
        if (!finite) this.#failed(new Error(`${name} stopped (${code ?? signal}).`));
      });
    });
    const entry = { child, done };
    this.#children.add(entry);
    child.send({ command, args }, () => {});
    return done;
  }
  async run(service) {
    const { code, signal } = await this.start(service, true);
    if (code !== 0) throw new Error(`${service.name} failed (${code ?? signal}).`);
  }
  async stop() {
    const entries = [...this.#children];
    for (const { child } of entries) if (child.connected) child.send("stop", () => {});
    await Promise.all(entries.map(({ done }) => done));
  }
}

export async function waitForHealth(url, signal, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      signal.throwIfAborted();
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(`Service did not become healthy at ${url}.`);
}
