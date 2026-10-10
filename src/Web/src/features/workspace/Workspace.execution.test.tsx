import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setup } from "./workspaceExecutionTestUtils";

vi.mock("./BrowserViewer", () => ({ default: () => <div aria-label="Managed browser" /> }));
describe("Workspace execution", () => {
  it("executes only on explicit click and invalidates every result while the request is pending", async () => {
    let finish!: (response: Response) => void;
    const user = await setup(
      "click",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(vi.mocked(fetch).mock.calls.some(([path]) => path === "/api/pages/page/execute")).toBe(
      false,
    );
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "keep my draft");
    await user.click(screen.getByRole("button", { name: "Execute click on target 1" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/pages/page/execute",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "session",
          documentId: "document",
          captureId: "capture",
          actionId: "a1",
        }),
      }),
    );
    expect(screen.queryByRole("button", { name: /Execute click/ })).not.toBeInTheDocument();
    expect(screen.getByText("Earlier result")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    finish(
      Response.json({
        actionId: "a1",
        action: "click",
        status: "completed",
        message: "Browser action completed. Check the page for the result.",
      }),
    );
    expect(
      await screen.findByText("Browser action completed. Check the page for the result."),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue(
      "keep my draft",
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/pages/page/resolve"),
    ).toHaveLength(1);
  });

  it("sends explicitly entered values only to execution and clears their field after dispatch", async () => {
    const user = await setup("fill");
    await user.type(
      screen.getByRole("textbox", { name: "Value to enter for target 1" }),
      "synthetic-private-value",
    );
    await user.click(screen.getByRole("button", { name: "Execute fill on target 1" }));
    await screen.findByText("Browser action completed. Check the page for the result.");
    expect(
      screen.queryByRole("textbox", { name: "Value to enter for target 1" }),
    ).not.toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls;
    const execution = calls.find(([path]) => path === "/api/pages/page/execute");
    expect(JSON.parse(execution![1]!.body as string)).toEqual(
      expect.objectContaining({ value: "synthetic-private-value" }),
    );
    expect(
      calls
        .filter(([path]) => path === "/api/pages/page/resolve")
        .every(
          ([, init]) =>
            typeof init?.body === "string" && !init.body.includes("synthetic-private-value"),
        ),
    ).toBe(true);
    expect(screen.queryByText("synthetic-private-value")).not.toBeInTheDocument();
  });

  it.each([409, 502])("retains execution failure %s without offering replay", async (status) => {
    const user = await setup("click", () =>
      Promise.resolve(
        Response.json({ message: "The target is no longer ready. Resolve it again." }, { status }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Execute click on target 1" }));
    const message =
      status === 409
        ? "The target is no longer ready. Resolve it again."
        : "The browser could not confirm completion. Check the page before resolving again.";
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Execute click/ })).not.toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/pages/page/execute"),
    ).toHaveLength(1);
  });

  it("does not offer execution for a historical result after a new resolution", async () => {
    const user = await setup();
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Click Save");
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Execute click on target 1" })).toHaveLength(1),
    );
    expect(screen.getByText("Earlier result")).toBeVisible();
  });
});
