# xpathed

Turn a plain-English instruction into a verified XPath for an element in the current browser view. Use the Resolver API directly or the included browser and chat workspace.

## Run locally

Install Node.js 24.16.0, pnpm 12.8.1, .NET SDK 10.0.401, Python 3.12+, and Google Chrome or Chromium. Local development supports macOS and Linux and runs without Docker.

```sh
git clone https://github.com/Mochib-Tech-Solutions/xpathed.git
cd xpathed
pnpm run setup
```

Set `OPENROUTER_API_KEY` in the generated `.env`, then start the services:

```sh
pnpm dev
```

Open [localhost:8080](http://localhost:8080), choose a resolution, enter a website address, and describe your target. Use **Execute** on a current result, or enable **Execute automatically** in **Settings** to run a single ready action after each new result. Actions needing a value and results with multiple targets remain manual. The Resolver API itself does not execute actions.

Requests use DeepSeek V4.1 Flash through InferenceNet by default. Set `OPENROUTER_MODEL` and `OPENROUTER_PROVIDER` in `.env` to override the route.

Each tab keeps its own settings. **Auto screenshots** includes a masked image when visual details may help; **Text only** prevents image sharing. Detected private fields are masked; other visible content may be sent to the model provider. Requests make paid calls, so use a dedicated key with a provider spending limit.

Stop with Ctrl+C or `pnpm dev:stop`. Set `XPATHED_PORT` for a different workspace port; the three APIs use the next three ports. Set `BROWSER_EXECUTABLE_PATH` if Chrome is installed in a custom location.

## API

Create a session, navigate its page, then resolve an instruction:

```sh
curl --fail http://localhost:8080/api/sessions \
  -H 'Content-Type: application/json' -d '{"resolution":"1280x800"}'
curl --fail http://localhost:8080/api/pages/PAGE_ID/navigate \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
curl --fail http://localhost:8080/api/pages/PAGE_ID/resolve \
  -H 'Content-Type: application/json' \
  -d '{"documentId":"DOCUMENT_ID","instruction":"Find the More information link."}'
curl --fail -X DELETE http://localhost:8080/api/sessions/SESSION_ID
```

Replace the uppercase IDs with returned values. `GET /api/sessions/options` lists supported resolutions. Each found target includes a unique XPath verified against its captured node; ambiguity, missing targets and blocked actions remain explicit. Frame and open-shadow context are returned separately.

## Development

`src/Resolver` owns interpretation and XPath construction. `src/Browser` manages Chromium, page capture, verification and execution. `src/ClientApi` connects the Web workspace to those APIs. Focused tests live in `tests/` and beside Web components.

```sh
pnpm check             # .NET, Web and tooling
pnpm test:resolution   # real-browser service tests; no paid calls
```

VPS deployment uses the production images in `docker/`. GitHub CI validates Docker configuration and build definitions before successful `main` checks trigger the hosted deployment. Local commands and Git hooks use native tools only. Read [SECURITY.md](SECURITY.md) before hosting.

Report bugs through [GitHub Issues](https://github.com/Mochib-Tech-Solutions/xpathed/issues).
