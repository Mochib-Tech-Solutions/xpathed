import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";

const bootstrap = readFileSync("public/theme-init.js", "utf8");

describe("prepaint theme bootstrap", () => {
  it.each([
    { saved: null, systemDark: false, expected: "dark" },
    { saved: null, systemDark: true, expected: "dark" },
    { saved: "light", systemDark: true, expected: "light" },
    { saved: "dark", systemDark: false, expected: "dark" },
    { saved: "system", systemDark: false, expected: "dark" },
    { saved: "sepia", systemDark: false, expected: "dark" },
  ])(
    "applies $expected before React for preference=$saved and systemDark=$systemDark",
    ({ saved, systemDark, expected }) => {
      mockSystemTheme(systemDark);
      if (saved !== null) localStorage.setItem("xpathed.theme", saved);

      window.eval(bootstrap);

      expect(document.documentElement.style.colorScheme).toBe(expected);
    },
  );

  it("uses dark when storage is blocked", () => {
    mockSystemTheme(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });

    window.eval(bootstrap);

    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
