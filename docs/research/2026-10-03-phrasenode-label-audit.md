# PhraseNode expectation audit — 3 October 2026

**Current admission:** The [instruction-contract audit](2026-10-03-contract-admission-audit.md) admits **569 cases**, with **515 explicit exclusions**.

**Superseding reviews:** The initial review below admitted 671 cases. The [runtime-boundary audit](2026-10-03-prepared-input-audit.md) reduced admission to 665. The [full target-uniqueness recheck](2026-10-03-target-uniqueness-audit.md) previously admitted **573 cases** and preserved **511 exclusions**. Counts and examples below describe the initial review; subsequent decisions take precedence.

## Result

The pinned collection reproduces its original source annotations correctly, but those annotations are not all valid singleton expectations for the retained saved-page input. All **1,084 cases across 192 page families** received a source-and-input semantic disposition. **671 cases across 177 families** have supported target expectations; **413 cases** remain excluded from accuracy evaluation under the current input representation.

| Disposition              |     Cases | Meaning                                                                                                     |
| ------------------------ | --------: | ----------------------------------------------------------------------------------------------------------- |
| Validated                |       671 | The reviewed instruction, original target and retained alternatives support the expected singleton target.  |
| Evidence insufficient    |       270 | Necessary target identity, type, association, visual evidence or context is absent from the retained input. |
| Ambiguous                |       138 | Multiple plausible targets or interpretations remain; the original singleton is not uniquely justified.     |
| Incorrect                |         5 | Original target semantics contradict the requested target or interaction.                                   |
| Unresolved               |         0 | No cases remain without a disposition in this review.                                                       |
| **Original denominator** | **1,084** | **Every case remains recorded, including all exclusions.**                                                  |

These are review outcomes, not fresh model accuracy measurements or a claim that the dataset is error-free. The original archive, instructions and expectations were preserved. No source labels were silently replaced, and no paid inference was needed for this audit.

The complete sanitized per-case record is [label-review.json](../../evaluation/datasets/label-review.json). Each record binds its disposition to both the exact input hash and expected-label hash. [The audit summary](../assets/evaluation/phrasenode-label-audit.json) records mechanical checks, risk signals and hashes of the private evidence. Accuracy consumers must admit only validated entries with matching bindings and retain the complete exclusion denominator.

## Evidence identity

- Source revision inspected: `b4e29819d1d7ef406b4b879779fca2da96a367c8`.
- Collection: `reviewed-72d140c1.json.gz`.
- Archive SHA-256: `72d140c1c5d4ef9032277ce9422f6f4039c6c864f166b3a6572078576db82d86`.
- Importer SHA-256: `71be874c994b99f029fe2c7be55242b8ac214419c247ec54a232cd113fed33ca`.
- Source material: 195 local source files containing command annotations and processed archived page records.
- Import behavior: [PhraseNode adapter](../../evaluation/datasets/import.mjs).

Private evidence stays under ignored artifact directories. It includes the source command line, original target identity, source target attributes, retained target and competing candidates. The public manifest contains no raw instructions or page payloads. Its `evidenceHash` is SHA-256 of `JSON.stringify` applied to the corresponding private disposition record. The summary binds the complete private semantic and mechanical files separately.

## Mechanical reconciliation

Every case passed all 15 checks independently replayed against the source files and current adapter:

1. Command source hash and page source hash.
2. Original annotation identity, case identity and page family.
3. Exact instruction preservation.
4. Unique original target `xid` and singleton source equivalence set.
5. Adapter target eligibility and original-to-imported target mapping.
6. Exact candidate replay.
7. Review input hash and imported input hash.
8. Unique candidate IDs and existence of the expected target.

The numbered groups above contain 15 individual checks, each with denominator 1,084 and zero mismatches. The original annotation uses `xid`; source hierarchy references use a separate `ref`. Reconciliation followed `xid` through the actual adapter filters instead of treating either source array position or `ref` as target identity.

No byte-provenance, target-mapping or candidate-replay defect was found. This establishes faithful import, not semantic correctness. Existing provider-submission/privacy review metadata did not certify unique answerability and sometimes explicitly retained ambiguous or missing-evidence examples.

## Semantic review method

The collection was sorted by family and case ID and partitioned into disjoint ranges covering every case. Each review considered the instruction, original source target, imported expected candidate and plausible alternatives. Source parent, child and sibling records helped verify what the annotation originally pointed to. Full retained candidate groups were inspected when names, ordinal references or scope needed more evidence than a compact target neighborhood supplied.

Lexical candidate matching was used to find alternatives, not to generate validation decisions. A supplementary equal-name scan checked validated cases for competing controls. A source-valid target was not automatically validated when its identifying evidence disappeared during import. Conversely, duplicate names, missing geometry or unnamed targets did not automatically cause exclusion: retained named groups, control types and record order sometimes made the requested target unambiguous.

The scope is **saved-page selection**. This review does not certify current-view membership, live DOM state, action readiness, successful execution or later-page behavior. Native selection-control identity can be valid while an option choice or readiness question remains outside this grade. Model errors from previous runs were not treated as proof of a bad label.

