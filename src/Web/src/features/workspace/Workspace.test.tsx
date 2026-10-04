import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockSystemTheme } from "@/test/systemTheme";
import { ThemeProvider } from "../theme/ThemeProvider";
import Workspace from "./Workspace";

vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    disconnect = vi.fn();
    focus = vi.fn();
  },
}));

const session = { sessionId: "session-1", pageId: "page-1", viewPath: "/view/page-1" };
const page = {
  ...session,
  documentId: "document-1",
  url: "https://example.test/checkout",
  title: "Checkout",
  blockedPopups: 0,
};
const target = {
  candidateId: "candidate-1",
  tag: "button",
  label: "Pay now",
  xpaths: ["//*[@data-testid='pay']", "//button[normalize-space(.)='Pay now']"],
  state: { rendered: true, inViewport: false, enabled: false, editable: false, checked: null },
  geometry: { x: 20, y: 1200, width: 100, height: 40 },
};
const found = {
  outcome: "found",
  sessionId: session.sessionId,
  pageId: session.pageId,
  documentId: page.documentId,
  captureId: "capture-1",
  frameId: "main",
  traceId: "trace-1",
  attemptId: "attempt-1",
  configurationId: "test-config",
  action: "click",
  target: null,
  actions: [
    {
      actionId: "a1",
      order: 1,
      instruction: "Click Pay now",
      action: "click",
      outcome: "found",
      target,
    },
  ],
  diagnostics: { code: null, message: null },
};

function renderWorkspace() {
  mockSystemTheme();
  return render(
    <ThemeProvider>
      <Workspace />
    </ThemeProvider>,
  );
}

function mockApi(resolve = () => Promise.resolve(Response.json(found)), currentPage = () => page) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (options?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            pages: [currentPage()],
          }),
        );
      if (path.endsWith("/resolve")) return resolve();
      return Promise.resolve(Response.json(currentPage()));
    }),
  );
}

async function openWorkspace() {
  const user = userEvent.setup();
  renderWorkspace();
  await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
  );
  return user;
}

async function submitInstruction(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Click Pay now");
  await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
}

