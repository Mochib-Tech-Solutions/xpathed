import { readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const root = await realpath(new URL("..", import.meta.url));
if (process.argv.slice(2).some((argument) => argument !== "--cache"))
  throw new Error("Use pnpm clean [--cache].");
const cache = process.argv.includes("--cache");
const tests = await readdir(join(root, "tests"), { withFileTypes: true }).catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const projects = [
  "src/Browser",
  "src/ClientApi",
  "src/Common",
  "src/Resolver",
  ...tests
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".Tests"))
    .map((entry) => `tests/${entry.name}`),
];
const outputs = [
  ...projects.flatMap((project) => [`${project}/bin`, `${project}/obj`]),
  "src/Web/dist",
  ...(cache
    ? [
        "node_modules",
        "src/Web/node_modules",
        "src/Web/.vitest",
        ".pnpm-store",
        ".artifacts/python-tools",
        "scripts/__pycache__",
      ]
    : []),
];

for (const output of outputs) {
  const path = join(root, output);
  try {
    const parent = await realpath(dirname(path));
    if (parent !== root && !parent.startsWith(`${root}${sep}`))
      throw new Error(`Refusing to clean outside the repository: ${output}`);
    await rm(path, { recursive: true, force: true });
    console.log(`Cleaned ${output}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
