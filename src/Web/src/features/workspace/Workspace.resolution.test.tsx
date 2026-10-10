import { screen, within } from "@testing-library/react";
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

  it.each([
    ["click", ["disabled", "pointer_events_none", "disabled"], "This element is disabled."],
    ["fill", ["readonly"], "This field is read-only."],
    ["select", ["incompatible_control"], "This control does not support the requested action."],
    [
      "click",
      ["obstructed_at_hit_point"],
      "Another element or clipping blocks the inspected pointer point.",
    ],
  ])("shows one red explanation for blocked %s (%s)", async (action, reasons, explanation) => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          action,
          actions: [
            {
              ...found.actions[0],
              action,
              target: {
                ...target,
                interactability: {
                  action,
                  status: "blocked",
                  reasons,
                  checks: { enabled: "fail", viewport: "pass", pointerReception: "fail" },
                },
              },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const response = await screen.findByRole("region", { name: "Target 1" });
    expect(response).toHaveTextContent(`Cannot ${action} “Pay now”. ${explanation}`);
    expect(response.querySelectorAll("p.text-destructive")).toHaveLength(1);
    expect(response.querySelector("p.text-destructive")).toHaveTextContent(explanation);
    expect(within(response).getByRole("heading", { name: "Button" })).toBeVisible();
    expect(within(response).getByText(`Action: ${action}`)).toBeVisible();
    expect(within(response).getByText(target.xpaths[0]!)).toBeVisible();
    expect(within(response).getByRole("button", { name: "Copy XPath 1" })).toBeEnabled();
    expect(within(response).queryByRole("button", { name: /Execute/ })).not.toBeInTheDocument();
    expect(response).not.toHaveTextContent(/Verification|Verified:|Interaction blocked|Disabled/);
  });

  it.each([
    {
      action: "click",
      status: "ready",
      checks: { enabled: "not_applicable", viewport: "pass", pointerReception: "pass" },
      message: "Verified: in view, unobstructed at the checked point.",
      limit: null,
      staticText: true,
    },
    {
      action: "hover",
      status: "ready",
      checks: { enabled: "not_applicable", viewport: "pass", pointerReception: "pass" },
      message: "Verified: in view, unobstructed at the checked point.",
      limit: null,
    },
    {
      action: "type",
      status: "ready",
      checks: { compatibleControl: "pass", enabled: "pass", writable: "pass", keyboard: "pass" },
      message: "Verified: compatible control type, enabled, not read-only.",
      limit: null,
    },
    {
      action: "fill",
      status: "unknown",
      checks: { compatibleControl: "pass", enabled: "pass", writable: "pass", keyboard: "unknown" },
      message: "Verified: compatible control type, enabled, not read-only.",
      limit: "Keyboard readiness unknown.",
    },
    {
      action: "click",
      status: "blocked",
      checks: { enabled: "fail", viewport: "pass", pointerReception: "pass" },
      message: "Cannot click “Pay now”. The requested action is blocked.",
      limit: null,
    },
    {
      action: "select",
      status: "unsupported",
      checks: { compatibleControl: "unknown", enabled: "pass", keyboard: "unknown" },
      message: "Verified: enabled.",
      limit: "Interaction assessment unsupported.",
    },
    {
      action: "inspect",
      status: "ready",
      checks: { compatibleControl: "pass", enabled: "not_applicable", viewport: "not_applicable" },
      message: "Off-screen",
      limit: null,
    },
    {
      action: "click",
      status: "ready",
      checks: {},
      message: "Detailed interaction checks are unavailable.",
      limit: "Detailed interaction checks are unavailable.",
    },
  ])(
    "explains $action/$status from the actual checks",
    async ({ action, status, checks, message, limit, staticText }) => {
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            action,
            target: null,
            actions: [
              {
                actionId: "a1",
                order: 1,
                instruction: "Click Pay now",
                action,
                outcome: "found",
                target: {
                  ...target,
                  ...(staticText && {
                    tag: "span",
                    label: "",
                    state: { ...target.state, enabled: true, inViewport: true },
                  }),
                  interactability: { action, status, reasons: [], checks },
                },
              },
            ],
          }),
        ),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      if (status === "blocked") {
        expect(await screen.findByRole("region", { name: "Target 1" })).toHaveTextContent(message);
      } else {
        expect(await screen.findByText(message)).toBeVisible();
      }
      if (limit) expect(screen.getByText(limit)).toBeVisible();
      if (staticText) {
        expect(screen.getByRole("heading", { name: "Element <span>" })).toBeVisible();
        expect(screen.queryByText(/enabled|active|interactive/i)).not.toBeInTheDocument();
      }
      if (checks.keyboard === "pass")
        expect(screen.queryByText("Keyboard readiness unknown.")).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          /No action was performed|no interaction requested|movement and page response/i,
        ),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Interaction checks passed.")).not.toBeInTheDocument();
      expect(screen.queryByText(/clickable|successfully clicked/i)).not.toBeInTheDocument();
    },
  );

  it.each([
    ["not_found", null, "Target not found", "I couldn’t find that element in the current view."],
    [
      "unsupported",
      "unsupported_action",
      "Unsupported interaction",
      "This requested interaction is outside the supported actions.",
    ],
    [
      "unsupported",
      "current_state_dependency",
      "Separate steps required",
      "This command needs separate steps. Resolve one interaction in the current view, then request the next step after any required page change. No action was executed.",
    ],
    [
      "unsupported",
      "appearance_unavailable",
      "Appearance unavailable",
      "That visual detail could not be established from the current view. Specify a label, section, or position.",
    ],
    [
      "unsupported",
      "state_unavailable",
      "State unavailable",
      "That form state is withheld from target selection. Identify the element by its label or position instead.",
    ],
    [
      "unsupported",
      "target_not_addressable",
      "Graphic detail unavailable",
      "That part of the graphic is not a separate page element. Request the whole graphic or a separately exposed element.",
    ],
    [
      "unsupported",
      "unsupported_scope",
      "Unsupported page content",
      "Frame or shadow content is outside this capture's supported scope.",
    ],
    [
      "unsupported",
      "future_reason",
      "Unsupported instruction",
      "The resolver supplied a specific limitation.",
    ],
    ["error", "provider_rate_limited", "Resolution failed", "The model provider is rate limited."],
    [
      "error",
      "stale_capture",
      "Resolution failed",
      "The page or current view changed. Resolve the instruction again.",
    ],
    [
      "error",
      "decomposition_incomplete",
      "Incomplete response",
      "The model returned an incomplete response for this instruction.",
    ],
  ])("presents %s / %s with its own response", async (outcome, code, title, message) => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome,
          target: null,
          action: outcome === "unsupported" ? "unsupported" : "click",
          actions:
            outcome === "error"
              ? []
              : [
                  {
                    actionId: "action-1",
                    order: 1,
                    step: 1,
                    instruction: "Click Pay now",
                    outcome,
                    action: outcome === "unsupported" ? "unsupported" : "click",
                    code,
                    message,
                    target: null,
                  },
                ],
          diagnostics: {
            code: outcome === "error" ? code : null,
            message: outcome === "error" ? message : null,
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByRole("heading", { name: title })).toBeVisible();
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Copy XPath/ })).not.toBeInTheDocument();
    if (outcome !== "not_found")
      expect(
        screen.queryByText("I couldn’t find that element in the current view."),
      ).not.toBeInTheDocument();
    if (outcome !== "not_found")
      expect(screen.queryByRole("heading", { name: "Target not found" })).not.toBeInTheDocument();
    if (outcome === "error") expect(screen.getByRole("alert")).toHaveTextContent(message);
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

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
