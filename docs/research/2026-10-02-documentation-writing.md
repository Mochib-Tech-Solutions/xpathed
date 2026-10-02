# Writing xpathed for a technical reviewer

Research date: 2026-10-02. This note records the writing approach for the internship case study. It is editorial guidance, not a change to the product contract.

## What the reader needs

The supplied assignment asks for a working natural-language-to-XPath prototype, architecture, evaluation and deployment, followed by trade-offs and strategic direction. Architecture and evaluation each account for 40% of the assessment; leadership and strategy account for 20%. The documentation should let a reviewer understand the answer, run the prototype and inspect the evidence without reconstructing the project from issue history.

The previous README already contained useful implementation details. Its opening mixed session behavior, keyboard shortcuts, highlights, costs, frame handling and historical results in one long paragraph. The core design appeared much later: a model selects targets from page evidence; application code builds and verifies their XPath expressions. Setup, contributor conventions and release operations competed for attention. These are observations from the README reviewed for this rewrite.

## Principles from primary sources

### Make the README an entry point

GitHub describes the README as the visitor's introduction: what the project does, why it is useful and how to start. It recommends moving longer documentation elsewhere and using relative links within the repository. For xpathed, the README should answer those questions first, then link to the engineering explanation and existing operating guides. A full command inventory and versioned contract belong in their reference documents. [GitHub: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

### Explain for someone who has never seen the repository

Google's technical-writing guidance starts with the reader's existing knowledge and intended outcome. It recommends stating the document's scope, summarizing the main points early and organizing around the audience's questions. Assume a reviewer understands software engineering but needs an explanation of xpathed's browser ownership, target selection and verification boundary. Define unfamiliar terms when introduced. [Google: Audience](https://developers.google.com/tech-writing/one/audience), [Google: Documents](https://developers.google.com/tech-writing/one/documents)

### Give each document a clear job

Diátaxis separates learning, task completion, reference and explanation. Its explanation guidance explicitly includes constraints, history, alternatives and reasons for decisions. Apply that distinction using the repository's existing files: the README introduces and starts the project; the engineering article explains decisions; runtime and resolution docs define behavior; evaluation and release guides explain how to operate those workflows. Link between them instead of copying entire sections. [Diátaxis: Start here](https://diataxis.fr/start-here/), [Diátaxis: Explanation](https://diataxis.fr/explanation/)

### Give the article a concrete promise and a worked example

Netlify's first-party authoring guidance recommends a descriptive title, a short introduction explaining relevance, an early summary, practical examples and useful next steps. For xpathed, open with an instruction from the assignment and the problem it creates: an element can have the right text while still being the wrong target. Follow that example through capture, selection, XPath construction and verification. Label illustrative HTML and outputs so readers do not mistake them for measured runs. [Netlify: Guidance for writing a guide](https://developers.netlify.com/guides/contributing-to-the-netlify-developer-hub/#guidance-for-writing-a-guide)

### Give each diagram one takeaway

Google recommends deciding the caption first, limiting visual complexity and separating overview diagrams from subsystem detail. It also recommends SVG for scalable diagrams. Use separate views for service ownership, one resolution request and evaluation-to-release flow. Label arrows with what crosses each boundary. Keep an explanatory sentence beside each diagram. [Google: Illustrating](https://developers.google.com/tech-writing/two/illustrations)

### Keep the explanation accessible

Use real headings in order, meaningful link text, short paragraphs and image alternatives. Essential information must also exist as text. Diagrams should remain understandable without color; the banner should introduce the project without carrying facts that exist only in the image. Inspect the rendered page at a normal reading width. [Google: Write accessible documentation](https://developers.google.com/style/accessibility)

## The narrative to use

The following structure is an application of the sources, tailored to this assignment:

1. **The problem:** translate an instruction into the intended element on the open page.
2. **The central decision:** let the model interpret intent; let the browser establish identity and verify the XPath.
3. **One request:** trace a concrete example through the actual services, including what happens when the target is ambiguous or missing.
4. **The difficult cases:** explain changing pages, repeated labels, frames, visibility and action readiness through their consequences.
5. **Choosing models:** explain what was compared, under which settings, what was measured and why the current configuration followed.
6. **Establishing reliability:** explain independent labels, browser verification, mutation checks, failures and saved evidence.
7. **Releasing changes:** distinguish source checks, live comparison, image approval, activation and monitoring.
8. **What comes next:** describe proposed integration and expansion with clear boundaries and measurable outcomes.

The story should follow decisions and their consequences. A commit-by-commit diary would make the reader do the synthesis.

## Evidence rules for this case study

These are project-specific editorial checks:

- Link implementation claims to the owning source or contract. Link historical choices to dated research or decisions.
- Attach dataset scope, denominator, model/provider settings and date to benchmark claims. Keep offline selection accuracy separate from full browser results.
- Explain what verification proves: uniqueness and same-node identity do not demonstrate that an interaction completed successfully.
- Distinguish measured results, accepted design, configured workflow and verified operation. A workflow file alone does not prove a deployment happened.
- Preserve failed attempts and unavailable cost information. Describe limitations next to the affected result.
- Say why a choice fit this prototype. Avoid unsupported claims of universal superiority, production readiness or completed the test platform integration.

Before finishing, check that a reviewer can find the demo, the design decision, model-selection evidence, evaluation limits and run commands directly from the README. Check local links, image rendering and claims against the repository. Keep detailed operational instructions in the guides that own them.
