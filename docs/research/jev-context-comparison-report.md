# Jev context comparison

Measured 2026-10-01 for [issue #48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48). The initial conservative planning policy did not improve the measured workload. It remains evaluation-only; no runtime promotion follows from this report.

## Historical pilot: two-second processing cutoff

The completed run is `.artifacts/evaluation/jev-context-live-v2-20261001`, at source `5e8196c8402be2d42cd3fd214866f8ab6ceafb89`. Its frozen manifest content hash is `32920c357ce75309be772761316c7867415281051e3f57f6ea8848c0687406be`. Raw requests and responses remain private artifacts.

This run used the former two-second server processing cutoff. It must not be presented as evidence for the subsequent policy that treats two seconds only as a performance metric.

Sixteen independently reviewed, authored current-view browser cases each received one control attempt and one assisted attempt, alternating which arm ran first. These are exposed regression cases, not imported dataset examples or fresh held-out families. Both arms used contract 4, the same core prompt version 8 and DeepSeek V4.1 Flash through the standard DeepInfra FP8 route. The assisted arm added the fixed evidence-availability instruction and one TypeSafe Jev Decisions call. There were no retries or discarded warmups.

The classifier ran after a complete browser capture, with a 500 ms allowance. Each optional evidence group could be omitted at probability ≤0.05; probability ≥0.95 retained it. Either answer inside the uncertainty band retained both groups. These provisional thresholds were frozen before inference, not calibrated guarantees. Original instructions, all candidates and core semantic evidence were retained. Capture cost reduction was not tested.

| Metric, all 16 attempts per arm  |       Control |   Jev-assisted |
| -------------------------------- | ------------: | -------------: |
| Correct and complete             | 14/16 (87.5%) | 13/16 (81.25%) |
| Correct below one second         |          7/16 |           0/16 |
| Correct within two seconds       |         14/16 |          13/16 |
| Resolver HTTP latency p50        |   1,012.09 ms |    1,394.94 ms |
| Resolver HTTP latency p95        |   2,009.89 ms |    2,011.85 ms |
| Final-model input bytes, total   |        26,200 |         27,336 |
| Final-model input tokens, total  |        19,314 |         20,578 |
| Final-model output tokens, total |           810 |            806 |
| Classifier input/output tokens   |             — |    5,259 / 576 |
| Reported total cost              |  $0.001740480 |   $0.002136638 |

All 16 Jev calls returned valid responses but selected `fallback_uncertain`: appearance probabilities ranged from 0.25 to 0.83 and layout probabilities from 0.40 to 0.95. No optional evidence was removed. The availability field increased serialized model input by 71 bytes per attempt, or 4.34% overall. Classifier latency was 333.22 ms at p50 and 409.12 ms at p95. This is an observed result of the frozen questions and thresholds, not proof that Jev cannot classify evidence needs.

Among the 12 pairs where both arms were correct, assisted resolution was slower in 11. Its median additional latency was 349.13 ms and mean additional latency was 307.68 ms. Failed pairs remain in accuracy, cost and all-attempt latency totals; they are excluded only from this successful-pair speed comparison. Timing includes capture, classification, final selection and verification at the Resolver HTTP boundary. Durable remote accounting is outside that interval. Provider prompt-cache warmth was uncontrolled; response-cache reuse was disabled and checked.

All five failed attempts are retained: each arm failed the same plural case's action-step contract; control timed out on the large visible-prefix case; assisted timed out on the basic-save case and incorrectly returned unsupported for the clipped-frame case. The late provider charges for both timeout attempts were recovered in the retained records. Original labels and grading rules were not changed after observing results.

The combined reported cost was **$0.003877118**: $0.001740480 for control, $0.001915760 for assisted final-model calls and $0.000220878 for Jev. Assisted cost was 22.76% higher. Independent verification checked the manifest and all 32 trial hashes, regraded every attempt, reproduced the summary and passed offline replay. All 48 forwarded calls had unique generation identities, the expected providers and known charges; no measurement setup failures remained.

The earlier `.artifacts/evaluation/jev-context-live-20261001` run is preserved separately. Reused fixture IDs prevented every resolution from starting: 32 setup failures, zero provider calls and 48 preregistered records explicitly marked `not_forwarded`. It is failed infrastructure evidence, not a model comparison, and contributes no paid inference to the totals above.

## New metric-only policy: measurement pending

[ADR-0020](../adr/0020-treat-latency-targets-as-evaluation-metrics.md) removes the total two-second application cutoff while retaining the sub-one-second goal and two-second reporting threshold. A new frozen, paired run is pending under that policy. It will retain its own source identity and all original attempts; the historical run above will remain unchanged.

The historical result supports keeping the provisional assisted policy disabled. Any later improvement needs separate family-disjoint confirmation before adoption; sixteen exposed cases with one attempt each cannot establish a general accuracy or latency advantage. See the [integration research](jev-context-planning.md) for the endpoint contract and evidence-selection limits.
