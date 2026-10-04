# Spatial item selection

Measured on 3 October 2026; merged through [PR #102](https://github.com/Mochib-Tech-Solutions/xpathed/pull/102) as `0499a5cf4748464aa026c654dc90cd6f4e0dc9d9`. This records a real-page investigation and a two-arm full Resolver pipeline check. It does not update the [recorded Basic/Improved/Stagehand comparison](clean-evaluation-comparison.md), which uses earlier configurations, different cases and the common action-and-target grader.

## Why the wrong product was selected

On Sauce Demo, “click on the item under the sauce labs backpack” selected Backpack's Add to cart button. “click on the card of the item that is under the backpack card” selected Bike Light beside Backpack. The intended target was the whole Bolt T-Shirt card below it.

Capture already contained geometry: Backpack's image link was at `(103,155)`, Bike Light's at `(658,155)`, and Bolt's at `(103,407)`. Whole product wrappers were absent because they had neither direct text nor a control/ARIA contract. Geometry without card identity and grouping left the model to infer the wrong relationship. A prompt-only change did not fix it. Same-node XPath verification can correctly verify the wrong selected element; independent target labels establish intent.

Browser now retains generic repeated-item containers alongside their controls and records parent identities. Resolver provides a compact named layout with measured directional neighbors among disjoint aligned peers sharing a parent and frame. The prompt distinguishes cards, images and named controls. Direction follows geometry rather than DOM order. Parent relationships and repeated-item geometry are revalidated before results return. See [spatial item context](../resolution.md#spatial-item-context) for the rules and limits.

The exact-page preservation check retained all 40 original candidates unchanged in tag, role, safe text, label, placeholder, scope, state, geometry and appearance. Six whole product cards were added, giving 46 current-view candidates; capture-scoped IDs were reassigned. The final card request used 18,429 model-input bytes versus 13,547 before the change. Existing capture/input budgets and privacy rules remain in force; no candidates were removed to fit the layout. Ordinary pages without a layout retain the existing model-input shape.

## Real Sauce Demo checks

| Request                                                           | Independently expected and selected node |
| ----------------------------------------------------------------- | ---------------------------------------- |
| click on the item under the sauce labs backpack                   | Whole Bolt T-Shirt card                  |
| click on the card of the item that is under the backpack card     | Whole Bolt T-Shirt card                  |
| Click the product image directly below Sauce Labs Backpack.       | Bolt T-Shirt image                       |
| Click the Add to cart button under the Sauce Labs Backpack title. | Backpack's Add to cart button            |
| Click the product card to the right of Sauce Labs Backpack.       | Whole Bike Light card                    |

All five passed target identity checks, with unique same-node XPath verification. Reported cost for these five calls was **$0.001881502**. Requests selected and highlighted nodes; no product action was executed. A card request is graded against the card itself, rather than a child image or cart button.

## Complete paired pipeline check

Each arm used the same frozen 191-case collection and independent labels, with reset browser sessions, DeepSeek V4.1 Flash through Wafer, reasoning/fallback disabled, strict structured output and 4,096 output tokens. One original attempt was planned per case per arm, without retries or excluded failures. The retained full pipeline grader checks action decomposition, targets, outcomes, XPath, state and readiness; its results are not the narrower three-system common score.

The pre-fix comparator is main `b1789373`, **not archived Basic**. The final candidate is `7b08bb8b`; its tested tree equals merged main `0499a5c`. The intermediate candidate and its lost pass remain recorded.

| Arm                       | Completed / planned | Passed | Failed | Gains vs pre-fix main | Lost passes |
| ------------------------- | ------------------: | -----: | -----: | --------------------: | ----------: |
| Pre-fix main              |             191/191 |    160 |     31 |                     — |           — |
| Initial spatial candidate |             191/191 |    169 |     22 |                    10 |           1 |
| Final spatial candidate   |             191/191 |    169 |     22 |                     9 |           0 |

The initial candidate lost `scope-horizontally-offscreen-episode-is-absent`. Restricting layout metadata to repeated items and tightening named-target matching restored that pass. The final 22 failing cases also failed pre-fix main; they remain failures, including plural action-decomposition and unsupported-command errors. The [public evidence](../assets/evaluation/spatial-comparison.json) retains every gain, loss and remaining failure from both comparisons.

| Behavior    | Cases | Pre-fix passes | Final passes | Gains | Lost passes |
| ----------- | ----: | -------------: | -----------: | ----: | ----------: |
| appearance  |     5 |              5 |            5 |     0 |           0 |
| cardinality |     4 |              1 |            2 |     1 |           0 |
| context     |    60 |             48 |           54 |     6 |           0 |
| frames      |     3 |              3 |            3 |     0 |           0 |
| robustness  |     3 |              3 |            3 |     0 |           0 |
| scope       |    26 |             26 |           26 |     0 |           0 |
| state       |    56 |             44 |           46 |     2 |           0 |
| targeting   |    34 |             30 |           30 |     0 |           0 |

All seven added spatial cases passed the final arm. They cover whole cards, images, a named cart control, above/right/below directions and CSS order differing from DOM order. The reordered grid independently expects Bike Light below Backpack, preventing an answer based on the usual product sequence. Across the full collection, 160 final model inputs were byte-identical to pre-fix main.

### Timing and charges

| Arm                       | p50 / p95 HTTP duration | Reported observed USD | Accounting observations / cases |
| ------------------------- | ----------------------: | --------------------: | ------------------------------: |
| Pre-fix main              |       772.4 / 1246.8 ms |          $0.020133738 |                         190/191 |
| Initial spatial candidate |       831.4 / 1611.3 ms |          $0.025484034 |                         190/191 |
| Final spatial candidate   |       787.9 / 1757.0 ms |          $0.024391330 |                         190/191 |

The one unavailable accounting observation per arm belongs to the capture-budget case, which made no inference call. There were 570 distinct observed provider generation IDs across these three arms. Timing and cost are descriptive; this does not claim a latency improvement. Each formal arm retains all original planned attempts. Three successful exploratory saved-input probes were overwritten by later exploratory records, so complete exploratory responses and spend are unavailable; no complete investigation-spend total is claimed.

## Evidence identity and limits

The [public evidence](../assets/evaluation/spatial-comparison.json) includes source/image identities, configuration IDs, the shared case hash, run IDs, original manifest digests, counts, timings, charges and complete paired failure lists. Its `originalAggregateSha256` binds the retained private aggregate; the public projection adds measurement/merge identity and clarifies scope without publishing page inputs or provider payloads.

The private manifests fingerprint the shared evaluation worktree rather than independently fingerprinting archived pre-fix source. The recorded baseline Browser/Resolver images identify the actually executed pre-fix runtime; candidate images and the tested/merged tree are recorded separately. This is research evidence rather than release qualification.

Final deterministic pipeline checks passed **221/221**, with **22/22** saved-locator mutations and **22/22** fresh resolutions after mutation. Real-browser integration passed **87/87**. An earlier deterministic run passed 220/221 because its controlled provider fixture requested a scope absent from the capture; correcting only that provider setup, while retaining the expected node, produced a separate passing run. Original failed evidence was retained.

The capture heuristic does not discover every possible wrapper. Spatial relationships require disjoint aligned repeated peers sharing a parent and frame; tied neighbors remain tied. Independent real-page checks and controlled authored cases do not establish unseen-site generalization.

Archived Basic, Stagehand and the admitted saved-page collection were not rerun for this change. Updating their scores requires complete new arms on matched cases, settings and grading boundaries under the [comparison rules](../evaluation.md#matched-inputs-and-scoring). Replaying or documenting this two-arm check cannot establish a new three-system ranking.
