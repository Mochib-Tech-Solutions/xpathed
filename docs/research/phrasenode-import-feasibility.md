# PhraseNode import feasibility

Primary sources checked on 2026-09-30 for issue #7. This is research and a proposed implementation boundary, not an accepted policy or a completed dataset evaluation. No paid inference or full dataset download was performed. Archive inspection used bounded HTTP byte ranges for ZIP metadata only.

## Findings

PhraseNode fits single-target selection: its paper reports 51,663 commands on 1,835 pages, with page-disjoint 70/10/20 train/development/test partitions. The original task grades the selected element; historical visibility and geometry do not establish current click readiness. The paper also documents ambiguous commands and noisy labels. Preserve source splits and report exclusions; neither the published command total nor an adapted score establishes executable case count or benchmark equivalence. [Original paper, sections 2 and 4](https://aclanthology.org/D18-1540.pdf)

The canonical source repository's `master` resolved to `84464381f5339196a1bbc937f6906bd99d5346b9`, committed 2022-07-26. Pin that revision for schema provenance; its download script references separately hosted mutable archives, so the code SHA does not pin data. Record an archive SHA-256 after any actual download. No upstream cryptographic checksums were observed in the project page or script. [Revision](https://github.com/stanfordnlp/phrasenode/commit/84464381f5339196a1bbc937f6906bd99d5346b9), [download script](https://github.com/stanfordnlp/phrasenode/blob/84464381f5339196a1bbc937f6906bd99d5346b9/download_dataset.sh)

## Assets and practical download scope

These exact official URLs returned HTTP 200 to HEAD on 2026-09-30 and HTTP 206 for bounded byte ranges. Sizes are observed metadata, not content-integrity checks.

| Asset                                                                               | Compressed bytes | ZIP member bytes | Observed layout                                                    |
| ----------------------------------------------------------------------------------- | ---------------: | ---------------: | ------------------------------------------------------------------ |
| [Commands](https://nlp.stanford.edu/projects/phrasenode/dataset-final.zip)          |        2,552,602 |       16,561,708 | Four `combined-v2-cleaned.{all,dev,test,train}.jsonl` members      |
| [Processed pages](https://nlp.stanford.edu/projects/phrasenode/processed-pages.zip) |      136,441,380 |      138,086,012 | 1,838 entries, including directory entries and `v6/info-<page>.gz` |
| [Raw HTML/CSS](https://nlp.stanford.edu/projects/phrasenode/raw-html.zip)           |      122,773,465 |      705,573,582 | 6,510 entries, including `v6/<page>.html`                          |

The processed-page member sizes remain gzip-compressed: 138 MB is not the final JSON memory or disk requirement. Entry counts include non-record entries and must not become evaluation denominators. The `all` command file must not be concatenated with train/dev/test, which would duplicate examples. Both archive range requests and their central directories were successfully inspected; content checksums, record counts and reconstructibility remain unmeasured.

For import, use commands plus processed pages first. GloVe, vocabulary downloads and the old Python/PyTorch training environment are unnecessary for the xpathed adapter. Fetch raw assets only for selected reconstruction probes; never visit the current website as a substitute for its archived state. The official page lists raw HTML/CSS as reference material. [Official resources](https://nlp.stanford.edu/projects/phrasenode/), [repository setup](https://github.com/stanfordnlp/phrasenode/tree/84464381f5339196a1bbc937f6906bd99d5346b9)

## Identity and reconstruction

An annotation contains `exampleId`, `version`, `webpage`, `phrase` and integer `xid`. The loader groups by `(version, webpage)` and opens `infos/<version>/info-<webpage>.gz`. Keep the original phrase as source evidence: the reference loader lowercases and strips it, which is a transformation, not an intrinsic source property. [Dataset loader](https://github.com/stanfordnlp/phrasenode/blob/84464381f5339196a1bbc937f6906bd99d5346b9/phrasenode/dataset.py)

Join the annotated `xid` to a unique processed node's `xid`; it is not an HTML `id`, array index or model candidate ID. The reference parser drops text nodes from its model-node index and ignores SVG children; its `xid_to_ref` dictionary would overwrite duplicates. The new importer should instead reject missing or duplicate identities explicitly. Processed page fields include metadata, node arrays, relationships, attributes, geometry and common/override styles. [Page parser](https://github.com/stanfordnlp/phrasenode/blob/84464381f5339196a1bbc937f6906bd99d5346b9/phrasenode/webpage.py)

The original DOM extractor reads `xid` from `data-xid`. It records input values and attributes, skips scripts/styles in its node traversal, starts at `document.body`, and has no explicit traversal into iframe documents. These are reasons to sanitize imported evidence and avoid claiming frame coverage. If raw snapshots retain `data-xid`, capture that mapping into an external oracle before removing it from the model-visible DOM and generated XPath candidates. Presence and uniqueness in actual raw files still require a content pilot. [Extractor](https://github.com/stanfordnlp/phrasenode/blob/84464381f5339196a1bbc937f6906bd99d5346b9/phrasenode/downloader/get-dom-info.js)

Recommended tracks, inferred from those schemas:

- **Saved-page selection:** trustworthy unique source identity but no faithful browser restoration. Grade selected source node only. Browser XPath uniqueness, readiness, obstruction and viewport checks remain unavailable.
- **Browser replay:** selected archived HTML with verified source-to-browser identity, sanitized scripts/requests, documented viewport and a reconstruction report. Grade XPath against the independent node mapping; qualify geometry/state only to the extent reconstruction supports it.
- **Excluded or reconstruction-limited:** absent assets, duplicate/missing target IDs, unsupported frame context, ambiguous labels or privacy restrictions. Retain records and reasons in the denominator report.

Converting the processed tree into synthetic HTML can test importer mechanics. It cannot, by itself, turn historical state into faithfully replayed browser evidence.

## Reuse terms and provider submissions

The publisher states separate licenses: commands **CC BY 4.0**, processed pages **ODC-By 1.0**, code **Apache 2.0**. It gives no separate raw-page license on that page; do not infer Apache or CC coverage for raw HTML/CSS. [Publisher's licenses](https://nlp.stanford.edu/projects/phrasenode/)

CC BY requires appropriate credit, a license link and change notices, and expressly warns that privacy and other rights may remain. ODC-By permits database reuse with its notice conditions, while section 2.4 excludes rights in individual contents from its grant. Dataset licensing therefore does not establish blanket permission to redistribute all page assets or send all recorded form values to a provider. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [ODC-By sections 2.4 and 4](https://opendatacommons.org/licenses/by/1-0/)

Proposed repository treatment: keep source/derived page assets ignored and private; store URLs, hashes, attribution and transformations in manifests; redact unrelated form values; submit only reviewed command/candidate payloads for an explicitly scoped live pilot. Provider retention/routing terms and the chosen payload must be checked separately. This note does not establish legal clearance for every third-party asset.

## Decisions before implementation

1. Recommended first slice: both accepted adapters, import/accounting tests and a local identity/reconstruction pilot with no inference fees. Support saved-page records honestly rather than promising all source records will run in a browser.
2. Review actual pilot payloads before deciding on paid external inference. Cost cannot be forecast from 51,663 commands alone: measure eligible counts, prompt/output tokens, repetitions and the selected route's prices. Downloads/imports incur local resource use but no model API charge.
3. Keep qualification incomplete. Development examples used for adapter design stay development evidence; preserve untouched source test groups for a later frozen evaluation, with public-dataset training contamination still unknown.

Unresolved facts are source-content identity success rate, raw asset completeness, exact eligible counts, provider payload permission and measured inference cost. These need a bounded content pilot, not a larger literature search.
