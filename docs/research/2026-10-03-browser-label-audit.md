# Controlled browser label audit

Reviewed 2026-10-03, before the Jev accuracy experiment.

## Result

All 220 original controlled browser definitions were reviewed against their authored fixture DOM and the current resolution contract. No instruction-to-target mapping needed correction. The audit found a real grading omission, 11 misleading case names and six duplicate mutation definitions. Those are corrected. The retained 214 cases pass a fresh provider-free browser run, including all independently mapped targets, readiness labels, unsupported reasons and saved-locator mutations.

The [per-case inventory](../assets/evaluation/browser-label-audit.json) accounts for every original definition. It records original and retained case hashes, instruction, expected result, source-review basis, fixture hash and the corresponding final browser trial. Six records point to consolidated cases; they were not discarded as failures.

This report covers controlled browser cases. It does not certify imported PhraseNode labels, which require a separate review of original source annotations and the transformed evidence actually supplied to the model.

## Review method

The source review compared each instruction with the authored HTML or inline DOM tree in [the case files](../../evaluation/cases/index.json), [fixture renderer](../../evaluation/fixtures/pages.mjs) and [fixture bodies](../../evaluation/fixtures/current-view.json). It checked:

- Intended node and disambiguating name, section, row, frame or position.
- Explicit action, duplicate mentions, all-target sets, named-target order and scoped absence.
- Hidden/inert/collapsed content, viewport and frame clipping, disabled/readonly controls, and custom-control limits.
- Unsupported mixed interactions, future-state dependencies and shadow boundaries.
- Provider fault expectations and mutation behavior separately from semantic selection.

