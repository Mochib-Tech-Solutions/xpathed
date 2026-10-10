import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import type { ImageMode } from "./api";
import WorkspaceSettings from "./WorkspaceSettings";

function SettingsHarness({ disabled = false }: { disabled?: boolean }) {
  const [imageMode, setImageMode] = useState<ImageMode>("auto");
  const [autoExecute, setAutoExecute] = useState(false);
  return (
    <WorkspaceSettings
      imageMode={imageMode}
      onImageModeChange={setImageMode}
      autoExecute={autoExecute}
      onAutoExecuteChange={setAutoExecute}
      disabled={disabled}
    />
  );
}

it("traps focus, applies changes immediately, and restores focus on Escape", async () => {
  const user = userEvent.setup();
  render(<SettingsHarness />);
  const trigger = screen.getByRole("button", { name: "Settings" });
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAccessibleDescription(
    "Each tab keeps its own settings.",
  );
  const mode = screen.getByRole("combobox", { name: "Screenshots" });
  const automatic = screen.getByRole("checkbox", { name: "Execute automatically" });
  expect(mode).toHaveFocus();
  expect(automatic).not.toBeChecked();
  await user.tab();
  expect(automatic).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
  await user.tab();
  expect(mode).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Done" })).toHaveFocus();
  await user.selectOptions(mode, "text_only");
  await user.click(automatic);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  expect(screen.getByRole("combobox", { name: "Screenshots" })).toHaveValue("text_only");
  expect(screen.getByRole("checkbox", { name: "Execute automatically" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("keeps settings readable while work is pending but disables both controls", async () => {
  const user = userEvent.setup();
  render(<SettingsHarness disabled />);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("combobox", { name: "Screenshots" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "Execute automatically" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
