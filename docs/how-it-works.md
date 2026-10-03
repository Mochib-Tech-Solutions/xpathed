# How xpathed resolves an instruction

“Hover over OK under Employee” requires more than matching text. Several OK buttons may exist, and the intended one may be covered or disabled. xpathed separates language interpretation, locator verification and readiness so each result explains what was established.

## Service ownership

[![Service ownership and request paths](diagrams/system-design.svg)](diagrams/system-design.svg)

Resolver is the core system: it accepts instructions through its API and coordinates capture, model selection and verification. Browser supplies live page operations through HTTP; the bundled implementation owns Playwright and Chromium. `Common` defines the records exchanged at this boundary. Web and ClientApi form the manual test client. Chat history lives in the workspace session.

Each managed session owns a Chromium process, browser context and display. Operations are serialized within the session. Viewer and resolver share the active page ID; navigation changes its document ID, and a capture identifies one temporary element inventory. Tab switches invalidate captures.

## The two internal stages

[![Model target selection followed by browser XPath construction and verification](diagrams/resolver-internals.svg)](diagrams/resolver-internals.html)

The model receives candidates and chooses IDs. Browser code turns selected IDs into XPath expressions and verifies those expressions against retained nodes. Resolver coordinates both stages, validates their contracts and returns the combined result. Model-selection evaluation checks the first stage, XPath evaluation isolates the second, and Resolver E2E exercises both together.

## Follow one command

[![Capture, selection, browser verification and response](diagrams/resolution-flow.svg)](diagrams/resolution-flow.svg)

The diagram follows a request from the bundled test client. Resolver's API is also the entry point for other callers and evaluation runners.

### 1. Capture the current view

A caller sends the instruction, active `pageId`, `documentId` and contract version to Resolver. Resolver requests a Browser capture. In the manual test client, Web forwards through ClientApi; evaluation runners call Resolver directly.

Browser retains live nodes locally and assigns temporary candidate IDs. The model-visible descriptions contain sanitized names, roles, section/row context, state, geometry, supported CSS colors and frame context. In our example, the Employee heading distinguishes its OK button from other OK buttons.

Hidden and accessibility-excluded elements are omitted. Partially visible, disabled and covered controls remain candidates. Fully off-screen targets are outside the current view. Budgets bound documents, visited elements, candidates, bytes and time; exceeding one fails capture rather than claiming absence from a partial inventory.

Passwords, editable values, cookies, storage and URL attributes are excluded. Native button captions are a narrow value-attribute exception. Images are identified by accessible names, not pixels. Arbitrary page text can still contain sensitive content.

### 2. Select targets with one model call

Resolver sends the instruction and every scoped candidate to OpenRouter. The model returns strict JSON: one shared interaction, distinct candidate IDs and per-target outcomes. It receives page text as untrusted data and has no browser tools.

The default is DeepSeek V4.1 Flash through Wafer. `ActionSelectionStrategy` defines the prompt, schema and selection checks; `OpenRouterGateway` owns transport, provider settings and accounting. No model is trained locally.

Resolver checks IDs, action consistency, duplicates and completeness. Ambiguity, scoped absence, unsupported instructions and malformed output remain distinct. Valid JSON cannot establish whether the selected button was intended; independent evaluation supplies that check.

### 3. Build and verify XPath

Browser retrieves each retained target and tries explicit test attributes, meaningful section/row scope, labels and semantic attributes, then ordinary anchors and structural fallback.

For suitable markup, the Employee button might resolve to:

```xpath
//section[h2[normalize-space(.)='Employee']]//button[normalize-space(.)='OK']
```

Every expression must match exactly one node in the target's whole document, identical to the retained node. The model can still choose the wrong button and receive a valid XPath for it.

An XPath cannot cross iframe boundaries. Results therefore carry an ordered frame chain plus the XPath inside the target document. Browser checks those frame identities, including cross-origin frames it owns through Playwright. Shadow-root XPath targets and unsupported frame transforms remain limitations.

### 4. Recheck state and return

Before returning, Browser rechecks document/frame identities and current-view membership. Changed scroll position, viewport or candidate membership can invalidate the capture. Absence is revalidated too.

Readiness checks depend on the interaction. Hover includes viewport membership and pointer reception at a sampled point; nested frames require that point to reach the target through each containing document. A covered target can be found with a valid XPath and blocked readiness. These observations do not dispatch events or establish a business outcome.

Browser highlights found targets and Resolver returns the shared action, target identities, XPath, verification, limitations and cost to its caller. The test client renders these results in chat; evaluation runners grade and save them. Highlights persist during mouse movement and scrolling; input or invalidation clears them. Chat results stay in each tab's client memory.

Estimated and provider-reported cost remain separate; missing accounting is unknown. Cancelled requests may still incur charges. Two seconds is a latency measurement, not a total-response cutoff.

## Extending and integrating

| Change                      | Implementation boundary                                        |
| --------------------------- | -------------------------------------------------------------- |
| Browser implementation      | `BrowserUrl` and the capture/verification HTTP contract        |
| Model or route              | `OPENROUTER_MODEL`, `OPENROUTER_PROVIDER`, `OpenRouterGateway` |
| Prompt or interpretation    | `ActionSelectionStrategy`                                      |
| Model-visible context       | `CandidateInput`                                               |
| Capture, XPath or readiness | `BrowserPageCapture`, `BrowserCaptureScript`                   |

The selected Resolver has one prompt/schema and implementation, updated in place. Browser replacement uses the service contract, independently of model selection. Changes require corresponding target, contract, privacy and browser checks.

A caller uses `POST /pages/{pageId}/resolve`, supplying `instruction`, `documentId` and `contractVersion: "4"` for a page owned by the configured browser service. The test client exposes its forwarding route at `POST /api/pages/{pageId}/resolve`. See [browser integration](runtime.md#browser-integration) for the contract and configuration required to replace the bundled browser. Only Playwright/Chromium is currently verified.

The consuming runner would own revalidation immediately before execution and checks of the resulting state. The integration must define browser ownership, cancellation, authentication and evidence retention. No action executor or external-runner adapter is implemented.

## Deployment limits

The local deployment preserves Chromium's sandbox, separate session contexts and origin checks. Hosted authentication and a production network-access policy are additional work.

Resolver is stateless between requests; Browser owns processes, displays and handles. Scaling needs authenticated routing to the owning worker, capacity limits and failed-worker cleanup. Measure session memory, CPU, queue time, provider limits and complete-response latency before sizing; this project has no production-throughput benchmark.

Use the [runtime reference](runtime.md) and [resolution contract](resolution.md) for exact fields, budgets and lifecycle rules.
