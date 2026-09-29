# Resolution contract, version 1

The client forwards `POST /api/pages/{pageId}/resolve` to the standalone resolver at `POST /pages/{pageId}/resolve`. The resolver needs the browser service and OpenRouter; it does not use the client application or database.

```json
{"instruction":"Click on About us.","documentId":"current-document-id"}
```

Get `documentId` from the managed page state. Instructions must be nonblank and at most 4,000 characters. The browser changes document identity on navigation, including same-URL reloads. The page ID continues to identify the same managed page until its session ends.

## Results

JSON field names use camelCase. The result has these fields:

| Field | Meaning |
| --- | --- |
| `contractVersion` | `"1"` |
| `outcome` | `found`, `not_found`, `unsupported`, or `error` |
| `sessionId`, `pageId`, `documentId`, `captureId`, `frameId` | Browser-owned identities; fields unavailable before capture are null |
| `traceId`, `attemptId`, `configurationId` | Request correlation, distinct attempt, and non-secret resolver configuration |
| `action` | Interpreted interaction; null when interpretation is unavailable |
| `target` | One verified target for `found`; otherwise null |
| `diagnostics` | Coverage, provider evidence, stage timings, and a safe failure code/message |

`found` means the model selected a candidate and every returned XPath uniquely matches that exact captured node. It does not establish semantic accuracy or action success. Independent fixture labels test semantic accuracy. `not_found` represents absence in the supported inspected scope. `unsupported` represents instructions or target scopes outside this slice. Processing failures, incomplete capture, excess input size and provider failures are `error`.

A target contains `candidateId`, `tag`, `label`, ordered `xpaths`, `state`, and `geometry`. State reports `rendered`, `inViewport`, `enabled`, `editable`, and nullable `checked`. Geometry is `{x,y,width,height}` in viewport-relative CSS pixels. Disabled and off-screen nodes remain eligible; application-hidden nodes are excluded. Actions cover click, hover, fill/type, select and check/uncheck on ordinary current-DOM controls. Resolution never executes the action or scrolls to the element.

Locators prefer explicit test attributes, suitable stable attributes and meaningful text/label/ancestor scope before positional paths. Every alternative must match exactly one node identical to the selection. Duplicated attributes do not establish uniqueness, and the resolver does not append a first-match predicate to conceal ambiguity.

## Capture and validation

The browser exposes two internal operations:

- `POST /pages/{pageId}/capture` with `{documentId}` returns a `CandidateCapture`.
- `POST /pages/{pageId}/selection` with `{documentId,captureId,candidateId,action}` validates the capture and selected node, constructs XPath alternatives and highlights the target. A null candidate validates the capture for a semantic absence/unsupported result and clears the highlight.

A capture includes session/page/document/capture/frame identities, its timestamp, candidates, coverage and `unsupportedBoundaryCount`. Candidates contain an opaque capture-scoped ID, tag, role, text, label, placeholder, structural scope, observed state and geometry. Real browser objects and the candidate-to-node mapping remain inside Browser. A new capture replaces the previous capture for that page; reset or navigation invalidates it. Stable DOM during a request is assumed. Failed identity validation is an error; it does not trigger automatic retries or recovery.

