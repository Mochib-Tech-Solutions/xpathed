# Basic resolver, Improved resolver and Stagehand

## Results

All three systems received the same frozen browser cases and independent target labels, with one original attempt per case and no retries. These are authored regression cases, not an estimate of accuracy on unseen websites.

| System            | Action + targets | Target selection only | Full resolver contract | Parallel median / p95 |  Known cost | Unreported charges |
| ----------------- | ---------------: | --------------------: | ---------------------: | --------------------: | ----------: | -----------------: |
| Basic resolver    |  161/183 (88.0%) |       160/175 (91.4%) |                147/183 |       0.599s / 1.060s | $0.01656773 |                  0 |
| Improved resolver |  169/183 (92.3%) |       169/175 (96.6%) |                155/183 |       0.581s / 0.793s | $0.01741879 |                  0 |
| Stagehand         |  103/183 (56.3%) |       136/175 (77.7%) |            Unavailable |       0.572s / 7.849s | $0.03913768 |                  0 |

![Accuracy by behavior](../assets/evaluation/engineering-category-results.svg)

Basic → Improved: **15 gained passes and 7 lost passes**.

Regressions: `duplicate-mentioned-target`, `release-holdout-clinic-5`, `release2-accordion-2`, `release4-annotations-3`, `release3-listbox-1`, `action-families-7`, `clinic-readonly-clear`.

## What changed

Basic resolver is the archived earlier setup. Improved resolver uses the current implementation: one shared prompt and schema, explicit rules for requested controls versus surrounding context, scoped absence, and current-view membership revalidation. These changes are measured together; the comparison does not isolate the effect of each change.

Stagehand uses stock `observe`, with caching and self-healing disabled, a current-view instruction, and the same DeepSeek V4.1 Flash/Wafer route, 4,096-token output limit and disabled reasoning. Its DOM representation and prompt differ from ours. The browser binaries, viewport, document, initial state, language and time zone are checked for parity.

## What the score means

The common score requires the correct interaction and complete set of independently labelled nodes. Each XPath must identify one eligible node. Singleton grading keeps the first Stagehand suggestion; plural grading checks the whole returned set. Wrong, missing, extra and duplicate targets fail. Operational errors remain in the denominator. Correct rejection of unsupported instructions is included; an adapter selector-conversion failure is not a correct instruction refusal.

The target-selection column separately checks exact node sets and correct absence, without requiring the interaction name. Its denominator excludes the explicitly unsupported-instruction cases, which do not have a supported target set. All errors within that subset still fail. This helps distinguish selecting the wrong element from interpreting the action differently.

Stagehand returns targets without xpathed's absence explanations or readiness contract. For an empty result, action interpretation is unavailable; the common score accepts correct absence. For a partly absent request, the common score checks the complete found set. The separate full resolver score also checks outcome details, capture coverage, readiness and summary fields. Neither system executes actions.

## Timing and evidence

Each system has its own serial worker; the three workers run concurrently with isolated browser sessions and provider accounting. Stagehand waits for the corresponding Basic browser observation to establish parity. Browser setup and independent grading are outside the measured inference interval. Timings above describe the parallel phase; retained serial attempts have separate timing fields in the aggregate. Provider caching and host contention can affect timings. Costs are reported amounts, with missing billing records kept separate.

Run: `b74b6e9f-695c-42f8-bc90-d826992a062d`; started `2026-10-02T19:54:47.421Z`. The [aggregate evidence](../assets/evaluation/engineering-comparison.json) records source and image identities, case outcomes and original evidence hashes. Private request/response payloads remain in the local run directory.

The initial runner stopped after one case per arm because it reused an attempt ID. Those three original outcomes remain included. Continuation ran only the remaining cases after the bookkeeping fix. Docker build-attestation wrappers changed during restart; saved build logs verify identical platform manifests and runtime configurations. Original and continuation image identities and the original manifest are retained in the evidence. No failed model attempt was retried.

This research comparison does not approve or activate a release. See [evaluation commands](../evaluation.md#engineering-comparison) to reproduce it.
