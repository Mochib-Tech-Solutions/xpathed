# Prepared model input audit — 3 October 2026

**Superseding semantic review:** The [full target-uniqueness recheck](2026-10-03-target-uniqueness-audit.md) now admits **573 cases** with **511 exclusions**. The counts below record the earlier prepared-input audit. Its hash checks remain in force; unchanged bytes alone do not establish unique answerability.

## Result

The initial label review missed a later boundary: the offline Resolver sanitizes each string after loading the reviewed imported input. That can erase a valid instruction or target name. The collection now admits **665 of 1,084 imported cases**, with **419 explicit exclusions**: 276 lack necessary evidence, 138 are ambiguous and five have contradictory expectations. The admitted cases span 177 historical page families (636 dev, 26 test, three train).

All 671 previously admitted inputs were passed through the exact recorded Resolver image using `--evaluate-offline /dev/stdin --prepare-only`, with eight workers and networking disabled. No provider credentials or model calls were used. The output was compared recursively with the reviewed imported input:

| Observation                                  |   Cases | Review outcome                                                                                   |
| -------------------------------------------- | ------: | ------------------------------------------------------------------------------------------------ |
| Input unchanged                              |     540 | Existing semantic review still applies.                                                          |
| Input changed but remains answerable         |     125 | Required names, scope, ordering and competing controls were reviewed against the prepared input. |
| Essential instruction or target text removed |       6 | Quarantined as evidence insufficient.                                                            |
| **Previously admitted inventory**            | **671** | **Every case has a prepared-input record.**                                                      |

Across the 131 changed inputs, four instructions and five expected-target records changed; those groups overlap. A changed footer, unrelated credential field or URL alone does not invalidate a case. Every changed case received an individual review. Scoped London controls, article ordering, newsletter inputs, domain search and repeated purchase links were checked using the retained groups and alternatives.

## Cause and corrections

`OfflineSelectionEvaluation.Text` calls `DiagnosticSanitizer.SanitizeText` for the instruction and every candidate string. The sanitizer replaces a whole string containing credential keywords or token patterns; otherwise it removes sensitive URL components and can normalize URLs. Ordinary page words can therefore trigger redaction even when no actual credential value is present. This audit preserves that privacy behavior.

The six newly quarantined cases are:

| Case                                  | Lost evidence                                 |
| ------------------------------------- | --------------------------------------------- |
| `phrasenode-333297f31fe7b0e96f53d0a8` | Instruction and target name.                  |
| `phrasenode-5b1750516271e1f6d33210b3` | Instruction and target placeholder.           |
| `phrasenode-7b4b5825bb7a0481d179d3c8` | Only target name and relevant policy context. |
| `phrasenode-ce0b109cdc1367f754bdd855` | Instruction.                                  |
| `phrasenode-cf9c72b50166f1092d22af76` | Instruction and target name.                  |
| `phrasenode-f46b2456df9a2665551e4910` | Only target name.                             |

The original archive and labels remain unchanged. The pinned label manifest now binds every admitted case to its prepared-input hash as well as its imported-input and expected-label hashes. The host checks the actual `--prepare-only` output before inference for both candidate and release baseline. Missing or changed prepared hashes block the provider call, retain the rejected preparation and stop new inference. Candidate-ID presence alone cannot pass this check.

A separate controlled-case follow-up clarified **“Hover over the Member code field.”** The earlier wording named both a visible label and its associated textbox without choosing between them. The expected textbox and readiness stay unchanged; original wording and completed attempts remain recorded in the [browser audit](2026-10-03-browser-label-audit.md#follow-up-member-code-hover-instruction).

## Evidence and study boundary

The source revision used for preparation was `f5497d319ea8819be1da78268d9bec2bd009b412`; the Resolver image was `sha256:e79c32348608fbdfbdf949002e94624657f8313c3211806833f6012984cce1d2`. The [sanitized audit summary](../assets/evaluation/prepared-input-audit.json) records hashes of the private per-case preparation and decision evidence. The [label manifest](../../evaluation/datasets/label-review.json) records all dispositions and per-case bindings. Private inputs remain under ignored artifacts.

The first advisory-hints study stopped and drained at 949 of 2,562 planned attempts when its instruction-preservation guard detected the redacted instruction. All original attempts, charges and missing attempts remain retained. Those partial results are diagnostic evidence, not a complete accuracy comparison. The clarified hover wording and revised collection require a separately frozen comparison; they must not silently replace old cases or turn original failures into passes.

Prepared-input checks establish what evidence reaches the model. They do not prove a model will interpret it correctly, make the imported cases current-view browser tests, or certify the collection as error-free. Future preparation changes require review of the changed prepared inputs before they are admitted.
