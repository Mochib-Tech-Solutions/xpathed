# Model evaluation cost estimates

Checked 2026-09-29. No inference requests or paid evaluations were run. Prices are a point-in-time planning input; model quality, latency, and structured-output compatibility remain unmeasured.

The updated user shortlist is GPT 6 Luna, Gemini 3.8 Flash and DeepSeek V4.1 Flash. See [fast-model-selection.md](fast-model-selection.md) for those exact routes and revised scenarios; the Gemini Lite and older DeepSeek estimates below are different configurations.

## Candidate rates

USD per million uncached tokens, using the lower context tier where applicable. All six IDs appear in the [public Zen catalog](https://opencode.ai/zen/v1/models). Rates and protocols: [Zen documentation](https://opencode.ai/docs/zen/#pricing).

| Model ID | Input | Output | Protocol |
| --- | ---: | ---: | --- |
| `gpt-6-luna` | $0.10 | $0.50 | Responses |
| `deepseek-v4-flash` | $0.14 | $0.28 | Chat Completions |
| `glm-5.3-flash` | $0.15 | $0.50 | Chat Completions |
| `qwen3.8-flash` | $0.15 | $0.47 | Messages |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | Gemini |
| `gpt-6-sol` | $2.00 | $10.00 | Responses |

The first five are inexpensive experiment candidates. The last is a higher-cost comparison. This selection does not establish a quality or speed ranking. A successful candidate must pass the same target-resolution and response-contract checks through its actual Zen connection.

## Cost model

Assumptions: one model call per case; no retries, cache discounts, browser costs, CI runner/storage costs, or taxes. Output tokens mean **total billed output**, including reasoning where billed, not merely the visible selected-element response. Actual tokenization varies by model. These are scenarios, not measured usage or upper bounds.

- Compact context: 8,000 input + 100 billed output tokens per case.
- Larger context: 32,000 input + 200 billed output tokens per case.
- 2,000 cases is an illustrative qualification-suite size, not a claimed public dataset split.
- 51,663 is the published PhraseNode command count, not a claim that all examples are eligible, restored, held out, or available for live XPath grading. [PhraseNode](https://nlp.stanford.edu/projects/phrasenode/)

`USD = cases × attempts × (input_tokens × input_rate + output_tokens × output_rate) / 1,000,000`

| Model | 2,000 compact | 2,000 larger | 51,663 compact | 51,663 larger |
| --- | ---: | ---: | ---: | ---: |
| GPT 6 Luna | $1.70 | $6.60 | $43.91 | $170.49 |
| DeepSeek V4 Flash | $2.30 | $9.07 | $59.31 | $234.34 |
| GLM 5.3 Flash | $2.50 | $9.80 | $64.58 | $253.15 |
| Qwen3.8 Flash | $2.49 | $9.79 | $64.42 | $252.84 |
| Gemini 3.5 Flash Lite | $5.30 | $20.20 | $136.91 | $521.80 |
| GPT 6 Sol | $34.00 | $132.00 | $878.27 | $3,409.76 |

Three attempts cost three times these amounts under identical assumptions. Comparing multiple strategies multiplies cost only when they actually use this same call/token pattern; Stagehand may use different prompts and call counts. Estimate its cost from recorded provider usage rather than applying this table unmodified.

Record tokens, all attempts, model-specific rates and estimated/billed cost per run. Replace the scenarios with measured mean and tail token counts after a small pilot. Forecast the full selected suite before running it; the user's current policy imposes no project spending cap.

## Reproduce the arithmetic

This uses only Python's standard library and makes no network requests:

```python
from decimal import Decimal

rates = {
    "gpt-6-luna": ("0.10", "0.50"),
    "deepseek-v4-flash": ("0.14", "0.28"),
    "glm-5.3-flash": ("0.15", "0.50"),
    "qwen3.8-flash": ("0.15", "0.47"),
    "gemini-3.5-flash-lite": ("0.30", "2.50"),
    "gpt-6-sol": ("2", "10"),
}
for model, (input_rate, output_rate) in rates.items():
    costs = [
        Decimal(cases) * (input_tokens * Decimal(input_rate)
                         + output_tokens * Decimal(output_rate)) / 1_000_000
        for cases in (2000, 51663)
        for input_tokens, output_tokens in ((8000, 100), (32000, 200))
    ]
    print(model, " | ".join(f"${cost:.2f}" for cost in costs))
```

## Billing and data handling

Zen separately passes through card fees of 4.4% + $0.30 per transaction. Funding transactions, cache effects, and actual bills need separate reconciliation. [Pricing](https://opencode.ai/docs/zen/#pricing)

Some promotional free models allow training/improvement use or prohibit confidential inputs. OpenAI and Anthropic routes also have documented retention exceptions. Check the selected route's current policy before sending private page data; do not choose a free endpoint solely from its price. [Zen privacy](https://opencode.ai/docs/zen/#privacy)
