import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";

vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    disconnect = vi.fn();
    focus = vi.fn();
  },
}));

async function setup(
  action = "click",
  execute = () =>
    Promise.resolve(
      Response.json({
        actionId: "a1",
        action,
        status: "completed",
        message: "Browser action completed. Check the page for the result.",
      }),
    ),
) {
  const session = {
    sessionId: "session",
    pageId: "page",
    viewPath: "/view/session",
    browserType: "chromium",
    resolution: "1280x800",
  };
  const page = {
    ...session,
    documentId: "document",
    url: "https://example.test",
    title: "Test",
    blockedPopups: 0,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (input === "/api/sessions/options")
        return Response.json({
          defaultBrowserType: "chromium",
          browserTypes: ["chromium"],
          defaultResolution: "1280x800",
          resolutions: [{ id: "1280x800", width: 1280, height: 800 }],
        });
      if (input === "/api/sessions") return Response.json(session);
      if (input === "/api/sessions/session")
        return Response.json({
          ...session,
          activePageId: "page",
          activationVersion: 1,
          pages: [page],
        });
      if (input === "/api/pages/page/execute") return execute();
      if (input === "/api/pages/page/resolve")
        return Response.json({
          outcome: "found",
          sessionId: "session",
          pageId: "page",
          documentId: "document",
          captureId: "capture",
          action,
          target: null,
          diagnostics: {},
          actions: [
            {
              actionId: "a1",
              order: 1,
              action,
              instruction: "Click Save",
              outcome: "found",
              target: {
                candidateId: "c1",
                tag: action === "fill" ? "input" : "button",
                label: "Save",
                xpaths: ["//button[@id='save']"],
                state: {
                  rendered: true,
                  inViewport: true,
                  enabled: true,
                  editable: action === "fill",
                  checked: null,
                },
                interactability: {
                  action,
                  status: "ready",
                  reasons: [],
                  checks: {
                    compatibleControl: "pass",
                    enabled: "pass",
                    keyboard: "pass",
                    viewport: "pass",
                    pointerReception: "pass",
                  },
                },
              },
            },
          ],
        });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(page);
    }),
  );
  mockSystemTheme();
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Page address" }),
    "https://example.test{Enter}",
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Describe an element" }),
    action === "fill" ? "Fill Save" : "Click Save",
  );
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
  await screen.findByRole("button", { name: `Execute ${action} on target 1` });
  return user;
}

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
  expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("keep my draft");
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
