# Target-resolution datasets and comparison baselines

Primary sources checked on 2026-09-29. These are recommendations for specification issue #1; no dataset has been downloaded or qualified, and no benchmark has been run.

## Recommendation

Use **owned, resettable browser fixtures for release gates**, **PhraseNode for the closest external task**, and a small **Mind2Web adaptation for broader page structures**. MiniWoB++ is useful for additional executable cases. WebLINX is relevant research, but its conversational task and noncommercial data terms make it a later choice.

None of these sources supplies a complete benchmark for our contract: one instruction, one eligible element, multiple equivalent XPaths, frame context, viewport preference, action state, and reliable `not_found`. Build the missing cases explicitly. External benchmark scores must remain separate from our release-gate score.

## Dataset comparison

| Source | Input and target labels | Fit and limitations |
| --- | --- | --- |
| **PhraseNode** | Webpage, natural-language command, target element. Captured DOM and element geometry; 51,663 commands across 1,835 pages. | Closest formulation. Commands include paraphrases, spatial/relational references, and form targets. Snapshot data is useful for grounding; it does not establish live action readiness or XPath durability. |
| **Mind2Web** | Task description, action trajectory, pre-action raw/cleaned HTML, operation, positive/negative element candidates with node IDs. | Broader real-site structure, but predicts the next action in a task. A self-contained instruction must be independently annotated or carefully selected for our contract. |
| **WebLINX** | Multi-turn user dialogue and demonstrations; recorded DOM, screenshots, element IDs and viewport bounding boxes. | Useful for contextual references and candidate ranking. Isolated commands may be ambiguous without conversation. Recorded geometry does not prove a reconstructed page has identical live state. |
| **MiniWoB++** | Executable synthetic browser tasks with generated utterances, DOM observations, element references and rewards. | Practical reproducible interaction tests. Choose single-target tasks; multi-step task success is a different metric from target selection. Synthetic coverage cannot establish real-site generalization. |

