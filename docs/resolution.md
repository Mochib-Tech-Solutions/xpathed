# Resolution contracts

The workspace opts into multi-action contract `"2"` from [#18](https://github.com/Mochib-Tech-Solutions/xpathed/issues/18). Direct Resolver and ClientApi callers that omit `contractVersion`, or send `"1"`, retain the single-action API and its selection prompt/schema. Both use [#17](https://github.com/Mochib-Tech-Solutions/xpathed/issues/17)'s accessibility-aware state version `"2"` and interactability version `"1"`. Older results without readiness remain readable as unavailable. [ADR-0008](adr/0008-resolve-multiple-current-page-actions.md) records action cardinality.

The client forwards `POST /api/pages/{pageId}/resolve` to the standalone resolver at `POST /pages/{pageId}/resolve`. The resolver needs the browser service and OpenRouter; it does not use the client application or database.

```json
{ "instruction": "Click all Approval buttons and fill Notes.", "documentId": "current-document-id", "contractVersion": "2" }
```

Get `documentId` from the managed page state. Instructions must be nonblank and at most 4,000 characters. The browser changes document identity on navigation, including same-URL reloads. The page ID continues to identify the same managed page until its session ends.

## Results

JSON field names use camelCase. Version 1 retains these fields; the common identities and request diagnostics also apply to version 2:

| Field                                                       | Meaning                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `contractVersion`                                           | `"1"`                                                                        |
| `outcome`                                                   | `found`, `not_found`, `unsupported`, or `error`                              |
| `sessionId`, `pageId`, `documentId`, `captureId`, `frameId` | Browser-owned identities; fields unavailable before capture are null         |
| `traceId`, `attemptId`, `configurationId`                   | Request correlation, distinct attempt, and non-secret resolver configuration |
| `action`                                                    | Interpreted interaction; null when interpretation is unavailable             |
| `target`                                                    | One verified target for `found`; otherwise null                              |
| `diagnostics`                                               | Coverage, provider evidence, stage timings, and a safe failure code/message  |

`found` means the model selected a candidate and every returned XPath uniquely matches that exact captured node. It does not establish semantic accuracy or action success. Independent fixture labels test semantic accuracy. `not_found` represents absence in the supported inspected scope. `unsupported` represents instructions or target scopes outside this slice. Processing failures, incomplete capture, excess input size and provider failures are `error`.

### Multi-action version 2

Version 2 has ordered `actions`, a nullable `summary`, and nullable `inspectedActionId`. Top-level `action`/`target` are null so a legacy reader cannot mistake one action for the entire instruction. Each action contains `actionId`, `order`, `step`, interpreted `instruction`/`action`, `outcome`, nullable `target`, `frameId`, `diagnosticsReference`, and nullable safe `code`/`message`. The four per-action outcomes remain found/not_found/unsupported/error. Provider and invalid/incomplete-processing failures fail the entire request with `outcome:error`, empty actions and no summary; they do not produce successful-looking partial results.

Action IDs `a1`, `a2`, etc. are assigned by Resolver and are stable within that attempt, not across fresh captures. Instruction steps are consecutive, ordered by the prompt; unordered plural expansion shares one step and is sorted by capture DOM order. Explicitly ordered individual targets use separate steps. Repeating an action on the same node is allowed in distinct instruction steps; duplicate step/action/candidate entries and mixed or ambiguous plural groups are rejected. Every found action targets one retained node; alternative XPaths locate that same node.

The top-level outcome is the common per-action outcome when all agree, otherwise `partial`. This describes resolution, not readiness or executed success. Summary reports `processingComplete`, `semanticCompleteness:"unverified"`, `total`, `found`, `notFound`, `unsupported`, `errors`, `blocked`, `readinessUnknown` and `assessmentUnsupported`. A disabled found action counts as both found and blocked. All passive assessments retain unknown event success; no count claims action-ready or executed success. Capture/model-input completeness, the model's declared complete action list, and independently graded semantic completeness are different evidence. A structurally valid model response can still omit an intended action; independent fixtures grade the expected entire action list, not just returned XPath validity.

A future-dependent step returns unsupported with `current_state_dependency`, even if a similarly named node currently exists. Ambiguity and unsupported interactions have their own reasons. Independent currently available actions remain useful beside missing or unsupported steps. Not-found becomes unsupported scope when uninspected frame/shadow content prevents an absence claim.

One completion owns request-level usage, cost estimates, reported charges and generation identity. Each action's `diagnosticsReference` points to the enclosing `attemptId`; actions contain no copied charges or invented token allocations. Chat displays one request cost/timing breakdown and each target with its XPath. Multiple actions have a compact summary; state details and alternative XPaths are available on demand. Single-action responses omit repeated instructions, website metadata and execution/completeness boilerplate. Its Inspect buttons revalidate and highlight one found action at a time, without executing it; historical results cannot be inspected.

To migrate a caller, send `contractVersion:"2"`, consume `actions`/`summary`, and retain request-level diagnostics once. Missing or `"1"` selects the existing single-action route with 512 output tokens; compound/plural interpretation is not promised there. Version-1 historical results remain readable by the workspace. Other versions and explicit null are invalid requests.

A target contains `candidateId`, `tag`, `label`, ordered `xpaths`, `state`, `geometry` and `interactability`. State version `"2"` retains `rendered`, `inViewport`, `enabled`, `editable` and nullable `checked`, adding `accessibilityExposed` and `readonly`. Geometry is `{x,y,width,height}` in viewport-relative CSS pixels. `rendered` observes a nonzero box, CSS visibility and ancestor opacity; it does not establish that every pixel is visible. `inViewport` observes bounding-box intersection, not obstruction or clipping. Accessibility exposure describes the supported DOM eligibility policy, not membership of every node in a raw platform accessibility tree. Actions cover click, hover, fill/type, select and check/uncheck. Resolution never executes an action, reveals content, scrolls, focuses or waits for readiness.

Locators prefer explicit test attributes, suitable stable attributes and meaningful text/label/ancestor scope before positional paths. Every alternative must match exactly one node identical to the selection. Duplicated attributes do not establish uniqueness, and the resolver does not append a first-match predicate to conceal ambiguity.

## Capture and validation

The browser exposes these internal operations:

- `POST /pages/{pageId}/capture` with `{documentId}` returns a `CandidateCapture`.
- `POST /pages/{pageId}/selection` with `{documentId,captureId,candidateId,action}` validates the capture and selected node, constructs XPath alternatives and highlights the target. A null candidate validates the capture for a semantic absence/unsupported result and clears the highlight.

- `POST /pages/{pageId}/selections` with `{documentId,captureId,actions:[{actionId,candidateId,action}]}` validates all actions in one session-serialized, synchronous capture operation. It returns ordered validated actions and the first found action as `inspectedActionId`. Any invalid/stale entry aborts the batch before a new highlight or usable action mapping is published. The complete batch shares the two-second validation budget.
- `POST /pages/{pageId}/highlight` with `{documentId,captureId,actionId}` revalidates a previously verified found action against that retained node and replaces the sole Chromium overlay. ClientApi forwards `/api/pages/{pageId}/highlight`; no inference is involved. Unknown/non-found action IDs fail explicitly. New capture, navigation, tab switches and session closure invalidate every batch action and highlight.

A capture includes session/page/document/capture/frame identities, its timestamp, candidates, coverage and `unsupportedBoundaryCount`. Candidates contain an opaque capture-scoped ID, tag, role, text, label, placeholder, structural scope, observed state and geometry. Real browser objects and the candidate-to-node mapping remain inside Browser. A new capture replaces the previous capture for that page; session closure or navigation invalidates it. Stable DOM during a request is assumed. Failed identity validation is an error; it does not trigger automatic retries or recovery.

This slice resolves the main document (`frameId: "main"`). Accessibility-exposed iframes and detected open shadow roots are counted separately; their content is not captured. Closed shadow roots cannot be detected by this DOM capture. A lack of a main-document match cannot establish absence inside an uninspected boundary. Expanded frame/state handling remains [#4](https://github.com/Mochib-Tech-Solutions/xpathed/issues/4).

The compact representation preserves Unicode and uses allowlisted fields. Current editable input, textarea and select values, editable content, cookies, storage and URL attributes are excluded. The displayed labels of `input[type=button|submit|reset]` are the narrow exception: they are captured as button labels, while checkbox/radio values remain excluded. Candidate `checked` state is null; only the selected target reports its actual checked state. Labels, safe text and ancestor headings describe controls without forwarding raw accessibility snapshots. Safe hidden label references may name exposed controls, while those referenced hidden nodes remain excluded as targets. This intentionally omits embedded control values from accessible names. The model receives page text as untrusted data, has no tools and returns only a selection. Browser constructs XPath from the live DOM. Highlighting uses Chromium's display overlay, outside the DOM, so it cannot become a candidate or change target semantics.

## Eligibility and action observations

The policy follows [WAI-ARIA tree inclusion/exclusion](https://www.w3.org/TR/wai-aria-1.2/#tree_exclusion), [accessible-name hidden references](https://www.w3.org/TR/accname-1.2/#computation-steps) and [HTML hidden/inert semantics](https://html.spec.whatwg.org/multipage/interaction.html), with deterministic Chromium checks. It is a sanitized DOM policy for this main-document slice, not a complete accessibility compliance implementation.

| Page condition | Candidate policy and observations |
| --- | --- |
| `display:none`, hidden input, `content-visibility:hidden`, unrevealed `hidden=until-found`, closed disclosure content | Excluded, including affected descendants; no reveal is performed |
| `visibility:hidden/collapse` | Excluded according to each element's computed visibility; explicitly visible descendants may remain eligible |
| `hidden` attribute | Excluded by browser CSS unless the page overrides the hidden display style |
| Explicit or modal background inertness | Excluded; a top-layer modal dialog escapes an ancestor's inertness, as in Chromium |
| `aria-hidden=true` ancestor | Excluded even if a child sets false; a currently focused subtree retains Chromium's focus exposure exception |
| Off-screen, clipped/screen-reader-only, opacity-zero, covered, zero-area, disabled, readonly | Eligible; visual, viewport and requested-action limits are observed separately |
| Hidden label/name references | Used only for safe name text; `aria-labelledby` precedes `aria-label`, then native labels and supported name-from-content/attribute fallbacks |

Modal exposure uses Chromium's focused modal or top-layer backdrop hit, rather than DOM order. If several open modals cannot be distinguished without interaction, capture is incomplete with `capture_exposure_unknown`; it cannot substantiate absence.

`interactability` has `{version:"1", action, status, reasons, checks}`. Every check is `pass`, `fail`, `unknown` or `not_applicable`. Status is `blocked` if an applicable observation fails, `unsupported` if custom-control behavior cannot be assessed with this slice, otherwise `unknown`. A found target remains found in all three cases and retains verified XPath alternatives. No status promises successful events or business outcomes.

| Requested action | Applicable observations | Explicit limits |
| --- | --- | --- |
| Click | Enabled, viewport, pointer reception | Any eligible element can be selected; a DOM hit does not establish a click handler or business effect |
| Hover | Viewport, pointer reception | Enabled is not applicable; disabled hover differs from disabled click |
| Fill/type | Compatible text input/textarea/contenteditable, enabled, writable | Pointer/viewport checks are not applicable to keyboard-oriented assessment; keyboard readiness remains unknown |
| Select | Compatible native select, enabled | Custom combobox/listbox assessment is unsupported; opening and selecting are untested |
| Check/uncheck | Compatible native checkbox/radio, enabled, viewport, pointer reception | Radio uncheck is incompatible; custom checkbox/radio/switch behavior is unsupported |

Checks are `compatibleControl`, `enabled`, `writable`, `viewport`, `pointerReception`, `keyboard`, `stability` and `eventOutcome`. Pointer reception samples the center of the target's viewport-intersected bounding box using `elementFromPoint`, accepting that node or a descendant. Failure describes that sampled point; other points, label proxies, clipping shapes and browser event delivery are not exhaustively tested. Zero-area and off-screen targets cannot establish a pointer hit without moving the page. A transparent element can pass pointer reception while `rendered` is false. For fill/type and select, off-screen/visual conditions remain reported limitations without claiming keyboard failure. Stability and event outcome always remain unknown because resolution performs no wait or event. Reasons include disabled, readonly, incompatible control, custom control unverified, off-screen, zero-area, not visually rendered, pointer-events none and obstruction/clipping at the hit point.

This per-action extension is shared by both result contracts. Resolution outcomes and request-owned usage/cost remain separate from interactability. Legacy version-1 results without the extension remain readable; readiness is unavailable. Browser and Resolver validate version-2 state and the matching action before returning a found result.

## Diagnostics and budgets

`diagnostics.capture` records `scannedCount`, `eligibleCount`, `capturedCount`, `complete`, and nullable `errorCode`. `modelInputCount`, `modelInputComplete` and `modelInputBytes` describe the full prepared model input separately; `modelCalls` records attempted provider requests. A complete representation rejected by the byte budget still reports its prepared count and complete coverage, with zero model calls. Incomplete capture fails before model input is prepared. A partial scan reports observed counts with `complete: false`; these are not invented page totals.

The operating configuration limits capture to 20,000 visited elements, 2,000 eligible candidates, 512,000 UTF-8 bytes of candidate records and two seconds of DOM processing. Text and visibility results are cached during each capture. No field is silently clipped: an exceeded limit returns `capture_budget_exceeded`, observed counts, `complete: false` and an empty candidate array. Model input has a separate 512,000-byte budget measured as UTF-8 bytes of the serialized `{instruction,frameId,candidates}` user message. The fixed system prompt and output schema are separate bounded source text. Session, page, document and capture identities, timestamps and coverage stay local. These are application resource limits, not model context-window claims or performance qualifications. No candidate subset may silently substantiate a page-wide absence result.

Version-2 decomposition is bounded to 16 actions, 300 characters per interpreted instruction, 16,000 UTF-8 bytes of model output and 4,096 output tokens. A model `complete:false`, empty complete list, exceeded action/output budget or length-truncated completion is an operational error; nothing is silently dropped to produce partial success. Semantic omissions cannot be established from schema validity alone and remain independently graded.

Diagnostics also include `stage`, safe `code`/`message`, `modelCalls`, `strategy`, `promptVersion`, model/provider/generation identifiers, finish reason, usage, and stage timings in milliseconds. Usage includes input/output/total/reasoning/cached tokens and cost when reported. Missing usage is null, never an invented zero. Logs contain correlation and failure codes rather than raw page context, instructions, credentials or provider response bodies. Persistence belongs to [#5](https://github.com/Mochib-Tech-Solutions/xpathed/issues/5).

## Cost estimates

`diagnostics.costEstimate` is an additive nullable version 1 field. After a completion reports model/provider identity and input/output token counts, Resolver fetches that model’s [OpenRouter endpoint rates](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model). The lookup has a two-second timeout and never makes another inference call. Missing, invalid or ambiguous rates, time-based pricing overrides and lookup failures leave the estimate unavailable without discarding the resolution or reported usage. Caller cancellation still propagates.

The structured estimate contains `currency: "USD"`, `inputPricePerMillion`, `outputPricePerMillion`, `inputCost`, `outputCost`, `requestCost`, `totalCost` and `pricingFetchedAt`. Input/output subtotals multiply reported native token counts by the matching provider’s listed per-token rates; the total adds any listed per-request fee. Reasoning tokens are already included in output tokens and are not charged twice. These are rates fetched after the call, not a locked quote or billing guarantee. The estimate uses normal input rates before cache discounts; special cache pricing, discounts and billing adjustments can make it differ from the reported charge. `diagnostics.usage.cost` remains the independently reported OpenRouter charge. Missing estimates/usage are null, never an invented zero.

Chat exposes these fields on cost hover or keyboard focus, with Escape dismissal. It includes model/provider and token counts, labels estimates separately from reported cost, and retains each attempt’s original cost data in its tab history.

## Model configuration

`OpenRouterGateway` handles transport/provider responses; `CandidateSelectionStrategy` preserves the legacy selection contract; `ActionSelectionStrategy` defines the version-2 action-list prompt/schema and validates the whole response before Browser validation. This keeps model configuration distinct from resolution strategy without adding unused gateway adapters.

The initial route is `deepseek/deepseek-v4.1-flash` via OpenRouter's `wafer` provider with reasoning disabled, strict JSON schema, 512 output tokens for version 1 or 4,096 for version 2, and no fallback, context compression, response healing or tools. Runtime requests do not include a provider price filter. The public route research and settings are in [the OpenRouter note](research/2026-09-29-openrouter-resolution.md). The live smoke pins this cheap route, makes at most two small requests (a plural/mixed current-page result and a legacy absence check), and stops if reported cost is missing or exceeds half a cent per call; total cost must remain below one cent. The dated research note records the authenticated two-case smoke check and its actual usage; this does not qualify other workloads or models.

| Setting                      | Purpose                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`         | Ignored local `.env`; mapped to resolver `OpenRouter__ApiKey`                                                |
| `OPENROUTER_MODEL`           | Default `deepseek/deepseek-v4.1-flash`; a different model requires supported settings and fresh verification |
| `OPENROUTER_PROVIDER`        | Default `wafer`; explicit serving route                                                                      |
| `OpenRouter__BaseUrl`        | Default OpenRouter API; overridden only by the deterministic local test stack                                |
| `OpenRouter__TimeoutSeconds` | Provider call timeout, default 30 seconds; greater than zero and at most 600                                 |
| `Resolution__Strategy`       | Default and sole implemented strategy `candidate-selection-v1`; other values fail explicitly                 |

`configurationId` hashes the normalized endpoint, model, provider, timeout, strategy, prompt/schema, versions and fixed budgets/settings, including result mode, maximum actions and output tokens. Prompt version 3 identifies version 2; legacy uses prompt version 2. Capture/state remain version 2. API keys, user instructions and page content are excluded, so local test routes and live routes have distinct identities.

The browser still applies origin checks, session isolation, serialized operations and the Chromium sandbox. Cancellation propagates through the resolver and browser. Invalid HTTP bodies use the existing `400 invalid_request` envelope. Capture and selection require the session’s active page. Switching tabs invalidates captures and highlights, even when switching back to the same document; an inactive request returns the operational code `inactive_page`. The UI associates each attempt with its originating tab and page document, retains older attempts as labelled history, and never presents a late result as the selected tab’s current highlight. Session polling discovers manual navigation and popup tabs. **Reset chat** clears only the active tab’s draft and results. Closing a tab clears its local chat, and **Close all tabs** ends the session and clears every tab and result.
