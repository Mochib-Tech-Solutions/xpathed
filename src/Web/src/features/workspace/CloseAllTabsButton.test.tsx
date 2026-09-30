import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CloseAllTabsButton from "./CloseAllTabsButton";

describe("CloseAllTabsButton", () => {
  it("focuses Cancel and preserves the session when cancelled", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CloseAllTabsButton disabled={false} onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Close all tabs" });

    await user.click(trigger);
    const dialog = screen.getByRole("alertdialog", { name: "Close all tabs?" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(cancel);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("dismisses with Escape and restores keyboard focus", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CloseAllTabsButton disabled={false} onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Close all tabs" });
    trigger.focus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes all tabs exactly once after explicit confirmation", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CloseAllTabsButton disabled={false} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Close all tabs" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("cannot open while closing is disabled", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<CloseAllTabsButton disabled onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Close all tabs" });

    expect(trigger).toBeDisabled();
    await user.click(trigger);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
