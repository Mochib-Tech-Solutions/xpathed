# Writing and illustrating xpathed

Research date: 2026-10-02. Editorial guidance for the current project documentation; product behavior remains defined by the implementation and accepted contracts.

## Write for a new technical reader

The README should answer what xpathed does, why its design matters and how to run it. Put detailed contracts and operating procedures in their existing guides. GitHub recommends this introductory role and relative links to longer documentation. [GitHub: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

Assume the reader understands software engineering but has never seen this repository. Define browser ownership, target selection and XPath verification when introduced. State each article's purpose early; organize around the reader's questions. [Google: Audience](https://developers.google.com/tech-writing/one/audience), [Google: Documents](https://developers.google.com/tech-writing/one/documents)

Give each document one job: introduction and setup, design explanation, contract reference or operating procedure. Explanation should include reasons and trade-offs. Describe the current approach directly; dated research preserves previous experiments without turning the main article into a change diary. [Diátaxis: Explanation](https://diataxis.fr/explanation/)

Use one concrete instruction to connect the stages: capture candidates, select targets, construct XPath, then verify identity. Label illustrative inputs and outputs. Netlify's authoring guidance recommends descriptive titles, practical examples and useful next steps. [Netlify: Writing a guide](https://developers.netlify.com/guides/contributing-to-the-netlify-developer-hub/#guidance-for-writing-a-guide)

Keep sentences short and links selective. Explain the essential point where it appears; link once to its detailed treatment. Keep provenance beside measured claims. [Google: Cross-references](https://developers.google.com/style/cross-references)

## Draw what the implementation establishes

Give each diagram one takeaway and a useful caption. Separate service ownership, request flow and release decisions. Label arrows with the data or operation crossing the boundary. Use scalable SVG and inspect it at normal article width. [Google: Illustrations](https://developers.google.com/tech-writing/two/illustrations), [C4: Notation](https://c4model.com/diagrams/notation)

The diagnostic diagram must reflect the EF mapping and migration: one application table, three JSONB columns and explicit indexes. Identifiers are not automatically foreign keys; embedded objects are not child tables. JSONB supports indexing, but the project defines no JSONB query index. [PostgreSQL: JSON types](https://www.postgresql.org/docs/current/datatype-json.html)

Preserve headings, meaningful link text and image alternatives. Essential information must exist in text, and diagrams must remain understandable without color. [Google: Accessible documentation](https://developers.google.com/style/accessibility)

## Graphify: observed fit

Graphify builds code/document relationship graphs and distinguishes extracted from inferred edges. Code-only extraction uses local AST parsing. Its official package is `graphifyy`; its command is `graphify`. [Graphify: source and command reference](https://github.com/Graphify-Labs/graphify)

We ran version 0.9.74 in an isolated temporary environment against tracked `src/` at `3557f552f643e01485bc96586c35b4bf498292cf`. The code-only run parsed 137 files in 3.6 seconds: 1,165 nodes, 2,172 edges and 69 communities. It skipped six non-code and two unclassified files. No project dependencies, hooks or model APIs were used.

Inspection confirmed `PagesController` → `ResolutionRecorder` → `DiagnosticStore` references at their source locations. Of the edges, 2,049 were labelled extracted and 123 inferred. These are extraction observations, not complete runtime coverage. Native HTML was generated, but its full symbol graph and generic community labels were too dense for the overview. Keep Graphify as an inspection aid; use the reviewed architecture diagrams for explanation.

## Make evaluation figures answer a question

Use at most two figures:

- **Paired outcome matrix:** baseline pass/fail against candidate pass/fail, with counts for retained passes, gains, losses and shared failures. Annotate regressions explicitly. These axes compare configurations; they are not true/predicted classifier labels.
- **Behavior-group heatmap:** only when case-level evidence supports the groups. Print passed/eligible counts and denominators, with one shared 0–100% scale. Independently normalized rows can conceal unequal rates. [MathWorks: Heatmaps](https://www.mathworks.com/help/matlab/ref/heatmap.html)

Use text labels as well as color. Prefer a perceptually uniform sequential palette for rates; reserve a zero-centered diverging scale for signed changes. Avoid rainbow scales. [Matplotlib: Colormaps](https://matplotlib.org/stable/users/explain/colors/colormaps.html)

Every figure needs its run, cohort, configuration and scoring rule. Pair identical case inputs; separate browser and offline denominators. Preserve missing attempts, operational failures and unsupported cases. An aggregate gain must not hide a lost baseline pass.

Recorded counts describe the tested suite and attempts, not production accuracy or repeat-run stability. Do not invent intervals. If a later study estimates uncertainty, preserve case pairing and explain sampling assumptions; repeated cases from one page may need page-level grouping. SciPy supports shared-index paired resampling. Show uncertainty when it changes interpretation. [SciPy: Bootstrap](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html), [ONS: Uncertainty](https://service-manual.ons.gov.uk/data-visualisation/guidance/showing-uncertainty-in-charts)
