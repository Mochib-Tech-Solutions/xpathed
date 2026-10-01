# Viewport capture options

Research date: 2026-10-01. Repository observations below describe the pre-change baseline at `864b626439944a8c0dedec461301fc00a800fd84`. The maintainer accepted current-view scope, retention of partially visible/disabled/covered targets, CSS/layout-first evidence and a two-second processing deadline. [ADR-0018](../adr/0018-scope-resolution-to-the-current-view.md) records the implemented decision. The alternatives below are research, not measured speed improvements or requirements to implement every option.

## Repository observations

[BrowserCaptureScript](../../src/Browser/Sessions/BrowserCaptureScript.cs) already batches native `IntersectionObserver` observations with `root: document`, disconnects on completion/timeout, and intersects the result with browser-owned containing-frame clips. It does not infer viewport membership from raw bounding-box overlap. [BrowserPageCapture](../../src/Browser/Sessions/BrowserPageCapture.cs) owns aggregate frame traversal and validation. Replacing this machinery is not necessary merely to send fewer candidates.

The present scan enforces 2,000 eligible elements **before** intersection observation and description. Filtering serialized candidates afterward would save model bytes but would not remove this failure on a long page containing many off-screen controls. Separating visited, eligible, in-scope and serialized counts would be a contract change, not a free performance fix. The 20,000-element, frame, time and byte limits still need explicit incomplete outcomes.

