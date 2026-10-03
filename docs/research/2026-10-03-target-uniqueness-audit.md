# Target uniqueness audit — 3 October 2026

## Result

The collection admits **573 of 1,084 PhraseNode cases**, across **171 historical page families**. The remaining **511 cases are explicitly excluded**: 288 lack necessary evidence, 218 are ambiguous and five have contradictory expectations. Original instructions, source labels, archive bytes and splits remain unchanged. The admitted split counts are 546 dev, 24 test and three train.

This review supersedes the admission decisions in the [initial source audit](2026-10-03-phrasenode-label-audit.md) and [prepared-input follow-up](2026-10-03-prepared-input-audit.md). It adds no model, prompt, grader or runtime behavior change.

## Why another review was needed

The second advisory-hints comparison exposed a remaining label problem: a generic request to download an application had an expected footer link, although direct application download controls also satisfied the request. Faithful source import and preserved input bytes do not establish that the source target is the only supported answer.

The run stopped scheduling new attempts and drained active work. We then reviewed **all 665 previously admitted cases**, including passes and failures, against the exact sanitized model input. Of these, 573 remained validated, 80 became ambiguous and 12 lacked sufficient evidence. The review was prompted by observed model outcomes; it was not blinded and does not establish held-out generalization.

## Review rules

- The instruction must identify the expected target using evidence actually retained in the prepared input. The original annotation alone cannot justify a singleton answer.
- Inspect semantically competing controls, including alternatives with different names. A keyword match alone can miss equivalent navigation or download paths.
- Distinguish a named control from repeated noninteractive wrappers. Repeated text alone does not make a case ambiguous, but competing actionable controls or unresolved parent/child interpretations do.
- Quarantine generic search requests when multiple search-related fields, submit controls or navigation paths remain plausible. Explicit field-entry or submission wording can distinguish them.
- Positional instructions need retained grouping and ordering evidence. Candidate IDs or dropped source geometry alone cannot establish visual position.
- Unnamed or unrelated controls do not automatically compete with a uniquely named target. Missing evidence must affect the requested distinction.
- Preserve unresolved source labels and exclude them from scoring. Do not guess replacements or rewrite instructions to match the expected answer.

Cases were partitioned into disjoint ranges for review, followed by consistency checks across search, sign-in, repeated text and positional requests. One overlapping download case supplied a supplemental cross-check; it was counted once. Every decision is bound to the imported input, expected label and actual prepared input. Mechanical checks verified complete coverage, matching hashes and the existence of recorded competing candidate IDs.

## Evidence

The [public summary](../assets/evaluation/target-uniqueness-audit.json) records all 92 new exclusions, counts, source revision and hashes of the private review files. The [pinned label manifest](../../evaluation/datasets/label-review.json) preserves all 1,084 records and adds a uniqueness-review binding to each of the 665 reviewed records. Private evidence contains individual rationales and the actual prepared inputs; public files contain no raw page payloads or instructions.

The reviewed preparation and experiment source is `a8e0d560f4a170b248dcd5aadeb508274df30bf1`. The original archive SHA-256 remains `72d140c1c5d4ef9032277ce9422f6f4039c6c864f166b3a6572078576db82d86`. The combined private decision file SHA-256 is `56270df51c850fa0b0b0070b10aacb93207a6378ca21b59591f9de99db12c485`.

## Retained experiments and continuation

The first run retains 949 of 2,562 planned attempts; the second retains 1,971 of 2,544. All original outcomes, exclusions, missing attempts and charges remain part of their original runs. Neither incomplete offline cohort is the final corrected accuracy comparison.

The second run completed its separate 183-case browser cohort across all three arms (549 attempts). Its replay and independent evidence audit passed. This admission-only correction permits retaining that cohort while running a separately frozen offline comparison on the 573 admitted cases. Source identities and denominators must be reported separately; the new offline cohort cannot silently replace the earlier attempts. No further paid inference should start before this correction is merged into main.

The imported cases evaluate offline target selection. They do not certify browser eligibility, action readiness, live DOM state or workflow execution. These decisions are supported review judgments, not a guarantee that the dataset is error-free. Future changes to the retained evidence require a new review before scoring.
