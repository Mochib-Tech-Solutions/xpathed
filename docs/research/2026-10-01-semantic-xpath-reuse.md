# Semantic XPath reuse

Research date: 2026-10-01. This note informs the narrow locator-ranking fix; it does not promise a selector that survives every future page change.

## Evidence and tradeoffs

Playwright recommends user-facing attributes and explicit testing contracts, illustrates scoping a repeated button to its product card, and warns against long structural paths. Test IDs are useful when the application deliberately maintains that contract. Its role locators compute accessibility semantics; an XPath attribute comparison is not an equivalent implementation. [Playwright locators](https://playwright.dev/docs/locators).

Selenium prefers IDs when they are unique and consistently predictable. That condition matters: looking readable in one capture does not establish that an ID survives a rerender. Its guidance also favors compact selectors and narrowed search scope. [Selenium locator guidance](https://www.selenium.dev/documentation/test_practices/encouraged/locators/), [scoped element searches](https://www.selenium.dev/documentation/webdriver/elements/finders/).

Accessible names may come from `aria-labelledby`, `aria-label`, native labels or permitted content, with defined precedence and hidden-content rules. Prefer an actual form-label relationship over assuming the control's text is its name; a `label/@for` relation can remain usable when both IDs change together. Do not treat arbitrary descendant text as the complete accessible-name algorithm. [W3C Accessible Name and Description Computation](https://www.w3.org/TR/accname-1.2/#computation-steps).

XPath element string values concatenate descendant text nodes. `normalize-space(.)` is useful for simple button text, including nested spans, but does not reproduce rendered text or accessibility naming. Copy changes and localization can break a text locator; stable test attributes or IDs can survive those changes. Conversely, a text-and-context locator can survive an ID replacement. These are different contracts, not a universal ordering guaranteed by a standard. [W3C XPath 1.0 data model](https://www.w3.org/TR/xpath-10/#data-model).

XPath cannot cross a shadow root. Keep that limitation explicit and preserve separate frame context; do not present a document XPath as a route through either boundary. [Playwright XPath limitations](https://playwright.dev/docs/other-locators#xpath-locator), [frame locators](https://playwright.dev/docs/locators#locating-elements).

## Recommended small policy

This ranking is an inference for xpathed's existing mutation contract, not a new general-purpose selector engine:

1. Preserve explicit test-attribute contracts first, including useful scope when the attribute repeats.
2. Prefer meaningful target semantics in a named section, row or landmark when that context is available. Retain the target's name inside the scope; an ancestor plus a bare tag is weaker evidence.
3. Use verified native-label relationships and other supported semantic predicates. Prefer them over ordinary IDs, and avoid a hardcoded control ID when following an associated label suffices.
4. Fall back to suitable ordinary attributes/IDs and then structural paths when stronger candidates cannot uniquely identify the node. Retain generated-ID exclusion, bounded capture work and XPath literal escaping.
5. For every candidate, evaluate the XPath in its own document and require exactly one match that is the selected captured node. Keep readiness checks separate from selector validity. No extra model call is necessary.

Repository evidence: `BrowserCaptureScript.cs` currently tries ordinary ID predicates before semantic/context candidates. The reviewed `mutation-id`, `mutation-replacement` and `mutation-duplicate` cases in `evaluation/cases.json` independently label the intended target and its post-mutation identity. Their requirement is saved-locator reuse, not a fresh model resolution. An ID-only Save button selector loses the former two; a global text-only selector risks the duplicate case. A meaningful Profile scope plus Save semantics addresses all three without changing their labels or grader.

Verify the policy with the unchanged mutation cases, explicit test-attribute precedence, duplicate names across scopes, native labels, generated IDs and same-node rejection. A passing mutation suite establishes those exercised changes only; it cannot establish future-proof behavior on unknown websites.
