# Natural Language to XPath

This context covers identifying a web element from a natural-language test instruction and expressing its location as an XPath.

## Language

**Test instruction**:
A natural-language request describing an interaction and the element it concerns, such as “Hover over OK under Employee.”

**Action**:
The requested interaction, such as clicking, hovering, or selecting an option.

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

**Alternative XPath**:
Another XPath expression for the same selected target element. Alternatives vary the way the element is located, not which element is selected.

**Browser session**:
A managed browsing instance in which the user prepares the page and the resolver inspects the target. The client and resolver refer to the same session.

**Managed page**:
The single page the user views and works with in a browser session. Its page identifier links resolution requests to that same live page.

**Page document**:
The current document within a managed page. Navigation can replace the document while keeping the managed page itself.

**Candidate capture**:
A temporary inventory of eligible candidate elements from one page document. Its candidate identities refer only to that captured inventory.

**Off-screen element**:
An element present in the current page content but outside the visible viewport. This is distinct from an element concealed by the application's display state.

**Target state**:
The observed condition of the selected element relevant to the requested action, such as whether it is rendered, in the viewport, enabled, or editable. Target state is separate from the element's identity.

**Action execution**:
The performance of the requested interaction on a resolved target element.

## Evaluation

**Evaluation case**:
A test instruction paired with a specified page state and independently defined expected resolution and target state.

**Evaluation run**:
An assessment of a resolver configuration against a versioned collection of evaluation cases.

**Failure flag**:
A diagnostic signal that a resolution attempt needs investigation because of a detected problem. It does not by itself establish a model error or an expected target.

**Resolver release**:
An identified version of the resolver's code, strategy, prompt, model/provider configuration, and page processing settings that is assessed as a unit.

**Approved default**:
The qualified resolver release selected for clients that do not request another approved release.

**Qualification**:
The evaluation of a resolver release against the agreed acceptance criteria before it can become an approved default.
