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
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<Theme>(readTheme);

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
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
