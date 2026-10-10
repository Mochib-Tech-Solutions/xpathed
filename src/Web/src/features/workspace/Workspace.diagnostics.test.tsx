import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  session,
  page,
  target,
  found,
  renderWorkspace,
  mockApi,
  openWorkspace,
  submitInstruction,
} from "./workspaceTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));

describe("Workspace diagnostics", () => {
  const resolutionRequests = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([path]) => typeof path === "string" && path.endsWith("/resolve"))
      .map(
        ([, options]) =>
          JSON.parse(options?.body as string) as { imageMode: string; includeImage?: boolean },
      );

  it("defaults to automatic screenshots without guessing whether an image was used", async () => {
    mockApi();
    const user = await openWorkspace();
    expect(screen.queryByRole("combobox", { name: "Screenshots" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const mode = screen.getByRole("combobox", { name: "Screenshots" });
    expect(mode).toHaveValue("auto");
    expect(mode).toHaveAccessibleDescription(
      "Auto sends a masked screenshot to the model provider when visual details may help. Other visible content can be shared.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry instruction" })).toBeEnabled(),
    );
    expect(resolutionRequests()).toEqual([expect.objectContaining({ imageMode: "auto" })]);
    expect(resolutionRequests()[0]).not.toHaveProperty("includeImage");
    expect(screen.queryByText("Image used")).not.toBeInTheDocument();
  });

  it("switches automatic screenshots to text only and preserves the choice through retry", async () => {
    mockApi();
    const user = await openWorkspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const mode = screen.getByRole("combobox", { name: "Screenshots" });
    await user.selectOptions(mode, "text_only");
    expect(mode).toHaveAccessibleDescription(
      "Text only sends page text and structure, without screenshots.",
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry instruction" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Retry instruction" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Retry instruction" })[1]).toBeEnabled(),
    );
    expect(resolutionRequests().map((request) => request.imageMode)).toEqual([
      "text_only",
      "text_only",
    ]);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("combobox", { name: "Screenshots" })).toHaveValue("text_only");
    expect(screen.getByRole("combobox", { name: "Screenshots" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Done" }));
  });

  it("switches text only back to automatic screenshots for the next instruction", async () => {
    mockApi();
    const user = await openWorkspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Screenshots" }), "text_only");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry instruction" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Screenshots" }), "auto");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Retry instruction" })[1]).toBeEnabled(),
    );
    expect(resolutionRequests().map((request) => request.imageMode)).toEqual(["text_only", "auto"]);
  });

  it("applies initial settings to the first page and displays automatic execution when enabled", async () => {
    mockApi();
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const mode = screen.getByRole("combobox", { name: "Screenshots" });
    const automatic = screen.getByRole("checkbox", { name: "Execute automatically" });
    expect(mode).toBeEnabled();
    expect(automatic).not.toBeChecked();
    await user.selectOptions(mode, "text_only");
    await user.click(automatic);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Auto execute on")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("combobox", { name: "Screenshots" })).toHaveValue("text_only");
    expect(screen.getByRole("checkbox", { name: "Execute automatically" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Done" }));
  });

  it.each([
    [
      "included",
      "visual_evidence",
      "Image used",
      "An image was chosen to help with visual details.",
    ],
    [
      "unavailable",
      "image_unavailable",
      "Image unavailable",
      "A usable screenshot was unavailable.",
    ],
    ["text_only", "semantic_evidence", "Text only", "Page text and structure appeared sufficient."],
  ])(
    "shows actual server image status %s instead of requested policy",
    async (status, reason, label, explanation) => {
      let complete!: (response: Response) => void;
      mockApi(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      expect(screen.queryByText("Image used")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.getByRole("combobox", { name: "Screenshots" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Execute automatically" })).toBeDisabled();
      await user.click(screen.getByRole("button", { name: "Done" }));
      complete(
        Response.json({
          ...found,
          diagnostics: {
            ...found.diagnostics,
            imageRouting: { mode: "auto", status, reason, score: null, cached: false },
          },
        }),
      );
      const indicator = await screen.findByLabelText(`${label}: ${explanation}`);
      expect(indicator).toHaveTextContent(label);
      expect(indicator).toHaveAttribute("title", explanation);
      if (status !== "included") expect(screen.queryByText("Image used")).not.toBeInTheDocument();
      expect(screen.queryByText("Screenshot included")).not.toBeInTheDocument();
    },
  );

  it.each([
    [
      "text_only",
      "text_only_requested",
      "That visual detail could not be established from page text and structure. Choose Auto screenshots, or specify a label, section, or position.",
    ],
    [
      "unavailable",
      "image_unavailable",
      "A screenshot was unavailable for this request. Identify the element by its label, section, or position.",
    ],
    [
      "included",
      "visual_evidence",
      "That visual detail could not be established from the current view. Specify a label, section, or position.",
    ],
    [
      "text_only",
      "semantic_evidence",
      "That visual detail could not be established from the current view. Specify a label, section, or position.",
    ],
  ])(
    "explains unavailable appearance using actual image status %s / %s",
    async (status, reason, message) => {
      mockApi(() =>
        Promise.resolve(
          Response.json({
            ...found,
            outcome: "unsupported",
            action: "unsupported",
            actions: [
              {
                ...found.actions[0],
                outcome: "unsupported",
                action: "unsupported",
                code: "appearance_unavailable",
                message: "The requested appearance cannot be established from the captured view.",
                target: null,
              },
            ],
            diagnostics: {
              ...found.diagnostics,
              imageRouting: {
                mode: reason === "text_only_requested" ? "text_only" : "auto",
                status,
                reason,
                score: null,
                cached: false,
              },
            },
          }),
        ),
      );
      const user = await openWorkspace();
      await submitInstruction(user);
      expect(await screen.findByText(message)).toBeVisible();
      if (reason !== "text_only_requested")
        expect(screen.queryByText(/Choose Auto screenshots/)).not.toBeInTheDocument();
      const response = screen.getByLabelText("Response message");
      expect(response).not.toHaveTextContent(/masked|blurry|low.quality/i);
      expect(
        within(response).queryByRole("heading", { name: "Target not found" }),
      ).not.toBeInTheDocument();
    },
  );

  it("shows minimal model usage on hover and keyboard focus, preferring reported charges", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: {
            ...found.diagnostics,
            model: "deepseek/deepseek-v4.1-flash",
            provider: "Wafer",
            usage: {
              inputTokens: 140,
              outputTokens: 15,
              totalTokens: 155,
              reasoningTokens: 0,
              cachedTokens: null,
              cost: 0.0000215,
            },
            costEstimate: {
              currency: "USD",
              inputPricePerMillion: 0.0749,
              outputPricePerMillion: 0.44,
              inputCost: 0.000010486,
              outputCost: 0.0000066,
              requestCost: 0,
              totalCost: 0.000017086,
              pricingFetchedAt: "2026-09-30T09:00:00Z",
            },
          },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: target,
              code: null,
              message: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const cost = await screen.findByRole("button", { name: "Reported cost: $0.0000215" });
    expect(screen.queryByText(`Session ${session.sessionId}`)).not.toBeInTheDocument();
    expect(screen.queryByTitle(`Browser session: ${session.sessionId}`)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(cost);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("deepseek/deepseek-v4.1-flash")).toBeInTheDocument();
    expect(within(tooltip).getByText("$0.0000215")).toBeInTheDocument();
    expect(within(tooltip).getByText("155")).toBeInTheDocument();
    expect(tooltip).not.toHaveTextContent(/Wafer|Estimated|Rates|Reasoning|Cached/);
    await user.unhover(cost);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    act(() => cost.focus());
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(cost).toHaveFocus();
  });

  it("shows a reported zero charge when rates are missing and unavailable when usage is missing", async () => {
    let attempt = 0;
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: {
            ...found.diagnostics,
            costEstimate: null,
            usage:
              ++attempt === 1
                ? {
                    inputTokens: null,
                    outputTokens: null,
                    totalTokens: null,
                    reasoningTokens: null,
                    cachedTokens: null,
                    cost: 0,
                  }
                : null,
          },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: target,
              code: null,
              message: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const cost = await screen.findByRole("button", { name: "Reported cost: $0.00" });
    await user.hover(cost);
    expect(within(screen.getByRole("tooltip")).getAllByText("Unavailable")).toHaveLength(2);
    await user.unhover(cost);
    await submitInstruction(user);
    expect(await screen.findByRole("button", { name: "Cost unavailable" })).toBeInTheDocument();
  });

  it("reports pending provider cost on a timed-out current-view request", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: "error",
          target: null,
          actions: [],
          diagnostics: {
            code: "resolution_timeout",
            message: "Resolution exceeded its two-second server processing deadline.",
            providerAccounting: "pending",
          },
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "two-second server processing deadline",
    );
    const cost = screen.getByRole("button", { name: "Cost pending" });
    await user.hover(cost);
    expect(
      screen.getByRole("row", { name: "Unavailable Pending Unavailable" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy XPath 1" })).not.toBeInTheDocument();
  });

  it("shows the resolver's reported duration beside the result", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          diagnostics: { ...found.diagnostics, timingsMs: { total: 1260 } },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: target,
              code: null,
              message: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("Resolution time: 1.26 s")).toBeInTheDocument();
  });

  it("omits duration when the resolver did not report one", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);

    await screen.findByText("Pay now", { selector: "bdi" });
    expect(screen.queryByText(/Resolution time:/)).not.toBeInTheDocument();
  });
});
