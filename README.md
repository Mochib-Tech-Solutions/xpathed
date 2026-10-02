![xpathed — a golden thread finds one illuminated doorway in a branching, painted library](docs/assets/banner.svg)

# xpathed

**Describe an element. Get a verified XPath for the page in front of you.**

xpathed is a local browser workspace built for the the test platform internship case study: turn natural-language testing instructions into XPath expressions, explain the design, and evaluate whether it finds the right elements.

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

The actual XPath comes from that page's DOM. The workspace highlights the element and reports observed readiness, elapsed time and cost. You interact with the page manually.

It also handles the less convenient answers: an ambiguous instruction, a missing target, a disabled or covered control, an unsupported workflow, or a page that changed while the request was running. These remain distinct results.

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

The viewer and resolver use the same managed page ID. Browser objects stay inside Browser; Resolver has no database dependency. OpenRouter is the external model gateway.

The [system walkthrough](docs/how-it-works.md) follows one request through those boundaries, including frames, stale captures, privacy and failure handling. [Diagram sources and interactive versions](docs/diagrams/README.md) are kept alongside the SVGs.

## What the prototype covers

- One English action across one or more distinct targets in the **current viewport**; each found target gets its own verified XPath.
- Main-document and nested iframe targets, with frame context kept separate from XPath.
- Accessibility-aware candidates and explicit disabled, readonly, covered or unknown readiness states.
- Per-tab chat, manual browsing, target highlights, timings, usage and separate estimated/reported costs.

The current view is a deliberate boundary. Fully off-screen targets require manual scrolling and a new request. Mixed actions and sequential workflows are unsupported. Shadow-root XPath targets, image-pixel interpretation and autonomous action execution are outside this prototype. A passing readiness check does not prove a business action succeeded.

The app is designed for local use. Hosted access needs authentication and network isolation; opaque session IDs do not provide user authentication. See the [resolution contract](docs/resolution.md) for exact limits.

## How quality is measured

The evaluator asks separate questions: **was the intended element captured, did the model select it, does the XPath identify it, and is the reported state correct?** Controlled browser cases use independent target labels. Imported datasets broaden selection coverage, with their narrower offline results reported separately.

Model experiments compare correctness, time to a correct complete result and cost on the same inputs. The checked-in development route is `deepseek/deepseek-v4.1-flash` through `wafer`; that setting is separate from a release approval. Historical comparisons have different case sets and policies, so their scores are presented with their dates and limits in [the engineering journey](docs/engineering-journey.md).

| Check                                          | Command                              |
| ---------------------------------------------- | ------------------------------------ |
| Local formatting, analysis, tests and builds   | `pnpm check`                         |
| Deterministic independent browser evaluation   | `pnpm evaluate`                      |
| Regrade an existing run without provider calls | `pnpm evaluate:replay RUN_DIRECTORY` |
| Explicit live evaluation                       | `pnpm evaluate:live`                 |

Local checks run independent groups concurrently. Deterministic browser evaluation runs individual cases in isolated sessions with up to four workers; use `pnpm evaluate -- --concurrency 1` for serial execution. See [CI execution](docs/ci.md#parallel-execution) for shared-resource limits.

Live evaluation requires the separate `OPENROUTER_EVAL_API_KEY` and incurs provider charges. The [evaluation guide](docs/evaluation.md) explains setup, grading, cases, datasets and artifacts; [package.json](package.json) lists all commands.

Ordinary CI uses deterministic responses. The release workflow compares exact candidate and approved images on the same complete reviewed collection, allows no lost baseline pass, and keeps activation explicit. Nightly monitoring records drift without changing the running app. [Release operations](docs/releases.md) documents the workflow and the remaining hosted setup; configured workflows alone are not evidence of deployment.

## Read the case study

| If you want to understand…                         | Start here                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| The design, request flow and technical tradeoffs   | [How xpathed resolves an instruction](docs/how-it-works.md)              |
| Model choices, experiments, evaluation and lessons | [The engineering journey](docs/engineering-journey.md)                   |
| The demo and assignment presentation               | [Demo guide](docs/demo.md)                                               |
| API, configuration and browser lifecycle           | [Runtime](docs/runtime.md) and [resolution contract](docs/resolution.md) |
| Diagnostics, privacy and retention                 | [Backend diagnostics](docs/diagnostics.md)                               |
| CI, release approval, activation and monitoring    | [CI](docs/ci.md) and [releases](docs/releases.md)                        |
| Why a consequential decision was made              | [Architecture decisions](docs/adr/)                                      |

Source is organized under [`src/`](src/), the independent evaluator under [`evaluation/`](evaluation/), and Compose definitions under [`docker/`](docker/). The [assignment specification](https://github.com/Mochib-Tech-Solutions/xpathed/issues/1) and its accepted follow-ups record the project requirements.
