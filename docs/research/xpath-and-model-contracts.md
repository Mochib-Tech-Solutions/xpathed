# XPath robustness and model connections

Official documentation checked on 2026-09-29. Recommendations below inform specification issue #1; they are not all accepted design decisions.

Subsequent decisions settled OpenRouter as the sole initial gateway and excluded hidden targets, including hidden file inputs. Off-screen targets remain eligible. Earlier open questions and other connection options below are research history; follow specification issue #1 and the ADRs for implementation.

## XPath construction and verification

Playwright recommends user-facing locators and explicit test contracts, and warns that long DOM-dependent XPath chains are fragile. For this assignment, which requires XPath output, prefer known test attributes, suitable stable attributes, and meaningful label/text/container relationships over long positional paths. This ordering is a project heuristic, not a universal guarantee. Attribute names such as `data-testid` do not prove uniqueness or stability. [Playwright locators](https://playwright.dev/docs/locators)

After the model selects an element, generate XPath expressions from the actual DOM. Evaluate each expression using the browser's XPath API and require exactly one element matching the selected DOM node. This verifies locator construction independently of whether the model chose the intended target. Avoid adding `[1]` merely to hide ambiguous matches. [MDN XPath evaluation](https://developer.mozilla.org/en-US/docs/Web/API/XPathEvaluator/evaluate)

Alternative XPath expressions must identify the same target. Proposed mutation tests include inserting wrappers, reordering unrelated siblings, changing CSS classes, regenerating volatile IDs, adding duplicate text, and rerendering controls. Also remove or replace the target and check that fallback expressions do not silently identify another control. An ordered list of alternatives alone does not establish robustness.

## Page state and scope

Viewport intersection is distinct from rendered visibility. Retain off-screen elements already present in the DOM. Decide separately whether application-hidden elements are eligible; page inspection and XPath uniqueness do not establish actionability. A user-triggered reveal can scroll later without making scrolling part of resolution. [Playwright actionability](https://playwright.dev/docs/actionability)

XPath is scoped to a document. Iframe support requires a frame reference plus an XPath evaluated inside that frame. XPath does not pierce shadow roots; shadow-root targets need a different locator contract or an explicit unsupported result. [Frames](https://playwright.dev/docs/frames), [Shadow DOM limitations](https://playwright.dev/docs/locators#locate-in-shadow-dom)

## Model connection distinctions

- OpenCode's application/server provides stateful agent sessions, tools, and messages. Using it introduces the agent runtime. [Server](https://opencode.ai/docs/server/)
- OpenCode Zen provides direct inference endpoints; models may use different API protocols. A configurable base URL alone does not normalize all providers. [Zen](https://opencode.ai/docs/zen/)
- OpenCode Go has subscription usage requirements, including client/session identification. Confirm the actual access path before assuming a subscription fits resolver traffic. [Go](https://opencode.ai/docs/go/#where-can-i-use-it)
- Ollama supports schema-constrained local chat output through `format`; responses still need application-side validation. [Structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- OpenRouter structured-output support depends on the serving endpoint. Provider preferences can require requested parameters, but application-side validation remains necessary. [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

Proposed model contract: a captured candidate set and instruction go in; a candidate identifier or no-match result comes out. Validate that identifiers belong to that capture. Keep credentials in environment variables and record model/provider identifiers with evaluation results. Exact adapters remain undecided until the available connection is confirmed.

## Model comparison

Compare configurations on the same reviewed tasks and captured page states. Measure intended-target correctness, wrong-target selections, absence handling, invalid output, retries, end-to-end p50/p95 latency, and cost per successful resolution. Separate first-attempt results from retry-assisted results and cold local-model starts from warm runs. Choose the fastest configuration meeting the agreed quality threshold; model identity alone does not establish latency. [OpenRouter latency considerations](https://openrouter.ai/docs/features/latency-and-performance)
