# From an instruction to a verified XPath

“Hover over OK under Employee” sounds simple. A page might contain six OK buttons, two Employee sections, an open dialog and a disabled control. A useful answer has to identify the intended element, locate it in the actual browser and explain whether hovering over it is currently possible.

xpathed is the local prototype built for this natural-language-to-XPath case study. Its central design decision is to give the language model one job: select targets from observed page candidates. Browser code constructs the XPath and checks it against the retained element. This makes the uncertain part of the system measurable while keeping locator verification deterministic.

This walkthrough follows that command through the implemented system. The [resolution contract](resolution.md) contains exact schemas and policies; the [runtime reference](runtime.md) contains endpoints and configuration.

## The system in one picture

[![Five-service architecture showing the workspace, ClientApi, Resolver, Browser, PostgreSQL and the external model provider.](diagrams/system-design.svg)](diagrams/system-design.svg)

The application runs as five Docker services:

| Service        | What it owns                                                    | Why that boundary matters                                                       |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Web**        | React chat, tabs, address bar and noVNC browser viewer          | The instruction and visible page share one active-page identity.                |
| **ClientApi**  | Workspace API, request forwarding and diagnostic recording      | Persistence stays outside the resolver.                                         |
| **Resolver**   | Capture → model selection → verification orchestration          | It carries request data without owning browser objects or a database.           |
| **Browser**    | Playwright, Chromium, live pages, capture, XPath and highlights | The service observing an element also verifies its identity.                    |
| **PostgreSQL** | Sanitized diagnostic records                                    | Evidence can survive a session without pretending to restore its browser state. |

OpenRouter is an external dependency used by Resolver. The shared `Common` project defines serializable contracts; it is a library, not another service.

Each managed session has its own Chromium process, browser context and display. noVNC lets the user interact with that browser through the workspace. The client owns the tab controls, while Browser owns the real pages. Operations are serialized within each session; separate sessions have separate locks.

## Follow one command

[![Resolution flow from an English command through candidate capture, model selection, browser verification and a highlighted result.](diagrams/resolution-flow.svg)](diagrams/resolution-flow.svg)

### 1. Establish which page the instruction means

The user enters a website address, opens the Employee section manually and submits:

> Hover over OK under Employee.

Web sends the active `pageId`, its `documentId`, the instruction and contract version `4`. ClientApi starts an internal diagnostic attempt and calls Resolver. Resolver asks Browser to capture that same page.

The identifiers guard different kinds of change: a tab is a page; a navigation replaces its document; a capture identifies one temporary inventory of elements. Browser rejects an inactive page or outdated document. Switching tabs invalidates the old capture, even if the user switches back.

The current workspace resolves **one interaction across one or more targets in the current viewport**. “Hover over all OK buttons under Employee” is supported within that view. “Open Employee, then hover over OK” requires a future page state and is rejected as a whole. Older API contracts retain their documented page-wide behavior.

### 2. Turn the live DOM into candidates

Browser traverses the main document and supported nested frames. It retains the actual nodes locally and gives each candidate a temporary ID. Resolver receives a compact description containing useful evidence:

- Element tag, role, accessible label and safe text.
- Labels and headings from surrounding sections or rows.
- State such as disabled or readonly, and geometry relative to the main viewport.
- Supported CSS foreground, background and border colors, with explicit gaps where appearance cannot be established.
- Frame identity and safe frame labels.

For the example, an OK button's label identifies the control, while its Employee heading distinguishes it from an OK button under Department. The heading is context; it is not another button to return.

Eligibility and readiness are separate. Hidden or accessibility-excluded content is outside the supported candidate set. An intersecting disabled, covered or partially visible control remains a candidate: it may be exactly what the user meant. Off-screen targets are outside contract 4's scope.

Capture excludes current editable values, passwords, cookies, storage and URL attributes. Accessible names use a documented, sanitized DOM policy rather than forwarding a raw accessibility snapshot. Button captions stored in native button `value` attributes are a narrow exception. Image identity comes from accessible names such as alt text; the system does not interpret image pixels.

