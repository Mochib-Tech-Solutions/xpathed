# XPath construction for browser tests — 2026-10-03

## Assessment before implementation

`normalize-space(.)` is a useful standard XPath operation. Its presence does not make a locator unreliable. The relevant questions are whether the expression represents the intended identity, whether its text semantics match the source used to construct it, and whether the saved expression survives the changes the test is expected to tolerate. Current xpathed validates identity now; no inspected source establishes that its ranking is universally optimal.

The initial assessment inspected revision `218d9aadd0d55d51fd1a1c05c12c3f722223a663`. It rechecked the sources behind the [September 30 research](2026-09-30-readiness-and-resilient-xpath.md). The targeted browser observations below describe that baseline, separately from the literature findings. The implementation follow-up at the end describes the resulting change.

## Why normalize spaces

For a button whose DOM text is `  Sign   in\n`, `//button[normalize-space(.)='Sign in']` tolerates formatting whitespace that exact raw equality would reject. The dot uses the element's string value, including descendant text. Using `text()` instead can miss nested markup: string conversion of a node set uses its first node. XPath string values concatenate descendant text without inserting separators. These are defined semantics, independent of xpathed. [XPath 1.0 string functions and data model](https://www.w3.org/TR/xpath-10/).

The normalization is limited to space, tab, carriage return and line feed. NBSP (`U+00A0`) and narrow NBSP (`U+202F`) are outside that set. This function also performs no Unicode NFC normalization. [XML whitespace production](https://www.w3.org/TR/REC-xml/#NT-S), [XPath normalize-space](https://www.w3.org/TR/xpath-10/#function-normalize-space).

## Construction at the inspected baseline

`xpathsFor` returns the first expression whose document-wide evaluation yields exactly one node identical to the retained target. Its order is:

1. Target test attributes: `data-testid`, `data-test-id`, `data-test`, `data-cy`, `data-qa`.
2. Target test attributes or semantics within ancestor headings, row cells, named containers or landmarks.
3. Explicit native label associations.
4. Target semantic attributes, normalized text and button-input values.
5. Ordinary attributes including ID and name, excluding recognized generated IDs.
6. Attribute pairs, then broader ancestor context.
7. A structural path with positional segments when necessary.

This is a bounded heuristic, not a search over all possible XPaths. The same-node check rejects incorrect text predicates, but the eventual fallback may be less resilient. Source: [BrowserCaptureScript.cs, `xpathsFor`](../../src/Browser/Sessions/BrowserCaptureScript.cs), [documented policy](../resolution.md#preferred-xpath).

The implementation's `text` helper excludes certain hidden/private contents, substitutes some accessible naming information, joins text parts with spaces, then applies JavaScript whitespace replacement and NFC normalization. XPath `normalize-space(.)` evaluates a different representation. Adjacent spans, hidden descendants, image alternatives, NBSP and decomposed Unicode can therefore prevent a semantic predicate from matching. This is an implementation concern already acknowledged in the September 30 note; it is not evidence that every returned XPath is wrong. [Current text helper](../../src/Browser/Sessions/BrowserCaptureScript.cs), [earlier analysis](2026-09-30-readiness-and-resilient-xpath.md#prefer-resilient-anchors-verify-every-candidate).

Accessible names have their own traversal rules, including label references and specific treatment of hidden referenced content. Plain XPath text predicates do not implement that algorithm. [W3C accessible name computation](https://www.w3.org/TR/accname-1.2/#computation-steps).

## Targeted browser observations

Eight diagnostic cases were exercised through the running production Browser HTTP API without provider calls. Every returned XPath uniquely matched the retained node initially (8/8). The originally returned expression was then evaluated after inserting a wrapper around the same button; four survived (4/8). This deliberately selected sample exposes edge cases and is not an overall accuracy estimate. The uncommitted local evidence is [xpath-probe-results.json](../../.artifacts/flow-demo/xpath-probe-results.json); the table records the observations if that ignored artifact is unavailable.

| Case                                   | Returned XPath                              | Same node after wrapper insertion |
| -------------------------------------- | ------------------------------------------- | --------------------------------- |
| Ordinary formatting whitespace         | `//button[normalize-space(.)='Learn more']` | Yes                               |
| Nested spans with a literal space      | `//button[normalize-space(.)='Learn more']` | Yes                               |
| NBSP between words                     | `/html/body/button`                         | No; zero matches                  |
| Adjacent spans without a literal space | `/html/body/button`                         | No; zero matches                  |
| Hidden descendant text                 | `/html/body/button`                         | No; zero matches                  |
| Decomposed Unicode in Café             | `/html/body/button`                         | No; zero matches                  |
| Explicit test attribute plus NBSP      | `//button[@data-testid='learn-more']`       | Yes                               |
| Ordinary stable ID plus visible text   | `//button[normalize-space(.)='Learn more']` | Yes                               |

The failures demonstrate loss of saved-locator resilience after structural fallback. They did not return the wrong node at initial verification. The stable-ID case also confirms that the inspected policy chooses text before an ordinary ID when both could identify the button.

## What official testing guidance supports

Playwright recommends user-facing locators and explicit test contracts. Its role locator implements accessibility semantics; it is not interchangeable with standard XPath. Its documentation discourages long DOM-dependent CSS/XPath chains and arbitrary positional choices. Test IDs deliberately survive changes to visible wording, while semantic locators can make wording part of the expected identity. [Playwright locators](https://playwright.dev/docs/locators).

Selenium recommends IDs when they are unique and consistently predictable, and compact, readable selectors. xpathed's policy of preferring semantic anchors before ordinary IDs is therefore an intentional trade-off, rather than a universal rule shared by every framework. [Selenium locator guidance](https://www.selenium.dev/documentation/test_practices/encouraged/locators/).

## Published algorithms worth comparing

ROBULA+ is a direct XPath-generation baseline. It progressively specializes a broad expression using ordered transformations, attribute priorities and exclusions until it uniquely identifies the target. Its 2016 evaluation covered more than one thousand elements from eight applications and reported lower fragility than its contemporary baselines. Those results justify a comparison; they do not establish superiority over current xpathed, modern sites or this product's privacy and latency constraints. [Authors' accepted paper](https://tsigalko18.github.io/assets/pdf/2016-Leotta-JSEP.pdf), [University of Genova project](https://sepl.dibris.unige.it/ROBULA.php).

Similo relocates elements using a weighted similarity score over multiple properties. It addresses recognizing an element after change, so using it during replay would add matching behavior beyond returning one saved XPath. Treat it as a distinct research comparison with explicit error/abstention criteria. [Original Similo paper](https://arxiv.org/abs/2208.00677). A later replication and extension studies Similo and VON Similo on a larger benchmark, another reason to avoid selecting an algorithm from its original headline result alone. [Comparative study](https://arxiv.org/abs/2505.16424).

## Recommended next evaluation

These are proposals, not newly accepted requirements:

- Keep normalized text matching where its semantics agree with the source text. Preserve unique same-node verification and the existing privacy boundary.
- Measure fallback caused by the text-representation mismatch before changing ranking. Avoid copying arbitrary hidden text or editable values into expressions to force matches.
- Compare saved expressions after whitespace changes, nested wrappers, Unicode variants, hidden descendants, row reorder, duplicate-label insertion and generated-ID replacement. Regenerating after each mutation measures a different capability.
- Include deliberate identity changes: label replacements should fail when wording defines identity; explicit test contracts can remain valid when wording changes. Review these expectations per case.
- Evaluate frozen representative browser cases and report both immediate target accuracy and saved-locator survival.
- Include ROBULA+ as a concrete XPath-generation baseline before proposing an algorithm replacement; evaluate similarity-based relocation separately from XPath generation.

The appropriate claim today is that xpathed uses a researched, deterministic construction policy with live identity verification. “Best possible algorithm” would require a defined workload, comparison baselines and independent results; documentation guidance alone cannot establish it.

## Implementation follow-up

The accepted improvement retains the existing locator ranking and separates XPath-compatible text construction from sanitized candidate naming. The Browser now offers an additional original-spelling predicate when the exposed text agrees with the sanitized name. For labels interrupted by excluded descendants it can use bounded exposed-text predicates with a text-node count guard, without emitting hidden or editable values. The helper is shared by target text, headings, row cells and native label associations. Every candidate expression still requires a unique same-node match.

The shared evaluation cases preserve the originally returned XPath across wrapper insertion and independently grade changed-meaning rejection, Unicode, quote handling and privacy. Tests do not regenerate a locator to pass saved-locator checks. Whole-document uniqueness, current-view validation, the existing preference for explicit test contracts and deterministic provider-free CI remain in place. These improvements do not establish general immunity to DOM changes; the [current policy](../resolution.md#preferred-xpath) records the bounds.
