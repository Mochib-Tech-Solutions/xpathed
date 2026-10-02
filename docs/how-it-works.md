# How xpathed resolves an instruction

“Hover over OK under Employee” requires more than matching text. Several OK buttons may exist, and the intended one may be covered or disabled. xpathed separates language interpretation, locator verification and readiness so each result explains what was established.

## Service ownership

![Service ownership and request paths](diagrams/system-design.svg)

Web owns chat, tabs and the noVNC viewer. ClientApi accepts requests and stores diagnostics. Resolver coordinates capture, model selection and verification. Browser owns Playwright, Chromium and live page state. PostgreSQL retains diagnostic records. `Common` defines the records exchanged between services.

Each managed session owns a Chromium process, browser context and display. Operations are serialized within the session. Viewer and resolver share the active page ID; navigation changes its document ID, and a capture identifies one temporary element inventory. Tab switches invalidate captures.

## Follow one command

![Capture, selection, browser verification and response](diagrams/resolution-flow.svg)

### 1. Capture the current view

Web sends the instruction, active `pageId`, `documentId` and contract version to ClientApi. After opening a diagnostic attempt, ClientApi calls Resolver, which requests a Browser capture.

Browser retains live nodes locally and assigns temporary candidate IDs. The model-visible descriptions contain sanitized names, roles, section/row context, state, geometry, supported CSS colors and frame context. In our example, the Employee heading distinguishes its OK button from other OK buttons.

Hidden and accessibility-excluded elements are omitted. Partially visible, disabled and covered controls remain candidates. Fully off-screen targets are outside the current view. Budgets bound documents, visited elements, candidates, bytes and time; exceeding one fails capture rather than claiming absence from a partial inventory.

Passwords, editable values, cookies, storage and URL attributes are excluded. Native button captions are a narrow value-attribute exception. Images are identified by accessible names, not pixels. Arbitrary page text can still contain sensitive content.

### 2. Select targets with one model call

Resolver sends the instruction and every scoped candidate to OpenRouter. The model returns strict JSON: one shared interaction, distinct candidate IDs and per-target outcomes. It receives page text as untrusted data and has no browser tools.

The development default is DeepSeek V4.1 Flash through Wafer. `ActionSelectionStrategy` owns prompt/schema validation; `OpenRouterGateway` owns transport, pinned provider settings and accounting. No model is trained or fine-tuned locally.

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

Browser highlights found targets. Web shows the shared action, then each target's identity, XPath, verification, limitations and cost. Highlights persist during mouse movement and scrolling; input or invalidation clears them. Chat results stay in each tab's client memory.

Estimated and provider-reported cost remain separate; missing accounting is unknown. Cancelled requests may still incur charges. Two seconds is a latency measurement, not a total-response cutoff.

## Storage and failure investigation

ClientApi's `ResolutionRecorder` starts a pending record, calls Resolver and completes the same attempt. A retry has a new ID. `DiagnosticStore` and EF Core's `AppDbContext` own persistence; Resolver does not depend on the database.

The sole application table, `diagnostic_records`, stores scalar identity, outcome and retention fields alongside `ResultJson`, `EvidenceJson` and `ProvenanceJson`. Page/time and expiration indexes support lookup and cleanup. Page IDs are diagnostic references, not restorable browser sessions.

Each database write has a two-second allowance. Storage failure is logged separately without replacing the resolution outcome. Ordinary records expire after 90 days and evidence after 30 by default; retained artifacts have explicit exceptions.

Investigate by attempt/trace ID, configuration, stage and reason code. Determine whether the failure occurred during capture, provider transport, response validation or browser verification. Semantic mistakes require an independently known intended target. Expired or withheld evidence limits the conclusion. The [diagnostics guide](diagnostics.md) includes the schema, commands and a worked example.

## Extending and integrating

| Change                      | Implementation boundary                                        |
| --------------------------- | -------------------------------------------------------------- |
| Model or route              | `OPENROUTER_MODEL`, `OPENROUTER_PROVIDER`, `OpenRouterGateway` |
| Prompt or interpretation    | `ActionSelectionStrategy`                                      |
| Model-visible context       | `CandidateSelectionStrategy.PrepareInput`                      |
| Capture, XPath or readiness | `BrowserPageCapture`, `BrowserCaptureScript`                   |
| Diagnostic persistence      | `ResolutionRecorder`, `DiagnosticStore`, `AppDbContext`        |

These are source boundaries. `candidate-selection-v1` is the only runtime strategy; the optional context planner is evaluation-only. Changes require corresponding target, contract, privacy and browser checks.

A caller can resolve against an xpathed-owned page with `POST /api/pages/{pageId}/resolve`, supplying `instruction`, `documentId` and `contractVersion: "4"`. An external runner's browser needs a new adapter or an ownership change; raw HTML cannot attach it to today's API.

The consuming runner would own action-time revalidation, execution and postconditions. Browser ownership, cancellation, authentication and evidence retention need an explicit agreement. No action executor or external-runner adapter is implemented.

## Deployment limits

The local deployment preserves Chromium's sandbox, separate session contexts and origin checks. Hosted authentication and a production network-access policy are additional work.

Resolver is stateless between requests; Browser owns processes, displays and handles. Scaling needs authenticated routing to the owning worker, capacity limits and failed-worker cleanup. Measure session memory, CPU, queue time, provider limits and complete-response latency before sizing; this project has no production-throughput benchmark.

Use the [runtime reference](runtime.md) and [resolution contract](resolution.md) for exact fields, budgets and lifecycle rules.
