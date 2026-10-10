import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

for (const directory of ["scripts", "tests/resolution", "src/Browser/Scripts"])
  for (const path of readdirSync(directory, { recursive: true }))
    if (/\.(mjs|js)$/.test(path) && !path.split("/").includes("node_modules"))
      execFileSync(process.execPath, ["--check", join(directory, path)], { stdio: "inherit" });

for (const path of readdirSync("scripts").filter((path) => path.endsWith(".py")))
  execFileSync(
    "python3",
    [
      "-c",
      "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())",
      join("scripts", path),
    ],
    { stdio: "inherit" },
  );
