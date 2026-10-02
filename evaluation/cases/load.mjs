import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadCases(path = new URL("./index.json", import.meta.url)) {
  path = path instanceof URL ? fileURLToPath(path) : resolve(path);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.groups) {
    const cases = manifest.groups.flatMap((group) => {
      if (!/^[a-z-]+\.json$/.test(group)) throw new Error("Invalid case group");
      return JSON.parse(readFileSync(resolve(dirname(path), group), "utf8"));
    });
    if (new Set(cases.map((item) => item.id)).size !== cases.length)
      throw new Error("Duplicate case identity");
    return { ...manifest, cases };
  }
  if (manifest.catalog) {
    const catalog = loadCases(resolve(dirname(path), manifest.catalog));
    return {
      ...manifest,
      cases: manifest.caseIds.map((id) => {
        const entry = catalog.cases.find((item) => item.id === id);
        if (!entry) throw new Error(`Unknown case: ${id}`);
        return { ...entry, ...manifest.overrides?.[id] };
      }),
    };
  }
  return manifest;
}
