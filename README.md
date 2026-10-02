![xpathed — a golden thread finds one illuminated doorway in a branching, painted library](docs/assets/banner.svg)

# A compass for the web.

xpathed turns natural-language instructions into verified XPath expressions for the page in front of you. Its local browser workspace brings together chat, the live page, highlighted targets and evidence that each XPath identifies the selected element.

The central decision is simple: **the model selects an element; browser code builds and verifies its XPath.** A valid XPath can still point to the wrong button, so evaluation checks the intended target independently.

[How it works](docs/how-it-works.md) · [Experiments and decisions](docs/engineering-journey.md) · [Demo guide](docs/demo.md)

## From an instruction to an element

Imagine a page with an **OK** button in both an Employee section and an Account section:

> Hover over OK under Employee.

xpathed captures the current view, sends the model a sanitized list of candidates and their context, and checks the selected element in the live browser. For a page with suitable markup, an illustrative result is:

```text
Button · OK
Action: hover
XPath: //*[@aria-label='Employee']//button[normalize-space(.)='OK']
Verification: one match, same captured node, still in the current view
```

The actual XPath comes from the DOM. The workspace highlights targets and reports readiness, time and cost. You browse manually. Ambiguity, absence, blocked controls and technical failures remain distinct.

## Run it locally

You need **Node 24.16.0**, **pnpm 12.8.1**, and **Docker with Compose and Buildx**. The browser container needs Linux sandbox support; see the [validated environment](docs/runtime.md#sandbox-and-supported-environment). A host .NET SDK is only needed for local .NET development checks.

```sh
git clone https://github.com/Mochib-Tech-Solutions/xpathed.git
cd xpathed
pnpm run setup
```

Setup creates an ignored `.env` with a database password. Add your application key to that file:

```dotenv
OPENROUTER_API_KEY=your-key-here
```

Then start the workspace:

```sh
pnpm dev
```

Open **[localhost:8080](http://localhost:8080)**, enter a website address, and submit an instruction in chat. Manual browsing works without a model key. Live resolution uses your OpenRouter account.

All five services run in Docker. Ctrl+C removes development containers while preserving configuration and database data. `pnpm docker:down` also provides explicit cleanup. For another checkout, set a distinct `COMPOSE_PROJECT_NAME` and `XPATHED_PORT`; keep its `.env` separate.

[Runtime configuration](docs/runtime.md) · [Presentation walkthrough](docs/demo.md)

## The system

[![Service architecture: Web sends requests through ClientApi to Resolver; Browser owns Chromium, Resolver calls OpenRouter, and ClientApi records diagnostics in PostgreSQL](docs/diagrams/system-design.svg)](docs/diagrams/system-design.svg)

| Part                                  | Owns                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| **Web** — React and TypeScript        | Chat, managed tabs, the noVNC page viewer and the web entry point          |
| **ClientApi** — ASP.NET Core          | Client requests and automatic sanitized diagnostics                        |
| **Resolver** — ASP.NET Core           | Candidate context, model selection and resolution orchestration            |
| **Browser** — Playwright and Chromium | Live pages, DOM capture, XPath construction and verification, highlighting |
| **PostgreSQL** — EF Core persistence  | Diagnostic records and retained evidence                                   |

Viewer and resolver share one managed page ID. Browser owns live nodes; Resolver has no database dependency. [Diagram sources](docs/diagrams/README.md) accompany the SVGs.

## Inside Resolver

[`ResolutionService`](src/Resolver/Services/ResolutionService.cs) coordinates five steps:

1. **Capture the current view.** Browser returns temporary candidate IDs with sanitized labels, roles, section/row context, state, geometry and supported CSS colors. Editable values, cookies and storage stay out. Incomplete capture fails explicitly.
2. **Select with one model call.** The original instruction and complete scoped candidate list go to OpenRouter. The model returns strict JSON: one shared interaction and distinct candidate IDs, or explicit missing/unsupported outcomes. Page text is untrusted data; the model has no tools.
3. **Validate the selection.** Resolver checks schema, candidate membership, shared action and enumeration completeness. Malformed output fails; valid JSON still cannot prove correct target selection.
4. **Build and verify XPath.** Browser tries test attributes, scoped semantics, labels and other anchors before structural fallback. Each expression must match exactly one node in its whole document, identical to the retained target. Frame context stays separate. A changed document or current-view membership invalidates the result, including absence.
5. **Observe and return.** Browser checks readiness and highlights targets. Disabled or covered targets can retain valid XPaths. No click, scroll, navigation or assertion is executed. ClientApi records sanitized diagnostics; Web shows results and request-owned cost.

### Current model implementation

The checked-in development configuration uses **`deepseek/deepseek-v4.1-flash` through OpenRouter's `wafer` provider**. The workspace sends **contract 4**, using **prompt 10**, capture 5 and XPath strategy 4. [`ActionSelectionStrategy`](src/Resolver/Services/ActionSelectionStrategy.cs) owns the prompt/schema; [`OpenRouterGateway`](src/Resolver/Services/OpenRouterGateway.cs) pins the provider, disables reasoning and provider fallback, and requests strict JSON with a 4,096-token output ceiling.

[`.env.example`](.env.example) and [Compose](docker/compose.yaml) define the model/provider defaults. Each response identifies its configuration with a hash of effective settings, prompt/schema and strategy versions. An environment override or experimental profile does not approve a release. The [engineering journey](docs/engineering-journey.md) explains the model comparisons and why the optional context-planning call remains evaluation-only; [how it works](docs/how-it-works.md) traces the implementation in depth.

## What the prototype covers

- One English action across one or more distinct targets in the **current viewport**; each found target gets its own verified XPath.
- Main-document and nested iframe targets, with frame context kept separate from XPath.
- Accessibility-aware candidates and explicit disabled, readonly, covered or unknown readiness states.

The current view is a deliberate boundary. Fully off-screen targets require manual scrolling and a new request. Mixed actions and sequential workflows are unsupported. Shadow-root XPath targets, image-pixel interpretation and autonomous action execution are outside this prototype. A passing readiness check does not prove a business action succeeded.

The app is designed for local use. Hosted access needs authentication and network isolation; opaque session IDs do not provide user authentication. See the [resolution contract](docs/resolution.md) for exact limits.

## How quality is measured

The evaluator asks separate questions: **was the intended element captured, did the model select it, does the XPath identify it, and is the reported state correct?** Controlled browser cases use independent target labels. Imported datasets broaden selection coverage, with their narrower offline results reported separately.

### Latest recorded measurements

These dated measurements have separate scopes. Browser cases exercise live capture, selection and verification; offline cases assess selection against saved labels. No fresh run was performed for this summary.

| Date / measurement                           | Correct / attempted                            | Timing and boundary                                                                                                                        | Evidence                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **2026-10-02 · v1.0.0 confirmation**         | **119/135 (88.15%)**; baseline 105/135         | Authored browser cases, DeepSeek/Wafer. Candidate median **1,116.9 ms**, p95 **1,710.2 ms**.                                               | [Qualification and approval](docs/research/2026-10-01-release-monitoring-setup.md#first-approved-release--2026-10-02)                         |
| **2026-10-02 · approved-image monitoring**   | **12/15 (80%)**, unchanged from saved baseline | Frozen browser subset. Median **1,057.9 ms**, p95 **1,578.6 ms**; **$0.00128837** reported.                                                | [Monitoring receipt](docs/research/2026-10-01-release-monitoring-setup.md#approved-release-monitoring-and-cleanup)                            |
| **2026-10-01 · expanded offline baseline**   | **547/860 (63.60%)**                           | Reviewed PhraseNode inputs, DeepSeek/DeepInfra FP8, prompt 7. **$1.618648388** reported; offline elapsed includes harness/accounting work. | [Report](docs/research/deepinfra-labelled-baseline-report.md) · [execution receipt](docs/research/deepinfra-labelled-baseline-execution.json) |
| **2026-10-01 · context-planning experiment** | Control **14/16**; assisted **13/16**          | Paired browser cases, DeepSeek/DeepInfra FP8, prompt 8; metric-only timing policy. The classifier removed no context and added cost.       | [Paired report](docs/research/jev-context-comparison-report.md#metric-only-policy-completed-paired-measurement)                               |

Confirmation had **15 gained passes and one lost baseline pass**, accepted under its temporary historical policy. Current policy allows no lost baseline pass. These exposed fixtures do not establish unseen-site accuracy; offline selection does not establish readiness. Approval does not establish activation. The linked reports retain all failures and charges.

| Check                                          | Command                              |
| ---------------------------------------------- | ------------------------------------ |
| Local formatting, analysis, tests and builds   | `pnpm check`                         |
| Deterministic independent browser evaluation   | `pnpm evaluate`                      |
| Regrade an existing run without provider calls | `pnpm evaluate:replay RUN_DIRECTORY` |
| Explicit live evaluation                       | `pnpm evaluate:live`                 |

Local checks run independent groups concurrently. Deterministic browser evaluation runs individual cases in isolated sessions with up to four workers; use `pnpm evaluate -- --concurrency 1` for serial execution. See [CI execution](docs/ci.md#parallel-execution) for shared-resource limits.

Live evaluation uses `OPENROUTER_EVAL_API_KEY` and incurs provider charges. The [evaluation guide](docs/evaluation.md) covers setup, grading and artifacts.

Ordinary CI uses deterministic responses. Release evaluation compares exact candidate and approved images on the complete reviewed collection. Activation is explicit; nightly monitoring records drift without changing the running app. See [release operations](docs/releases.md).

## Explore the project

| If you want to understand…                         | Start here                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| The design, request flow and technical tradeoffs   | [How xpathed resolves an instruction](docs/how-it-works.md)              |
| Model choices, experiments, evaluation and lessons | [The engineering journey](docs/engineering-journey.md)                   |
| The demo and presentation                          | [Demo guide](docs/demo.md)                                               |
| API, configuration and browser lifecycle           | [Runtime](docs/runtime.md) and [resolution contract](docs/resolution.md) |
| Diagnostics, privacy and retention                 | [Backend diagnostics](docs/diagnostics.md)                               |
| CI, release approval, activation and monitoring    | [CI](docs/ci.md) and [releases](docs/releases.md)                        |
| Why a consequential decision was made              | [Architecture decisions](docs/adr/)                                      |

The [project specification](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and accepted follow-ups record the project requirements.
