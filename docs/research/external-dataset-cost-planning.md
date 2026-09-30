# External dataset evaluation cost planning

Checked 2026-09-30 for issue #7. No paid inference was performed. These are planning scenarios, not measured forecasts or an approved spending budget.

The maintainer subsequently rejected the $37–$127 full-corpus scenario as too expensive, especially when multiplied across models and prompt/processing variants. The accepted preference is speed, then target-resolution performance, then cost; inexpensive models must not be selected on price alone. Use small shared development samples and staged comparisons, preserving correctness requirements and expanding only promising configurations. A monetary budget and concrete live pilot remain to be agreed. Full-source inventory is separate from full-source inference.

## Separate preparation from model evaluation

Source inspection, local import, identity mapping, reconstruction checks, deterministic tests and saved-report replay require no paid model calls. They still consume local compute, disk and download bandwidth. The existing deterministic provider reports synthetic token usage; it cannot supply a measured full-suite cost forecast.

The checked-in live evaluation route is `deepseek/deepseek-v4.1-flash` through `wafer`. Its [public endpoint catalog](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints) currently reports $0.0749 per million input tokens and $0.70 per million output tokens, with a separate cached-input rate. The catalog lists structured output and reasoning controls as supported; this is availability metadata, not evidence that our external dataset pilot has run successfully.

## Illustrative arithmetic

Assume one completion per case, no retries or cache discounts, and 200 billed output tokens:

| Cases  | Input tokens per case | Estimated model cost |
| ------ | --------------------- | -------------------- |
| 50     | 8,000                 | $0.03696             |
| 50     | 32,000                | $0.12684             |
| 50,000 | 8,000                 | $36.96               |
| 50,000 | 32,000                | $126.84              |

Formula: `cases × repetitions × (inputTokens × 0.0749 + outputTokens × 0.70) / 1,000,000`.

These counts are scenarios, not assertions about either dataset's eligible records. Additional models, attempts and repetitions add cost. Output truncation, operational errors and billed failed attempts must remain in the accounting. Local Docker costs and hosted runner/storage costs are separate.

## Proposed sequence

1. Pin source revisions and checksums; account for imported, eligible, excluded and reconstruction-limited records by original dataset split.
2. Validate a small local pilot without provider calls. Measure payload sizes, but do not relabel bytes or synthetic usage as actual model tokens.
3. Review the exact sanitized provider payload, route and estimated budget before a paid pilot. Dataset reuse terms and provider handling are separate checks; [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection) and [provider routing controls](https://openrouter.ai/docs/guides/routing/provider-selection) describe available controls, not proof of account configuration.
4. Use the pilot's actual token distributions, billed attempts and reported costs to forecast the selected complete suites. Recheck endpoint rates before launch and preserve every attempt.

No full-corpus run or paid pilot has been authorized by this research note.
