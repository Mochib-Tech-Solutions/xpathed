import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "./useTheme";

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const label = { system: "System", light: "Light", dark: "Dark" }[theme];
  const ThemeIcon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Theme: ${label}`}
          title={`Theme: ${label}`}
        >
          <ThemeIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") setTheme(value);
          }}
          aria-label="Theme"
        >
          <DropdownMenuRadioItem value="system">
            <Monitor className="size-4" aria-hidden="true" />
            System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun className="size-4" aria-hidden="true" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon className="size-4" aria-hidden="true" />
            Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
