# Saved-page instruction contract audit — 3 October 2026

## Result

The collection now admits **569 of 1,084 PhraseNode cases**, across **171 historical page families** (542 dev, 24 test, three train). It preserves **515 exclusions**: 288 evidence-insufficient, 218 ambiguous and nine incorrect expectations. Five of the nine contradict their source target semantics; four additional `found` expectations conflict with the Resolver instruction contract even though their source target identity is established.

The original archive, instructions, expected labels and splits remain unchanged. This audit changes admission metadata only. It supersedes the admission counts in the [target-uniqueness review](2026-10-03-target-uniqueness-audit.md).

## Defect and complete review

The saved-page runner uses `ActionSelectionStrategy.Prompt` and its response parser. It therefore enforces the same one-interaction and current-state contract as Resolver. Grading target identity alone does not make the inference task independent of that contract: a correct whole-request refusal cannot satisfy an imported `found` expectation.

Every one of the 573 previously admitted instructions was reviewed against that boundary, with its actual prepared target evidence. Four expectations were excluded:

| Case                                  | Contract conflict                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `phrasenode-8ce0f0a35e3a211b6ecf2b6c` | Explicit click followed by typing requests two interaction types.                     |
| `phrasenode-b76341fc965bef0ed5ad91a6` | Explicit click and subsequent reading requests an interaction followed by inspection. |
| `phrasenode-cfd8f30e605d1cb66e9ecd54` | Explicit scrolling is unsupported by the shared selection prompt.                     |
| `phrasenode-f5e6ce69026685a8ec5828fb` | Scrolling before locating and clicking a target requires a future page state.         |

These are invalid expected outcomes for this evaluator, not newly discovered source-node mapping errors. We preserve their original labels and exclude them rather than inventing unsupported-result labels from the source dataset.

The review does not classify every navigation purpose as a workflow. A current link, menu opener or Load more control can be identified by its purpose without requesting a second target after navigation or reveal. Action words within a control's name do not add interactions. Purpose clauses such as clicking a control to read its destination differ from explicitly requesting click and subsequent inspection. Borderline interpretations are recorded in the private decisions. Native option existence and value validity remain outside the documented readiness contract; a missing option does not invalidate an otherwise identifiable selection control.

## Evidence and retained attempts

The [public summary](../assets/evaluation/contract-admission-audit.json) binds the three complete review partitions and the four exclusions. Every reviewed record in the [label manifest](../../evaluation/datasets/label-review.json) carries its contract disposition and private decision hash alongside the existing imported-input, expected-label and prepared-input hashes. Private evidence contains case-specific reasons; public files omit raw page payloads and instructions.

The reviewed source is `105d6c57840bdcd3666f2e44066e6945883d588c`. Combined private evidence SHA-256: `33f5062838e9a2f22caac6b24953ad5e051da2442b3814ec53066912f3f3f5a9`.

The affected saved-page study stopped scheduling and drained at **1,563 of 1,719 attempts**. Built-in replay verified all retained results, with no pending provider calls and no unknown charges; reported cost was **$1.110387776**. Original outcomes remain diagnostic evidence under their original labels. The earlier stopped runs and completed 183-case browser cohort remain separate and unchanged. Further paid comparison waits for this correction to merge into main and uses a new frozen saved-page cohort.

Admission now checks source reconciliation, target semantics, actual prepared evidence, competing targets and compatibility of the expected outcome with the shared instruction contract. Review judgments still do not establish perfect labels or unseen-data generalization.