describe("Workspace resolution", () => {
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
    expect(blocked).not.toHaveTextContent(/XPath|Verification/);
    expect(
      within(screen.getByRole("region", { name: "Target 2" })).getByText("XPath"),
    ).toBeVisible();
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

  it.each([false, true])(
    "timestamps sent and received messages, including failure=%s",
    async (failure) => {
      let finish!: (response: Response) => void;
      mockApi(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const user = await openWorkspace();
      const sentAt = new Date("2026-09-30T19:24:00.000Z");
      const receivedAt = new Date("2026-09-30T19:25:02.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(sentAt);
      try {
        await submitInstruction(user);
        expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
        expect(screen.getByLabelText("Sent message")).toHaveTextContent("Click Pay now");
        const sent = screen.getByLabelText(/^Sent /, { selector: "time" });
        expect(sent).toHaveAttribute("datetime", sentAt.toISOString());
        expect(screen.queryByLabelText(/^Received /, { selector: "time" })).not.toBeInTheDocument();
        expect(
          within(screen.getByLabelText("Response message")).getByText("Resolving…"),
        ).toBeVisible();
        vi.setSystemTime(receivedAt);
        finish(
          failure
            ? Response.json({ message: "Provider unavailable" }, { status: 502 })
            : Response.json({
                ...found,
                diagnostics: { ...found.diagnostics, timingsMs: { total: 739 } },
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
        );
        const received = await screen.findByLabelText(/^Received /, { selector: "time" });
        expect(received).toHaveAttribute("datetime", receivedAt.toISOString());
        expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
        expect(sent).toHaveAttribute("datetime", sentAt.toISOString());
        expect(sent).toHaveTextContent(
          sentAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        );
        expect(received).toHaveTextContent(
          receivedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        );
        if (failure) expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
        else {
          const response = within(screen.getByLabelText("Response message"));
          const content = [
            response.getByRole("heading", { name: "Button" }),
            response.getByText("Action: click"),
            response.getByText(target.xpaths[0]!),
            response.getByRole("heading", { name: "Verification" }),
          ];
          for (let index = 0; index < content.length - 1; index++) {
            expect(content[index]!.compareDocumentPosition(content[index + 1]!)).toBe(
              Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }
          expect(response.getByText("Resolution time: 739 ms")).toBeVisible();
        }
      } finally {
        vi.useRealTimers();
      }
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
        else expect(within(target).queryByText(/Click the/)).not.toBeInTheDocument();
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
          }),
        }),
      );
    },
  );

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

  it("shows the frame chain separately from the document XPath and selected state", async () => {
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
                frame: {
                  id: "f2",
                  documentId: "child-document",
                  chain: [
                    { frameId: "f1", label: "Employee", xpath: "//iframe[@id='employee']" },
                    { frameId: "f2", label: "Payroll", xpath: "//iframe[@id='payroll']" },
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
    expect(screen.getByText("//iframe[@id='employee']")).toBeInTheDocument();
    expect(screen.getByText("//iframe[@id='payroll']")).toBeInTheDocument();
    expect(screen.getByText("//*[@data-testid='pay']")).toBeInTheDocument();
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByText("2 options selected")).toBeInTheDocument();
  });

  it("shows a direct single-target reply without repeated instructions or technical boilerplate", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          target: null,
          action: null,
          inspectedActionId: "a1",
          summary: {
            total: 1,
            found: 1,
            notFound: 0,
            unsupported: 0,
            errors: 0,
            blocked: 0,
            readinessUnknown: 1,
          },
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: { ...target, interactability: { status: "unknown", reasons: [] } },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    const transcript = screen.getByRole("log");
    expect(within(transcript).getAllByText("Click Pay now")).toHaveLength(1);
    expect(within(transcript).queryByText(page.url)).not.toBeInTheDocument();
    expect(within(transcript).queryByText(page.title)).not.toBeInTheDocument();
    expect(
      within(transcript).queryByText(/No action was executed|Semantic completeness|Event delivery/),
    ).not.toBeInTheDocument();
    expect(within(transcript).queryByText(/1 target found/)).not.toBeInTheDocument();
    expect(within(transcript).getByText(target.xpaths[0]!)).toBeVisible();
    expect(
      within(transcript).queryByRole("button", { name: /Inspect action/ }),
    ).not.toBeInTheDocument();
    expect(within(transcript).queryByText(target.xpaths[1]!)).not.toBeInTheDocument();
    expect(
      within(transcript).queryByText(/Verified XPaths|alternative XPath|State details/),
    ).not.toBeInTheDocument();
    expect(within(transcript).getByText("Interaction readiness unknown.")).toBeVisible();
    expect(within(transcript).getByText("Off-screen")).toBeVisible();
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
        }),
      }),
    );
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
    expect(response.querySelector("p")).toHaveClass("text-destructive");
    expect(response.querySelectorAll("p")).toHaveLength(1);
    expect(within(response).queryByRole("heading")).not.toBeInTheDocument();
    expect(within(response).queryByRole("button")).not.toBeInTheDocument();
    expect(response).not.toHaveTextContent(
      /XPath|Verification|Verified:|Interaction blocked|Disabled/,
    );
  });

  it.each([
    {
      action: "hover",
      status: "ready",
      checks: { enabled: "not_applicable", viewport: "pass", pointerReception: "pass" },
      message: "Verified: in view, unobstructed at the checked point.",
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
    async ({ action, status, checks, message, limit }) => {
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
      expect(
        screen.queryByText(
          /No action was performed|no interaction requested|movement and page response/i,
        ),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Interaction checks passed.")).not.toBeInTheDocument();
      expect(screen.queryByText(/clickable|successfully clicked/i)).not.toBeInTheDocument();
    },
  );

  it("shows structured cost details on hover and keyboard focus without mixing estimates and charges", async () => {
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
    const cost = await screen.findByRole("button", { name: "Estimated cost: $0.00001709" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(cost);
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("$0.0749")).toBeInTheDocument();
    expect(within(tooltip).getByText("$0.44")).toBeInTheDocument();
    expect(within(tooltip).getByText("$0.0000215")).toBeInTheDocument();
    expect(within(tooltip).getByText("140")).toBeInTheDocument();
    expect(within(tooltip).getByText("Unavailable")).toBeInTheDocument();
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
    expect(within(screen.getByRole("tooltip")).getAllByText("Unavailable")).toHaveLength(12);
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
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "The provider may still charge this timed-out request.",
    );
    expect(screen.queryByRole("button", { name: "Copy XPath 1" })).not.toBeInTheDocument();
  });

  it("reports a clipboard failure only on the history entry being copied", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await submitInstruction(user);
    await waitFor(() =>
      expect(screen.getAllByText("Pay now", { selector: "bdi" })).toHaveLength(2),
    );
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("Clipboard unavailable"),
    );
    await user.click(
      within(screen.getAllByRole("article").at(-1)!).getByRole("button", { name: "Copy XPath 1" }),
    );
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
  });

  it("keeps earlier instructions, outcomes and reported times in the current tab chat", async () => {
    let attempt = 0;
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          outcome: ++attempt === 1 ? "found" : "not_found",
          diagnostics: { ...found.diagnostics, timingsMs: { total: attempt === 1 ? 1260 : 430 } },
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: attempt === 1 ? "found" : "not_found",
              target: attempt === 1 ? target : null,
              code: null,
              message: null,
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    const composer = screen.getByRole("textbox", { name: "Describe an element" });
    await user.clear(composer);
    await user.type(composer, "Click the missing button{Enter}");

    expect(
      await screen.findByText("I couldn’t find that element in the current view."),
    ).toBeInTheDocument();
    expect(screen.getByText("Click Pay now")).toBeInTheDocument();
    expect(screen.getByText("Click the missing button", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Resolution time: 1.26 s")).toBeInTheDocument();
    expect(screen.getByText("Resolution time: 430 ms")).toBeInTheDocument();
  });

  it("sends an instruction with Enter", async () => {
    mockApi();
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.type(instruction, "Click Pay now{Enter}");

    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(instruction).toHaveValue("");
  });

  it("returns focus to the composer when a sent request completes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(() => pending);
    const user = await openWorkspace();
    await submitInstruction(user);
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    await screen.findByText("Pay now", { selector: "bdi" });
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveFocus();
  });

  it("keeps focus on another control when a sent request completes", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(() => pending);
    const user = await openWorkspace();
    await submitInstruction(user);
    const theme = screen.getByRole("button", { name: "Switch to light theme" });
    await user.click(theme);
    await user.keyboard("{Escape}");
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    await screen.findByText("Pay now", { selector: "bdi" });
    expect(theme).toHaveFocus();
  });

  it("inserts a Ctrl+Enter newline at the selected text and keeps the caret there", async () => {
    const resolve = vi.fn(() => Promise.resolve(Response.json(found)));
    mockApi(resolve);
    const user = await openWorkspace();
    const instruction = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Describe an element",
    });
    await user.type(instruction, "Click the Pay now button");
    instruction.setSelectionRange(9, 18);
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(instruction).toHaveValue("Click the\nbutton");
    expect(instruction.selectionStart).toBe(10);
    expect(instruction.selectionEnd).toBe(10);
    expect(resolve).not.toHaveBeenCalled();
    await user.keyboard("primary ");
    expect(instruction).toHaveValue("Click the\nprimary button");
  });

  it("does not submit Enter while an IME composition is active", async () => {
    const resolve = vi.fn(() => Promise.resolve(Response.json(found)));
    mockApi(resolve);
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.type(instruction, "Click 確認");
    fireEvent.keyDown(instruction, { key: "Enter", isComposing: true });
    fireEvent.keyDown(instruction, { key: "Enter", keyCode: 229 });

    expect(resolve).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
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

  it("reports a noneditable fill target as found with its observed state", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          action: "fill",
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "fill",
              outcome: "found",
              target: { ...target, tag: "input", label: "Name" },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(await screen.findByText("Name", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByText("Not editable")).toBeInTheDocument();
    expect(
      screen.queryByText("I couldn’t find that element in the current view."),
    ).not.toBeInTheDocument();
  });

  it("preserves a result as historical when polling detects a same-URL document change", async () => {
    let current = page;
    mockApi(undefined, () => current);
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    current = { ...page, documentId: "document-2" };

    await waitFor(() => expect(screen.getByText(/Earlier result/)).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled();
  });

  it.each([
    { name: "another page", result: { pageId: "page-2" }, current: {} },
    { name: "another document", result: { documentId: "document-2" }, current: {} },
    { name: "another session", result: { sessionId: "session-2" }, current: {} },
  ])("rejects a result from $name", async ({ result, current: changed }) => {
    let current = page;
    mockApi(
      () =>
        Promise.resolve(
          Response.json({
            ...found,
            ...result,
            target: null,
            actions: [
              {
                actionId: "a1",
                order: 1,
                instruction: "Click Pay now",
                action: "click",
                outcome: "found",
                target: target,
              },
            ],
          }),
        ),
      () => current,
    );
    const user = await openWorkspace();
    current = { ...page, ...changed };
    await submitInstruction(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The page changed. Resolve the instruction again.",
    );
    expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument();
  });

  it("preserves the previous result as historical when the user reloads the page", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await user.click(screen.getByRole("button", { name: "Reload page" }));

    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByText(/Earlier result/)).toBeInTheDocument();
    expect(screen.getByText(target.xpaths[0]!)).toBeVisible();
    expect(screen.queryByText(target.xpaths[1]!)).not.toBeInTheDocument();
    expect(screen.getByText("Interaction readiness unavailable.")).toBeVisible();
  });

  it("closes all tabs and clears chat without creating a replacement session", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: /reset|close all/i }),
    ).not.toBeInTheDocument();
    await user.click(
      within(screen.getByRole("region", { name: "Browser workspace" })).getByRole("button", {
        name: "Close all tabs",
      }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveFocus();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/sessions/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(
      vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => input === "/api/sessions"),
    ).toHaveLength(1);
  });

  it("reopens with fresh chat and ignores a delayed snapshot from the closed session", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    const originalFetch = globalThis.fetch;
    const freshSession = { sessionId: "session-2", pageId: "page-2", viewPath: "/view/session-2" };
    const freshPage = {
      ...page,
      ...freshSession,
      documentId: "document-2",
      url: "https://fresh.test/",
      title: "Fresh page",
    };
    let finishOldSnapshot: ((response: Response) => void) | undefined;
    const resolveFresh = vi.fn(() =>
      Promise.resolve(
        Response.json({
          ...found,
          sessionId: freshSession.sessionId,
          pageId: freshPage.pageId,
          documentId: freshPage.documentId,
          target: null,
          actions: [
            {
              actionId: "a1",
              order: 1,
              instruction: "Click Pay now",
              action: "click",
              outcome: "found",
              target: { ...target, label: "Fresh target" },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, options) => {
        if (input === "/api/sessions/session-1" && options?.method === "GET")
          return new Promise<Response>((resolve) => {
            finishOldSnapshot = resolve;
          });
        if (input === "/api/sessions") return Promise.resolve(Response.json(freshSession));
        if (input === "/api/sessions/session-2")
          return Promise.resolve(
            Response.json({
              ...freshSession,
              activePageId: freshPage.pageId,
              activationVersion: 1,
              pages: [freshPage],
            }),
          );
        if (input === "/api/pages/page-2/navigate")
          return Promise.resolve(Response.json(freshPage));
        if (input === "/api/pages/page-2/resolve") return resolveFresh();
        return originalFetch(input, options);
      }),
    );
    await waitFor(() => expect(finishOldSnapshot).toBeTypeOf("function"), { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true"),
    );
    await user.type(screen.getByRole("textbox", { name: "Page address" }), "fresh.test{Enter}");
    expect(await screen.findByRole("tab", { name: "Fresh page" })).toBeInTheDocument();
    await act(() =>
      Promise.resolve(
        finishOldSnapshot!(
          Response.json({
            ...session,
            activePageId: page.pageId,
            activationVersion: 1,
            pages: [page],
          }),
        ),
      ),
    );
    expect(screen.queryByRole("tab", { name: "Checkout" })).not.toBeInTheDocument();
    expect(screen.queryByText("Pay now", { selector: "bdi" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
    await user.type(
      screen.getByRole("textbox", { name: "Describe an element" }),
      "Click Fresh target{Enter}",
    );
    expect(await screen.findByText("Fresh target", { selector: "bdi" })).toBeInTheDocument();
    expect(resolveFresh).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/pages/page-2/resolve",
      expect.objectContaining({
        body: JSON.stringify({
          instruction: "Click Fresh target",
          documentId: "document-2",
        }),
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the tabs and chat available if closing the session fails", async () => {
    mockApi();
    const user = await openWorkspace();
    await submitInstruction(user);
    await screen.findByText("Pay now", { selector: "bdi" });
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "Next draft");
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, options) =>
        options?.method === "DELETE"
          ? Promise.resolve(
              Response.json({ message: "Unable to close the browser." }, { status: 503 }),
            )
          : originalFetch(input, options),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Close all tabs" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Close all tabs" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to close the browser.");
    expect(screen.getByRole("tab", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("Next draft");
    expect(screen.getByRole("button", { name: "Close all tabs" })).toBeEnabled();
  });

  it("prevents duplicate resolution and navigation while a request is pending", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const resolve = vi.fn(() => pending);
    mockApi(resolve);
    const user = await openWorkspace();
    await submitInstruction(user);

    expect(screen.getByText("Resolving…")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close all tabs" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });
    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
  });

  it("requires an open page and a nonblank instruction", async () => {
    mockApi();
    const user = userEvent.setup();
    renderWorkspace();
    expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled(),
    );
    await user.type(screen.getByRole("textbox", { name: "Describe an element" }), "   ");

    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
  });

  it.each([
    {
      name: "network",
      response: () => Promise.reject(new TypeError("Failed to fetch")),
      message: "Failed to fetch",
    },
    {
      name: "HTTP",
      response: () =>
        Promise.resolve(
          Response.json({ message: "The resolver is unavailable." }, { status: 503 }),
        ),
      message: "The resolver is unavailable.",
    },
  ])(
    "reports a $name failure without inventing an absence result",
    async ({ response, message }) => {
      mockApi(response);
      const user = await openWorkspace();
      await submitInstruction(user);

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(
        screen.queryByText("I couldn’t find that element in the current view."),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toBeEnabled();
      expect(screen.getByRole("textbox", { name: "Describe an element" })).toHaveValue("");
      expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    },
  );

  it("marks a late result historical after manual navigation and updates the shown page address", async () => {
    let current = page;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    mockApi(
      () => pending,
      () => current,
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    current = { ...page, documentId: "document-2", url: "https://example.test/done" };
    await act(async () => {
      finish(Response.json(found));
      await pending;
    });

    expect(await screen.findByText(/Earlier result/)).toBeInTheDocument();
    expect(screen.getByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Page address" })).toHaveValue(
      "https://example.test/done",
    );
  });

  it("blocks instructions exceeding the service limit without truncating the text", async () => {
    mockApi();
    const user = await openWorkspace();
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await user.click(instruction);
    await user.paste("a".repeat(4001));

    expect(instruction).toHaveValue("a".repeat(4001));
    expect(screen.getByRole("button", { name: "Resolve instruction" })).toBeDisabled();
    expect(screen.getByText("Use 4,000 characters or fewer.")).toBeInTheDocument();
  });

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
      "Page change required",
      "This element depends on a page change. Make that change, then try again.",
    ],
    [
      "unsupported",
      "appearance_unavailable",
      "Appearance unavailable",
      "The requested appearance cannot be established from the captured CSS evidence.",
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

  it("resolves the managed page and displays one copyable XPath with inline state", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            pages: [page],
          }),
        );
      if (path === "/api/pages/page-1/resolve") {
        expect(JSON.parse(typeof options?.body === "string" ? options.body : "null")).toEqual({
          instruction: "Click Pay now",
          documentId: "document-1",
        });
        return Promise.resolve(Response.json(found));
      }
      return Promise.resolve(Response.json(page));
    });
    vi.stubGlobal("fetch", fetch);
    renderWorkspace();

    await user.type(screen.getByRole("textbox", { name: "Page address" }), `${page.url}{Enter}`);
    const instruction = screen.getByRole("textbox", { name: "Describe an element" });
    await waitFor(() => expect(instruction).toBeEnabled());
    await user.type(instruction, "Click Pay now");
    await user.click(screen.getByRole("button", { name: "Resolve instruction" }));

    expect(await screen.findByText("Pay now", { selector: "bdi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy XPath 2" })).not.toBeInTheDocument();
    expect(screen.queryByText(target.xpaths[1]!)).not.toBeInTheDocument();
    expect(screen.queryByText("1 alternative XPath")).not.toBeInTheDocument();
    expect(screen.getByText("Off-screen")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy XPath 1" }));
    expect(await navigator.clipboard.readText()).toBe("//*[@data-testid='pay']");
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute/i })).not.toBeInTheDocument();
  });
});
