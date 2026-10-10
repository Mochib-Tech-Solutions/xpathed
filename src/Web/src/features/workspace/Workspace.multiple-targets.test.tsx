import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { target, found, mockApi, openWorkspace, submitInstruction } from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));
describe("Workspace multiple-targets", () => {
  it("keeps a covered target in its numbered card beside the ready target", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          actions: [
            {
              ...found.actions[0],
              target: {
                ...target,
                label: "Log in",
                interactability: {
                  action: "click",
                  status: "blocked",
                  reasons: ["obstructed_at_hit_point"],
                  checks: {},
                },
              },
            },
            {
              ...found.actions[0],
              actionId: "a2",
              order: 2,
              target: { ...target, label: "Log in" },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const blocked = await screen.findByRole("region", { name: "Target 1" });
    expect(within(blocked).getByText("Target 1")).toBeVisible();
    expect(blocked).toHaveClass("rounded-xl", "border");
    expect(blocked).toHaveTextContent(
      "Cannot click “Log in”. Another element or clipping blocks the inspected pointer point.",
    );
    expect(within(blocked).getByText(target.xpaths[0]!)).toBeVisible();
    expect(within(blocked).getByRole("button", { name: "Copy XPath 1" })).toBeEnabled();
    expect(within(blocked).queryByRole("button", { name: /Execute/ })).not.toBeInTheDocument();
    expect(blocked).not.toHaveTextContent(/Verification|Requested:/);
    expect(
      within(screen.getByRole("region", { name: "Target 2" })).getByText("XPath"),
    ).toBeVisible();
  });

  it("renders independent action results with one request cost and no inspection control", async () => {
    const batch = {
      ...found,
      outcome: "partial",
      action: "click",
      target: null,
      inspectedActionId: "a1",
      summary: {
        processingComplete: true,
        semanticCompleteness: "unverified",
        total: 2,
        found: 1,
        notFound: 1,
        unsupported: 0,
        errors: 0,
        blocked: 1,
        readinessUnknown: 0,
        assessmentUnsupported: 0,
      },
      actions: [
        {
          actionId: "a1",
          order: 1,
          step: 1,
          instruction: "Click Pay now",
          action: "click",
          outcome: "found",
          target: target,
          frameId: "main",
          diagnosticsReference: "attempt-1",
          code: null,
          message: null,
        },
        {
          actionId: "a2",
          order: 2,
          step: 2,
          instruction: "Click Contact",
          action: "click",
          outcome: "not_found",
          target: null,
          frameId: "main",
          diagnosticsReference: "attempt-1",
          code: null,
          message: "I couldn’t find that element in the current view.",
        },
      ],
    };
    mockApi(() => Promise.resolve(Response.json(batch)));
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(
      await screen.findByText("1 target found · 1 missing · 1 blocked · current view"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Partial result" })).toBeVisible();
    expect(screen.getByText(/Click Contact/)).toBeInTheDocument();
    expect(
      screen.getByText("I couldn’t find that element in the current view."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Cost unavailable")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Inspect action/ })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/api/pages/page-1/resolve",
      expect.objectContaining({
        body: JSON.stringify({
          instruction: "Click Pay now",
          documentId: "document-1",
          imageMode: "auto",
        }),
      }),
    );
  });
});
