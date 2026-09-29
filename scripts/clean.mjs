import { realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const root = await realpath(new URL("..", import.meta.url));
const projects = ["src/Browser", "src/ClientApi", "src/Contracts", "src/Resolver"];
const outputs = [
  ...projects.flatMap((project) => [`${project}/bin`, `${project}/obj`]),
  "src/Web/dist",
];

for (const output of outputs) {
  const path = join(root, output);
  try {
    const parent = await realpath(dirname(path));
    if (!parent.startsWith(`${root}${sep}`))
      throw new Error(`Refusing to clean outside the repository: ${output}`);
    await rm(path, { recursive: true, force: true });
    console.log(`Cleaned ${output}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
