import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { ThemeContext } from "./theme-context";
import type { Theme } from "./theme-context";

const storageKey = "xpathed.theme";

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<Theme>(readTheme);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    }
    applyTheme();
    if (theme === "system") {
      media.addEventListener("change", applyTheme);
      return () => media.removeEventListener("change", applyTheme);
    }
  }, [theme]);

  function setTheme(next: Theme) {
    setPreference(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // A blocked preference store must not prevent the current choice.
    }
  }

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}
