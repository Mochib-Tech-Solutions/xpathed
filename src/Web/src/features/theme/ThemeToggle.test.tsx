import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "./ThemeProvider";
import ThemeToggle from "./ThemeToggle";

describe("ThemeToggle", () => {
  it("switches directly between light and dark by keyboard and remembers the choice", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole("button", { name: "Switch to light theme" });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("xpathed.theme")).toBe("light");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toHaveFocus();
    await user.keyboard(" ");
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("xpathed.theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toHaveFocus();
  });
});