The [resolution contract](../resolution.md#eligibility-and-action-observations) defines readiness independently of target identity. A disabled target remains found; hover and inspection do not require enabled state. Keyboard, native select and upload readiness remain unknown when keyboard behavior is unobserved. A valid unique XPath does not prove that a label is semantically correct.

Only after that review did the deterministic provider feed controlled selections through Resolver and Browser. The DOM oracle resolves independent CSS labels, checks document/frame identity and confirms same-node XPath matches. It also checks unchanged page state. The controlled provider is a pipeline test double; its choices were not used as evidence that the English instruction was interpreted correctly.

## Corrections

### Expected reason codes were ignored

Three cases already declared per-action `code: unsupported_action`, but the grader never compared that field. A response with the wrong unsupported reason could pass. A negative test reproduced that failure before the fix.

The grader now enforces every declared per-action reason code and counts an unsupported answer as correct only when its labelled reason also matches. All eight unsupported browser cases now declare a reason:

- Mixed actions: `unsupported_action`.
- Sequential clicks or a future confirmation dialog: `current_state_dependency`, preserving the shared `click` action.
- The control inside an open shadow root: `unsupported_scope`.

Missing codes and an incorrect `ambiguous` code fail the focused negative tests. Request-level operational diagnostics retain their separate checks.

### Names overstated readiness

Eleven `state-...-is-ready` IDs actually expected `unknown`. The expected readiness was correct. The IDs now end in `readiness-is-unknown`: native Country select, native date fill, textarea type/clear/focus/blur/keypress, attachment upload, follow-up question fill, codec select and micrograph upload. Every former ID remains in `sourceIds`.

### Duplicate mutations inflated the deterministic denominator

Six form cases repeated the same instruction, fixture, viewport, mutation and target under two names: wrapper insertion, sibling insertion, class change, ID change, duplicate insertion and rerender. Each pair is now one `preserves-current-view-target` case retaining the stronger before/after viewport assertion and all historical source IDs. A catalogue test prevents those duplicate mutation inputs from returning and checks the retained aliases.

| Group       | Original definitions | Retained cases |
| ----------- | -------------------: | -------------: |
| Targeting   |                   34 |             34 |
| Cardinality |                    4 |              4 |
| Appearance  |                    5 |              5 |
| Context     |                   53 |             53 |
| Scope       |                   26 |             26 |
| State       |                   56 |             56 |
| Robustness  |                   11 |             11 |
| Frames      |                    3 |              3 |
| Locators    |                   28 |             22 |
| Total       |                  220 |            214 |

The live release-eligible browser collection remains 183 cases because mutation cases were already excluded from that track. The retained catalogue represents 85 distinct fixture definitions, including inline variations; it does not represent 85 external websites.

## Verification evidence

The final run used isolated Compose project `xpathed-evaluation-label-audit-20261003`, four browser workers and no provider credentials. Its containers and network were removed after completion.

```sh
XPATHED_EVALUATION_PROJECT=xpathed-evaluation-label-audit-20261003 \
  scripts/evaluate.sh --output .artifacts/evaluation/browser-label-audit-final --concurrency 4
node evaluation/run.mjs --replay .artifacts/evaluation/browser-label-audit-final
```

| Check                                      |  Result |
| ------------------------------------------ | ------: |
| Original attempts completed and passed     | 214/214 |
| Independently intended targets             | 194/194 |
| State assertions                           | 158/158 |
| Readiness assertions                       | 178/178 |
| Unsupported reason assertions              |     8/8 |
| Saved locator mutations                    |   22/22 |
| Fresh resolution after mutation            |   22/22 |
| Focused fixture/oracle/runner/grader tests |   49/49 |

Replay recomputed the final results successfully. An earlier run before the reason-code grader fix also passed 214/214 and remains separately retained at `.artifacts/evaluation/browser-label-audit`; the final run is the evidence for the corrected grader. There were no retries of failed provider attempts or paid calls.

Final manifest ID: `85ae3531-293a-4263-aa8b-d2a2528c0daf`. Manifest content hash: `cd73300675e50aec124c8596e3c5c92d59a7776d4c4e90df8e52915eeced61ee`. The run used working-tree changes over `b4e29819d1d7ef406b4b879779fca2da96a367c8`, with source-tree hash `dd9bab3de1681f920c1a228cf92343ef5b6c80536749a9ae5053302abc51655a`; it is not an unmodified-commit claim. Per-file source fingerprints and case/trial identities are retained in the inventory.

Imported-dataset loading and selection guards were edited independently while this browser run executed. The controlled cases, fixture implementation, Browser/Resolver source and grader stayed unchanged and the saved run replayed successfully. This receipt validates those browser boundaries; it is not an exact receipt for the entire final branch tree. The dataset guards require their separate tests.

## Limits

No unresolved wrong-target label was found in these controlled fixtures. That is a review conclusion for the recorded source, not a guarantee that every future natural-language interpretation is unambiguous. Browser checks establish the authored states under the recorded Chromium/viewport configuration. They do not establish model accuracy, real interaction success or external-site coverage.

Some cases intentionally test a narrow property and omit unrelated readiness assertions. For example, text-locator mutation cases primarily establish identity and privacy. The catalogue still needs broader ambiguity, negation, dense current-view, state-qualified target selection and real-page coverage before it can support broad accuracy claims. Adding those cases is separate from certifying that the existing expected answers are valid.

## Follow-up: Member code hover instruction

A further review on 2026-10-03 found an ambiguity missed by the original source audit. In `targeting-external-form-field-for-hover`, the instruction “Hover over Member code.” names both a visible `<label for="member-code">` and its associated readonly textbox. Both are eligible hover targets. The original review established the intended textbox and its readiness, but did not establish that the instruction uniquely requested that node. This qualifies the earlier conclusion that no instruction-to-target mapping needed correction.

The current prompt distinguishes requested controls from surrounding containers and repeated descendant text. Neither that rule nor the [hover readiness contract](../resolution.md#eligibility-and-action-observations) makes a bare name prefer a textbox over its separate visible label. This finding follows from the instruction, fixture DOM and product contract; model agreement is not an oracle.

The instruction is now **“Hover over the Member code field.”** The case ID, expected `#member-code` identity, action, readiness and controlled provider response are unchanged. Its `sourceReview` retains the original wording and explains the correction. All eight supported hover cases were checked for the same issue; the other seven directly name a unique button or link and have no separate same-name label/control pair. Unsupported mixed-action instructions remain unsupported as a whole.

The archived [per-case inventory](../assets/evaluation/browser-label-audit.json), original browser receipts and completed frozen study attempts remain unchanged. The earlier deterministic results validate the original case input and cannot certify the revised wording. Report the frozen study's original denominator, with a separate sensitivity analysis excluding this disputed instruction; do not claim that the revised instruction was evaluated by those attempts.

Focused provider-free validation passed: the three existing catalogue tests for reviewed cases, case identity and split/coverage integrity. A direct comparison against `HEAD` confirmed that only this instruction and its `sourceReview` changed in the catalogue; expected labels, provider response, other fields and other cases are identical. Formatting checks passed. No new model inference or browser execution is claimed for the revised wording.
