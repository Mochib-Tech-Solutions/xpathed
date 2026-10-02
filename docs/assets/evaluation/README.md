# Evaluation figures

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
