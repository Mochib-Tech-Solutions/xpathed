# Natural Language to XPath

This context covers identifying a web element from a natural-language test instruction and expressing its location as an XPath.

## Language

**Test instruction**:
A natural-language request describing an interaction and the element it concerns, such as “Hover over OK under Employee.”
A basic test instruction requests one interaction across one or more targets, such as “Click all Approval buttons.”

**Action**:
The requested interaction, such as clicking, hovering, or selecting an option.

**Action resolution**:
The result of identifying one action's target in a particular page state, including absence or an unsupported scope. A found action resolution concerns one target and has one preferred verified XPath expression for that target.

**Target set**:
The distinct elements intended by one action on the current page. Finding only some of those elements does not establish that the target set is complete.

**Multi-target result**:
One shared action with independent outcomes for its intended targets. Its partial-result summary separates found targets from missing, unsupported, failed or non-interactable targets.

**Multi-action result**:
The ordered resolutions of several interactions requested together. This legacy scope is distinct from one action concerning several targets.

**Instruction step**:
An ordered part of a test instruction. An unordered plural step expands into multiple action resolutions, one for each intended eligible target.

**Inspected action**:
The found action whose verified target currently owns the browser highlight. Inspecting an action does not execute it.

**Target element**:
The web element that the instruction intends the action to affect.
_Avoid_: XPath file

**Target resolution**:
The identification of the intended target element from the instruction and the current page.

**Candidate element**:
A web element proposed as a possible target for an instruction. Being a candidate does not establish that it is the intended target.

**Resolution strategy**:
An approach for proposing target elements and their XPath expressions from an instruction and page context. Different strategies address the same resolution task.

**XPath expression**:
An expression that locates nodes within a document. In this assignment, the output is intended to locate the target element on the current page.

**Browser session**:
A managed browsing instance containing related tabs and their shared browsing state. The client and resolver refer to the same session.

**Managed page**:
A live browser tab within a session. Its page identifier links resolution requests and chat history to that same tab.

**Active page**:
The managed page currently selected for viewing and target resolution. A session has one active page at a time.

**Resolution history**:
The ordered record of instructions and their results for a managed page, including when they were requested and how long resolution took. Historical results describe the page state at that time.

**Resolution attempt**:
One attempt to resolve an instruction, including its target results or operational failure. A later retry is a separate attempt and does not replace the original outcome.

**Diagnostic evidence**:
The sanitized observations and configuration associated with a resolution attempt that support later investigation. Evidence can be incomplete and does not by itself reconstruct the original browser state.

**Page document**:
The current document within a managed page. Navigation can replace the document while keeping the managed page itself.

**Frame document**:
A document embedded within a page or another frame. Its target locations are relative to that document.

**Frame chain**:
The ordered containing frames from the main page to a target's frame document.

**Candidate capture**:
A temporary inventory of eligible candidate elements from a page and its supported frame documents. Its candidate identities refer only to that captured inventory.

**Off-screen element**:
An element present in the current page content but outside the visible viewport. This is distinct from an element concealed by the application's display state.

**Target state**:
The observed condition of the selected element relevant to the requested action, such as whether it is rendered, in the viewport, enabled, or editable. Target state is separate from the element's identity.

**Accessibility exposure**:
Whether page content is available to assistive technology under the supported inspection policy, separately from whether it is visually rendered or ready for an action.

**Target eligibility**:
Whether an element belongs to the supported inspection scope. Eligibility is distinct from whether the requested action is possible on that element.

**Target interactability**:
The observed suitability of a target for a particular requested action, including known limitations and unknown observations. Passing the applicable observations establishes observed readiness; it is distinct from finding the target or successfully executing the action.

**Action execution**:
The performance of the requested interaction on a resolved target element.

## Evaluation

**Evaluation case**:
A test instruction paired with a specified page state and independently defined expected resolution and target state.

**Evaluation run**:
An assessment of a resolver configuration against a versioned collection of evaluation cases.

**Evaluation trial**:
One declared execution of an evaluation case. Repetitions and later diagnostic reruns retain separate identities and outcomes.

**Target oracle**:
An independently established mapping from an expected action to its intended element. It is separate from the resolver's selected candidate and generated XPath.

**Saved-locator reuse**:
Checking whether a previously returned locator still identifies its intended element after a page change. This is distinct from resolving the instruction again on the changed page.

**Failure flag**:
A diagnostic signal that a resolution attempt needs investigation because of a detected problem. It does not by itself establish a model error or an expected target.

**Resolver release**:
An identified version of the resolver's code, strategy, prompt, model/provider configuration, and page processing settings that is assessed as a unit.

**Approved default**:
The qualified resolver release selected for clients that do not request another approved release.

**Qualification**:
The evaluation of a resolver release against the agreed acceptance criteria before it can become an approved default.