## Main defects and limits

### Lost control names and types

The adapter retains a flat selection representation. Source input types, some image alternative text and explicit label relationships can be lost. A query-entry field and its submit control can therefore become identical unnamed input records. A faithful source target remains unanswerable when the model cannot distinguish those records.

Representative cases:

| Case                                  | Finding                                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `phrasenode-24e3e1a0f6eb0d960fbb3258` | Text entry and submit controls have indistinguishable retained records.                 |
| `phrasenode-b465f89f3ddae8aa31785288` | Expected home anchor loses its child logo name and competes with other unnamed anchors. |
| `phrasenode-a4f5c1349c38cdf95283908e` | Expected search input loses the source distinction from the adjacent search control.    |

An advisory classifier given the same retained input cannot reliably recover omitted source facts. Restoring safe evidence would require an explicit adapter change, renewed input/privacy review and new hashes; it must not be supplied only to one experimental arm.

### Genuine ambiguity

Repeated search forms, repeated navigation destinations and generic action requests often admit more than one plausible target. Original crowdworker selection alone does not establish that only one candidate is correct.

| Case                                  | Finding                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `phrasenode-94db5d85889e4a9fdbe880cd` | Two search fields satisfy an unscoped query-entry request.                                                    |
| `phrasenode-59f92834f28826a5f567eec9` | Account access and wallet navigation are different plausible interpretations.                                 |
| `phrasenode-a4af76563e2d96ce3e2094c2` | Wording combines entering credentials with a navigation control; the interaction is not uniquely established. |

These cases should remain excluded unless a separate reviewed correction establishes an appropriate expectation. Adding multiple accepted targets or rewriting instructions would change the task and must preserve the original label and rationale.

### Contradictory original labels

The five incorrect cases are individually recorded in the manifest:

| Case                                  | Contradiction                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `phrasenode-c6d70486f6952faddefe9d35` | Explicit field entry is labelled as a source submit input.                                             |
| `phrasenode-89fb785f497fc8a2c0bf4042` | Requested menu control is labelled as a home-navigation link.                                          |
| `phrasenode-f389d95f054151dbaf49a8b3` | Requested page refresh is labelled as a home-navigation link.                                          |
| `phrasenode-67936bceb62f48fadaadfbdf` | Requested account-information entry is labelled as navigation to another page.                         |
| `phrasenode-d176c745919904ce46d2064c` | Requested event-specific destination is labelled as general news despite a separate event destination. |

No replacement label was established by this audit. The correction is to stop grading these expectations as valid accuracy cases while retaining their original evidence.

### Preserved context can resolve difficult cases

The audit retained cases whose scope is recoverable from actual input evidence. It did not remove every repeated-name, positional or unnamed target.

| Case                                  | Retained evidence supporting validation                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `phrasenode-a6acefbc5cda58c355ef7ae6` | Aggregate article-list text and order distinguish the first article from its later duplicate link.             |
| `phrasenode-eb833767698dcee599447140` | A named popularity group and ordered list identify the first ranked article.                                   |
| `phrasenode-b0256ec066bb2d7bd0dc1178` | Named featured-picture group and the image-anchor sequence distinguish the picture link from its caption link. |
| `phrasenode-77d66a56e02bd0af296a6b8f` | Retained sponsor heading and link order establish the first unnamed sponsor anchor.                            |

## Screening signals are not dispositions

Mechanical risk counts overlap and must not be added together:

| Signal                                                   | Cases |
| -------------------------------------------------------- | ----: |
| Unnamed retained target                                  |   247 |
| Another target record with identical own-record evidence |   218 |
| Source type omitted                                      |   440 |
| Source link destination omitted                          |   533 |
| Alternative text omitted                                 |    92 |
| Label association omitted                                |    81 |
| Original target marked hidden                            |    18 |
| Nonpositive source bounds                                |     3 |
| Outside origin viewport                                  |   342 |

These counts identify review leads. Source scroll offset is unavailable, so the origin-viewport calculation is not current-view eligibility. A source hidden flag or an ancestor flag is not a verified runtime accessibility observation. Visibility and geometry flags therefore did not automatically exclude a case. Identical-record flags ignore contextual grouping, which was reviewed separately.

## Implications for the planned comparison

1. Freeze the validated manifest and its input/label bindings before model evaluation. Reject absent, changed or nonvalidated expectations.
2. Report 671 admitted cases and 413 excluded cases against the original 1,084, with family coverage and per-case exclusion reasons. Keep this separate from controlled browser-case denominators.
3. Keep historical full-collection scores as historical measurements; they used expectations this audit now questions. They are not the clean accuracy baseline for the repaired collection.
4. Compare the same fixed validated inputs across the current prompt, improved fixed prompt and improved prompt with advisory answers. Recovering omitted page facts requires a separate representation experiment and a new audit.
5. Review controlled browser labels independently. Source annotation reconciliation does not validate browser action/state expectations or the grader's behavior.

Zero unresolved dispositions means every case received a decision. It does not eliminate judgment uncertainty or establish that any model improvement has already been measured.