Sources: [PhraseNode paper](https://aclanthology.org/D18-1540.pdf), [Mind2Web schema](https://github.com/OSU-NLP-Group/Mind2Web/blob/main/README.md), [WebLINX paper](https://raw.githubusercontent.com/mlresearch/v235/main/assets/lu24e/lu24e.pdf), [MiniWoB++ repository](https://github.com/Farama-Foundation/miniwob-plusplus), [MiniWoB++ observations](https://miniwob.farama.org/content/observation_space/).

### Closest match: PhraseNode

The original task is explicitly selection of one webpage element from a command. It already separates pages across train/development/test, and its analysis identifies duplicate plausible targets and annotation noise. Its rendered snapshots include geometry and visibility, with targets drawn from visible interactive elements. Preserve original page splits and manually review ambiguous examples against our explicit-instruction/viewport policy. The archived pages are older and do not constitute coverage of current frame behavior or all application state rules. [Paper](https://aclanthology.org/D18-1540.pdf)

The project offers processed pages and command files separately; raw HTML/CSS is described as reference material. First validate that processed target identities map to browser-restorable nodes before committing to full XPath evaluation. Use a saved-page selection track if that mapping cannot be established. [Official resources](https://nlp.stanford.edu/projects/phrasenode/)

### Mind2Web adaptation

Use `raw_html` to retain targets that preprocessing removed; the documented positive list can be empty even though the original target exists in raw HTML. Keep annotation/action IDs as provenance. Operations are normalized to CLICK/TYPE/SELECT; original HOVER/ENTER labels require care. Cross-website/domain splits are valuable. [Schema and splits](https://github.com/OSU-NLP-Group/Mind2Web/blob/main/README.md)

Do not expose the current gold action representation as if it were an independent user instruction. A reviewed rewritten step is a derived dataset, with its rewrite method disclosed. Do not claim its accuracy is the original Mind2Web score. If the original viewport or rendered state cannot be reproduced, grade DOM target identity only and mark state/viewport checks unavailable.

### Coverage gaps

None of the reviewed schemas establishes sufficient iframe-chain, hidden-target rejection, obstruction, disabled/editable, missing-target, or selector-mutation coverage for this project. Use controlled fixtures to fill these gaps. Exclude hidden elements consistently, including hidden file inputs. Add explicit frame identity tests rather than assuming a dataset's element ID identifies a browser frame.

## Data reuse and provenance

| Resource | Publisher's stated terms | Repository treatment |
| --- | --- | --- |
| PhraseNode command files | CC BY 4.0 | Preserve attribution and mark adaptations. |
| PhraseNode processed pages | ODC-By 1.0 | Preserve the distinct database attribution terms. |
| PhraseNode code | Apache 2.0 | Do not apply the code license to the data or raw page assets. |
| Mind2Web dataset | CC BY 4.0; card also states research purpose | Preserve dataset attribution, original IDs, and adaptation notes. |
| WebLINX dataset | CC BY-NC-SA 4.0, additional third-party terms acknowledged | Keep optional until proposed reuse, redistribution, and provider submission are assessed; do not silently bundle into a hosted commercial demo. |
| MiniWoB++ software/task environments | MIT | Retain copyright/license notices for reused task files. Separately sourced demonstrations need their own provenance. |

Sources: [PhraseNode licenses](https://nlp.stanford.edu/projects/phrasenode/), [Mind2Web data card](https://huggingface.co/datasets/osunlp/Mind2Web), [WebLINX data terms](https://huggingface.co/datasets/McGill-NLP/WebLINX/blob/main/README.md), [MiniWoB++ license](https://github.com/Farama-Foundation/MiniWoB-plusplus/blob/main/LICENSE).

Pin dataset revision, source URL, original split, example IDs, checksum, license and any modifications in a manifest. Keep third-party assets out of ordinary source commits until their exact reuse conditions are understood. Prefer selective downloads; WebLINX documents downloading individual demonstrations. [Selective download example](https://huggingface.co/datasets/McGill-NLP/WebLINX/blob/main/README.md)

## Initial evaluation increment

Proposed sizes are engineering starting points, not statistical assurance:

1. Build 40 reviewed fixture cases spanning unique/duplicate labels, viewport preference, explicit off-screen scope, missing/hidden targets, labels and ARIA, native/custom controls, disabled/read-only/obstructed state, quoting/Unicode, nested frames and hostile page text. Include at least eight missing/hidden-only cases.
2. Add 30 development examples from PhraseNode, across at least ten pages, after validating identity mapping and data access. Keep a separately selected page-disjoint qualification subset sealed.
3. Add 20 reviewed Mind2Web steps across multiple site families. Report them as adapted single-step cases; do not mix them into original-benchmark claims.
4. Optionally import a few MiniWoB++ task families to check execution on disposable pages. Use held-out families as well as fresh seeds; fresh seeds alone do not create an unfamiliar task family.
5. Expand after the first baseline exposes missing coverage. Do not download full archives merely to produce a large case count.

Keep original and mutated versions, paraphrases, site families, and duplicates in the same split. Gold identity must live outside model-visible DOM: exclude answer-bearing metadata and prevent generated XPath from relying on harness-only IDs. Public benchmark contamination in model training cannot be ruled out; private original fixtures complement it.

## Stagehand comparison

Use a small separate Node adapter around `observe(instruction, { page })`. The official reference returns actions ordered by relevance, with selectors and suggested methods; it can observe a specified Playwright page. Take the first result for our one-target contract, then run the same independent validator. Zero results are a resolver miss; exceptions remain operational failures. Do not call `act()` during target-resolution scoring. [Observe API](https://docs.stagehand.dev/v3/references/observe)

Pin the installed SDK version and integration contract. Stagehand's documented frame/shadow support must not be mistaken for native XPath crossing these boundaries: normalize its selector/context representation and record any unsupported conversion. Shadow targets remain outside our initial eligible set. [Observe reference](https://docs.stagehand.dev/v3/references/observe)

Compare our resolver, Stagehand, and a simple lexical baseline on the same cases. A direct-XPath model prompt is an optional additional baseline. Use fresh equivalent browser contexts with identical page, viewport, scroll, frame state, instruction and timeout. Use the same model/provider when supported; otherwise label the comparison as whole-system rather than attributing differences to strategy alone.

Report top-one target accuracy, wrong-target and false-not-found rates, unique-correct XPath rate, state checks, latency distribution, tokens/cost, errors and failures by case category. Keep cold and cached results separate and include browser/DOM extraction and validation in end-to-end latency. If token usage is unavailable, mark it unavailable. Never use the reference target to choose among Stagehand results.

For mutations, measure both reuse of previously returned XPaths and fresh resolution. Count a selector that lands on a distractor as a failure even when another alternative succeeds. A displayed alternative list is not an automatically safe fallback policy.
