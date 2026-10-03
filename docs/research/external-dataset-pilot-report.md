# External dataset pilot — 2026-09-30

Issue: [#7](https://github.com/Mochib-Tech-Solutions/xpathed/issues/7). These are observed local results, not release qualification or a model comparison. Source assets, reviewed payloads and detailed run artifacts remain in ignored private storage. The [evaluation guide](../evaluation.md) documents source acquisition, attribution, import, review, execution and retention.

## Source accounting

| Source                                         |      Original records |                    Offline eligible | Remaining records                                                           | Original splits                        |
| ---------------------------------------------- | --------------------: | ----------------------------------: | --------------------------------------------------------------------------- | -------------------------------------- |
| PhraseNode command corpus with processed pages |                51,663 |                              36,404 | 14,965 source-equivalence review required; 294 accessibility-hidden targets | Train 36,078 / dev 5,334 / test 10,251 |
| Pinned Mind2Web `train_10` pilot shard         | 49 actions in 9 tasks | 1 independently reviewed adaptation | 48 require independent instruction adaptation                               | Train only; not the full corpus        |

PhraseNode eligible counts are train 25,426, dev 3,719 and test 7,259. Inputs deduplicate to 1,810 page representations. Historical browser replay eligibility is zero for these imports: historical layout, state and readiness cannot be established from these assets.

Mind2Web authors used task intent and current-page semantic controls with target annotations, operation labels and gold action descriptions hidden. Independent review compared their frozen proposals with the original target and operation. Proposals that guessed a different interaction or insufficiently distinguished an annotated descendant from its parent control were rejected, not rewritten using the answer. The accepted NFL Scores/Schedule anchor preserves original task/action IDs and its exact raw target. This small accepted subset is adaptation evidence, not a representative benchmark.

## Browser identity pilot

A sanitized derivative of one actual PhraseNode training page preserved the independent source-node mapping. The source `xid=12` maps to one reconstructed anchor. The real Browser and Resolver returned an XPath that identified that exact node: **1/1 target correct**, zero wrong targets. No page action was executed. The controlled `click` is a browser identity probe, not a source-annotated PhraseNode action label.

The fixture removes scripts, network assets and form values; styles and some document wrappers change. Its results prove identity in the derivative document, not historical geometry or readiness. The durable run manifest retains fixture/source hashes without the fixture tree. A separate real-browser shared-action scenario verified both intended approval buttons, including the disabled button, with one shared action and one XPath per target.

Private evidence: `.artifacts/evaluation/phrasenode-derived-pilot` and `.artifacts/evaluation/v3-plural-reviewed`.

## Offline pilots

The diagnostic lexical baseline selected 4/30 PhraseNode targets and 0/1 adapted Mind2Web target. Both runs exited nonzero and retain every attempted case. They validate failure accounting and report plumbing, not model quality. These are the final sanitized imports; earlier development runs are not the reported baseline.

Three reviewed PhraseNode training inputs from one public page family were sent to standard `deepseek/deepseek-v4.1-flash` through the pinned `wafer` route. The baseline prompt, schema, 4,096 maximum output tokens, reasoning disabled, provider fallbacks disabled and provider price caps were recorded. There were no retries.

| Observed measure                      |                  Value |
| ------------------------------------- | ---------------------: |
| Intended targets                      |                    3/3 |
| Input / output / reasoning tokens     |        6,670 / 143 / 0 |
| Provider-reported cached input tokens |                    512 |
| Reported total cost                   |          $0.0005843742 |
| Estimated total cost                  |           $0.000599683 |
| Provider latency p50 / p95            |   924.92 / 1,050.93 ms |
| CLI end-to-end latency p50 / p95      | 1,304.70 / 1,483.59 ms |

The persistent ledger retains all three reservations and reconciled reported charges against the **$5 total initial ceiling**. No fast/priority tier was requested. The saved effective request contains a prompt ceiling of $0.0749/million tokens, completion ceiling of $0.70/million and zero request fee. Current endpoint metadata was fetched immediately before the run; the saved metadata is historical evidence, not a future price promise. [OpenRouter provider price caps](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx)

The report extrapolates mean observed tokens at those recorded prices: approximately $5.08 for all eligible PhraseNode training records, $0.74 for dev and $1.45 for test, one attempt each. **This one-family pilot is not representative enough to authorize those runs or establish a reliable full-corpus budget.** Larger pages, failures and repetitions can substantially change the totals. No dev/test inference occurred, no full-corpus paid run was started, and the initial $5 ceiling was not increased. Issue #9 must select a diverse reviewed screening sample and reforecast before broad comparisons.

## Reproduction and limits

The current private imports are `.artifacts/datasets/phrasenode-private-import` and `.artifacts/datasets/mind2web-private-import`. Their manifests record source URLs/checksums, transformation version, original splits, derived-case/inventory hashes and per-case reasons. Mind2Web review provenance is in `.artifacts/datasets/mind2web-reviewed-sources.json`; PhraseNode provider review is in `.artifacts/datasets/phrasenode-private-reviewed-inputs.json`. Recreate inputs through the guide's pinned fetch/import commands and repeat the independent review before replacing those files.

```sh
pnpm evaluate:dataset --import .artifacts/datasets/phrasenode-private-import --output .artifacts/datasets/new-phrase-diagnostic --split train --limit 30 --seed 1
pnpm evaluate:dataset --import .artifacts/datasets/mind2web-private-import --output .artifacts/datasets/new-mind-diagnostic --split train --limit 30 --seed 1
pnpm evaluate -- --suite .artifacts/datasets/phrasenode-browser-suite.json --output .artifacts/evaluation/new-derived-pilot
pnpm evaluate -- --case single-action-plural-confirmations --output .artifacts/evaluation/new-plural-pilot
pnpm evaluate:dataset --replay .artifacts/datasets/phrasenode-live-pilot
```

The live launch was the following explicit command. Repeating it bills another attempt against the existing ledger; replay does not.

```sh
pnpm evaluate:dataset --import .artifacts/datasets/phrasenode-private-import --output .artifacts/datasets/phrasenode-live-pilot --split train --mode live --limit 3 --budget-usd 5 --reviewed-inputs .artifacts/datasets/phrasenode-private-reviewed-inputs.json
```

Saved live aggregates were replayed exactly without another provider call. Correctness/latency qualification thresholds remain unset, so qualification is incomplete even for the three passing requests. No default model was changed. Multi-target quality cannot be inferred from these single-target source labels; the separate controlled shared-action tests cover the application contract. Color-relative commands remain a representation gap until appearance information is explicitly supported and evaluated.
