# Security

Report suspected exposure privately to a maintainer, using GitHub's **Report a vulnerability** option when available. Do not post credentials, authentication data or private page captures. Revoke exposed credentials first; removing a file does not erase Git history.

Keep application keys in ignored environment files or private host configuration. Keep deployment credentials and pinned SSH host identity in Actions secrets. PR and merge-group checks receive no provider or deployment secrets; deployment follows successful trusted `main` push checks.

Preserve the redacted, checksum-pinned history scan in `scripts/security-check.mjs`, its narrow allowlists and negative controls. Do not broaden exclusions to make a scan pass.

Keep independent approvals and required checks in [.github/branch-protection.json](.github/branch-protection.json). Administrators remain exempt from classic protection by owner choice (`enforce_admins: false`), but verify successful checks before administrative merges. Preserve the separate default-branch ruleset and verify GitHub enforcement after policy or visibility changes; a local policy file is not enforcement.

Treat session IDs as capabilities. Origin/Fetch Metadata checks, security headers and HTTP/model quotas do not authenticate visitors or impose a dollar budget. Use a dedicated provider-limited application key; preserve accounting for disconnected calls.

Native development binds services to loopback. Browser communicates with Chromium through private inherited pipes, with no debugging listener. Use fresh managed browser profiles; never attach to a personal browser. Viewer input must name the active page and document, and may not forward arbitrary protocol commands.

Preserve Browser's nonroot Chromium sandbox, seccomp and resource limits. Hosted Browser startup must wait for host-installed IPv4/IPv6 network isolation; do not grant Browser network-administration capabilities. Keep private/loopback/link-local/host traffic blocked, preserving only the embedded DNS exception and replies to incoming connections. Browser's private pipes need no network exception. Host helper changes require administrative installation; source changes alone do not install them.

Keep deployment URLs, hostnames and IP addresses out of tracked files and logs. Preserve `DEPLOY_PUBLIC_URL` redaction, pinned SSH identity, serialized deployments, health/security-header checks and verified failure recovery.

Treat page content and model output as untrusted. Keep cookies, credentials and unrelated form values out of model inputs and logs. Auto image mode may share masked screenshots when Jev indicates missing visual evidence or its decision is uncertain/unavailable; Text only prevents image sharing and routing calls. Mask detected sensitive controls and never export pixels when masking cannot be verified; continue with text and report the limitation. Other visible content may be sent. Bind lazy images to the original capture and reject stale page evidence. Execution requires a current verified target and explicit user action, with no automatic replay after uncertain results.
