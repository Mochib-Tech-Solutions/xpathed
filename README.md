# Natural-language to XPath

Resolve one web element from an English test instruction and the current page's HTML/DOM. Return XPath expressions verified against that element, report its state, and highlight it in a managed browser.

## Project status

Design and research are recorded; application implementation has not started.

- [Specification and accepted scope](https://github.com/Mochib-Tech-Solutions/thunders-assignment/issues/1)
- [Domain glossary](CONTEXT.md)
- [Architecture decisions](docs/adr/)
- [Research and primary sources](docs/research/)

The planned local system uses separate .NET client API, resolver, and browser services, a React client with noVNC, and PostgreSQL, run through Docker. OpenRouter is the initial model gateway. The user interacts with the browser manually; the resolver identifies and validates targets without executing instructions.

## Reading the design

The specification and ADRs define accepted requirements. Research notes preserve alternatives considered during discovery; superseded proposals are not implementation requirements. Package versions, model availability, prices, and API support must be verified when implementing the relevant ticket.

Implementation work is tracked in GitHub Issues. Each ticket should deliver a working, testable slice and name its blockers. Evaluation uses independently labelled targets and scores target selection separately from XPath validity.
