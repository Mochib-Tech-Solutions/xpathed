import { screen, waitFor, within } from "@testing-library/react";
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
describe("Workspace targets", () => {
  it("labels visual target phrases as requests without replacing accessible names", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          actions: [
            {
              ...found.actions[0],
              instruction: "Click the blue triangle in Primary controls",
              target: { ...target, accessibleName: "Option B", label: "Legacy label" },
            },
            {
              ...found.actions[0],
              actionId: "a2",
              order: 2,
              instruction: "Click the blue triangle in Secondary controls",
              target: { ...target, candidateId: "candidate-2", accessibleName: "Option B" },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const first = await screen.findByRole("region", { name: "Target 1" });
    const second = screen.getByRole("region", { name: "Target 2" });
    expect(within(first).getByText("Option B", { selector: "bdi" })).toBeVisible();
    expect(within(second).getByText("Option B", { selector: "bdi" })).toBeVisible();
    expect(first).toHaveTextContent("Requested: Click the blue triangle in Primary controls");
    expect(second).toHaveTextContent("Requested: Click the blue triangle in Secondary controls");
    expect(first).not.toHaveTextContent("Secondary controls");
    expect(second).not.toHaveTextContent("Primary controls");
    expect(screen.queryByText("Legacy label")).not.toBeInTheDocument();
  });

  it("keeps an unnamed graphic unnamed while showing the requested visual detail", async () => {
    mockApi(() =>
      Promise.resolve(
        Response.json({
          ...found,
          actions: [
            {
              ...found.actions[0],
              instruction: "Click the picture of a mountain",
              target: { ...target, tag: "img", label: "", accessibleName: "" },
            },
          ],
        }),
      ),
    );
    const user = await openWorkspace();
    await submitInstruction(user);
    const response = await screen.findByRole("region", { name: "Target 1" });
    expect(within(response).getByRole("heading", { name: "Image" })).toBeVisible();
    expect(within(response).getByText("No accessible name")).toBeVisible();
    expect(response).toHaveTextContent("Requested: Click the picture of a mountain");
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

  it("resolves the managed page and displays one copyable XPath with inline state", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
      const path =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (path === "/api/sessions/options")
        return Promise.resolve(
          Response.json({
            defaultBrowserType: "chromium",
            browserTypes: ["chromium"],
            defaultResolution: "1280x800",
            resolutions: [
              { id: "1280x800", width: 1280, height: 800 },
              { id: "1920x1080", width: 1920, height: 1080 },
            ],
          }),
        );
      if (path === "/api/sessions") return Promise.resolve(Response.json(session));
      if (path === "/api/sessions/session-1")
        return Promise.resolve(
          Response.json({
            sessionId: session.sessionId,
            activePageId: page.pageId,
            activationVersion: 1,
            viewPath: session.viewPath,
            browserType: "chromium" as const,
            resolution: "1280x800",
            pages: [page],
          }),
        );
      if (path === "/api/pages/page-1/resolve") {
        expect(JSON.parse(typeof options?.body === "string" ? options.body : "null")).toEqual({
          instruction: "Click Pay now",
          documentId: "document-1",
          imageMode: "auto",
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
