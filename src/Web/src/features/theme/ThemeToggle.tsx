import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "./useTheme";

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const ThemeIcon = next === "light" ? Sun : Moon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
    >
      <ThemeIcon aria-hidden="true" />
    </Button>
  );
}
