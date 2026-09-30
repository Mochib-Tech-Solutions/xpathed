# Fast-model qualification report

Measured 2026-09-30 for issue #9. **No configuration qualifies for default promotion.** Gemini meets the confirmation accuracy and latency thresholds, but the development color-reference failure remains a blocking capability gap. Application defaults are unchanged.

## Measured results

Correct means the entire response has the expected action, distinct target set, absence/state/readiness and summary, verified against independent live-DOM observations. Every planned attempt remains in the denominator. Latency includes failed attempts; times below are rounded.

### Pilot

| Profile          | Correct | Correct within 2 s | Correct within 3 s | p50 / p95, ms |  Reported USD |
| ---------------- | ------: | -----------------: | -----------------: | ------------: | ------------: |
| luna             |   37/51 |              35/51 |              37/51 |   1424 / 2077 | $0.0129746000 |
| gemini           |   48/51 |              40/51 |              46/51 |   1732 / 2838 | $0.0891333000 |
| deepseek         |   37/51 |              32/51 |              37/51 |   1416 / 2330 | $0.0075381194 |
| deepseek-concise |   39/51 |              38/51 |              39/51 |    621 / 1530 | $0.0070815194 |

### Confirmation

| Profile          | Correct | Correct within 2 s | Correct within 3 s | p50 / p95, ms |  Reported USD |
| ---------------- | ------: | -----------------: | -----------------: | ------------: | ------------: |
| luna             |   75/80 |              73/80 |              75/80 |   1446 / 1919 | $0.0123076000 |
| gemini           |   80/80 |              70/80 |              78/80 |   1585 / 2404 | $0.0960022500 |
| deepseek         |   75/80 |              62/80 |              74/80 |   1473 / 2370 | $0.0071757826 |
| deepseek-concise |   74/80 |              74/80 |              74/80 |     606 / 764 | $0.0064547698 |

The development pilot covers 17 cases × 3 repetitions × 4 profiles (204 calls). Confirmation covers 24 regression and 16 held-out cases × 2 repetitions × 4 profiles (320 calls). The held-out cases span ten separate DOM/domain families. Both runs completed all planned calls without retries.

| Profile          | Regression correct / within 3 s | Held-out correct / within 3 s | Successful held-out families | Descriptive 95% family interval |
| ---------------- | ------------------------------- | ----------------------------- | ---------------------------- | ------------------------------- |
| luna             | 47/48 / 47/48                   | 28/32 / 28/32                 | 8/10                         | 49.0%–94.3%                     |
| gemini           | 48/48 / 46/48                   | 32/32 / 32/32                 | 10/10                        | 72.2%–100.0%                    |
| deepseek         | 48/48 / 47/48                   | 27/32 / 27/32                 | 8/10                         | 49.0%–94.3%                     |
| deepseek-concise | 48/48 / 48/48                   | 26/32 / 26/32                 | 6/10                         | 31.3%–83.2%                     |

A successful family has every planned request correct and complete within 3 seconds. These Wilson intervals describe ten authored families; they do not certify production reliability or treat repetitions as independent samples. [Family and split aggregates](model-qualification-results.csv) retain correctness, target/absence/error counts, completion, latency and costs separately for both phases.

### Confirmation stage timings and usage

| Profile          | Capture p50/p95 ms | Model p50/p95 ms | Validation p50/p95 ms | Validation observations | Input / output tokens | Reasoning / cached tokens |
| ---------------- | -----------------: | ---------------: | --------------------: | ----------------------: | --------------------: | ------------------------: |
| luna             |          19.5/26.4 |    1410.2/1889.1 |             14.9/19.5 |                   76/80 |         102236 / 4168 |                     0 / 0 |
| gemini           |          18.7/28.1 |    1547.6/2364.8 |             14.3/19.0 |                   80/80 |          99448 / 5711 |                  1434 / 0 |
| deepseek         |          21.0/31.7 |    1443.6/2348.2 |             15.0/21.3 |                   78/80 |          96138 / 4188 |                 0 / 62464 |
| deepseek-concise |          19.8/26.8 |      573.3/726.1 |             15.1/22.3 |                   75/80 |          79498 / 4025 |                 0 / 42496 |