The current [resolution contract](../resolution.md#eligibility-and-action-observations) deliberately retains disabled, readonly, covered, transparent, clipped, zero-area and off-screen eligible targets. It distinguishes selection from readiness and forbids a candidate subset from proving page-wide absence. [ADR-0012](../adr/0012-keep-frame-context-separate-from-xpath.md) keeps frame identity outside the target XPath. These are the existing runtime semantics; the accepted viewport boundary requires an explicit migration rather than a silent filter. The maintainer subsequently accepted retaining partially visible, disabled and covered targets with readiness reporting, and CSS/layout evidence first with screenshot interpretation deferred.

## Four different questions

| Question               | Meaning for this codebase                                                                             | Incorrect shortcut                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Eligible?              | The sanitized accessibility/DOM policy permits this node as a target.                                 | “Every DOM node” or “every enabled control.”                       |
| In the viewport?       | A positive-area part intersects the declared viewport after clipping and frame mapping.               | “Its bounding rectangle overlaps the window.”                      |
| Visually rendered?     | Current rendering observations permit a visible representation; this is not pixel-perfect perception. | Treating intersection as proof of opacity or absence of overlays.  |
| Ready for this action? | Applicable passive checks pass at observation time; some checks remain unknown.                       | Treating visible, enabled, or found as successful event execution. |

Playwright itself separates visibility, stability, event reception, enabled state and editability. Its visibility convention even accepts opacity-zero elements. Its click readiness therefore should not be copied into a single product-level “visible” predicate. Keep disabled/covered targets selectable and explain the failed check; an intended blocked button is still the intended button. [Playwright actionability](https://playwright.dev/docs/actionability).

## Native intersection versus synchronous geometry

Native intersection computes containing-block clipping, scroll-container clipping and nested browsing-context intersections. Notifications are asynchronous, not a hard real-time freshness guarantee. `takeRecords()` drains queued observations; it does not force layout or create a fresh observation. Edge-adjacent contact can set `isIntersecting` with zero area, so retain the existing positive-width-and-height rule. An explicit document root differs from an implicit top-level root; preserve the existing per-document observation plus explicit frame mapping. [Intersection Observer draft, processing model](https://w3c.github.io/IntersectionObserver/#processing-model).

`getBoundingClientRect()` provides an enclosing rectangle of client fragments, not the actually exposed shape. `elementFromPoint()` reports hit-test participation, which differs from paint order when `pointer-events` excludes an element. Layout and visual viewports also diverge under pinch zoom. Consequently, plain rectangle overlap is only a coarse prefilter, and a rectangular center can miss a multiline or nonrectangular target. [CSSOM View](https://www.w3.org/TR/cssom-view/).

Synchronous geometry has no observer callback wait, but reading geometry after style/layout invalidation can force layout. Avoid interleaving DOM writes with reads and cache repeated reads within one observation. Whether it beats a fresh observer batch on this workload needs measurement; fewer JavaScript lines do not establish lower latency. [Google web.dev layout guidance](https://web.dev/articles/avoid-large-complex-layouts-and-layout-thrashing).

Recommendation: keep the native clipping path first. Measure scan, naming/context extraction, observer wait, frame traversal and serialization separately. Consider a conservative bounding-box rejection only after tests establish that it cannot lose descendants escaping a clipping ancestor, fragmented controls or permitted frame transforms. Do not prune an entire subtree because its ancestor has no box: descendants may have their own boxes. Do not add a persistent observer/cache until measurements justify its invalidation and lifecycle cost.

### Why visibility tracking is not the selection filter

`trackVisibility` adds conservative occlusion/opacity checks and a minimum 100 ms notification interval. A false result can be a false negative; it is unsuitable as a rule that removes every supposedly invisible target. It also cannot answer whether a specific requested action would succeed. This is especially unattractive when the product must return disabled or covered targets with explanations. Do not assume a 100 ms initial delay is always paid, or that v1 callbacks have a fixed delay; measure the actual pinned Chromium behavior. [Google web.dev Intersection Observer v2](https://web.dev/articles/intersectionobserver-v2).

Keep point hit testing separate and late, for selected targets. It should remain passive through every ancestor frame. Do not replace it with `click({trial:true})`: Playwright's click preparation includes scrolling, and trial mode still presses supplied keyboard modifiers. That conflicts with the repository's unchanged scroll/focus/input requirement. [Playwright locator click](https://playwright.dev/docs/api/class-locator#locator-click).

## Compact representation and relational anchors

Proposed first experiment: preserve live node identities locally and create a compact, explicitly scoped representation for one model call. Include candidate ID, role/tag, nonduplicate name/text, necessary state, frame reference, geometry and small shared semantic context. Deduplicate repeated row/section/frame context through references rather than repeating it per target. Exact representation and budgets must be versioned and independently graded; do not silently truncate fields or enumerate only the first matches of a plural request.

The accepted design now makes “all confirmation buttons in the list” refer to the current view and reports absence within that view. Runtime migration must make completeness equally scoped; reaching a scan/time limit must remain incomplete. Compare the proposed current-view representation with the existing runtime baseline using labels appropriate to each declared scope; do not count newly out-of-scope elements as accidental successes or failures. Deduplicating repeated context can be measured separately from the scope change. Neither optimization has been benchmarked here.

Retain relational anchors that are not actionable controls: headings, nearby labels, row identifiers and relevant noninteractive elements. A viewport target may take its name from a hidden or off-screen reference; calculate the safe accessible name before discarding reference nodes. Hidden naming references do not become selectable targets. [Accessible Name computation](https://www.w3.org/TR/accname-1.2/#computation-steps).

For “the button above the red button,” retain both the target and reference candidate with geometry in one declared coordinate system; distinguish the reference from a second action target. “Above” needs observed geometry rather than DOM order: flex ordering can change visual order independently of source order. Duplicate anchors, diagonal/overlapping layouts or indistinguishable distances should remain ambiguous. A row/section match can constrain the relation without inventing a proximity threshold. [CSS Flexbox ordering](https://www.w3.org/TR/css-flexbox-1/#order-accessibility).

## CSS color versus pixel appearance

`getComputedStyle()` exposes resolved CSS property values, including supported pseudo-element properties. That is useful for a small allowlist such as background, foreground and border colors; it is not a rendered-pixel oracle. Avoid serializing entire style declarations or resource-valued properties. [CSSOM resolved values](https://www.w3.org/TR/cssom-1/#resolved-values).

A button's apparent color can depend on alpha, its backdrop and blending, not just `background-color`. CSS also supports several color spaces, so a parser restricted to legacy integer `rgb()` is insufficient. [Compositing and Blending](https://www.w3.org/TR/compositing-1/#backdrop), [CSS Color 4](https://www.w3.org/TR/css-color-4/).

Recommendation, not established capability: start any color experiment with labelled simple opaque CSS surfaces and bounded provenance such as “computed background color.” Treat gradients, images, canvas, filters, overlays, pseudo-element artwork and ambiguous color names as unsupported or uncertain unless a separate method validates them. A nearest named-color heuristic is a product rule, not an objective definition of “red.” Do not infer that an element is disabled merely because it looks gray.

Screenshot-assisted vision would be a separate privacy, latency, cost and identification change. It would still need to map the proposed target back to a retained DOM node and independently verify the XPath; it must not invent XPath from pixels. The present image accessible-name policy must not be changed implicitly. No source examined establishes that adding vision meets this workload's speed target.

## Required evidence before changing defaults

Use deterministic browser cases for the capture boundary, then an explicitly budgeted model comparison only if authorized. Suggested high-value cases:

| Scenario                                                                          | Expected distinction to preserve                                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Nested overflow scrollports; fixed descendants escaping a non-containing ancestor | Native clipped intersection rather than arbitrary ancestor-box intersections.                          |
| Partial visibility, one-pixel edge contact, inline fragments, SVG/clip-path       | Positive area; sampled hit-point limitations remain explicit.                                          |
| Sticky header/overlay and `pointer-events:none` cover                             | Viewport membership independent of pointer reception and paint coverage.                               |
| Disabled/readonly controls and transparent targets                                | Found identity survives; action-dependent checks explain limits.                                       |
| Scaled/translated nested frames; covered iframe owner                             | Main-viewport geometry and ancestor hit checks agree. Unsupported frame transforms remain unsupported. |
| Hidden labelled-by reference; `display:contents` grouping                         | Naming/context survives without incorrectly promoting hidden targets.                                  |
| Multiple same-name rows; CSS-reordered buttons                                    | Semantic scope plus visual geometry resolve references without DOM-order assumptions.                  |
| Plural instruction crossing the viewport boundary                                 | Explicit scope/completeness; no silent omission or extra alternative targets.                          |
| Virtualized list or lazy off-screen content                                       | No claim about records absent from the observed DOM. No automatic scrolling.                           |
| Scroll, resize, animation or frame navigation during capture/response             | Stale identity rejection and fresh final validation; no persistent geometry assumption.                |
| Long page with many off-screen controls; numerous small frames                    | Real scan/observer/naming cost and bounded failure behavior.                                           |

Freeze the compared representation, labels and target scope. Record request-to-result latency, capture stages, input bytes/tokens, complete target-set/action correctness and readiness correctness together. Smaller payloads are only a hypothesis for faster inference. Report missed targets and failures in the original-attempt denominator. The present [qualification policy](../adr/0016-qualify-models-with-correct-complete-latency.md) is a percentage-based deadline gate; it does not guarantee every response within two seconds. The subsequently accepted contract-4 processing deadline returns an explicit timeout failure; it does not guarantee correct results within two seconds.
