# the test platform: public product and execution model

Checked 2026-09-29 against official product pages and Help Center articles. These are documented or advertised capabilities, not a fresh execution audit. Account availability and exact behavior need separate verification.

## Company and product

the test platform sells an AI-assisted software testing platform: teams describe expected behavior, create executable tests, run them, and investigate results. It targets QA, engineering, product, and business contributors who hold product knowledge but may not write automation scripts. Its company history identifies Karim Jouini and Jihed Othmani, previously founders of Expensya, as founders; the test platform SAS was incorporated in Paris in November 2024 and the platform launched in January 2025. The company reports offices in Paris, Tunis, and Boston. [About](https://www.the test platform.ai/about), [Product positioning](https://www.the test platform.ai/)

The advertised value is reduced test authoring and maintenance effort. Homepage figures such as speed multipliers and maintenance reductions are marketing claims; they are not independent benchmark results. [Homepage](https://www.the test platform.ai/)

## Features

| Area | What the official sources describe |
| --- | --- |
| Authoring | Natural-language scenarios, requirements and user stories, URL browsing, connected Jira/Linear context, conversational editing, and creation through MCP-compatible assistants. [AI test generation](https://www.the test platform.ai/product/features/ai-test-generation) |
| Organization | Organizations contain projects. Projects hold apps, environments, plans, cases, sets, variables, and assets. Plans organize requirements into sections/scenarios; cases contain executable steps; sets group cases for execution. [Concepts](https://help.the test platform.ai/en/articles/11410394-key-concepts-terminology) |
| Configuration | Environments supply app URLs and variables; project/environment variables parameterize tests. Authenticated Profiles save encrypted cookies/storage to start a run already signed in. Assets include files for uploads, visual comparisons, and CSV datasets. [Concepts](https://help.the test platform.ai/en/articles/11410394-key-concepts-terminology) |
| Browser automation | Explicit Browser Steps provide actions and element targeting by CSS, XPath, ARIA label, or text, alongside AI instructions. Actions include navigation, tab switching, typing, selection, waiting, downloads, and screenshots. [Browser steps](https://help.the test platform.ai/en/articles/12115674-how-to-add-and-use-a-browser-step) |
| API testing | HTTP requests capture status, timing, headers, and body. Assertions compare response values; extraction saves values for later API or UI steps. Extracted values live within a case run. [API assertions/extraction](https://help.the test platform.ai/en/articles/14997220-api-response-assertions-and-variable-extraction) |
| Mobile | Upload APK/IPA builds; execute native Android/iOS cases on physical devices or emulators selected through device pools. Recording controls a live device. Web and mobile remain separate cases, although a set can launch both. [Mobile guide](https://help.the test platform.ai/en/articles/16936387-how-do-i-test-a-native-mobile-app) |
| Desktop | Documented approach exposes the desktop application through a browser-accessible virtualization service such as Citrix, Azure Virtual Desktop, or Guacamole. This is a conditional integration path, not evidence of a universal native desktop driver. [Desktop guide](https://help.the test platform.ai/en/articles/14283129-testing-desktop-apps-with-the test platform-via-virtualization) |
| Rich workflows | AI, deterministic web/mobile, API, visual/file comparison, conditional, and reusable-case steps. Cleanup can be placed in a teardown stage. Sets support schedules. [Concepts](https://help.the test platform.ai/en/articles/11410394-key-concepts-terminology) |
| Reporting | Per-step results/screenshots, environment/persona/browser settings, status, duration, and a replay player. Analytics includes run counts, pass rates, reported bugs, and browser/persona/environment filters. [Run reports](https://help.the test platform.ai/en/articles/11499281-view-a-test-run-report), [Analytics](https://help.the test platform.ai/en/articles/15754292-the test platform-analytics) |
| Integrations | Context sources include Jira, Notion, Confluence, Linear, and Xray; the product documents external bug reporting and an MCP interface for assistants. These are product capabilities, not proof that any particular account is connected. [Concepts](https://help.the test platform.ai/en/articles/11410394-key-concepts-terminology), [Help Center](https://help.the test platform.ai/en/) |

## Behind the scenes: what is actually documented

### 1. Language becomes structured actions

The assistant maps instructions to a known action vocabulary: click, input, navigate, validate, wait, select, scroll, generate/extract variables, upload, and more. The documentation specifically requires valid Playwright key names for key presses. This supports the existence of structured automation primitives; it alone does not establish the whole internal stack. [Supported AI actions](https://help.the test platform.ai/en/articles/12517655-supported-ai-actions)

### 2. Discovery can happen during execution, then be replayed

For a Discovery Prompt, the test platform waits until runtime to determine concrete actions from the page. It stores those actions as child Discovered Steps. Subsequent runs skip the parent discovery instruction and execute the generated children. Editing or healing the prompt removes these children and regenerates them on the next execution. Therefore, at least this documented path combines AI discovery with reuse of a persisted action sequence; it does not re-plan the complete task from scratch every run. [Discovery Prompts](https://help.the test platform.ai/en/articles/11651132-how-to-create-discovery-prompts)

### 3. Self-healing has several meanings

The product page describes alternative element resolution strategies, fresh element references, waits/retries for late-loading elements, and a Heal button that regenerates AI actions. Runtime element recovery and regeneration of discovered actions are different mechanisms. The public page describes selectors including text, position, CSS classes, IDs, and XPath, but does not reveal their ranking algorithm or model prompts. [Self-healing](https://www.the test platform.ai/product/features/self-healing-tests)

### 4. A runner executes the actions

Explicit Browser Steps specify both operation and targeting. Private-network execution is concretely documented as a customer-hosted Browserless Docker service connected through Azure Relay: the cloud sends commands and receives screenshots/results through the relay; the customer side establishes an outbound HTTPS/WebSocket connection. This proves that deployment option uses Browserless and Azure Relay, not that every hosted execution takes the identical route. It also means browser self-hosting does not, by itself, mean screenshots/results never leave the customer network. [Browser steps](https://help.the test platform.ai/en/articles/12115674-how-to-add-and-use-a-browser-step), [Azure Relay architecture](https://help.the test platform.ai/en/articles/12611222-self-hosted-browser-testing-with-azure-relay)

### 5. Orchestration queues, retries, and groups runs

The CI API queues executions using `POST /api/ci/run`, exposes status at `GET /api/ci/run/{runId}`, and returns reports through `GET /api/ci/run/{runId}/report`. It uses bearer-token authentication plus the documented `X-MS-API-ROLE: M2M` header. Responses group cases/sets under a shared run ID; reports support JUnit XML or JSON. CSV assets can supply per-row run variations. This documents asynchronous job orchestration without exposing the internal queue technology. [CI/CD API](https://help.the test platform.ai/en/articles/11410275-ci-cd)

Run settings control parallelism and failed-case retries. The retry guide says the Test Runs view displays the final result while the Test Case list shows all attempts. A final pass therefore needs to be interpreted with retry history when assessing reliability. [Execution behavior](https://help.the test platform.ai/en/articles/13797650-execution-behavior-max-retries-max-parallelism)

## Interpretation and limits

- **Reasonable architectural interpretation:** a test-management application plus AI authoring/discovery, stored action sequences, browser/device/API execution, orchestration, and evidence/reporting. This is a synthesis of the cited interfaces, not access to their private source code.
- **Model boundary:** the reviewed sources do not identify the exact models, model providers, prompts, training data, planning algorithm, or whether every validation uses deterministic rules or model judgment.
- **Infrastructure boundary:** these public pages do not establish their database, cache, backend framework, tenant-isolation implementation, or full production topology.
- **Marketing versus documentation:** the homepage advertises SEO, security, and custom Personas; the current concepts article names QA Engineer and Accessibility Personas. Treat the broader catalog as advertised until verified for the account and plan. [Homepage](https://www.the test platform.ai/), [Concepts](https://help.the test platform.ai/en/articles/11410394-key-concepts-terminology)
- **Availability versus evidence:** mobile, desktop virtualization, MCP, integrations, and saved profiles are documented. This research did not execute them and does not establish when each feature first shipped.
- **Reliability:** the vendor itself discusses incorrect assertions and false confidence after healing. Generated cases and regenerated actions still require comparison with the original requirements; a passing run alone does not prove the intended coverage. [AI generation risks](https://www.the test platform.ai/product/features/ai-test-generation), [Self-healing risks](https://www.the test platform.ai/product/features/self-healing-tests)
