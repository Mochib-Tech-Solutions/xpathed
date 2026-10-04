import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const version = "8.30.1";
const packages = {
  "linux-x64": ["linux_x64", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"],
  "darwin-arm64": [
    "darwin_arm64",
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  ],
};
const directory = mkdtempSync(join(tmpdir(), "xpathed-security-"));
try {
  let binary = process.env.GITLEAKS_BINARY;
  if (!binary) {
    const [platform, digest] = packages[`${process.platform}-${process.arch}`] ?? [];
    if (!platform) throw new Error("Set GITLEAKS_BINARY to the pinned scanner on this platform");
    const response = await fetch(
      `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`,
      { signal: AbortSignal.timeout(60000) },
    );
    if (!response.ok) throw new Error("Cannot download the pinned secret scanner");
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== digest)
      throw new Error("Scanner checksum mismatch");
    const archive = join(directory, "scanner.tar.gz");
    writeFileSync(archive, data);
    execFileSync("tar", ["-xzf", archive, "-C", directory, "gitleaks"]);
    binary = join(directory, "gitleaks");
  }
  if (execFileSync(binary, ["version"], { encoding: "utf8" }).trim() !== version)
    throw new Error("Unexpected scanner version");
  // Prove the checked-in allowlists do not suppress a credential-shaped value.
  const probe = join(directory, "probe");
  const synthetic = `OPENROUTER_API_KEY=sk-or-v1-${createHash("sha256").update(directory).digest("hex")}`;
  const fixtures = {
    "docs/assets/evaluation/probe.json": `ApiError.cs": "${"a".repeat(64)}"`,
    "docs/evaluation.md": "API contracts, missing/duplicate ",
    "tests/Resolver.Tests/ResolutionContractTests.cs": 'API_KEY=violet-cactus-782"',
  };
  for (const [name, safe] of Object.entries(fixtures)) {
    const file = join(probe, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${safe}\n${synthetic}\n`);
  }
  const report = join(directory, "probe.json");
  let detected = false;
  try {
    execFileSync(
      binary,
      [
        "dir",
        "--config",
        ".gitleaks.toml",
        "--redact=100",
        "--no-banner",
        "--report-path",
        report,
        "--report-format",
        "json",
        probe,
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    detected = true;
  }
  if (!detected) throw new Error("Secret scanner negative control did not fail");
  const findings = JSON.parse(readFileSync(report, "utf8"));
  if (
    !Object.keys(fixtures).every((name) =>
      findings.some(
        (item) => item.File.endsWith(name) && item.StartLine === 2 && item.Secret === "REDACTED",
      ),
    )
  )
    throw new Error("An allowlist suppressed a credential-shaped negative control");
  execFileSync(
    binary,
    [
      "git",
      "--config",
      ".gitleaks.toml",
      "--redact=100",
      "--no-banner",
      "--ignore-gitleaks-allow",
      "--gitleaks-ignore-path",
      directory,
      "--log-opts=--all",
      ".",
    ],
    { stdio: "inherit" },
  );
  console.log("Credential scan and negative control passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
