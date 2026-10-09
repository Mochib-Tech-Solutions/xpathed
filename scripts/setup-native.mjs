import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { browserExecutable, loadEnvironment } from "./native.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  const env = await loadEnvironment(root);
  await browserExecutable(env);
  // global.json selects the supported SDK; restore also verifies its availability.
  execFileSync("dotnet", ["tool", "restore"], { cwd: root, stdio: "inherit" });
  execFileSync("dotnet", ["restore", "Xpathed.slnx", "--locked-mode"], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("Native development is ready. Run pnpm dev.");
} catch (error) {
  console.error(
    error.code === "ENOENT" ? "Install the .NET SDK selected by global.json." : error.message,
  );
  process.exitCode = 1;
}
