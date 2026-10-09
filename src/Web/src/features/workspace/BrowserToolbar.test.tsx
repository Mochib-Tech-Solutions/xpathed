import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BrowserToolbar from "./BrowserToolbar";

const defaults = {
  browserType: "chromium" as const,
  browserTypes: ["chromium" as const, "firefox" as const],
  canStart: true,
  onBrowserTypeChange: () => undefined,
  resolution: "1280x800",
  resolutions: [{ id: "1280x800", width: 1280, height: 800 }],
  onResolutionChange: () => undefined,
  sessionId: "session",
  pageUrl: "https://current.example/page",
  address: "https://draft.example",
  busy: false,
  onAddressChange: () => undefined,
  onNavigate: () => undefined,
};

describe("BrowserToolbar", () => {
  it.each([
    ["example.com/path", "https://example.com/path"],
    ["  https://example.com/path  ", "https://example.com/path"],
    ["http://localhost:8081", "http://localhost:8081"],
  ])("submits %s as %s", async (address, expected) => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<BrowserToolbar {...defaults} address={address} onNavigate={onNavigate} />);

    await user.click(screen.getByRole("button", { name: "Go to address" }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("ignores a blank address submitted with Enter", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<BrowserToolbar {...defaults} address="   " onNavigate={onNavigate} />);

    expect(screen.getByRole("button", { name: "Go to address" })).toBeDisabled();
    await user.keyboard("{Enter}");

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("reloads the current page instead of the edited address", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<BrowserToolbar {...defaults} onNavigate={onNavigate} />);

    await user.click(screen.getByRole("button", { name: "Reload page" }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(defaults.pageUrl);
  });

  it("disables navigation while a request is pending", () => {
    render(<BrowserToolbar {...defaults} busy />);

    expect(screen.getByRole("textbox", { name: "Page address" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go to address" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeDisabled();
  });

  it("does not reload a blank managed page", () => {
    render(<BrowserToolbar {...defaults} pageUrl="about:blank" />);

    expect(screen.getByRole("button", { name: "Reload page" })).toBeDisabled();
  });

  it("focuses the address when a new session becomes available", () => {
    const view = render(<BrowserToolbar {...defaults} sessionId={undefined} />);

    view.rerender(<BrowserToolbar {...defaults} sessionId="new-session" />);

    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveFocus();
  });

  it("reports address edits to the workspace", async () => {
    const user = userEvent.setup();
    const onAddressChange = vi.fn();
    render(<BrowserToolbar {...defaults} address="" onAddressChange={onAddressChange} />);

    await user.type(screen.getByRole("textbox", { name: "Page address" }), "x");

    expect(onAddressChange).toHaveBeenCalledExactlyOnceWith("x");
  });
});
