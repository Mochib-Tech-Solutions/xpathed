import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { once } from "node:events";
import { localDocker, localDockerHost } from "./release/bundle.mjs";
import { startOfflineWorker } from "./release/offline.mjs";

// Called by evaluate.sh after its isolated Resolver and evaluation runner are ready.
const [envFile, ...args] = process.argv.slice(2);
const dockerHost = await localDockerHost();
const docker = await localDocker(dockerHost);
const project = process.env.COMPOSE_PROJECT_NAME;
const id = (
  await docker([
    "ps",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    "label=com.docker.compose.service=resolver",
  ])
).trim();
if (!/^[a-f\d]{64}$/.test(id)) throw new Error("Expected exactly one model-evaluation Resolver");
const [container] = JSON.parse(await docker(["inspect", id]));
const directory = await realpath(process.cwd());
if (container.Config?.Labels?.["com.docker.compose.project.working_dir"] !== directory)
  throw new Error("Model-evaluation Resolver belongs to another checkout");
const stop = startOfflineWorker(
  {
    output: process.env.XPATHED_EVALUATION_OUTPUT,
    project,
    directory,
    dockerHost,
    service: "resolver",
    artifact: { images: [null, { id: container.Image }] },
  },
  docker,
);
let child;
const interrupt = (signal) => child?.kill(signal);
const onInt = () => interrupt("SIGINT");
const onTerm = () => interrupt("SIGTERM");
process.on("SIGINT", onInt);
process.on("SIGTERM", onTerm);
try {
  child = spawn(
    "docker/compose.sh",
    [
      "--env-file",
      envFile,
      "-f",
      "docker/compose.evaluation.yaml",
      "-f",
      "docker/compose.qualification.yaml",
      "exec",
      "-T",
      "-e",
      `XPATHED_MODEL_IMAGE=${container.Image}`,
      "evaluation-fixture",
      "node",
      "/evaluation/model.mjs",
      ...args,
    ],
    { stdio: "inherit", env: { ...process.env, DOCKER_HOST: dockerHost, DOCKER_CONTEXT: "" } },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  await stop();
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
}