Capture has explicit limits on documents, visited elements, retained candidates, bytes and time. Exceeding a limit produces an incomplete-capture error. A truncated inventory cannot support a confident “not found.” The current bounds and naming rules live in the [capture contract](resolution.md#capture-and-validation).

### 3. Ask the model to identify the target

Resolver sends the original instruction and every captured candidate through one inference call. The prompt treats candidate text as untrusted page data. The model has no browser tools and returns structured JSON containing the interaction, selected candidate IDs and per-target outcomes.

For our example, the expected interpretation is `hover`, with the candidate ID belonging to the OK button under Employee. The model can also report scoped absence or an unsupported instruction. Ambiguity requires a clearer name, section or position.

Resolver validates the response beyond JSON syntax: selected IDs must exist in the capture, entries must obey the contract, targets must be distinct and all entries must share one interaction. A model-declared incomplete enumeration is an error. Schema compliance alone cannot establish that the model understood the instruction or found every intended target; independent evaluation measures those questions.

The [selection prompt and validation](../src/Resolver/Services/ActionSelectionStrategy.cs) are ordinary versioned source. The gateway owns provider transport and settings. This keeps experiments in model choice separate from browser correctness.

### 4. Construct and verify one XPath

Browser receives the selected candidate ID and retrieves its retained node. It tries XPath expressions in a defined order:

1. Explicit test attributes such as `data-testid`.
2. Target semantics inside meaningful sections, rows or landmarks.
3. Native label associations and unscoped semantic attributes or text.
4. Ordinary IDs/names, attribute combinations and broader ancestor context.
5. A structural path as the final fallback.

For a simple illustrative page containing `<section><h2>Employee</h2><button>OK</button></section>`, the resulting expression could be:

```xpath
//section[h2[normalize-space(.)='Employee']]//button[normalize-space(.)='OK']
```

Every proposed expression must match **exactly one node in the target's whole document**, and that node must be the retained target. A matching string or a unique result alone is insufficient. Generated-looking IDs are avoided as literal anchors, and semantic scope helps a saved XPath remain specific when another OK button appears elsewhere.

These checks establish locator identity at validation time. A model can still choose the wrong OK button and receive a perfectly valid XPath for it. That is why evaluation needs independently labelled targets, and why saved-locator tests must exercise later DOM changes separately.

### 5. Recheck the view and observe readiness

The page can change while the model is answering. Browser verifies the document, frame and capture identities, then rechecks the current-view membership. A changed viewport, scroll position or candidate membership can invalidate the capture. Absence also goes through revalidation: an old empty view must not justify a new “not found” response.

Browser then evaluates the observations relevant to the requested interaction. For hover, readiness checks include viewport membership and pointer reception at a sampled point in the clipped target area; rendering is reported separately. Nested frames require the point to reach the target through every containing document.

The result keeps four questions distinct:

| Question                                                   | What establishes it                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Did we select the intended element?                        | Independently labelled evaluation; live model selection remains fallible. |
| Does the XPath locate the selected element?                | Unique, same-node browser verification.                                   |
| Is the element observably ready for this action?           | Action-specific passive state and hit-point checks.                       |
| Did the action achieve the application's intended outcome? | Outside this prototype's resolution flow; no action is executed.          |

A covered OK button can be **found** with a verified XPath and **blocked** readiness. A passing pointer check describes the sampled point, not every point or event handler. Highlights add DOM decorations that page mutation observers can detect. Stability, dispatched events and business outcomes remain untested. Custom-control behavior can remain unsupported even when element identity is established.

### 6. Show the result and retain diagnostic evidence

Browser highlights every found target. Web presents the interpreted action once, followed by each target's accessible identity, XPath and verification details. Mixed found/missing results retain their separate outcomes. Highlights follow manual scrolling and remain during mouse movement; browser clicks, keypresses, a new instruction or invalidation clear them.

Each tab keeps its own chat draft and results in client memory. A historical response belongs to the document that produced it and cannot become a fresh highlight in another tab. Reset chat clears only the active tab's conversation.

ClientApi records bounded, sanitized evidence in PostgreSQL: the original attempt identity, result, configuration, timings and available usage/cost. Recording failure is reported operationally and does not turn a successful resolution into a semantic failure. Records have retention limits and internal operator access; they do not recreate a browser session. See [backend diagnostics](diagnostics.md).

Cost estimates and provider-reported charges remain separate. Missing accounting is unknown, not zero. A cancelled provider request may still incur a charge; bounded late accounting records what becomes available without rewriting the original failed attempt. Two seconds is a speed measurement, not an end-to-end cutoff that discards otherwise valid results.

## Why frames need more than an XPath

An XPath is evaluated within one document. It cannot cross an iframe boundary by itself.

For a button inside an embedded Employee application, xpathed returns the target's XPath **and** an ordered frame chain. Each chain entry locates a frame owner in the preceding document; the final XPath runs inside the target's document. Browser retains and verifies those frame identities. A frame navigation invalidates the capture.

Both same-origin and cross-origin frames can be inspected through Browser's Playwright ownership. Detected open shadow roots and unsupported frame transforms remain explicit boundaries. Closed shadow roots cannot be detected. The system cannot establish absence inside content it could not inspect. [ADR-0012](adr/0012-keep-frame-context-separate-from-xpath.md) explains the frame design.

## The trade-offs behind this design

| Decision                                   | Benefit                                                                                    | Cost or limit                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Select candidate IDs, then construct XPath | Browser verification is independent of model-generated locator text.                       | Selection quality depends on the captured evidence and model interpretation.                      |
| Resolve the current view                   | The scope matches what the user can inspect; “all” has an explicit boundary.               | Off-screen and future-state targets require manual navigation and a new request.                  |
| Inspect passively                          | Resolution preserves focus, form and scroll state without performing the requested action. | Observed readiness cannot prove successful execution.                                             |
| Preserve complete scoped input             | Missing candidates cannot silently disappear behind a context filter.                      | Large pages can exceed an explicit resource budget and fail.                                      |
| Keep browser state in one owner            | Nodes, frames, captures and highlights share one lifecycle.                                | Browser sessions consume processes and displays; scaling needs session-aware capacity management. |
| Keep diagnostics separate                  | Failures can be investigated without adding persistence to Resolver.                       | Redacted evidence may be insufficient to reproduce the original page.                             |

Privacy relies on restricted capture fields and additional persistence sanitization. Arbitrary page text can still contain sensitive content; this is not a guarantee that every secret in a website will be recognized. Prompt instructions and schema validation reduce the model's authority, but do not prove resistance to every malicious page instruction.

The local deployment preserves Chromium's sandbox, separate session contexts and origin checks. Browser/debugging ports are not published. It is a local prototype, with no hosted tenant-authentication or production network-access policy. The [runtime security details](runtime.md) document the implemented boundary.

## Where it would fit in the test platform

The proposed integration point is between a test instruction and the platform's existing action executor. the test platform would supply the current page context and instruction; a resolver component would return target identity, frame context, XPath and readiness observations. The executor would own revalidation at execution time, action delivery and assertions about the application's response.

That integration has not been implemented. The current prototype owns its browser instead of attaching to a the test platform session. Adapting browser ownership, authentication and evidence access would require an explicit platform contract. Executing an action would also introduce a new race between resolution and execution, so a stored XPath should never be treated as permanently verified.

The immediate engineering question is measurable: **does the system select the intended elements reliably across realistic page states?** Continue with [the engineering journey](engineering-journey.md) for model choices, experiments and evaluation evidence. The [evaluation reference](evaluation.md) covers running those checks; [release operations](releases.md) explains how tested images are approved and explicitly activated.

## Read the implementation

| Start here                                                                                                                                              | Responsibility                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`useWorkspace.ts`](../src/Web/src/features/workspace/useWorkspace.ts)                                                                                  | Active page, per-tab conversation and request lifecycle.          |
| [`ResolutionService.cs`](../src/Resolver/Services/ResolutionService.cs)                                                                                 | Capture, inference, response validation and browser verification. |
| [`CandidateSelectionStrategy.cs`](../src/Resolver/Services/CandidateSelectionStrategy.cs)                                                               | Compact model input projection.                                   |
| [`ActionSelectionStrategy.cs`](../src/Resolver/Services/ActionSelectionStrategy.cs)                                                                     | Current-view prompt, schema and selection validation.             |
| [`BrowserSessions.cs`](../src/Browser/Sessions/BrowserSessions.cs)                                                                                      | Serialized page operations, identity checks and highlights.       |
| [`BrowserPageCapture.cs`](../src/Browser/Sessions/BrowserPageCapture.cs) / [`BrowserCaptureScript.cs`](../src/Browser/Sessions/BrowserCaptureScript.cs) | Frame traversal, DOM evidence, XPath ranking and passive checks.  |
| [`ResolutionRecorder.cs`](../src/ClientApi/Diagnostics/ResolutionRecorder.cs)                                                                           | Request-owned diagnostic recording.                               |
