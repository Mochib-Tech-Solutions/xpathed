# Stagehand comparison pilot — 2026-09-30

Issue [#8](https://github.com/Mochib-Tech-Solutions/xpathed/issues/8) now has a local, observation-only comparison against pinned Stagehand 4.1.0. This pilot does not establish a production winner. Both strategies found the complete intended target set in the final run, but the custom resolver misclassified one button-click paraphrase; an earlier Stagehand run produced several truncated model responses. Those failures are retained below.

## Method

Both strategies used standard `deepseek/deepseek-v4.1-flash` through OpenRouter's `wafer` route, reasoning disabled, a 4,096-token output limit, no fallback and no retry. Stagehand's supported custom-model callback preserves its own prompt and schema. The custom resolver preserves its production prompt, candidate representation and passive readiness checks. Consequently this compares complete configurations, not identical prompts or a causal estimate of one algorithm's advantage.

The reviewed subset contains 12 controlled cases: exact and paraphrased buttons, quoted labels, section context, off-screen, covered and transparent controls, hidden and genuinely absent targets, page-text injection, nested frames and plural approvals including a disabled button. All requested interactions are clicks; this pilot does not establish other action-family performance, real-site performance or a held-out benchmark. The plural example is one case family, not broad plural coverage. No prompt or model settings were tuned against these outcomes.

Each pair used fresh isolated browser sessions and the same fixture/setup revision. Before inference, the runner compared actual Chromium binary SHA-256, user agent, viewport, language list, timezone, document checksums, scroll/focus and sanitized form state. Observed viewport was 1279×799 within the existing kiosk tolerance; languages were `en-US,en`, timezone UTC and Chromium user agent version 153. The matching binary digest was `839efe5fd8b6a773dd81b2e10afdc15f3c0a17316fb82b5908c0533306c4ed9e`. Stagehand needed explicit viewport setup and native language-feature configuration to match; early mismatched trials stopped before inference and remain private artifacts.

Singleton requests grade the first Stagehand suggestion. Explicit plural requests grade every returned target as an unordered set, retaining duplicate, wrong, missing and extra targets. Expected node mappings are supplied only to an independent fixture oracle after inference. Each result must resolve one intended eligible DOM node in its explicit frame chain. Disabled/off-screen elements remain eligible; accessibility-hidden nodes do not. Scroll, focus and form values must remain unchanged. No `act`, self-healing or requested interaction executes.

Latency measures each strategy's resolution operation, including its capture/inference/output handling, excluding browser startup, fixture setup and independent grading. The first two-repeat pilot alternated strategy order between repetitions. Provider prompt-cache tokens are reported separately from response reuse; the final grader requires one fresh provider request and Stagehand cache status `DISABLED` for successful live observations.

## Retained results

| Run                  | Strategy  | Singleton passes | Plural passes | Operational errors | p50 / p95 ms | Reported USD |
| -------------------- | --------- | ---------------- | ------------- | ------------------ | ------------ | ------------ |
| Two repetitions      | Custom    | 21/22            | 2/2           | 0                  | 952 / 2,065  | 0.0016614656 |
| Two repetitions      | Stagehand | 17/22            | 2/2           | 5                  | 909 / 34,036 | 0.0098423502 |
| Final one repetition | Custom    | 10/11            | 1/1           | 0                  | 926 / 2,491  | 0.0008001608 |
| Final one repetition | Stagehand | 11/11            | 1/1           | 0                  | 824 / 1,412  | 0.0003981159 |

The custom failure in both runs was `paraphrase-save`: “Please press the Save changes button in Profile.” It returned the correct node with action `press` instead of `click`. Target identity alone therefore did not earn a passing result. This provides a concrete action-disambiguation case for [#9](https://github.com/Mochib-Tech-Solutions/xpathed/issues/9).

The earlier Stagehand failures had provider `finish_reason: length` with all 4,096 output tokens consumed: transparent control in both repetitions, then nested frame, scoped Save and basic Save in the second repetition. There were no automatic retries. The final run was performed after review strengthened fresh-inference and shared-accounting checks; its better Stagehand result does not replace the earlier failures. The model inputs/settings were unchanged. Common non-error/non-unsupported coverage was 19/24 pairs in the first pilot and 12/12 in the final pilot. All planned attempts were retained.

Final usage was 10,808 input / 605 output tokens for Custom, including 9,216 provider-cached input tokens; Stagehand used 3,763 input / 473 output, including 3,072 cached input tokens. Every reported charge reconciled. The initial two-call live compatibility check cost $0.0001566299. Total comparison spend across all 74 paid calls was **$0.0128587224**; including the prior dataset pilot, the persistent experiment ledger totals **$0.0134430966 of $5**, with no unresolved reservations.

The small sample, development/regression exposure, provider caching and observed run-to-run variation prevent a statistically defensible speed/quality ranking. Stagehand readiness and capture/model-input coverage are explicitly unavailable rather than manufactured to match xpathed's contract. No runtime default was changed.

## Reproduction and validation

```sh
pnpm evaluate:compare -- --output .artifacts/evaluation/comparison-check
pnpm evaluate:compare -- --mode live --repetitions 2 --output .artifacts/evaluation/comparison-live
pnpm evaluate:compare:replay .artifacts/evaluation/stagehand-live-final
```

The live command first performs deterministic singleton and plural preflight checks. A locked forwarding gateway then reserves every possible provider charge against the existing shared ledger before sending it. Missing/excessive charges block subsequent paid calls across both dataset and comparison runners. Never delete that ledger to restart an experiment. Fresh reruns require new artifact directories and will produce different model outputs and latency.

The final retained run is `ffb881b5-c29a-4389-aacb-5df2ed4fb81f`, under `.artifacts/evaluation/stagehand-live-final`. Its manifest SHA-256 is `c4aa3cc51eb206a9da9264ac4fb80708111756b474355a8b3f9c8976dd7ccb53`; its workspace source fingerprint is `3186c552e07e1c527a2f7e1e99199a14d314c5d78320dd010536389d76c5584e`. The manifest records source/dependency hashes and the Stagehand lockfile. Raw provider evidence remains private with the ordinary 30-day evidence retention; the shared ledger remains separate. Earlier artifacts remain in `stagehand-live-compatibility` and `stagehand-live-pilot` and retain their original runner/grader identities.

Exact replay of the final report was verified with no provider calls. It correctly exits nonzero because the action paraphrase failed; model accuracy is not a CI pass requirement or release qualification. Deterministic paired browser checks passed all 24 attempts, and the standalone adapter's seven real-browser scenarios covered wrong-first selection, plural targets, frames, hidden/absent targets and provider errors. The repository full local gate, affected tooling gate after review fixes, and Docker definition checks passed. Independent standards/spec reviews found and closed shared-ledger reconciliation and cached-response classification gaps.

The broader existing deterministic evaluation completed 32/32 trials: all 40 initial targets, 45 actions and 40 readiness checks matched, but saved-XPath reuse failed for ID renaming and same-ID replacement (30/32 overall). Both failures were reproduced separately from unchanged base commit `f6966c2fa3590b6a3e03e68207fa3361c06be21f`; initial selection and fresh resolution passed in each. They are pre-existing locator-robustness limitations, not suppressed assertions or regressions introduced by this comparison. Evidence remains under `.artifacts/evaluation/shared-oracle-regression` and `baseline-mutation-id` / `baseline-mutation-replacement`.

See [pinned API/source research](stagehand-v4-compatibility.md) and the [evaluation contract](../evaluation.md) for setup, bounds and artifact semantics.
