import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "./ThemeProvider";
import { useTheme } from "./useTheme";

function ThemeControls() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <output aria-label="Selected theme">{theme}</output>
      <button type="button" onClick={() => setTheme("light")}>
        Light
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        Dark
      </button>
    </>
  );
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeControls />
    </ThemeProvider>,
  );
}

describe("ThemeProvider", () => {
  it.each([false, true])("defaults to dark when the system dark preference is %s", (dark) => {
    mockSystemTheme(dark);
    renderTheme();

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("keeps the dark default when the system changes", () => {
    const setSystemDark = mockSystemTheme();
    renderTheme();

    act(() => setSystemDark(true));
    expect(document.documentElement.style.colorScheme).toBe("dark");
    act(() => setSystemDark(false));
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(screen.getByLabelText("Selected theme")).toHaveTextContent("dark");
  });

  it("keeps dark after unmount and system changes", () => {
    const setSystemDark = mockSystemTheme();
    const view = renderTheme();
    view.unmount();

    act(() => setSystemDark(true));

    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it.each(["light", "dark"] as const)("persists %s and restores it on remount", async (theme) => {
    mockSystemTheme(theme === "light");
    localStorage.setItem("xpathed.theme", theme === "dark" ? "light" : "dark");
    const user = userEvent.setup();
    const view = renderTheme();

    await user.click(screen.getByRole("button", { name: new RegExp(`^${theme}$`, "i") }));
    expect(localStorage.getItem("xpathed.theme")).toBe(theme);
    view.unmount();
    renderTheme();

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent(theme);
    expect(document.documentElement.style.colorScheme).toBe(theme);
  });

  it.each(["light", "dark"] as const)("keeps explicit %s mode when the system changes", (theme) => {
    const setSystemDark = mockSystemTheme(theme !== "dark");
    localStorage.setItem("xpathed.theme", theme);
    renderTheme();

    expect(document.documentElement.style.colorScheme).toBe(theme);
    act(() => setSystemDark(true));
    expect(document.documentElement.style.colorScheme).toBe(theme);
    act(() => setSystemDark(false));

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent(theme);
    expect(document.documentElement.style.colorScheme).toBe(theme);
  });

  it.each(["system", "sepia"])("uses dark for stored preference %s", (saved) => {
    mockSystemTheme(true);
    localStorage.setItem("xpathed.theme", saved);
    renderTheme();

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("starts safely when storage cannot be read", () => {
    mockSystemTheme(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    renderTheme();

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("still applies a preference when storage cannot be written", async () => {
    mockSystemTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is blocked", "SecurityError");
    });
    const user = userEvent.setup();
    renderTheme();

    await user.click(screen.getByRole("button", { name: "Light" }));

    expect(screen.getByLabelText("Selected theme")).toHaveTextContent("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});
