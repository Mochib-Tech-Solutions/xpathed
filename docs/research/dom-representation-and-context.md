# DOM representation and context limits

Primary sources checked on 2026-09-29. This note proposes an approach for specification issue #1; it does not record an implemented or benchmarked system.

## Recommendation

Start with one model call over a compact, sanitized description of the current page, backed by a browser-owned map from candidate IDs to actual DOM elements. Preserve the context that distinguishes targets: accessible names, labels, headings, sections, rows, nearby text, frame identity and viewport position. Construct and validate the XPath after selection, as already agreed.

Use native Playwright semantic snapshots where they help, with a small DOM adapter for the project's eligibility, privacy and identity requirements. Do not assume an accessibility snapshot contains every eligible target or that it can be forwarded unchanged. Do not add a trained retriever, embeddings service or separate summarizing model before measuring a real need.

Large context support makes overflow less likely; it does not establish that arbitrarily large pages fit or that processing them is fast. The initial benchmark should determine a tested input budget for each exact model configuration. An explicit resource-limit error remains necessary when the system cannot inspect the eligible content within its configured limits. That is different from `not_found`.

## What Playwright already provides

The .NET locator API documents `AriaSnapshotAsync` since 1.49, `Mode = AriaSnapshotMode.Ai` and `Depth` since 1.59, and `Boxes` since 1.60. AI mode includes element references and descendant iframe snapshots; it does not wait for the locator to appear. Boxes use viewport-relative CSS pixels. A depth limit intentionally omits deeper content, so it cannot be a silent completeness mechanism. [Locator API](https://playwright.dev/dotnet/docs/api/class-locator#locator-aria-snapshot)

The page-level `Page.AriaSnapshotAsync` is documented since 1.59 and exposes the same AI mode. This is useful native functionality to test before building an equivalent semantic-tree serializer. Neither this API description nor the locator documentation promises complete coverage of arbitrary DOM targets. [Page API](https://playwright.dev/dotnet/docs/api/class-page#page-aria-snapshot)

Inspection of the **pinned Playwright 1.62.0 source**, rather than an assumption about ARIA, finds:

- AI mode uses an ARIA-or-rendered visibility rule, includes generic roles, then distills the tree.
- Reference assignment depends on visibility and receiving pointer events. A missing reference is therefore not proof that a DOM target does not exist.
- It traverses open shadow roots, which this project's XPath contract excludes.
- It serializes input and textarea values; the value branch excludes checkbox, radio and file types, but does not explicitly exclude password type. Treat raw snapshots as potentially sensitive.
- It keeps a map between references and elements internally. This is implementation evidence, not a promise that those internal structures are a public .NET API.

These are reasons to normalize and sanitize the representation and test coverage. Do not copy Playwright internals into the project. [Pinned snapshot source](https://github.com/microsoft/playwright/blob/v1.62.0/packages/injected/src/ariaSnapshot.ts)

Playwright's pinned box computation checks rendering and dimensions without requiring viewport intersection. Off-screen status must stay separate from hidden status. Its visibility rules also need comparison with the project's definition of hidden; a library's default is not automatically that product policy. [Pinned visibility source](https://github.com/microsoft/playwright/blob/v1.62.0/packages/injected/src/domUtils.ts)

MCP documents refs as snapshot-scoped, with frame-prefixed refs and stale-ref errors. That supports the temporary-ID pattern, but MCP's tool contract should not be mistaken for a guaranteed public .NET method for resolving a ref. Verify the selected .NET package's mapping path in a small integration check before committing to native refs. Otherwise use application-owned candidate IDs backed by captured element handles. [MCP snapshots](https://playwright.dev/mcp/snapshots)

## What Stagehand and research establish

Browserbase describes Stagehand's DOM/accessibility representation and gives one example reducing its own landing page from roughly 27,000 HTML tokens to 6,000 representation tokens. This is an illustrative vendor example, not an expected compression ratio or latency result for our dataset. [Browserbase explanation](https://www.browserbase.com/blog/what-is-computer-use)

Stagehand v3 `observe()` returns suggested actions without executing them and supports iframe/shadow traversal. Its broader locator support needs normalization to our frame-plus-standard-XPath contract. The current repository changelog lists **v4.0.1** and describes a v4 protocol rebuild. Existing v3 research remains version-specific: select and pin the comparison release explicitly before implementation. [v3 observe](https://docs.stagehand.dev/v3/references/observe), [current changelog](https://github.com/browserbase/stagehand/blob/main/CHANGELOG.md)

Mind2Web's MindAct baseline first ranks elements with a small model, then asks an LLM to select from candidates. Its reported top-50 candidate recall is 88.9%, 85.3% and 85.7% across its three test settings. This supports candidate selection as a useful design, while demonstrating that pruning can discard the correct answer before the final model sees it. Those numbers are historical dataset results, not forecasts for this project or current models. [Mind2Web paper, section 4](https://arxiv.org/html/2306.06070v2)

## Proposed capture and resolution flow

1. **Capture the current managed page.** Keep the page ID, capture ID and frame ID with every candidate. Read the current DOM; do not navigate, scroll or reveal controls. The agreed stable-page assumption applies during this request.
2. **Build the eligible inventory.** Exclude application-hidden elements under an explicit tested visibility policy and exclude shadow-root targets. Keep off-screen DOM elements. Keep disabled elements so target selection and action state remain separate. Do not limit the inventory to native buttons and inputs: hovering or inspecting text, cards and custom controls is in scope.
3. **Describe candidates compactly.** Keep names, relevant text, type/role, label relationships and meaningful ancestor context. Collapse meaningless wrappers. Keep repeated labels when their surrounding scope differs. Preserve enough row/header and spatial context for instructions such as “the dropdown next to Country” or “OK under Employee.” Use viewport information as a preference only after explicit instruction context.
4. **Sanitize before provider calls or capture logging.** Send allowlisted fields. Remove passwords, unrelated current form values, embedded scripts/styles, cookie/storage data and URL secrets. A snapshot returned by a library is still subject to this policy. Do not temporarily clear fields on the live page to sanitize them.
5. **Fit and send the representation.** Prefer all eligible candidates in a single call when they fit the tested budget. Return only the action interpretation and one candidate ID or no match; lengthy model explanations are unnecessary for execution. Validate response shape and candidate membership.
6. **Resolve the selected node.** Read its current DOM attributes, construct alternative XPath expressions and verify that every returned expression matches exactly that node in its frame. Then inspect action-specific state and calculate the highlight box. Semantic target correctness remains a separate evaluation question.

The candidate map is local execution state, not a field the model can create or a browser handle persisted in PostgreSQL. Raw full HTML can be a sanitized comparison baseline in controlled fixtures; it does not need to be the production default.

## Handling large pages honestly

Use a model-specific budget:

`available page tokens = accepted context limit − instructions/schema − reserved output/reasoning − safety margin`

Use the provider's tokenizer or token-count facility when available; otherwise calibrate a conservative estimate against returned usage. Include all protocol overhead. Keep the provider limit distinct from a lower operating budget chosen to meet latency targets. No fixed number is justified until actual configurations are tested.

Initial policy: remove irrelevant representation overhead first, without discarding candidates or necessary scope. If the full eligible representation still exceeds the operating budget, record an explicit coverage/resource-limit result. Never silently truncate the last part of the DOM and interpret a model no-match as page-wide `not_found`.

If real measurements show frequent overflow, the next extension is deterministic grouping by frame and meaningful page section. Read all groups through bounded calls, preserve a shared scope summary, then choose among returned candidates. This trades calls and latency for coverage; it still requires evaluation for relational instructions spanning groups. A top-k retriever is another experiment, not an automatic improvement. Its candidate recall must be measured independently, and omitted candidates must be recorded. Partial coverage cannot substantiate an exhaustive absence claim.

## Qualification checks

The following checks should run against the exact browser package, DOM adapter, prompt, model/provider settings and token budget being qualified:

| Check | Evidence |
| --- | --- |
| Candidate coverage | Expected eligible target is present in the captured inventory and model input; report both rates separately. |
| Representation identity | Each candidate resolves to its original DOM element and correct frame; fabricated IDs fail validation. |
| Scope preservation | Duplicate labels across sections, repeated table rows, label/control associations, distant headings and relational descriptions remain distinguishable. |
| State policy | Off-screen stays eligible; hidden is excluded; disabled stays resolvable; pointer-events and occlusion do not become accidental semantic absence. |
| Nonstandard DOM | Custom controls, text-only hover targets, nested frames, large tables, deep wrappers, long attribute values and non-Latin text. |
| Data handling | Sentinel passwords, unrelated form values, query secrets and page instruction attacks never leak into model requests/logs or alter system behavior. |
| Size boundaries | Just below/at/above each configured budget; target at beginning/middle/end; oversized individual section; no false `not_found` caused by omission. |
| Correctness | Expected target accuracy, wrong-target rate, true absence handling, malformed output and independently verified XPath identity. |
| Speed and cost | End-to-end p50/p95 plus capture, serialization, provider, XPath and validation timings; input/output/reasoning tokens; calls and retries. |

Compare full sanitized DOM, normalized semantic-plus-DOM representation and the pinned Stagehand strategy on identical fixture states. Report cold and warm execution separately. Choose the fastest configuration meeting the agreed quality gates; provider model names and advertised context sizes do not establish that result.

## Still to verify in a prototype

- Whether the chosen stable .NET package exposes a supported native-ref mapping that is sufficient for the same-node identity check.
- Whether native snapshot enrichment actually saves work compared with one compact DOM serializer on the required fixtures.
- Exact hidden-element policy, especially visually rendered `aria-hidden` content and opacity-zero content.
- Model-specific context accounting and observed input sizes, accuracy and latency. No live model calls or benchmark measurements were performed for this note.
