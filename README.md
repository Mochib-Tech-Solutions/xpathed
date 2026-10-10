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
