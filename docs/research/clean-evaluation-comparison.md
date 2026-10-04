# System comparison using the Gemini default

Measured against runtime source `1cc50794c3269ab395640ecb829863d4434531b0`. All three browser systems use **Gemini 3.8 Flash / Google AI Studio**, low reasoning, a 4,096-token output allowance and provider fallback disabled. Basic retains archived source `d533377945f67f99dbb2d23ab9b2ea04eef61569`; Stagehand is pinned to **4.1.0**. Improved is the enhanced implementation used by the application.

All **190 browser cases** and **569 reviewed saved-page cases per applicable arm** completed with one new original attempt, no retries and no omitted failures. Stagehand uses stock `observe` on a live page and has no saved-page arm. The [earlier completed DeepSeek comparison](comparison-2026-10-04-deepseek.md) and [interrupted runs](comparison-2026-10-04-interrupted.md) remain historical evidence. The [original Gemini-default key-limited saved-page attempts](gemini-saved-key-limit-2026-10-04.md) are retained separately and never used as accuracy.

## Results

| System            | Saved-page exact-target selection | Browser action + targets |
| ----------------- | --------------------------------- | ------------------------ |
| Basic resolver    | 532/569 (93.5%)                   | 182/190 (95.8%)          |
| Improved resolver | 551/569 (96.8%)                   | 190/190 (100.0%)         |
| Stagehand         | Not applicable                    | 123/190 (64.7%)          |

![Complete system comparison using Gemini](../assets/evaluation/clean-comparison.svg)

Basic → Improved has **8 browser gains and 0 lost passes**; saved-page exact-target selection has **27 gains and 8 lost passes**. Complete case lists and trial hashes are in the [verified aggregate](../assets/evaluation/clean-comparison.json).

| Browser comparison   | Gains | Lost passes |
| -------------------- | ----- | ----------- |
| Basic → Improved     | 8     | 0           |
| Basic → Stagehand    | 3     | 62          |
| Improved → Stagehand | 0     | 67          |

## Dataset and scoring boundaries

The saved-page collection retains all **569 admitted PhraseNode cases** across 171 historical page families: 542 dev, 24 test and three train. The source inventory has 1,084 records with 515 explicit exclusions: 288 insufficient evidence, 218 ambiguous labels and nine contradictory expectations. Input, independent expected-label and exact prepared-input hashes bind every admitted case. Failure never reduces a denominator.

| System            | Action + targets | Target selection only | Full resolver contract |
| ----------------- | ---------------- | --------------------- | ---------------------- |
| Basic resolver    | 182/190 (95.8%)  | 176/183 (96.2%)       | 182/190 (95.8%)        |
| Improved resolver | 190/190 (100.0%) | 183/183 (100.0%)      | 190/190 (100.0%)       |
| Stagehand         | 123/190 (64.7%)  | 161/183 (88.0%)       | Not applicable         |

The common browser score checks action and the complete expected target set, including applicable passive-state and privacy checks. Target-only scoring excludes seven unsupported instructions. Full-contract scoring additionally checks readiness, capture coverage and response details; Stagehand does not expose this contract. Singleton Stagehand grading uses its first suggestion; plural grading uses its entire returned set. No system executes the requested action.

Controlled XPath evidence replays at **180/180**, with **22/22 saved-locator mutations** and **22/22 fresh resolutions after mutation**, without model calls. This retained provider-free evidence is separate from the new paid Gemini run; Browser behavior and case definitions are unchanged.

## Browser behavior categories

| Behavior    | Basic resolver | Improved resolver | Stagehand     |
| ----------- | -------------- | ----------------- | ------------- |
| appearance  | 5/5 (100.0%)   | 5/5 (100.0%)      | 3/5 (60.0%)   |
| cardinality | 4/4 (100.0%)   | 4/4 (100.0%)      | 2/4 (50.0%)   |
| context     | 53/60 (88.3%)  | 60/60 (100.0%)    | 53/60 (88.3%) |
| frames      | 2/3 (66.7%)    | 3/3 (100.0%)      | 1/3 (33.3%)   |
| robustness  | 3/3 (100.0%)   | 3/3 (100.0%)      | 1/3 (33.3%)   |
| scope       | 25/25 (100.0%) | 25/25 (100.0%)    | 18/25 (72.0%) |
| state       | 56/56 (100.0%) | 56/56 (100.0%)    | 16/56 (28.6%) |
| targeting   | 34/34 (100.0%) | 34/34 (100.0%)    | 29/34 (85.3%) |

## Duration and cost

| Category / system             | Cohort                     | Measured / attempts | Median | p95    |
| ----------------------------- | -------------------------- | ------------------- | ------ | ------ |
| browser / Basic resolver      | parallel                   | 190/190             | 1.427s | 2.676s |
| browser / Improved resolver   | parallel                   | 190/190             | 1.449s | 2.045s |
| browser / Stagehand           | parallel                   | 190/190             | 1.175s | 2.161s |
| savedPage / Basic resolver    | gemini-systems-saved-fresh | 569/569             | 1.767s | 3.775s |
| savedPage / Improved resolver | gemini-systems-saved-fresh | 569/569             | 1.763s | 3.065s |