All 80 attempts per profile have capture/model/end-to-end timings. Validation is unavailable when malformed or incomplete output prevents that stage; it is not recorded as zero. Stage quantiles are independent and cannot be summed.

## Why nothing qualifies

Policy version 1 was frozen before held-out inference: a 2-second goal, at least 95% correct and complete within 3 seconds overall and in each required split, at least 95% correctness, an 80% family correctness floor, and no critical/invariant failures or unresolved capability gaps. No threshold changed after results were observed.

- **Every profile:** the development color-only reference remains unreliable: Luna, Gemini and concise passed 0/3; DeepSeek baseline passed 1/3. Capture includes geometry but not computed color, so an occasional correct guess does not establish that capability. Gemini's otherwise strong result cannot erase this missing capability.
- **Luna:** confirmation failed both repetitions of mixed and future-dependent commands, plus one transparent-control observation. Two `provider_malformed_response` and two `decomposition_incomplete` errors were model-output contract failures, not observed gateway outages. Held-out correctness was 87.5%.
- **DeepSeek baseline:** both future-dependent commands returned inappropriate targets, both mixed commands produced malformed contract output, and one scoped-plural response had an incorrect ordered step. Held-out correctness was 84.4%; pilot and confirmation identity failures remain blocking.
- **DeepSeek concise:** three incomplete and two malformed responses, plus one incorrect ordered step in a named-target response. Held-out correctness was 81.3%. Its 606 ms median does not qualify it; pilot hard failures also remain blocking.

Gemini is the strongest measured candidate on these fixtures, not an approved default. The next tuning work should address color evidence and unsupported-command/action/step consistency, then replace these now-exposed held-out families before another qualification. Do not tune on this holdout and reuse it as unseen evidence.

## Method, serving and budget

The baseline profiles share prompt version 7, contract 3, schema, capture and grader. `deepseek-concise` is a separate predeclared prompt variant, version `7-concise-1`. Each profile runs its own actual Resolver service. [Availability research](model-qualification-availability.md) records exact model IDs, canonical revisions, route prices and official sources; [profile configuration](../../evaluation/qualification-profiles.json) records the effective settings. Luna uses reasoning `none`, Gemini `low`, and both DeepSeek profiles disable reasoning. All use a 4,096-token output allowance, pinned standard providers and no fallback or response healing.

The runner uses seed 1, rotating model order, concurrency 1, no retries and a 45-second timeout. A slow failure can run beyond the 3-second qualification deadline; the deadline is a grading threshold, not a claim that every request is forcibly stopped at 3 seconds. Each trial creates a fresh browser session. Before payment, 44 deterministic compatibility checks cover positive, absent, scoped/plural and malformed/unknown-ID/rate-limit/timeout/refusal/empty/truncated/missing-usage outcomes across the four profiles. These checks warm service processes; there are no discarded paid warmups.

Every live call has a distinct generation ID, matching requested/observed model and provider, response reuse disabled and a reconciled reported charge. No response-cache hit or route-identity violation was observed. Provider prompt caching is separate: the pilot recorded 0 / 40,054 / 82,176 / 71,168 cached tokens for Luna / Gemini / DeepSeek / concise; confirmation usage appears above. Prompt-cache warmth was uncontrolled. Standard/default service tier was observed for Luna and Gemini; DeepSeek omitted the returned tier field, with standard routing requested and verified from the pinned endpoint.

Timing covers Resolver HTTP capture, inference and same-node XPath/readiness validation. Independent fixture setup and oracle grading are outside it. The evaluation proxy serves frozen price metadata locally; production currently fetches price metadata over the network. These are measured resolver-path timings, not guaranteed browser-to-chat UI latency. Inspection remains passive; no requested browser action was executed.

The existing ledger began at **$0.0134430966** across 77 earlier calls. This pilot cost **$0.1167275388**; confirmation cost **$0.1219404024**. Total new spend is **$0.2386679412** and the shared experiment total is **$0.2521110378 of $5**, across 601 reconciled calls with zero pending reservations. Model-output failures were charged and retained. Reported provider charges are actual observations. Diagnostic estimates were unavailable for Luna and Gemini, not zero; DeepSeek baseline estimates totaled $0.0099951818 / $0.0090434562 for pilot / confirmation, and concise $0.0092094426 / $0.0077254002. Those estimates remain separate from reported charges and the conservative preflight forecast.

