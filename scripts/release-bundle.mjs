import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const components = ["browser", "resolver"];
const inventory = ["configuration.json", "images.tar", "manifest.json", "source.tar"];
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());

function validate(manifest) {
  ensure(
    keys(manifest, [
      "version",
      "status",
      "defaultActivated",
      "sourceSha",
      "profileId",
      "platform",
      "images",
      "files",
    ]) &&
      manifest.version === 1 &&
      manifest.status === "packaged-unqualified" &&
      manifest.defaultActivated === false &&
      /^[a-f\d]{40}$/.test(manifest.sourceSha ?? "") &&
      /^[a-z0-9-]+$/.test(manifest.profileId ?? ""),
    "Unsupported bundle manifest",
  );
  ensure(
    keys(manifest.platform, ["os", "architecture"]) &&
      manifest.platform.os === "linux" &&
      ["amd64", "arm64"].includes(manifest.platform.architecture),
    "Unsupported bundle platform",
  );
  ensure(
    Array.isArray(manifest.images) &&
      manifest.images.length === 2 &&
      new Set(manifest.images.map((image) => image.id)).size === 2 &&
      manifest.images.every(
        (image, i) =>
          keys(image, ["component", "id", "os", "architecture", "sourceSha"]) &&
          image.component === components[i] &&
          /^sha256:[a-f\d]{64}$/.test(image.id ?? "") &&
          image.os === manifest.platform.os &&
          image.architecture === manifest.platform.architecture &&
          image.sourceSha === manifest.sourceSha,
      ),
    "Invalid component image identities",
  );
  ensure(
    keys(
      manifest.files,
      inventory.filter((name) => name !== "manifest.json"),
    ) &&
      Object.values(manifest.files).every(
        (file) =>
          keys(file, ["sha256", "bytes"]) &&
          /^[a-f\d]{64}$/.test(file.sha256 ?? "") &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes > 0,
      ),
    "Invalid bundle file manifest",
  );
}

async function command(program, args, input, env = process.env) {
  const file = input ? await open(input, "r") : null;
  try {
    return await new Promise((resolve, reject) => {
      if (program === "git")
        env = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")));
      const child = spawn(program, args, { stdio: [file?.fd ?? "ignore", "pipe", "inherit"], env });
      const chunks = [];
      let size = 0;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) child.kill();
        else chunks.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 && size <= 1024 * 1024
          ? resolve(Buffer.concat(chunks).toString("utf8").trim())
          : reject(new Error(`${program} ${args[0]} failed`)),
      );
    });
  } finally {
    await file?.close();
  }
}

async function localDocker() {
  ensure(
    !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith("unix:///"),
    "Private bundles require a local Unix Docker endpoint",
  );
  const context = await command("docker", ["context", "show"]);
  const descriptions = JSON.parse(await command("docker", ["context", "inspect", context]));
  const host =
    (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) ||
    descriptions[0]?.Endpoints?.docker?.Host;
  ensure(
    typeof host === "string" && host.startsWith("unix:///"),
    "Private bundles require a local Unix Docker endpoint",
  );
  const env = { ...process.env, DOCKER_BUILDKIT: "1", BUILDX_BUILDER: "default" };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  return (args, input) => command("docker", ["--host", host, ...args], input, env);
}

async function regular(path) {
  const info = await lstat(path);
  ensure(
    info.isFile() && (await realpath(path)) === resolve(path),
    "Bundle files must be regular files without symlinks",
  );
  return info;
}

async function smallFile(path) {
  ensure((await regular(path)).size <= 1024 * 1024, "Bundle metadata exceeds 1 MiB");
  return readFile(path);
}

async function fingerprint(path) {
  await regular(path);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return { sha256: digest.digest("hex"), bytes };
}

