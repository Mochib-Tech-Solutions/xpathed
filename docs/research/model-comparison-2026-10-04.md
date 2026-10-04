# Current Resolver model comparison — 4 October 2026

This refresh holds current runtime `d444176cd2351d85336167cd3b9e7b60114bf77e`, the prompt/schema, browser fixtures and all 569 reviewed saved inputs fixed while changing the model and pinned provider. It uses the same 190 browser cases as the [system comparison](clean-evaluation-comparison.md). DeepSeek reference results are reused for reporting, with no additional inference. No application model default changes.

**Saved-page provider-limit caveat:** DeepSeek retains 105 key-limit refusals and Luna retains 293. Scores include every failed original attempt; they cannot isolate model quality or support a model ranking. Gemini's current request configuration was rejected for all 190 browser cases, so it has no selection-accuracy estimate and no saved-page run.

## Results

| Model / pinned provider             | Browser action + targets                  | Saved-page first-attempt success |
| ----------------------------------- | ----------------------------------------- | -------------------------------- |
| DeepSeek V4.1 Flash / Wafer         | 176/190 (92.6%)                           | 376/569 (66.1%)                  |
| GPT-6 Luna / OpenAI                 | 183/190 (96.3%)                           | 249/569 (43.8%)                  |
| Gemini 3.8 Flash / Google AI Studio | Unavailable: 190 configuration rejections | Not run: incompatible settings   |

![Current Resolver model results with configuration and provider-limit caveats](../assets/evaluation/model-comparison.svg)

Browser full-contract success is **171/190** for DeepSeek and **182/190** for Luna. DeepSeek → Luna has **8 browser gains and 1 lost pass**. Saved-page first-attempt success has **37 gains and 164 lost passes**, including provider refusals; this is not a clean accuracy comparison. Paired case lists and original hashes are in the [aggregate](../assets/evaluation/model-comparison.json).

## Settings and compatibility

All profiles use standard pinned OpenRouter routes, provider fallback disabled, reasoning disabled and a 4,096-token allowance: `deepseek/deepseek-v4.1-flash` / `wafer`, `openai/gpt-6-luna` / `openai`, and `google/gemini-3.8-flash` / `google-ai-studio`. The observed Gemini route returned HTTP 400 stating that reasoning is mandatory. Its 190 operational failures are retained; showing 0/190 as model accuracy would misrepresent configuration rejection. Enabling reasoning would change the application contract and was outside this documentation-only refresh.

Official route metadata was captured on 4 October: [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints), [Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints), [Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints). Supported-parameter metadata alone did not establish whether reasoning could be disabled; retained actual responses provide the compatibility result.

## Accounting and timing

| Category / profile   | Original requests | Known reported USD | Unreported charges | Key-limit refusals |
| -------------------- | ----------------- | ------------------ | ------------------ | ------------------ |
| browser / deepseek   | 190               | $0.02724589        | 0                  | 0                  |
| browser / luna       | 190               | $0.02398588        | 0                  | 0                  |
| browser / gemini     | 190               | $0.00000000        | 190                | 0                  |
| savedPage / deepseek | 569               | $0.32830161        | 105                | 105                |
| savedPage / luna     | 569               | $0.40805897        | 293                | 293                |

Across both reports there are **2,657 unique original provider requests**, **$1.13871907 known reported cost** and **703 unreported charges**. This counts shared DeepSeek results once. Gemini rejections and key-limit refusals have unavailable billing metadata, not proven zero charges. No original attempt was retried or replaced.

| Profile / category | Cohort                 | Median | p95    |
| ------------------ | ---------------------- | ------ | ------ |
| luna / browser     | interleaved-two-models | 1.446s | 2.378s |
| gemini / browser   | interleaved-two-models | 0.203s | 0.288s |
| luna / savedPage   | parallel-arms          | 0.280s | 2.423s |

DeepSeek browser timings come from the separate concurrent three-system cohort. Luna/Gemini browser attempts are interleaved, serially, with identical per-case inputs and reset environments. Saved-page streams run concurrently, serial within each stream. Timings include fast refusals and do not establish the fastest model.

## Evidence and grading

The private model collector omitted `strategy` and the top-level model-call count in the common-grader envelope. Regrading restores only `strategy=custom` and the already retained native `diagnostics.modelCalls`; original requests, responses, trial files and full-contract grades are unchanged. The original recorded grades are verified and retained alongside corrected common scores. Actual native request inputs, system prompts and schemas match between paired browser models, including cases whose diagnostic input was redacted or omitted.

All planned 380 browser attempts and 569 Luna saved-page attempts are retained, with zero retries. Every saved-page input, expected label and prepared-input review hash matches the same admitted collection as DeepSeek. The actual native CLI request binding was checked locally before inference. The aggregate records original trial/provider hashes, collector/exporter identity, manifests, complete paired outcomes and explicit unavailable measurements. Raw payloads remain private. Provider identity, cache and evidence-integrity checks passed; billing availability does not affect grades.

These results are descriptive observations on one audited set. Browser gains do not establish unseen-site quality, release approval or a new preferred default. Saved-page provider refusals prevent a model-quality conclusion.