The first three-repeat confirmation forecast was **$6.864023952**, above the remaining **$4.8698293646**, so it stopped before any paid or held-out call. Uniformly reducing repetitions from three to two brought the conservative forecast to **$4.576015968**, keeping every case, profile and threshold unchanged before held-out exposure. The estimate uses twice the pilot token maxima and conservative current endpoint rates, including larger advertised pricing tiers. It is a reservation forecast, not expected spend. The blocked run and original ledger remain preserved.

## Evidence and reproduction

Measured implementation: commit `e0bc01dfb6ad72bd9ac1d9c20107e796d31c1000`. The pilot used the same source bytes before that commit; confirmation verified the semantic source/configuration fingerprints against the pilot. Subsequent report-only changes do not alter measured behavior.

| Run          | Manifest ID                            | Manifest content hash                                              |
| ------------ | -------------------------------------- | ------------------------------------------------------------------ |
| Pilot        | `dd3f45d0-f777-44bf-9416-783f8a48331c` | `ea4e438237766e10e87a60df01df2f38e5c1fdaa686c426908a6c3470309323f` |
| Confirmation | `312713e2-f4ba-4e35-b28b-6df3e3e78fce` | `56a8f75e085eb4812983ba76232db010ed0a421035274ce9767f737e60870371` |

Confirmation links source tree fingerprint `ddb7c05fb7d1c9b0b6f99cf6bdf6c7470e289ff1dc3a48fe83095cc9ac6d081a`, suite hash `3b0957aa1c104cb6ab0f3fc1a5d8ce2f1c82e112329ec66ad51c13d22a6a6139`, policy hash `3ce9648dcc3a6d3f44e1872432c477c5bce62868c79c519984c941b419a80e4e` and Chromium binary hash `839efe5fd8b6a773dd81b2e10afdc15f3c0a17316fb82b5908c0533306c4ed9e`. The complete manifest retains dependency, prompt, schema, configuration and provider metadata. Policy freeze was `2026-09-30T21:22:24.645Z`; first held-out start was `2026-09-30T21:23:00.160Z`.

```sh
pnpm evaluate:qualify -- --mode live --profile luna,gemini,deepseek,deepseek-concise --repetitions 3 --output .artifacts/evaluation/qualification-live-pilot
pnpm evaluate:qualify -- --mode live --phase confirmation --split regression,held-out --profile luna,gemini,deepseek,deepseek-concise --repetitions 2 --pilot .artifacts/evaluation/qualification-live-pilot --output .artifacts/evaluation/qualification-live-confirmation-budgeted
pnpm evaluate:qualify:replay .artifacts/evaluation/qualification-live-confirmation-budgeted
```

The first two commands are paid experiments, not required CI gates. Use new output directories for a new run, retain the shared ledger, refresh prices and replace exposed holdout families before tuning. Replay makes no browser or provider calls. Independent audit recomputed grades from retained raw observations, matched all metrics and charges, and reproduced the final summary byte for byte. CLI replay also passed.

Private manifests, trial/page/provider evidence and the ledger stay local; only reviewed aggregates are committed. Apply the documented 30-day page-evidence and 90-day artifact retention. No candidate release was activated.

## Verification and exclusions

All 200 development/regression deterministic matrix trials passed; all 66 authored fixture definitions passed ordinary deterministic verification. The .NET, Web, tooling and Docker checks passed, as did 65 real-browser regression checks and hosted CI. Independent standards and specification reviews had no remaining findings.

The repeated-session workload exposed forced x11vnc shutdown leaking System V shared-memory segments: the original matrix hit the 4,096-segment limit and returned `display_unavailable`. The failed run remains retained. Browser teardown now sends bounded graceful termination to its owned VNC/display processes with a forced fallback. A 128-session real-browser create/close regression and the complete rerun passed; no host IPC limits or browser sandbox settings changed.

Original legacy contract and saved-XPath mutation cases remain a separate regression track. Previously recorded saved-locator ID-change/replacement failures are not claimed fixed by this model comparison. Imported PhraseNode and Mind2Web original splits were not rerun across this model matrix: offline node selection cannot establish plural action/readiness correctness, and unreviewed/reconstruction-limited records remain excluded. These results describe controlled authored browser fixtures, not full-corpus benchmark scores or unrestricted websites.
