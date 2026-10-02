# System diagrams

The SVGs are embedded in the project documentation. The three system-flow diagrams also have HTML viewers and JSON sources. The database schema is a directly editable SVG.

| Diagram                | Image                         | Interactive viewer              | Source                          |
| ---------------------- | ----------------------------- | ------------------------------- | ------------------------------- |
| Service ownership      | [SVG](system-design.svg)      | [HTML](system-design.html)      | [JSON](system-design.json)      |
| One resolution request | [SVG](resolution-flow.svg)    | [HTML](resolution-flow.html)    | [JSON](resolution-flow.json)    |
| Evaluation and release | [SVG](evaluation-release.svg) | [HTML](evaluation-release.html) | [JSON](evaluation-release.json) |
| Diagnostic storage     | [SVG](diagnostic-storage.svg) | —                               | SVG itself                      |

GitHub displays HTML files as source. Clone the repository or download an HTML file, then open it in a browser. Each viewer is self-contained and works locally.

## Update the storage schema

`diagnostic-storage.svg` shows the physical columns and indexes defined by `src/ClientApi/Data/AppDbContext.cs` and its migration. Edit that SVG directly when the schema changes. It represents one table; embedded JSON payloads are not related tables. The column names, types, nullability, primary key and indexes were checked against the EF Core model, and the rendered SVG was inspected in Chrome at its native 1100 × 740 size. Its schema check and visual review are separate from the Archify receipts below.

## Regenerate a system-flow diagram

Use an installed [Archify](https://github.com/tt-a1i/archify) skill. Set `ARCHIFY_PATH` to its directory, then run these commands from the repository root. The checked-in artifacts were generated with Archify 2.17.

```sh
export ARCHIFY_PATH="$HOME/.agents/skills/archify"
node "$ARCHIFY_PATH/bin/archify.mjs" validate architecture docs/diagrams/system-design.json --quality showcase --json
node "$ARCHIFY_PATH/bin/archify.mjs" deliver architecture docs/diagrams/system-design.json docs/diagrams/system-design.html --quality showcase --json
node "$ARCHIFY_PATH/bin/archify.mjs" visual-check docs/diagrams/system-design.html --json
```

Use type `sequence` for `resolution-flow` and `architecture` for `evaluation-release`. The release map uses explicit component positions to keep its labels readable in the README. Run each step only after the preceding command passes. Open the delivered HTML and choose **Export → SVG**. Save that canonical export beside its JSON and HTML; it includes its fonts, background and light/dark styling. Extracting only the inline SVG from HTML loses the export preparation.

Inspect the rendered diagram after changes: labels must remain readable, arrows must have clear endpoints and both themes must preserve contrast. Also inspect its SVG embedded at the documentation's reading width. Keep explanatory prose and meaningful image alternatives in the article that uses it.

## Verification

[validation.json](validation.json) records the exact source, HTML and SVG hashes. It separates three checks:

- **Artifact validation:** all nine showcase checks passed, with no composition errors or warnings.
- **Browser evidence:** Chrome checked containment at 1440×900, 1600×1000, 1920×1080 and 2048×1320; screenshots covered light and dark themes.
- **Visual review:** the rendered screenshots were inspected for readability, diagram flow and overlap. This is separate from automated validation.

Any source edit or reformatting changes its hash. Regenerate, export and review again, then replace the corresponding receipt. Browser screenshots and full local receipts are verification artifacts, not required to view the diagrams.

The diagrams summarize [runtime ownership](../runtime.md), [resolution behavior](../resolution.md) and [the accepted release design](../adr/0023-simplify-release-evaluation.md). The release diagram describes the workflow; it does not establish that every hosted operation has run successfully.
