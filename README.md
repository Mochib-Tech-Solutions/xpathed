# xpathed

Turn a plain-English instruction into a verified XPath for an element in the current browser view. Use the Resolver API directly or the included browser and chat workspace.

## Run locally

Install Node.js 24.16.0, pnpm 12.8.1, .NET SDK 10.0.401, Python 3.12+, and Google Chrome or Chromium. Local development supports macOS and Linux.

```sh
git clone https://github.com/Mochib-Tech-Solutions/xpathed.git
cd xpathed
pnpm run setup
```

Set `OPENROUTER_API_KEY` in the generated `.env`, then start the services:

```sh
pnpm dev
```

## VPS deployment

The production host runs Ubuntu 26.04 x86-64. systemd manages three nonroot APIs on loopback ports 18081–18083; Caddy serves Web, proxies the APIs and viewer, and manages HTTPS. Browser keeps Chromium's sandbox, resource limits and a root-installed nftables policy that rejects private, host and IPv6 destinations.

Private service configuration lives in root-only `/etc/xpathed/{browser,resolver,client-api,gateway}.env` files, with the HTTPS origin in `/etc/xpathed/public-url`. Provider credentials belong only in `resolver.env`. Administrative provisioning is `sudo python3 scripts/deployment-setup.py "$PWD" /home/ubuntu/xpathed`; the CI SSH key remains restricted to the pinned receiver. Network helper changes require administrative installation.

Successful trusted `main` checks trigger serialized deployment. Each release builds with locked dependencies before switching `/opt/xpathed/current`; health checks gate the receipt and a failed switch restores the previous native release. Current and previous compiled releases are retained; successful builds leave no source caches. Inspect services with `systemctl status xpathed-{browser,resolver,client-api,network} caddy`, and verify public routing and browser isolation with `python3 scripts/hosted-security-check.py "$PUBLIC_ORIGIN"`.

Expose only SSH, HTTP and HTTPS. Back up private configuration, SSH access and Caddy's certificate store, and keep native dependencies updated. Locally, `pnpm clean --cache` removes project/test builds and project dependency caches while preserving `.env` and evidence; run `pnpm install --frozen-lockfile` before starting again.
