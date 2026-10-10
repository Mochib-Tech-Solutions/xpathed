import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { target, found, mockApi, openWorkspace, submitInstruction } from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));
describe("Workspace spotlight", () => {
  it("spotlights each target's own XPath on hover and focus in a plural result", async () => {
    const secondTarget = {
      ...target,
      candidateId: "candidate-2",
      label: "Cancel",
      xpaths: ["//*[@data-testid='cancel']"],
    };
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          actions: [
            found.actions[0],
            { ...found.actions[0], actionId: "a2", order: 2, target: secondTarget },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const firstXpath = await screen.findByText(target.xpaths[0]!);
    const secondXpath = screen.getByText(secondTarget.xpaths[0]!);
    for (const [xpath, actionId] of [
      [firstXpath, "a1"],
      [secondXpath, "a2"],
      [firstXpath, "a1"],
    ] as const) {
      await user.hover(xpath);
      await waitFor(() =>
        expect(fetch).toHaveBeenLastCalledWith(
          "/api/pages/page-1/spotlight",
          expect.objectContaining({
            body: JSON.stringify({ documentId: "document-1", captureId: "capture-1", actionId }),
          }),
        ),
      );
      await user.unhover(xpath);
      fireEvent.focus(xpath);
      await waitFor(() =>
        expect(fetch).toHaveBeenLastCalledWith(
          "/api/pages/page-1/spotlight",
          expect.objectContaining({
            body: JSON.stringify({ documentId: "document-1", captureId: "capture-1", actionId }),
          }),
        ),
      );
      fireEvent.blur(xpath);
      await waitFor(() =>
        expect(fetch).toHaveBeenLastCalledWith(
          "/api/pages/page-1/spotlight",
          expect.objectContaining({
            body: JSON.stringify({
              documentId: "document-1",
              captureId: "capture-1",
              actionId: null,
            }),
          }),
        ),
      );
    }
  });

  it("spotlights the current XPath on hover and focus, and clears it on exit", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    const xpath = await screen.findByText(target.xpaths[0]!);
    let finishHover!: (response: Response) => void;
    const hoverResponse = new Promise<Response>((resolve) => {
      finishHover = resolve;
    });
    const upstream = vi.mocked(fetch).getMockImplementation()!;
    let delayHover = true;
    vi.mocked(fetch).mockImplementation((input, options) => {
      if (input === "/api/pages/page-1/spotlight" && delayHover) {
        delayHover = false;
        return hoverResponse;
      }
      return upstream(input, options);
    });
    await user.hover(xpath);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/pages/page-1/spotlight",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            documentId: "document-1",
            captureId: "capture-1",
            actionId: "a1",
          }),
        }),
      ),
    );
    await user.unhover(xpath);
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/pages/page-1/spotlight",
      expect.objectContaining({
        body: JSON.stringify({ documentId: "document-1", captureId: "capture-1", actionId: null }),
      }),
    );
    finishHover(new Response(null, { status: 204 }));
    await waitFor(() =>
      expect(fetch).toHaveBeenLastCalledWith(
        "/api/pages/page-1/spotlight",
        expect.objectContaining({
          body: JSON.stringify({
            documentId: "document-1",
            captureId: "capture-1",
            actionId: null,
          }),
        }),
      ),
    );
    fireEvent.focus(xpath);
    await waitFor(() =>
      expect(fetch).toHaveBeenLastCalledWith(
        "/api/pages/page-1/spotlight",
        expect.objectContaining({
          body: JSON.stringify({
            documentId: "document-1",
            captureId: "capture-1",
            actionId: "a1",
          }),
        }),
      ),
    );
    fireEvent.blur(xpath);
    await waitFor(() =>
      expect(fetch).toHaveBeenLastCalledWith(
        "/api/pages/page-1/spotlight",
        expect.objectContaining({
          body: JSON.stringify({
            documentId: "document-1",
            captureId: "capture-1",
            actionId: null,
          }),
        }),
      ),
    );
    await submitInstruction(user);
    const calls = vi.mocked(fetch).mock.calls.length;
    await user.hover(xpath);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  });

  it.each([
    ["input", "button", "Search", "Button"],
    ["img", "img", "Product photo", "Image"],
    ["img", "img", "", "Image"],
    ["div", "button", "Close", "Button"],
    ["div", "group", "", "Group"],
  ])("describes %s role=%s with accessible name '%s'", async (tag, role, accessibleName, type) => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
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
                tag,
                role,
                accessibleName,
                label: "Unrelated descendant content",
              },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByRole("heading", { name: type })).toBeVisible();
    expect(screen.getByText(accessibleName || "No accessible name")).toBeVisible();
    expect(screen.queryByText("Unrelated descendant content")).not.toBeInTheDocument();
    expect(screen.getByText(target.xpaths[0]!)).toBeVisible();
  });

  it.each([1, 2])(
    "preserves %i ready targets beside a missing target in a partial result",
    async (foundCount) => {
      const xpath = "//article[h3/a[@title='A Light in the Attic']]//button";
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            outcome: "partial",
            summary: {
              total: foundCount + 1,
              found: foundCount,
              notFound: 1,
              unsupported: 0,
              errors: 0,
              blocked: 0,
            },
            actions: [
              {
                ...found.actions[0],
                instruction: "Add to basket for A Light in the Attic",
                target: {
                  ...target,
                  label: "Add to basket",
                  xpaths: [xpath],
                  state: { ...target.state, enabled: true, inViewport: true },
                  interactability: { action: "click", status: "ready", reasons: [], checks: {} },
                },
              },
              ...(foundCount === 2
                ? [
                    {
                      ...found.actions[0],
                      actionId: "a2",
                      order: 2,
                      instruction: "Click the second button",
                      target: {
                        ...target,
                        candidateId: "candidate-2",
                        label: "Second button",
                        xpaths: ["//button[@id='second']"],
                        state: { ...target.state, enabled: true, inViewport: true },
                        interactability: {
                          action: "click",
                          status: "ready",
                          reasons: [],
                          checks: {},
                        },
                      },
                    },
                  ]
                : []),
              {
                actionId: `a${foundCount + 1}`,
                order: foundCount + 1,
                instruction:
                  foundCount === 2
                    ? "Click the third requested button"
                    : "Add to basket for The Missing Book",
                action: "click",
                outcome: "not_found",
                target: null,
                message: "No matching element found in the current view.",
              },
            ],
          }),
        ),
      );
      const user = await openWorkspace();
      await user.type(
        screen.getByRole("textbox", { name: "Describe an element" }),
        foundCount === 2
          ? "cilck on the 3 buttons"
          : "Add to basket for A Light in the Attic and The Missing Book",
      );
      await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
      expect(await screen.findByRole("heading", { name: "Partial result" })).toBeVisible();
      expect(
        screen.getByText(
          `${foundCount} target${foundCount === 1 ? "" : "s"} found · 1 missing · current view`,
        ),
      ).toBeVisible();
      expect(screen.getAllByText("Action: click")).toHaveLength(1);
      const cards = screen.getAllByRole("region", { name: /Target [123]/ });
      expect(cards).toHaveLength(foundCount + 1);
      expect(within(cards[0]!).getByText(xpath)).toBeVisible();
      expect(within(cards[0]!).getByRole("button", { name: "Copy XPath 1" })).toBeVisible();
      if (foundCount === 2) {
        expect(within(cards[1]!).getByText("//button[@id='second']")).toBeVisible();
        expect(within(cards[1]!).getByRole("button", { name: "Copy XPath 2" })).toBeVisible();
      }
      expect(
        within(cards[foundCount]!).getByText(
          foundCount === 2 ? /third requested button/ : /The Missing Book/,
        ),
      ).toBeVisible();
      expect(
        within(cards[foundCount]!).getByText("I couldn’t find that element in the current view."),
      ).toBeVisible();
      expect(
        within(cards[foundCount]!).queryByRole("button", { name: /Copy XPath/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Resolution failed")).not.toBeInTheDocument();
      expect(screen.getAllByText("Cost unavailable")).toHaveLength(1);
    },
  );

  it.each(["found", "not_found"])(
    "shows one shared action with a %s second result",
    async (secondOutcome) => {
      const missing = secondOutcome === "not_found";
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            outcome: missing ? "partial" : "found",
            target: null,
            summary: {
              total: 2,
              found: missing ? 1 : 2,
              notFound: missing ? 1 : 0,
              unsupported: 0,
              errors: 0,
              blocked: 0,
            },
            actions: [
              {
                actionId: "a1",
                order: 1,
                instruction: "Click the first confirmation button",
                action: "click",
                outcome: "found",
                target: target,
              },
              {
                actionId: "a2",
                order: 2,
                instruction: "Click the second confirmation button",
                action: "click",
                outcome: secondOutcome,
                target: missing
                  ? null
                  : {
                      ...target,
                      label: "Confirm booking",
                      xpaths: ["//button[@id='confirm-booking']"],
                    },
              },
            ],
          }),
        ),
      );
      const user = await openWorkspace();
      await user.type(
        screen.getByRole("textbox", { name: "Describe an element" }),
        "Click all confirmation buttons in the list",
      );
      await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
      expect(
        await screen.findByText(
          (missing ? "1 target found · 1 missing" : "2 targets found") + " · current view",
        ),
      ).toBeVisible();
      expect(screen.getAllByText("Action: click")).toHaveLength(1);
      expect(screen.getByText("Current view only")).toBeVisible();
      expect(screen.queryByText(/all targets/i)).not.toBeInTheDocument();
      const targets = screen.getAllByRole("region", { name: /Target [12]/ });
      expect(targets).toHaveLength(2);
      expect(within(targets[0]!).getByText("Target 1")).toBeVisible();
      expect(within(targets[1]!).getByText("Target 2")).toBeVisible();
      expect(within(targets[0]!).getByRole("button", { name: "Copy XPath 1" })).toBeVisible();
      if (!missing)
        expect(within(targets[1]!).getByRole("button", { name: "Copy XPath 2" })).toBeVisible();
      for (const target of targets) {
        expect(within(target).queryByText(/Action:/)).not.toBeInTheDocument();
        if (missing && target === targets[1])
          expect(within(target).getByText(/Click the second confirmation button/)).toBeVisible();
        else
          expect(target).toHaveTextContent(
            /Requested: Click the (first|second) confirmation button/,
          );
      }
      expect(within(targets[0]!).getByText(target.xpaths[0]!)).toBeVisible();
      expect(within(targets[0]!).getByText("Disabled")).toBeVisible();
      expect(
        within(targets[1]!).getByText(
          missing
            ? "I couldn’t find that element in the current view."
            : "//button[@id='confirm-booking']",
        ),
      ).toBeVisible();
      expect(screen.getAllByText("Cost unavailable")).toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(
        "/api/pages/page-1/resolve",
        expect.objectContaining({
          body: JSON.stringify({
            instruction: "Click all confirmation buttons in the list",
            documentId: "document-1",
            imageMode: "auto",
          }),
        }),
      );
    },
  );

  it.each([false, true])(
    "shows frame and shadow context with a copyable XPath when blocked=%s",
    async (blocked) => {
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
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
                  interactability: blocked
                    ? { status: "blocked", reasons: ["disabled"], checks: {} }
                    : null,
                  shadowChain: [{ xpath: "//consent-panel", label: "Consent panel" }],
                  frame: {
                    id: "f2",
                    documentId: "child-document",
                    chain: [
                      { frameId: "f1", label: "Employee", xpath: "//iframe[@id='employee']" },
                      {
                        frameId: "f2",
                        label: "Payroll",
                        xpath: "//iframe[@id='payroll']",
                        shadowChain: [{ xpath: "//payroll-panel", label: "Payroll panel" }],
                      },
                    ],
                  },
                  state: { ...target.state, selected: true, selectedOptionCount: 2 },
                },
              },
            ],
          }),
        ),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      expect(await screen.findByText("Frame: Employee → Payroll")).toBeInTheDocument();
      expect(screen.getByText("Shadow roots: Payroll panel")).toBeInTheDocument();
      expect(screen.getByText("Shadow roots: Consent panel")).toBeInTheDocument();
      expect(screen.getByText("//consent-panel")).toBeInTheDocument();
      expect(screen.getByText("//iframe[@id='employee']")).toBeInTheDocument();
      expect(screen.getByText("//iframe[@id='payroll']")).toBeInTheDocument();
      expect(screen.getByText("//*[@data-testid='pay']")).toBeInTheDocument();
      if (blocked) {
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Retry instruction" })).toBeEnabled(),
        );
        const xpath = screen.getByText(target.xpaths[0]!);
        await user.hover(xpath);
        await waitFor(() =>
          expect(vi.mocked(fetch)).toHaveBeenCalledWith(
            "/api/pages/page-1/spotlight",
            expect.objectContaining({
              body: JSON.stringify({
                documentId: "document-1",
                captureId: "capture-1",
                actionId: "a1",
              }),
            }),
          ),
        );
        await user.unhover(xpath);
        act(() => xpath.focus());
        expect(xpath).toHaveFocus();
        await user.click(screen.getByRole("button", { name: "Copy XPath 1" }));
        expect(await navigator.clipboard.readText()).toBe(target.xpaths[0]);
        expect(screen.getByText("Copied")).toBeVisible();
        expect(screen.queryByText("Verification")).not.toBeInTheDocument();
      } else {
        expect(screen.getByText("Selected")).toBeInTheDocument();
        expect(screen.getByText("2 options selected")).toBeInTheDocument();
      }
    },
  );
});
