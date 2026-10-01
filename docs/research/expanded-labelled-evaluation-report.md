# Expanded original-labelled evaluation

2026-10-01. Follow-up to [issue #50](https://github.com/Mochib-Tech-Solutions/xpathed/issues/50).

## Selection

The frozen candidate pool contains 1,000 previously unselected original PhraseNode development records across 182 page families and 672 distinct source target nodes. The earlier comparison used 191 reviewed cases from 40 families. The new selection excludes all 200 previously reviewed cases plus two prior privacy exclusions; a later request-level audit removes three identical inputs under different source IDs. The final run does not repeat prior paid requests or mix old timings into its results.

The import contains 3,719 eligible development cases across 183 families. Removing those 202 previous records leaves 3,517 cases across 182 families. Selection includes every remaining select target and literal color-word case, then fills the least-represented families first. Within each family it prioritizes rare control types, unnamed targets and lexical cues, breaking ties with SHA-256 ranks seeded by 47. No model outcome determines inclusion. The remaining 2,517 cases form a retained reserve queue; they are not approved inputs or completed tests.

| Candidate coverage                         | Count |
| ------------------------------------------ | ----: |
| Links                                      |   483 |
| Inputs                                     |   326 |
| Buttons                                    |   156 |
| Selects                                    |    35 |
| Targets without text, label or placeholder |   231 |
| Pages with at most 100 candidates          |    43 |
| Pages with 101–250 candidates              |   200 |
| Pages with 251–500 candidates              |   335 |
| Pages with more than 500 candidates        |   422 |

The selected instructions contain 47 spatial, 61 ordinal, five color-word, 21 plural-word and 179 input-verb matches. These overlapping lexical counts describe sampling, not independently labelled actions or visual behavior. Original instructions and singleton target IDs remain unchanged. Missing appearance or geometry is a representation limitation; it is not silently supplied or treated as a verified visual label.

The [selection receipt](expanded-labelled-evaluation-selection.json) records hashes, case identities and coverage without publishing page text. The private preparation directory is `.artifacts/datasets/expanded-source-dev-1000/`; its source import and exact reviewed payloads remain outside Git and CI.

## Review and execution contract

Each complete sanitized page payload and original instruction/target pair receives independent review before provider submission. Demonstrable label mismatches, irreducible ambiguity, unsupported sequential workflows and privacy concerns remain recorded exclusions. Difficult unnamed or visual-reference targets stay in the denominator when their source labels are valid; weak representation alone is not a reason to remove them.

All 1,000 candidate records were reviewed before inference. The review approved 870 and excluded 130; seven approved records duplicate another prepared request and three duplicate previously attempted inputs. Removing those redundant calls leaves **860 distinct new requests across 180 families and 581 source target nodes**. This is 4.50 times the earlier 191-case sample and 4.50 times its 40-family coverage, not 4.50 times as many independent observations. The original test split remains unused by this expansion.

The final sample has 398 link, 287 input, 143 button and 32 select cases; 203 targets are unnamed in the serialized representation. Candidate-count bands contain 39 / 178 / 304 / 339 cases for ≤100 / 101–250 / 251–500 / >500 candidates. Overlapping lexical counts are 43 spatial, 49 ordinal, four color-word, 18 plural-word and 145 input-verb cases. No replacements were selected after observing model results; the reserve queue remains unused. Review exclusions and duplicate-source mappings remain separate from model failures.

This expansion uses the existing offline runner, selected standard DeepSeek V4.1 Flash/Wafer profile and baseline version-7 prompt, with one attempt per accepted case. It does not rerun the four-model comparison or introduce another prompt. Whole-response target correctness is stricter than merely containing the gold node among extra guesses. Original source labels do not establish action, readiness, XPath, current-viewport or full plural-set correctness.

The current-view contract-4/prompt-8 baseline remains the separate [measured browser experiment](viewport-baseline-report.md). The fixed offline representation omits archived coordinates, and original labels do not establish viewport eligibility or readiness. The records cannot become a viewport benchmark by assuming every candidate is visible. This exposed development sample is not a fresh holdout or release qualification. Its deliberately different composition also prevents treating a raw score change from the old sample as a model improvement.

## Budget

[PR #51](https://github.com/Mochib-Tech-Solutions/xpathed/pull/51) raised the existing cumulative campaign ceiling to $10. The authoritative ledger migration preserved all 1,529 entries byte-for-byte in their JSON representation: entry SHA-256 `2f0dcd0c00560c7f2d4108fe67b962ba8e3084a9f92a4f03af69ba5767e85137`. Initial consumption was $2.0351258258, leaving $7.9648741742. This includes $0.014334 of previously reviewed unknown-charge reservations; these remain distinct from reported provider charges.

At the 2026-10-01 preparation snapshot, the pinned route advertised $0.05 per million input tokens and $0.60 per million output tokens, with no per-request charge. The exact prepared-request maximum for all 1,000 candidates was $8.258884194, including the full output allowance, framing and allocation headroom. This is a conservative reservation bound, not an expected bill or permission to exceed the remaining campaign.

Only reviewed inputs can run. Each bounded batch must fit the reconciled remaining ledger using fresh route rates and exact prepared requests; each actual request separately reserves its maximum before inference. Reported costs release unused capacity for the next batch. Unknown charges, identity failures and accounting failures stop continuation; original failed attempts are never retried or removed. No priority serving or scheduled paid CI is introduced.

## Measurement status

Preparation and independent review are complete; paid execution has not started. The final report will retain reviewed exclusions, achieved coverage, every original attempt, reported costs and separate timing scopes. Offline elapsed time includes request preparation, child-process startup and inline GitHub budget accounting; it is not browser HTTP or UI latency.
