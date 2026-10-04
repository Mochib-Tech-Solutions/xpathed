# Evaluation figures

## Recorded comparison and refresh

The checked-in `clean-comparison.json` and SVG describe the refreshed comparison in the [current report](../../research/clean-evaluation-comparison.md). The complete browser arms, both saved-page arms and controlled XPath run share their recorded source, collection and grading boundaries.

`comparison-2026-10-03.json` and SVG preserve the earlier measured configurations and frozen collection in the [historical report](../../research/comparison-2026-10-03.md). Supplementary [spatial pipeline evidence](../../research/spatial-item-selection.md) remains separate.

After all runs complete, export the browser comparison, both Saved-page selection arms and the controlled XPath run:

```sh
uv run docs/assets/evaluation/clean-comparison-plot.py BROWSER_RUN BASIC_SAVED_RUN IMPROVED_SAVED_RUN XPATH_RUN
```

This provider-free command writes `clean-comparison.json` and `clean-comparison.svg`. It requires live-provider evidence, exactly one retained original attempt per planned case and arm, the complete current browser case definitions, matching saved-page inputs and labels, and the complete currently admitted saved-page collection. The six deterministic browser compatibility trials are separately bound and excluded from inference counts. It rejects missing or extra trials, changed manifest hashes, reused provider records, unverified successful provider identities and response-cache hits. Recorded browser common/full grades and saved-page grades must exactly match the existing graders under the recorded grader hashes; counts and charges must match saved summaries. Completed operational failures remain in the denominator, including a failed final attempt that stopped further scheduling; missing attempts and integrity failures block export.

The JSON retains original outcome IDs, evidence hashes, failure categories, separate browser common/full-contract/target-only scores, paired gains and regressions, unknown charges and separate timing cohorts. Only explicitly unsupported browser instructions leave the target-only denominator. Raw instructions, candidates, requests and responses remain private. Stagehand has no saved-page arm and is shown as unavailable. The graph shows browser action-and-target correctness and saved-page exact-target correctness separately; neither is a combined score or release approval.

The browser directory must retain `basic-runtime-receipt.json` and `basic-bundle-lineage.json`. Their allowlisted source, native image and adapter-file hashes bind the executed Basic adapter to the projected bundle without publishing raw payloads.

A continued browser run must retain its hashed amendment and complete parent evidence snapshot. Original attempts must remain byte-identical; timing groups follow the amendment’s retained/pending partition. The saved-page directories must share the frozen launcher plan, helper hashes, amendment test receipts and preparation records. Saved-page continuation receipts must also bind every copied original trial and provider record, preserve the disjoint retained/pending partition, and identify each trial’s execution cohort. Both tracks must bind the same native Resolver images.

The fourth input is the completed XPath construction and verification run. The exporter checks it against the current XPath case selection, replays the existing grader and retains trial hashes, pass counts and saved-locator/fresh-resolution counts separately. It performs no provider calls.

The generator pins Matplotlib and writes an accessible SVG plus a temporary PNG preview. Review the preview after exporting. It updates only the new clean-comparison files; historical reports and figures below remain unchanged.

## Current model figure

`model-comparison.json` and SVG describe the [4 October current-Resolver model comparison](../../research/model-comparison-2026-10-04.md). DeepSeek references the refreshed Improved evidence above; Luna uses the same runtime, prompt/schema, cases and reviewed inputs. Gemini is configuration-incompatible and has no accuracy estimate. Saved-page first-attempt totals include provider-limit refusals, displayed directly in both figures.

The model aggregate binds all 380 original browser attempts and all 569 Luna saved-page attempts, paired outcomes, source/image identities, collector/exporter hashes and unavailable accounting. The private collector's common-grader envelope omitted `strategy` and the call count; reconciliation restores only the documented `custom` strategy and retained native diagnostics count, while preserving original evidence and full-contract grades. Actual native request parity and prepared-input review bindings are verified before export. Model regeneration uses the retained private calculation helpers identified by their hashes; no application or checked-in tooling changes were needed.

For this refresh, Basic's container receipt was taken during explicitly labelled post-completion image restoration. A complete hash snapshot verifies that every original manifest, trial and provider record remained unchanged. The aggregate retains this receipt phase rather than presenting it as contemporaneous measurement evidence.

## Historical figures

The figures compare two configurations on identical browser cases. Offline results are stored separately in the same aggregate data file.

- `paired-outcomes.svg`: retained passes, gains, regressions and shared failures.
- `category-results.svg`: all eight browser behavior categories, with passing/total counts and a shared 0–100% color scale.
- `configuration-comparison.json`: saved grades, configuration identities, latency, available charges and evidence hashes. Raw inputs and provider responses remain private.

Case membership follows the frozen run plan. Every planned case must have both original attempts before exporting a complete comparison. Categories come from `evaluation/cases/index.json`; historical fixture-family names are retained only as provenance.

## Rebuild

```sh
uv run docs/assets/evaluation/plot.py
```

The script pins Matplotlib, checks totals against individual grades and writes the SVGs here. PNG previews go to the system temporary directory. It performs no inference. Review both figures after changing data or layout.

The [comparison report](../../research/configuration-comparison.md) records the configurations, results, commands and measurement limits.
