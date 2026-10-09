# xpathed

Turn a plain-English instruction into a verified XPath for an element in the current browser view. Use the API directly or the included browser and chat workspace.

## Run locally

Install Node.js 24.16.0, pnpm 12.8.1 and Docker with Compose and Buildx.

```sh
git clone https://github.com/Mochib-Tech-Solutions/xpathed.git
cd xpathed
pnpm run setup
```

Add your OpenRouter API key to the generated, ignored `.env` file. The default is DeepSeek V4.1 Flash through Wafer on OpenRouter; model and provider settings live in `.env`. Use a dedicated key with a provider spending limit; resolving instructions makes paid requests.

```sh
pnpm dev
```

Open [localhost:8080](http://localhost:8080), choose Chromium or Firefox and a browser resolution, then enter a website address and describe the element you want. Stop the workspace with Ctrl+C or `pnpm docker:down`.

**Include screenshot** adds visual evidence for that request. It masks detected form fields; other visible content, including inaccessible controls, is sent to the model provider. Images are not stored in chat or diagnostics.

Use **Execute** on a current result to perform its action. Enter text, an option value, or a key when needed; these values go directly to Browser. Execution rechecks the target and consumes the result, so resolve again for another action. Completion describes the browser interaction; check the page for its effect.

A separate checkout needs a distinct `COMPOSE_PROJECT_NAME` and `XPATHED_PORT` in its own `.env`.

## Use the API

Resolver is independent of the chat client. Browser owns sessions, pages and captures; Resolver interprets instructions and asks Browser to verify the selected element. The workspace forwards these APIs under `/api`.

Create a session, navigate its returned page, then resolve using the current document ID:

```sh
curl --fail -X POST http://localhost:8080/api/sessions \
  -H 'Content-Type: application/json' -d '{"browserType":"chromium","resolution":"1280x800"}'
curl --fail -X POST http://localhost:8080/api/pages/PAGE_ID/navigate \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
curl --fail -X POST http://localhost:8080/api/pages/PAGE_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"DOCUMENT_ID","instruction":"Find the More information link."}'
curl --fail -X DELETE http://localhost:8080/api/sessions/SESSION_ID
```

Replace the uppercase IDs with values returned by the preceding requests. Each found target has a unique XPath verified against its captured node. Frame and open-shadow context are returned separately. Requests cover the current viewport; ambiguity, missing targets and blocked controls remain explicit.

`GET /api/sessions/options` lists the supported browser/resolution choices. Add `"includeImage":true` to opt into a screenshot. Execute a returned action with `POST /api/pages/PAGE_ID/execute` and its `sessionId`, `documentId`, `captureId`, `actionId`, plus `value` if required. Resolution itself never executes an action.

Page content is untrusted. Keep credentials out of instructions and use the workspace only with pages you are allowed to inspect. API quotas limit traffic; a provider key limit controls spending.

## Check changes

Services and shared contracts live in `src/`; tests use our own controlled websites in `tests/resolution/` and `evaluation/fixtures/`. Expected targets are independent of the model response. Development, CI and deployment commands live in `scripts/` and `docker/`.

```sh
pnpm check                 # .NET, Web and tooling checks
pnpm test:browser          # Chromium and Firefox contracts
pnpm test:resolution       # controlled provider, no paid inference
pnpm evaluate:xpath        # XPath identity and mutation checks
pnpm evaluate:resolver     # complete pipeline with controlled responses
```

Local checks require .NET SDK 10.0.401 and Python 3.12 or later. `pnpm test:resolution:live` and `pnpm evaluate:resolver:live` make paid provider calls; the latter requires `OPENROUTER_EVAL_API_KEY`.

Report bugs and request changes through [GitHub Issues](https://github.com/Mochib-Tech-Solutions/xpathed/issues). Keep credentials and private page content out of reports.
