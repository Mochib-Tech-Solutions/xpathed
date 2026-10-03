# Natural Language to XPath

This context covers identifying a web element from a natural-language test instruction and expressing its location as an XPath.

## Language

**Resolver**:
The core system that interprets an instruction against a current browser view and returns intended targets, verified XPath expressions and observed readiness.

**Browser service**:
The component that supplies live page observations and verifies target locations for the Resolver. Its implementation can be replaced while preserving the browser contract.

**Test client**:
A consumer used to exercise and inspect Resolver results. The included chat workspace supports manual testing and demonstrations.

**Test instruction**:
A natural-language request describing an interaction and the element it concerns, such as “Hover over OK under Employee.”
A basic test instruction requests one interaction across one or more targets, such as “Click all Approval buttons.”

**Action**:
The requested interaction, such as clicking, hovering, or selecting an option.

**Action resolution**:
The result of identifying one action's target in a particular page state, including absence or an unsupported scope. A found action resolution concerns one target and has one preferred verified XPath expression for that target.

**Target set**:
The distinct elements intended by one action within the current view. Finding only some of those elements does not establish that the target set is complete.

**Multi-target result**:
One shared action with independent outcomes for its intended targets. Its partial-result summary separates found targets from missing, unsupported, failed or non-interactable targets.

**Instruction step**:
An ordered part of a test instruction. An unordered plural step expands into multiple action resolutions, one for each intended eligible target.

**Inspected action**:
A found action selected for individual inspection. Resolution can highlight its full target set together; inspecting one action does not execute it.

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
An expression that locates nodes within a document. A resolved XPath is intended to locate the target element on the current page.

**Browser session**:
A managed browsing instance containing related tabs and their shared browsing state. The client and resolver refer to the same session.

**Managed page**:
A live browser tab within a session. Its page identifier links resolution requests and chat history to that same tab.

**Active page**:
The managed page currently selected for viewing and target resolution. A session has one active page at a time.

**Current view**:
The active page's viewport at its current scroll position. A target set scoped to the current view concerns that viewport, not every matching element elsewhere on the page.

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

**Evaluation set**:
The collection of independently labelled cases used to assess model selection, XPath construction and verification, and the complete Resolver request. Each category has its own score.
_Avoid_: Regression evaluation set

**Resolver E2E evaluation**:
Assessment of the complete resolution request, from browser capture through target selection, XPath verification and readiness to the final result.

**XPath construction and verification evaluation**:
Assessment of the stage after selection: known selected elements must produce XPath expressions that uniquely identify the intended nodes in a real browser, with accurate state observations.

**Model-selection evaluation**:
Assessment of target selection from saved page inputs and independent labels. Offline describes the page inputs; inference can use a live model.

**Regression**:
A case that passes in a reference run and fails in the compared run. It describes a comparison outcome, rather than a kind of evaluation set.

**Evaluation case**:
A test instruction paired with a specified page state and independently defined expected resolution and target state.

**Evaluation run**:
An assessment of a resolver configuration against a frozen collection of evaluation cases and independently defined expectations.

**Evaluation trial**:
One declared execution of an evaluation case. Repetitions and later diagnostic reruns retain separate identities and outcomes.

**Target oracle**:
An independently established mapping from an expected action to its intended element. It is separate from the resolver's selected candidate and generated XPath.

**Comparison pair**:
Two resolution attempts on the same evaluation case with equivalent inputs and independently reset page state where applicable. A release comparison pairs the candidate with the approved baseline and retains both outcomes, including failures.

**Target-set completeness**:
Whether the returned distinct elements exactly cover all independently labelled targets for the command, with no missing or extra elements. Correct interaction and passive state are assessed separately.

**Saved-locator reuse**:
Checking whether a previously returned locator still identifies its intended element after a page change. This is distinct from resolving the instruction again on the changed page.

**Failure flag**:
A diagnostic signal that a resolution attempt needs investigation because of a detected problem. It does not by itself establish a model error or an expected target.

**Resolver release**:
An identified version of the resolver's code, strategy, prompt, model/provider configuration, and page processing settings that is assessed as a unit.

**Approved default**:
The qualified resolver release selected for deployment through the release process.

**Qualification**:
The evaluation of a resolver release against the agreed acceptance criteria before it can become an approved default.

**Release baseline**:
The approved resolver release retained as the comparison reference while a candidate is evaluated. Development changes do not replace it; approving a replacement establishes the next baseline.

**Release comparison**:
The assessment of a candidate and the approved baseline on the same frozen collection. A lost baseline pass is a case that the baseline passes and the candidate fails.

**Approved evaluation collection**:
The evaluation set and expected observations frozen when a resolver release is approved. Repeating them detects lost passes and model drift; it does not establish unseen-data generalization.

**Model drift**:
A change in the observed behavior of an approved resolver configuration when its frozen cases are repeated against the hosted model.

**Sentinel case**:
A case in the smaller monitoring subset retained by historical approvals. New approvals monitor their complete approved evaluation collection.

**Release activation**:
Deploying an explicitly approved release and checking that its exact components are running.

**Release rollback**:
Explicitly selecting and activating a retained qualified compatible release. Restoring code cannot restore historical hosted model weights.