function configuration(profile) {
  ensure(
    keys(profile, [
      "id",
      "model",
      "provider",
      "reasoning",
      "maxTokens",
      "resolver",
      "variant",
      ...(Object.hasOwn(profile, "promptCacheOptions") ? ["promptCacheOptions"] : []),
    ]),
    "Unsupported profile settings",
  );
  ensure(
    [profile.id, profile.model, profile.provider, profile.resolver].every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
      profile.maxTokens === 4096 &&
      ["baseline", "concise"].includes(profile.variant) &&
      ((keys(profile.reasoning, ["enabled"]) && profile.reasoning.enabled === false) ||
        (keys(profile.reasoning, ["effort"]) &&
          typeof profile.reasoning.effort === "string" &&
          profile.reasoning.effort.length > 0)) &&
      (!profile.promptCacheOptions ||
        (keys(profile.promptCacheOptions, ["mode"]) &&
          profile.promptCacheOptions.mode === "explicit")),
    "Unsupported profile settings",
  );
  const resolverEnvironment = {
    OpenRouter__Model: profile.model,
    OpenRouter__Provider: profile.provider,
  };
  if (profile.reasoning?.effort)
    resolverEnvironment.OpenRouter__ReasoningEffort = profile.reasoning.effort;
  if (profile.promptCacheOptions?.mode)
    resolverEnvironment.OpenRouter__PromptCacheMode = profile.promptCacheOptions.mode;
  if (profile.variant === "concise") resolverEnvironment.Resolution__PromptVariant = "concise";
  return {
    version: 1,
    profile,
    resolverEnvironment,
    secretsRequired: ["OpenRouter__ApiKey"],
    runtimeDefaults: "frozen-in-images",
    defaultActivated: false,
  };
}

async function archivedConfiguration(source, profileId, sha) {
  ensure(
    (await command("git", ["get-tar-commit-id"], source)) === sha,
    "Archived source revision mismatch",
  );
  const profiles = JSON.parse(
    await command("tar", ["-xOf", source, "evaluation/qualification-profiles.json"]),
  );
  const matches = Array.isArray(profiles) ? profiles.filter((item) => item.id === profileId) : [];
  ensure(matches.length === 1, "Unknown or duplicate archived profile");
  const profile = matches[0];
  return configuration(profile);
}

async function dockerPlatform(docker) {
  const info = JSON.parse(await docker(["info", "--format", "{{json .}}"]));
  const platform = {
    os: info.OSType,
    architecture: { x86_64: "amd64", aarch64: "arm64" }[info.Architecture] ?? info.Architecture,
  };
  ensure(
    platform.os === "linux" && ["amd64", "arm64"].includes(platform.architecture),
    "Only local Linux amd64/arm64 image bundles are supported",
  );
  return platform;
}

async function inspect(docker, id, component, sha, platform) {
  const images = JSON.parse(await docker(["image", "inspect", id]));
  ensure(Array.isArray(images) && images.length === 1, "Missing or duplicate image inspection");
  const image = images[0];
  ensure(
    image.Id === id &&
      image.Os === platform.os &&
      image.Architecture === platform.architecture &&
      image.Config?.Labels?.["org.opencontainers.image.revision"] === sha &&
      image.Config?.Labels?.["tn.chiboub.xpathed.component"] === component,
    "Image identity, platform or source labels mismatch",
  );
  return { component, id, os: image.Os, architecture: image.Architecture, sourceSha: sha };
}

