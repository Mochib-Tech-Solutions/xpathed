# Presenting xpathed

This guide walks through a live demonstration of xpathed, its architecture, evaluation evidence and proposed integrations.

Start by showing the behavior, then explain the decisions and their evidence. The suggested timings can be adapted to the audience.

## Prepare the demo

Follow [the README setup](../README.md#run-it-locally). Open a website you are authorized to use and rehearse against its actual current markup. Choose a page with a clearly named control, repeated labels in different sections, and a disabled or covered control. Keep each target visible before submitting its instruction.

Confirm the application key works before presenting. Record the exact model/provider configuration used; the checked-in `.env.example` is a development default, while an approved release has its own frozen configuration. Keep credentials out of screenshots and terminal output.

Have one saved evaluation report ready, including its case definition, expected target and original response. Choose a failure as well as a pass. If a live provider becomes unavailable, use the saved evidence and label it as a previous run.

## 1. Demo: make the result inspectable

Allow roughly five minutes. Use these as command patterns; adapt the names to the prepared page.

| Show                           | Example                                         | Explain                                                                     |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| A named target                 | “Click About us”                                | The instruction selects and highlights a link; the user controls execution. |
| Context among duplicate labels | “Hover over OK under Employee”                  | Section context separates two otherwise similar controls.                   |
| A form relationship            | “Select the dropdown next to Country”           | Naming, labels and surrounding structure help identify the control.         |
| A limitation                   | Request a disabled control, then a missing name | Finding a target, assessing readiness and reporting absence are separate.   |

For one result, point out the target description, interpreted action, XPath, passed checks, state, time and cost. Manually change the page or switch tabs and show why an old result is historical. If time allows, resolve several targets with the same action and show the per-target results.

Do not rely on the application inventing demo content: it opens your chosen website. Controlled evaluation fixtures are separate from the user workspace.

## 2. Architecture: follow one request

Use [the service diagram](diagrams/system-design.svg) and [request flow](diagrams/resolution-flow.svg) with [the walkthrough](how-it-works.md). In the indicative 15 minutes, answer:

1. **Why candidate selection?** The model maps language to an element in a bounded inventory. Browser code controls XPath construction and verification.
2. **Which page?** The viewer and resolver share a page ID, with document/capture identities protecting against stale evidence.
3. **What reaches the model?** Sanitized names, roles, structure, frame and relevant appearance/geometry evidence. Explain both data minimization and remaining page-content sensitivity.
4. **What does verification prove?** One match to the selected node in its document, with current-view membership rechecked. Independent labels assess whether that selection was intended.
5. **Why separate services?** Browser owns live state; Resolver can be evaluated without the client database; ClientApi owns persistence.

Close with the proposed test-runner integration boundary and hosted requirements. Clearly mark these as proposed work; the implementation is a local Chromium prototype.

## 3. Evaluation: explain one score and one failure

In roughly ten minutes, walk through an actual saved case:

- Instruction and independent expected target.
- What Browser captured and what the model received.
- Selected target, verified XPath and observed state.
- The grader's result and the reason for a mismatch, if any.

Use [the experiment history](engineering-journey.md) to explain model comparisons. Keep the date, model/provider, case set, denominator and measurement boundary beside each score. Explain why offline selection accuracy cannot establish live XPath readiness, and why an older two-second acceptance rule is different from today's descriptive latency target.

Finish with the current [release comparison](diagrams/evaluation-release.svg): exact candidate and approved images, the same collection, no lost baseline pass, verified approval, explicit activation and monitoring. Distinguish this implemented workflow from hosted runs actually evidenced in the release records.

## 4. Q&A: be ready for the awkward cases

| Question                               | Anchor for the answer                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Can a verified XPath still be wrong?” | Yes. It may identify the model's wrong selection exactly. Independent target labels measure that error.                                                               |
| “What if the page changes?”            | Captures and current-view membership are revalidated; stale evidence produces a resolve-again outcome.                                                                |
| “Why not send the whole HTML?”         | Explain sanitization, candidate coverage, context size and explicit budget failures.                                                                                  |
| “Why not execute the click?”           | The accepted scope establishes target resolution and passive readiness. Execution adds action outcomes and recovery responsibilities.                                 |
| “How would this scale?”                | Browser sessions own costly processes and displays. A hosted design needs session placement, capacity limits, authenticated access and isolation before more workers. |
| “Why this model?”                      | Explain the measured quality/latency/cost tradeoff for its actual experiment, then identify the current configuration separately.                                     |
| “How do you detect drift?”             | Re-run the frozen approved collection, retain original attempts and distinguish model errors from infrastructure failures.                                            |

## 5. Strategy: connect reliability to test maintenance

The proposed value is less time identifying and repairing locators while keeping test behavior reviewable. Measure time to a correct accepted target, wrong-target rate, clarification rate and maintenance time after UI changes. Business savings remain hypotheses until measured in real authoring workflows.

Prioritize better failure coverage and domain-specific regression cases, then integration with test authoring. Suggest locator repair only when it preserves the intended target and assertions. Broader test generation and execution should build on measured resolution reliability and introduce their own outcome evaluation.

The [engineering journey](engineering-journey.md) develops these next steps and explains which experiments supported the current design.
