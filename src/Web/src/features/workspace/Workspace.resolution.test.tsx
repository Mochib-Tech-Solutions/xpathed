import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { target, found, mockApi, openWorkspace, submitInstruction } from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));
describe("Workspace resolution", () => {
  it("explains the single-action limit for unsupported commands", async () => {
    const message = "Use one action per command. You can target several elements on this page.";
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "unsupported",
          action: "unsupported",
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              action: "unsupported",
              outcome: "unsupported",
              code: "unsupported_action",
              message,
              target: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click Pay now and fill the notes field",
    );
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText("Action: unsupported")).not.toBeInTheDocument();
    expect(screen.queryByText("This interaction is not supported yet.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy XPath/ })).not.toBeInTheDocument();
  });

  it.each([
    ["double_click", "double-click"],
    ["type", "type"],
  ])("shows the interpreted %s action", async (action, label) => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          action,
          actions: [{ actionId: "a1", order: 1, action, outcome: "found", target: target }],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByText(`Action: ${label}`)).toBeVisible();
    expect(screen.getByText(target.xpaths[0]!)).toBeVisible();
  });

  it.each([
    ["ready", [], "Verified: enabled, in view, unobstructed at the checked point."],
    ["unknown", [], "Interaction readiness unknown."],
    ["unsupported", ["custom_control_unverified"], "Interaction assessment unsupported."],
  ])(
    "shows %s readiness while retaining target, XPath and diagnostics",
    async (status, reasons, message) => {
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            diagnostics: { ...found.diagnostics, timingsMs: { total: 125 } },
            target: null,
            actions: [
              {
                actionId: "a1",
                order: 1,
                instruction: "Click Pay now",
                action: "click",
                outcome: "found",
                target: {
                  ...target,
                  interactability: {
                    action: "click",
                    status,
                    reasons,
                    checks: {
                      enabled: status === "ready" ? "pass" : "fail",
                      viewport: status === "ready" ? "pass" : "fail",
                      pointerReception: status === "ready" ? "pass" : "unknown",
                      eventOutcome: "unknown",
                    },
                  },
                },
                code: null,
                message: null,
              },
            ],
          }),
        ),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
      expect(screen.getByText("Resolution time: 125 ms")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Copy XPath 1" })).toBeInTheDocument();
      expect(
        screen.queryByText("Event delivery and action success were not tested."),
      ).not.toBeInTheDocument();
    },
  );

  it.each(["partial", "error"])("preserves per-target errors in a %s result", async (outcome) => {
    const message = "The target could not be verified because its frame changed.";
    const failed = {
      actionId: "a2",
      order: outcome === "partial" ? 2 : 1,
      step: 1,
      instruction: "Click Contact",
      outcome: "error",
      action: "click",
      code: "stale_frame",
      message,
      target: null,
    };
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome,
          target: null,
          actions:
            outcome === "partial"
              ? [
                  {
                    actionId: "a1",
                    order: 1,
                    step: 1,
                    instruction: "Click Pay now",
                    outcome: "found",
                    action: "click",
                    code: null,
                    message: null,
                    target: target,
                  },
                  failed,
                ]
              : [failed],
          diagnostics: { code: null, message: null },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "Resolution failed" })).toHaveLength(1);
    if (outcome === "partial") {
      expect(screen.getByRole("heading", { name: "Partial result" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Copy XPath 1" })).toBeVisible();
      expect(screen.getByText("Pay now", { selector: "bdi" })).toBeVisible();
    } else {
      expect(screen.queryByRole("heading", { name: "Partial result" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Copy XPath/ })).not.toBeInTheDocument();
    }
  });

  it("reports provider failures as errors rather than semantic absence", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "error",
          diagnostics: {
            code: "provider_rate_limit",
            message: "The model provider is rate limited.",
          },
          target: null,
          actions: [],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The model provider is rate limited.");
    expect(
      screen.queryByText("I couldn’t find that element in the current view."),
    ).not.toBeInTheDocument();
  });

  it("labels ambiguous targets without guessing", async () => {
    const message = "The instruction does not identify one intended target.";
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "unsupported",
          action: "unsupported",
          target: null,
          actions: [
            {
              actionId: "action-1",
              order: 1,
              step: 1,
              instruction: "Click the button next to Community",
              outcome: "unsupported",
              action: "unsupported",
              code: "ambiguous",
              message,
              target: null,
            },
          ],
          diagnostics: { code: "ambiguous", message },
        }),
      ),
    );
    const user = await openWorkspace();
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click the button next to Community",
    );
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    expect(await screen.findByRole("heading", { name: "Ambiguous target" })).toBeVisible();
    expect(
      screen.getByText(
        "The instruction does not identify a unique target. Specify its exact name, section, or position, such as left or right.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy XPath/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("This interaction is not supported yet.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Departments|Business/)).not.toBeInTheDocument();
  });

  it("distinguishes unsupported instructions from absence", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "unsupported",
          diagnostics: {
            code: "unsupported_action",
            message: "Drag and drop is unsupported.",
          },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "unsupported",
              target: null,
              code: "unsupported_action",
              message: "Drag and drop is unsupported.",
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByRole("heading", { name: "Unsupported interaction" })).toBeVisible();
    expect(screen.getByText("Drag and drop is unsupported.")).toBeVisible();
    expect(
      screen.queryByText("I couldn’t find that element in the current view."),
    ).not.toBeInTheDocument();
  });

  it("reports semantic absence without displaying a target", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "not_found",
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "not_found",
              target: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(
      await screen.findByText("I couldn’t find that element in the current view."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy XPath 1" })).not.toBeInTheDocument();
  });
});
