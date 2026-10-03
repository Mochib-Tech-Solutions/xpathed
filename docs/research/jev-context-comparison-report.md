# Jev context comparison

Measured 2026-10-01 for [issue #48](https://github.com/Mochib-Tech-Solutions/xpathed/issues/48). The initial conservative planning policy did not improve the measured workload. It remains evaluation-only; no runtime promotion follows from this report.

## Historical pilot: two-second processing cutoff

The completed run is `.artifacts/evaluation/jev-context-live-v2-20261001`, at source `5e8196c8402be2d42cd3fd214866f8ab6ceafb89`. Its frozen manifest content hash is `32920c357ce75309be772761316c7867415281051e3f57f6ea8848c0687406be`. Raw requests and responses remain private artifacts.

This run used the former two-second server processing cutoff. It must not be presented as evidence for the subsequent policy that treats two seconds only as a performance metric.

Sixteen independently reviewed, authored current-view browser cases each received one control attempt and one assisted attempt, alternating which arm ran first. These are exposed regression cases, not imported dataset examples or fresh held-out families. Both arms used the current-view contract, the same core selection prompt and DeepSeek V4.1 Flash through the standard DeepInfra FP8 route. The assisted arm added the fixed evidence-availability instruction and one TypeSafe Jev Decisions call. There were no retries or discarded warmups.

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

## Metric-only policy: completed paired measurement

[ADR-0020](../adr/0020-treat-latency-targets-as-evaluation-metrics.md) removes the total two-second application cutoff while retaining the sub-one-second goal and two-second reporting threshold. The separate `.artifacts/evaluation/jev-context-metric-only-20261001` run measured this policy at source `38d6696841585ece11f39c241fe407770033278c`. Its frozen manifest content hash is `b8d314e755a3e1900334c1712add6aad2273ce0fd688550310765e6f0e3c1779`. The historical run above remains unchanged.

This run used the same sixteen cases, one fresh attempt per arm, alternating arm order, the same final model/provider, classifier questions and provisional thresholds. Only this run's contemporaneous control is its paired baseline. Neither cross-run cost differences nor individual latency swings establish an effect of removing the cutoff.

| Metric, all 16 attempts per arm     |       Control |   Jev-assisted |
| ----------------------------------- | ------------: | -------------: |
| Correct and complete                | 14/16 (87.5%) | 13/16 (81.25%) |
| Correct below one second            |          7/16 |           0/16 |
| Correct within two seconds          |         12/16 |          11/16 |
| Correct but slower than two seconds |          2/16 |           2/16 |
| Resolver HTTP latency p50           |   1,000.59 ms |    1,505.49 ms |
| Resolver HTTP latency p95           |  28,353.06 ms |   12,394.88 ms |
| Final-model input bytes, total      |        26,200 |         27,336 |
| Final-model input tokens, total     |        19,314 |         20,578 |
| Final-model output tokens, total    |           804 |            803 |
| Classifier input/output tokens      |             — |    5,259 / 576 |
| Reported total cost                 | $0.0009731344 |  $0.0012836404 |

All 16 classifier calls again selected `fallback_uncertain`; appearance probabilities ranged from 0.25 to 0.84 and layout probabilities from 0.40 to 0.95. No context was omitted. Classifier latency was 320.82 ms at p50 and 474.96 ms at p95. Serialized final-model input remained 4.34% larger in the assisted arm.

Among the 12 pairs where both arms were correct, assisted resolution was slower in 10, with median additional latency of 283.66 ms. Its mean paired latency was instead 1,773.23 ms lower, dominated by one control response taking 28.35 seconds while the assisted response took 1.60 seconds. With sixteen observations, the nearest-rank p95 is the maximum: the lower assisted p95 is not evidence of a reliable tail-latency improvement. All these observations remain in the report; none were discarded as outliers.

The new policy returned four correct results after two seconds: control's spatial-reference case at 3.05 seconds and large visible-prefix case at 28.35 seconds; assisted's checkbox case at 2.07 seconds and scoped-absence case at 5.48 seconds. They count as correct overall and as misses of the two-second metric, rather than being converted into timeout results.

All five failed attempts remain: both arms again failed the plural case's action-step contract; control returned `decomposition_incomplete` for the off-screen-help case; assisted returned `provider_malformed_response` for the notes field and `decomposition_incomplete` for the clipped-frame case. The latter took 12.39 seconds and remains a failed result, not a successful latency comparison.

The combined reported cost was **$0.0022567748**: $0.0009731344 for control, $0.0010627624 for assisted final-model calls and $0.000220878 for Jev. Assisted cost was 31.91% higher. Provider prompt-cache usage was observed and uncontrolled; these recorded charges should not be generalized into fixed future rates. Both paid pilots together cost **$0.0061338928**. The earlier zero-call setup failure adds no inference cost.

Independent verification checked all 32 trial hashes and grades, reproduced the summary, and passed offline replay. All 48 forwarded calls had unique generation identities, expected providers and known charges, with no setup or measurement failures. Replay success establishes evidence consistency, not model qualification.

Both measurements support keeping this provisional assisted policy disabled: it retained every optional field while adding a classifier call. They do not establish that Jev or context planning is generally worse. Any revised questions or thresholds need a separately declared development experiment, followed by fresh family-disjoint confirmation if a benefit appears. Sixteen exposed cases with one attempt each cannot establish a general accuracy or latency advantage. See the [integration research](jev-context-planning.md) for the endpoint contract and evidence-selection limits.