![System median and p95 durations using Gemini](../assets/evaluation/system-duration.svg)

Median is the middle duration (the mean of the two middle values for an even count); p95 uses the nearest-rank method. Browser arms execute concurrently in isolated environments, serially within each arm. Saved-page arms use two concurrent serial streams. Browser duration measures the Resolver/observer request; saved-page duration measures the Resolver CLI inference process, excluding preparation. All original failed attempts are included. An independent model refresh ran concurrently during the early saved-page collection and was then stopped; its attempts are excluded from these accuracy and cost totals. Cohorts and unavailable timing measurements remain explicit; timings do not establish a fastest model.

| Category / system             | Original requests | Known reported USD | Unreported charges |
| ----------------------------- | ----------------- | ------------------ | ------------------ |
| browser / Basic resolver      | 190               | $0.27402600        | 0                  |
| browser / Improved resolver   | 190               | $0.37808025        | 0                  |
| browser / Stagehand           | 190               | $0.13975275        | 0                  |
| savedPage / Basic resolver    | 569               | $5.79957975        | 0                  |
| savedPage / Improved resolver | 569               | $6.10871175        | 0                  |

Total: **1,708 original provider requests**, **$12.70015050 known reported cost** and **0 unreported charges**. Six provider-free Basic compatibility trials are excluded. Unknown billing is never treated as zero cost; accounting does not change grades.

## Matched conditions and Basic compatibility

Browser arms share instructions, reset fixture state, viewport and Chromium binary; each prepares its own context. Basic and Improved share identical reviewed saved-page inputs and expectations but retain their respective prompts. Improved uses the same current prompt/schema and pinned Resolver image in both categories. Stagehand uses its own stock snapshot, prompt and selector generation.

The archived Basic image remains unchanged. An envelope adapter supplies only its historical contract selector. Its native request disables reasoning, so the comparison proxy changes only that field to the shared Gemini low-reasoning setting; each original native and forwarded request and both hashes are retained. Improved and Stagehand send Gemini settings directly. Contemporaneous runtime receipts bind the actual images during original inference. Identity, cache, complete-plan, source, input, label and grader checks passed.

## Case examples

The browser gains for Improved over Basic are:

- `context-clinic-visit-type-for-select`
- `context-control-in-collapsed-accordion-is-absent`
- `context-item-under-backpack`
- `context-product-card-above-shirt`
- `context-product-card-right-of-backpack`
- `context-product-card-under-backpack`
- `context-product-card-under-backpack-with-reordered-dom`
- `frames-open-shadow-root-target-is-found`

Browser lost passes: **0**. Every saved-page gain, lost pass and failure category remains in the aggregate; raw instructions and provider payloads stay private.

## Evidence and reproduction

| Evidence                     | Run ID                               | Manifest SHA-256                                                 |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Browser comparison           | 6bc596cb-18e8-43d6-858a-517d04a4e835 | f5385ce2b119c74d999aa91016c3e7b9b74412a428c58a71fa45a7679457dad6 |
| Saved-page Basic resolver    | 31594ff3-03a3-428b-bb33-3a52d4ece24e | bd23d27556bcbca1e73ae8ae01b9289299af5523828a87ee002ee518d76f4720 |
| Saved-page Improved resolver | 6a73a408-5224-4935-8ffa-9880a58c10d3 | ae4c10e79e45870053122f589b48ce709a84e3e0b9794eba043ac56bfcf29d31 |
| Controlled XPath             | 9194a95c-e2ea-482c-ba0c-fb9a241a08bc | a296e5aa6c599bad18b25357e155fbbb7b0bbc6ffecc83d91a2e931283ec5248 |

Active archive SHA-256: `ca9c2dd8e5fbf5a6bc48b80fcc863113eff771f9a726858f3f9386f2a39080ae`. Review SHA-256: `f7233682af26dd85c34d1904504cf9542454a398a318ffc3d0738cd0c8fa5fbb`. The aggregate binds runtime/source identities, contemporaneous images, frozen plans, prepared-input receipts, recorded inference profiles, original trials, all paired results and exporter hashes. Existing graders replayed every outcome before export.

See the [figure guide](../assets/evaluation/README.md) for provider-free regeneration and the [model-selection comparison](model-comparison-2026-10-04.md). The model-selection comparison is an earlier complete measurement; its scores and timing cohorts remain separate from this approach comparison.

## Limits

These are descriptive first-attempt results on an audited evaluation set, with no retries. Authored browser cases and historical saved pages have separate measurement boundaries. They do not establish unseen-site accuracy, isolate the causal effect of a prompt or model, or qualify a release. Every lost pass remains recorded.