This slice resolves the main document (`frameId: "main"`). Visible iframes and detected open shadow roots are counted separately; their content is not captured. Closed shadow roots cannot be detected by this DOM capture. A lack of a main-document match cannot establish absence inside an uninspected boundary. Expanded frame/state handling remains [#4](https://github.com/Mochib-Tech-Solutions/xpathed/issues/4).

The compact representation preserves Unicode and uses allowlisted fields. Current editable input, textarea and select values, editable content, cookies, storage and URL attributes are excluded. The displayed labels of `input[type=button|submit|reset]` are the narrow exception: they are captured as button labels, while checkbox/radio values remain excluded. Candidate `checked` state is null; only the selected target reports its actual checked state. Labels, safe text and ancestor headings describe controls without forwarding raw accessibility snapshots. Hidden, inert, `aria-hidden`, zero-size, CSS-invisible and opacity-zero elements are excluded; off-screen and disabled elements remain eligible. The model receives page text as untrusted data, has no tools and returns only a selection. Browser constructs the XPath from the live DOM. Highlighting uses Chromium's display overlay, outside the DOM, so it cannot become a candidate or change target semantics.

## Diagnostics and budgets

`diagnostics.capture` records `scannedCount`, `eligibleCount`, `capturedCount`, `complete`, and nullable `errorCode`. `modelInputCount`, `modelInputComplete` and `modelInputBytes` describe the full prepared model input separately; `modelCalls` records attempted provider requests. A complete representation rejected by the byte budget still reports its prepared count and complete coverage, with zero model calls. Incomplete capture fails before model input is prepared. A partial scan reports observed counts with `complete: false`; these are not invented page totals.

The first operating configuration limits capture to 20,000 visited elements, 2,000 eligible candidates, 64,000 UTF-8 bytes of candidate records and two seconds of DOM processing. Text and visibility results are cached during each capture. No field is silently clipped: an exceeded limit returns `capture_budget_exceeded`, observed counts, `complete: false` and an empty candidate array. Model input has a separate 64,000-byte budget measured as UTF-8 bytes of the serialized `{instruction,frameId,candidates}` user message. The fixed system prompt and output schema are separate bounded source text. Session, page, document and capture identities, timestamps and coverage stay local. These are application resource limits, not model context-window claims or performance qualifications. No candidate subset may silently substantiate a page-wide absence result.

Diagnostics also include `stage`, safe `code`/`message`, `modelCalls`, `strategy`, `promptVersion`, model/provider/generation identifiers, finish reason, usage, and stage timings in milliseconds. Usage includes input/output/total/reasoning/cached tokens and cost when reported. Missing usage is null, never an invented zero. Logs contain correlation and failure codes rather than raw page context, instructions, credentials or provider response bodies. Persistence belongs to [#5](https://github.com/Mochib-Tech-Solutions/xpathed/issues/5).

## Model configuration

`OpenRouterGateway` handles transport/provider responses; `CandidateSelectionStrategy` defines the prompt, selection contract and validation. This keeps model configuration distinct from resolution strategy without adding unused gateway adapters.

The initial route is `openai/gpt-6-luna` via OpenRouter's `openai` provider with reasoning `none`, strict JSON schema, standard service tier, 512 output tokens and no fallback, context compression, response healing or tools. The public route research and settings are in [the OpenRouter note](research/2026-09-29-openrouter-resolution.md). Advertised capability does not establish authenticated access; live smoke evidence must come from an explicitly invoked run.

| Setting | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Ignored local `.env`; mapped to resolver `OpenRouter__ApiKey` |
| `OPENROUTER_MODEL` | Default `openai/gpt-6-luna`; a different model requires supported settings and fresh verification |
| `OPENROUTER_PROVIDER` | Default `openai`; explicit serving route |
| `OpenRouter__BaseUrl` | Default OpenRouter API; overridden only by the deterministic local test stack |
| `OpenRouter__TimeoutSeconds` | Provider call timeout, default 30 seconds; greater than zero and at most 600 |
| `Resolution__Strategy` | Default and sole implemented strategy `candidate-selection-v1`; other values fail explicitly |

`configurationId` hashes the normalized endpoint, model, provider, timeout, strategy, prompt/schema, versions and fixed budgets/settings. API keys, user instructions and page content are excluded, so local test routes and live routes have distinct identities.

The browser still applies origin checks, session isolation, serialized operations and the Chromium sandbox. Cancellation propagates through the resolver and browser. Invalid HTTP bodies use the existing `400 invalid_request` envelope. The UI checks current page/document identity before showing a result, clears results on navigation/reset, and continues to detect manual navigation through page polling.
