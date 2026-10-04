# Evaluation figures

## Model selection, then approach comparison

First, the [complete model-selection comparison](../../research/model-comparison-2026-10-04.md) holds the enhanced Resolver, prompt/schema and inputs fixed at its recorded source. Gemini had the highest observed accuracy and became the application default. Its original `model-comparison.json` and SVG remain unchanged; they include the recorded Gemini reasoning adaptation and grading-envelope reconciliation.

Second, the [Gemini approach comparison](../../research/clean-evaluation-comparison.md) tests Basic, Improved (Enhanced) and Stagehand with Gemini / Google AI Studio, low reasoning and the same output allowance. The [presentation statistics](../../research/presentation-statistics.md) keeps the two measurements and their source identities separate. No additional DeepSeek/Luna refresh is included.

Regenerate the Gemini approach accuracy and duration figures from complete original evidence, without provider calls:

```sh
uv run docs/assets/evaluation/clean-comparison-plot.py SYSTEM_BROWSER_RUN GEMINI_SAVED_RUN/basic GEMINI_SAVED_RUN/current XPATH_RUN
uv run docs/assets/evaluation/comparison-figures.py
```

The exporter verifies browser and saved-page grades under the recorded graders, complete case/arm membership, original trials/provider files, pinned semantic input/label/prepared-input hashes, matched model/provider/reasoning/output limits, actual images and contemporaneous runtime receipts. Six provider-free Basic compatibility trials are bound separately and excluded from paid totals. The archived Basic Gemini request adapts only reasoning; both native/upstream request hashes are verified. Raw inputs, prompts, requests and responses remain private.

Missing or extra attempts, evidence drift, identity violations and response-cache hits block export. Completed provider failures remain failed outcomes and stay in denominators. Authentication/spending refusals prevent an affected run from replacing presentation accuracy; preserve its outcomes as separate operational evidence. Unavailable charges never mean zero cost. Billing availability does not alter grades. Retained provider-free XPath evidence replays separately under its recorded grader.

The accuracy figure keeps browser action/target and saved-page exact-target denominators separate. Target-only and full-contract scores, behavior categories, paired gains/lost passes and original evidence hashes remain in `clean-comparison.json`. Stagehand has no saved-page arm. The duration figure uses the conventional median (averaging the two middle durations for an even count) and nearest-rank p95. It includes every original attempt, reports unavailable measurements and keeps browser and CLI boundaries separate; its renderer rejects pooling multiple cohorts.

The exporters write `clean-comparison.svg` and `system-duration.svg`, with accessible descriptions and temporary PNG previews. Matplotlib is pinned. Review both previews before publishing. Retain original evidence and historical aggregate/figure bytes before replacing current assets.

## Retained completed and interrupted measurements

- `gemini-saved-key-limit-2026-10-04.json` retains the [original Gemini-default saved-page attempts with key-limit refusals](../../research/gemini-saved-key-limit-2026-10-04.md); full-set selection accuracy is unavailable.

- `comparison-2026-10-04-deepseek.json` and SVG retain the [completed DeepSeek system comparison](../../research/comparison-2026-10-04-deepseek.md).
- The `comparison-2026-10-04-interrupted` assets retain spending-limit refusals and other failures. Their run-success percentages are not model accuracy.
- `comparison-2026-10-03.json` and SVG retain the [3 October comparison](../../research/comparison-2026-10-03.md). Supplementary [spatial pipeline results](../../research/spatial-item-selection.md) remain separate.

Earlier receipt phases and reconciliation limitations remain attached to those historical measurements. Current runs have contemporaneous native runtime receipts and verified original grades.

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
