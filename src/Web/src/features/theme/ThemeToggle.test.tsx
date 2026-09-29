import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "./ThemeProvider";
import ThemeToggle from "./ThemeToggle";

function renderToggle() {
  mockSystemTheme();
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("opens from the keyboard and names all three theme choices", async () => {
    const user = userEvent.setup();
    renderToggle();
    screen.getByRole("button", { name: "Theme: System" }).focus();

    await user.keyboard("{Enter}");

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it.each(["System", "Light", "Dark"])(
    "selects %s and announces the current preference",
    async (label) => {
      const user = userEvent.setup();
      localStorage.setItem("xpathed.theme", label === "Dark" ? "light" : "dark");
      renderToggle();

      await user.click(screen.getByRole("button", { name: /^Theme:/ }));
      await user.click(screen.getByRole("menuitemradio", { name: label }));

      expect(screen.getByRole("button", { name: `Theme: ${label}` })).toBeInTheDocument();
      expect(localStorage.getItem("xpathed.theme")).toBe(label.toLowerCase());
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    },
  );
});
