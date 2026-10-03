# Demo guide

Present the Resolver API through its manual test client, then explain its implementation, evaluation and browser integration boundary.

## Prepare

Follow the [README setup](../README.md#run-locally). Rehearse on an authorized website with a named control, repeated labels and a disabled or covered control. Keep targets visible. Confirm the model key works and record the effective configuration without exposing credentials.

Keep a saved evaluation pass and failure ready. Label saved evidence as a previous run if the live provider is unavailable.

## 1. Show the result · 5 minutes

Adapt these commands to the page:

- “Click About us.”
- “Hover over OK under Employee.”
- “Select the dropdown next to Country.”

Point out the interpreted action, target, XPath, same-node verification, readiness, time and cost. Show a disabled target or scoped absence. Explain that the user executes actions; xpathed selects and highlights. Switch tabs or change the page to show why previous results are historical.

## 2. Follow the request · 15 minutes

Use the diagrams in [How it works](how-it-works.md):

1. Web and Resolver share the active managed page identity.
2. Browser captures sanitized candidates and retains their live nodes.
3. One model call selects IDs; Resolver validates the contract.
4. Browser builds XPath, verifies identity and rechecks the current view.
5. The workspace keeps the result in the active tab’s chat history until it is cleared or the tab closes.

Explain the five local Docker services, model settings and single-table schema. Distinguish candidate selection, locator correctness and observed readiness.

A test platform can call Resolver directly for a page owned by the configured browser service. The browser implementation is replaceable through the [HTTP contract](runtime.md#browser-integration); an external browser needs a compatible adapter, and its runner owns execution and postconditions. The chat workspace is one test client of the core API.

## 3. Explain quality · 10 minutes

Walk through a saved case: instruction, independent expected target, captured evidence, response and grade. The recorded `release3-listbox-1` failure found the correct option but changed `click` to `select`; explain why it fails despite a valid XPath.

Show how attempt/trace IDs connect configuration, error stage and available evidence. Describe the three evaluation categories: model selection from reviewed PhraseNode inputs, XPath construction and verification from controlled selections, and Resolver E2E with a real model and browser. Keep scores separate, with dates and denominators; use regression to describe a lost pass in a comparison.

Describe the current release gate: exact candidate/baseline images, the complete reviewed collection, no lost baseline pass, explicit activation and nightly monitoring.

## 4. Discuss tradeoffs · 10 minutes

Be ready to explain stale pages, frames, prompt injection, capture limits, ambiguity and why a verified XPath can identify the wrong selection. Scaling requires Browser session ownership, capacity management, authentication and isolation; throughput has not been benchmarked.

## 5. Connect to product value · 10 minutes

Explain the system plainly: a tester describes a control, the model selects a candidate, and browser code checks its locator. Independent evaluation measures whether the selection was right.

Propose measuring correction rate and time to an accepted locator. Prioritize known selection failures, then test-authoring integration, then reviewed repair or triage suggestions. Those product benefits remain hypotheses until measured.