async function create(options) {
  const sha = await command("git", ["rev-parse", "HEAD"]);
  ensure(
    /^[a-f\d]{40}$/.test(options.sourceSha ?? "") && sha === options.sourceSha,
    "Source SHA differs from actual checkout",
  );
  ensure(
    !process.env.XPATHED_CODE_REVISION &&
      !process.env.XPATHED_TREE_HASH &&
      !process.env.XPATHED_WORKSPACE,
    "Source identity overrides are not accepted",
  );
  ensure(
    !(await command("git", ["status", "--porcelain", "--untracked-files=all"])),
    "Bundle creation requires a clean checkout",
  );
  ensure(
    !(await command("git", ["ls-files", "-z"]))
      .split("\0")
      .some((path) => /(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example")),
    "Remove tracked environment files before packaging",
  );
  const output = resolve(options.output);
  await mkdir(output, { mode: 0o700 });
  try {
    const source = join(output, "source.tar");
    await command("git", ["archive", "--format=tar", "--output", source, sha]);
    await chmod(source, 0o600);
    const sourceFingerprint = await fingerprint(source);
    const config = await archivedConfiguration(source, options.profile, sha);
    const configBytes = JSON.stringify(config, null, 2) + "\n";
    await writeFile(join(output, "configuration.json"), configBytes, {
      flag: "wx",
      mode: 0o600,
    });
    const docker = await localDocker();
    const platform = await dockerPlatform(docker);
    const images = [];
    for (const component of components) {
      const iid = join(output, `${component}.iid`);
      await docker(
        [
          "build",
          "--builder",
          "default",
          "--quiet",
          "--platform",
          `${platform.os}/${platform.architecture}`,
          "--file",
          `docker/${component}/Dockerfile`,
          "--target",
          "runtime",
          "--label",
          `org.opencontainers.image.revision=${sha}`,
          "--label",
          `tn.chiboub.xpathed.component=${component}`,
          "--iidfile",
          iid,
          "-",
        ],
        source,
      );
      const id = (await readFile(iid, "utf8")).trim();
      ensure(/^sha256:[a-f\d]{64}$/.test(id), "Invalid built image ID");
      images.push(await inspect(docker, id, component, sha, platform));
      await rm(iid);
    }
    ensure(
      new Set(images.map((image) => image.id)).size === images.length,
      "Components must have distinct image IDs",
    );
    await docker([
      "image",
      "save",
      "--output",
      join(output, "images.tar"),
      ...images.map((image) => image.id),
    ]);
    await chmod(join(output, "images.tar"), 0o600);
    const files = {};
    for (const file of inventory.filter((name) => name !== "manifest.json"))
      files[file] = await fingerprint(join(output, file));
    ensure(
      isDeepStrictEqual(files["source.tar"], sourceFingerprint) &&
        isDeepStrictEqual(files["configuration.json"], {
          sha256: hash(configBytes),
          bytes: Buffer.byteLength(configBytes),
        }),
      "Archived source or configuration changed during packaging",
    );
    ensure(
      (await command("git", ["rev-parse", "HEAD"])) === sha &&
        !(await command("git", ["status", "--porcelain", "--untracked-files=all"])),
      "Source changed during packaging",
    );
    const manifest = {
      version: 1,
      status: "packaged-unqualified",
      defaultActivated: false,
      sourceSha: sha,
      profileId: options.profile,
      platform,
      images,
      files,
    };
    validate(manifest);
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(join(output, "manifest.json"), bytes, { flag: "wx", mode: 0o600 });
    console.log(
      `Bundle packaged without qualification or activation; retain manifest SHA-256 ${hash(bytes)} independently.`,
    );
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function verify(directory, digest) {
  directory = resolve(directory);
  const bytes = await smallFile(join(directory, "manifest.json"));
  ensure(/^[a-f\d]{64}$/.test(digest ?? "") && hash(bytes) === digest, "Manifest SHA-256 mismatch");
  const manifest = JSON.parse(bytes);
  validate(manifest);
  ensure(
    isDeepStrictEqual((await readdir(directory)).sort(), inventory),
    "Unexpected or missing bundle files",
  );
  for (const name of inventory.filter((name) => name !== "manifest.json"))
    ensure(
      isDeepStrictEqual(await fingerprint(join(directory, name)), manifest.files[name]),
      `Bundle file integrity mismatch: ${name}`,
    );
  const config = await archivedConfiguration(
    join(directory, "source.tar"),
    manifest.profileId,
    manifest.sourceSha,
  );
  ensure(
    isDeepStrictEqual(config, JSON.parse(await smallFile(join(directory, "configuration.json")))),
    "Archived configuration mismatch",
  );
  return { directory, manifest };
}

async function main() {
  process.umask(0o077);
  const [operation, ...args] = process.argv.slice(2);
  if (["verify", "restore"].includes(operation)) {
    ensure(
      args.length === 3 && args[1] === "--sha256",
      "Use verify/restore DIRECTORY --sha256 MANIFEST_DIGEST",
    );
    const { directory, manifest } = await verify(args[0], args[2]);
    if (operation === "restore") {
      const docker = await localDocker();
      ensure(
        isDeepStrictEqual(await dockerPlatform(docker), manifest.platform),
        "Restore daemon platform differs from bundle",
      );
      await docker(["image", "load", "--input", join(directory, "images.tar")]);
      for (const image of manifest.images)
        await inspect(docker, image.id, image.component, manifest.sourceSha, manifest.platform);
    }
    console.log(
      `Bundle ${operation === "restore" ? "images restored" : "integrity verified"}; unqualified, runtime default unchanged.`,
    );
    return;
  }
  ensure(
    operation === "create" && args.length === 6,
    "Use create --profile ID --source-sha SHA --output DIRECTORY",
  );
  const names = { "--profile": "profile", "--source-sha": "sourceSha", "--output": "output" };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      names[args[i]] && args[i + 1] && !Object.hasOwn(options, names[args[i]]),
      "Invalid or duplicate bundle option",
    );
    options[names[args[i]]] = args[i + 1];
  }
  await create(options);
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
