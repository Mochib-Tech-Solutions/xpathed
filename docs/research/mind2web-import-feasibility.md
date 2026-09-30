# Mind2Web import feasibility

Research checked on 2026-09-30 for [issue #7](https://github.com/Mochib-Tech-Solutions/xpathed/issues/7). These findings propose an adapter policy; they do not establish benchmark qualification or authorize paid inference. Only public documentation, source code and file metadata were fetched. No dataset shard, raw dump or model was downloaded, and no inference request was made during this investigation.

## Sources and reproducible download scope

Use the original offline Mind2Web dataset, not Online-Mind2Web, Multimodal-Mind2Web or Mind2Web-2. Pin code to `33bd95caeee7bba22dd08ecc935845e15c5e5dc7` and the Hugging Face dataset to `17ece8eb89862368edc0cc806acee6fca5163474`. These were the heads returned by the [GitHub commit API](https://api.github.com/repos/OSU-NLP-Group/Mind2Web/commits/33bd95caeee7bba22dd08ecc935845e15c5e5dc7) and [dataset API](https://huggingface.co/api/datasets/osunlp/Mind2Web) when checked.

The immutable [dataset tree metadata](https://huggingface.co/api/datasets/osunlp/Mind2Web/tree/17ece8eb89862368edc0cc806acee6fca5163474?recursive=true) gives these sizes. File checksums below are the LFS SHA-256 object identifiers, not Git blob identifiers; the downloader must independently hash the received bytes.

| Asset                       |         Bytes | SHA-256 / use                                                                                                                         |
| --------------------------- | ------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `data/train/train_10.json`  |    28,366,146 | `182542d7947b3fa9e90fc57a3d82d4d8f2997ca5a06664217720d7a78a956e33`; smallest complete training shard, suitable initial identity pilot |
| All 11 training JSON shards | 5,931,387,773 | Manifest each shard separately; about 5.93 GB before derived artifacts                                                                |
| `test.zip`                  |   567,745,122 | `8f5fbe72afab942fe97cdf7fb397e179885d89b5c16862288e9a14bc6d41ca89`; compressed bytes, not extracted size                              |

The pilot's immutable URL is [train_10.json at the pinned revision](https://huggingface.co/datasets/osunlp/Mind2Web/resolve/17ece8eb89862368edc0cc806acee6fca5163474/data/train/train_10.json). Do not clone the whole LFS repository for a small pilot. The candidate-score pickle is unnecessary for our capture and must not be deserialized as a shortcut.

## Labels, splits and instructions

The source declares 1,009 training tasks and test splits of 252 cross-task, 177 cross-website and 912 cross-domain tasks. These are task counts, not executable action counts. Preserve `annotation_id`, `action_uid`, website/domain/subdomain, original split and action index. `confirmed_task` is a task instruction; `action_reprs` describes the action sequence. `operation.op` collapses HOVER and ENTER into CLICK; preserve `original_op` rather than silently changing our action labels. The source also distinguishes original targets from algorithmically promoted top-level targets. Empty cleaned positive candidates do not mean the original page had no target. [Pinned dataset schema](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/README.md#data-fields)

The upstream prediction input combines the task, earlier actions and current page candidates; it does not use a separately authored command for every step. Its target output contains the annotated operation and value. Therefore copying the current `action_reprs` entry, target text or gold operation into our input would evaluate an easier, answer-derived task. [Upstream input/output construction](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/src/action_prediction/dataloader.py)

Recommended adaptation: author a current-page instruction from task intent, preceding context and the page with gold identifiers hidden. Independently review whether that instruction identifies the original target and action without requiring a future navigation. Record author/reviewer, input context, policy version and reasons for rejection. Unreviewed task steps remain `adaptation-required`, not automatically eligible. Keep all steps, paraphrases and mutations from a task together. Keep source test categories separate; any exposed/tuned case family becomes regression evidence. A reviewed subset of public training data is not an unseen benchmark.

## Target identity and reconstruction limits

`raw_html` is already a serialized DOMSnapshot transformation. The source constructs artificial `text` elements, normalizes attribute punctuation to underscores, adds `backend_node_id` and historical bounding rectangles, copies input values and nests frame trees. Cleaning removes attributes and may collapse structure. Consequently neither string is an original executable HTML page, and mechanically loading it into Chromium does not reproduce original layout or accessibility semantics. [Pinned DOM transformation](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/src/data_utils/dom_utils.py)

The trace processor configures `data-pw-testid-buckeye` as the original target annotation and resolves it using `action_uid`. It hides an annotation highlight before capture, then extracts screenshots, DOMSnapshot data and MHTML from the trace viewer. In transformed `raw_html`, attribute normalization implies `data_pw_testid_buckeye`; verify that implication on actual data instead of assuming it universally. [Pinned trace processing](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/src/data_utils/process_trace.py)

Recommended identity policy:

- Resolve the original annotation to exactly one source node and cross-check its backend node ID against original-positive labels where available. Missing, duplicate or conflicting mappings fail validation.
- Retain raw source privately when cleaning loses the target. Never choose an arbitrary positive ancestor merely to increase coverage.
- Keep node mappings outside resolver input. Strip target annotations, annotation highlights, captured values unrelated to the instruction and dataset-only geometry from submitted page content. Derive candidate identities independently of which node is gold.
- Count raw-only targets, unsupported frame/shadow scope, ambiguous labels, sanitization loss and reconstruction failures separately. A missing positive label is neither an absent-target success nor automatically a resolver failure.

Start with **offline target-selection-only** cases. Historical geometry, hit testing, enabled/editable state, stability and readiness remain unavailable unless independently recoverable. A browser can verify XPath identity against a deliberately reconstructed local DOM, but that proves identity in that derivative DOM, not historical page replay. If offered, name that mode explicitly and report historical state as unknown. A genuine browser-replayable case requires its own reconstruction evidence; source markup alone does not satisfy that claim.

The raw dump includes trace/HAR/session storage/MHTML assets and requires separate Globus access. The authors warn that network replay is nontrivial. Raw asset retrieval and storage sizing were not verified here; avoid making that full dump a prerequisite for the initial adapter. [Raw-dump documentation](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/README.md#raw-dump-with-full-traces-and-snapshots)

## Terms, private assets and provider submission

The dataset card declares CC BY 4.0 for the dataset. Repository code has an MIT license. Keep attribution records for annotations/processed snapshots distinct from copied source code and raw third-party page resources. The upstream README requests that unencrypted test files not be redistributed online and states a research-purpose intent. Neither statement establishes separate rights to every website image, page asset, account artifact or personal datum. [Dataset card](https://huggingface.co/datasets/osunlp/Mind2Web/blob/17ece8eb89862368edc0cc806acee6fca5163474/README.md), [code license](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/LICENSE), [dataset access and disclaimer](https://github.com/OSU-NLP-Group/Mind2Web/blob/33bd95caeee7bba22dd08ecc935845e15c5e5dc7/README.md)

CC BY permits adaptation with attribution and change notices, but explicitly does not guarantee all necessary privacy/publicity rights. This is why the proposed adapter keeps source pages and derivatives in ignored private storage and publishes only importer code, synthetic tests, attribution and aggregate counts. That is a project handling policy, not a claim that CC BY itself forbids sharing. [Creative Commons terms](https://creativecommons.org/licenses/by/4.0/)

Dataset availability does not establish permission to send every record to a remote provider. Review sanitized inputs and destination handling before live evaluation. OpenRouter distinguishes its own optional logging from upstream endpoint policies; its request-level `provider.zdr` can restrict inference to zero-retention endpoints. This does not override asset rights, remove the need to sanitize, or prove our existing route/account is configured accordingly. [OpenRouter data handling](https://openrouter.ai/docs/guides/privacy/data-collection), [ZDR routing](https://openrouter.ai/docs/guides/features/zdr)

## Smallest useful pilot and remaining decisions

1. Download and checksum only the pinned smallest training shard into private ignored storage. Inventory every task/action before eligibility filtering.
2. Validate raw/cleaned target mappings without inference. Preserve complete denominators and per-record exclusion reasons.
3. Independently adapt/review a small fixed set of instructions. Demonstrate an honestly limited offline case; use separately evidenced replayable assets for any historical browser claim.
4. Test the adapter with synthetic duplicate/missing/mis-mapped targets, normalized attributes, cleaned-target loss, original-operation differences and split collisions. Those tests require no paid model calls.
5. Only after eligibility and submission policy are settled, run a bounded live pilot if authorized. Forecast each selected dataset/split using measured input/output tokens and repetitions with timestamped route prices; include excluded and unsupported records in the coverage report. No valid full-suite dollar estimate is available from task totals alone.

Remaining product decisions are instruction-review ownership, whether a reconstructed-DOM identity demonstration is useful alongside offline selection, and the explicit budget and handling policy for any later provider run. No decision is needed to start deterministic import/identity work.
