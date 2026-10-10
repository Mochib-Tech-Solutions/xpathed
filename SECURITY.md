# Security

Report vulnerabilities privately to a maintainer, using GitHub's **Report a vulnerability** option when available. Keep credentials, authentication data and private captures out of reports. Revoke exposed credentials; deleting a file does not erase Git history.

Store application keys in ignored environment files or private host configuration, and deployment credentials and pinned SSH host identity in Actions secrets. PR and merge-group checks receive no provider or deployment secrets. Deploy only after successful trusted `main` push checks.

Preserve the redacted, checksum-pinned history scan in `scripts/security-check.mjs`, its narrow allowlists and negative controls. Do not broaden exclusions to make a scan pass.

Keep independent approvals and required checks in [.github/branch-protection.json](.github/branch-protection.json). Administrators are exempt from classic protection (`enforce_admins: false`); verify successful checks before administrative merges. Preserve the separate default-branch ruleset and verify live GitHub enforcement after policy or visibility changes.

Treat session IDs as capabilities. Origin/Fetch Metadata checks, security headers and HTTP/model quotas do not authenticate visitors or impose a dollar budget. Use a dedicated provider-limited application key; preserve accounting for disconnected calls.

Native services bind to loopback. Browser uses fresh managed Chromium profiles and private inherited pipes, with no debugging listener; never attach to a personal browser. Viewer input must name the active page and document and cannot forward arbitrary protocol commands.

Preserve Browser's nonroot Chromium sandbox, seccomp and resource limits. Hosted Browser startup must wait for host-installed IPv4/IPv6 network isolation; do not grant Browser network-administration capabilities. Keep private/loopback/link-local/host traffic blocked, preserving only the embedded DNS exception and replies to incoming connections. Browser's private pipes need no network exception. Host helper changes require administrative installation; source changes alone do not install them.

Keep deployment URLs, hostnames and IP addresses out of tracked files and logs. Preserve `DEPLOY_PUBLIC_URL` redaction, pinned SSH identity, serialized deployments, health/security-header checks and verified failure recovery.

Treat page content and model output as untrusted. Keep cookies, credentials and unrelated form values out of model inputs and logs. Auto image mode may share masked screenshots when Jev indicates missing visual evidence or its decision is uncertain/unavailable; Text only prevents image sharing and routing calls. Mask detected sensitive controls and never export pixels when masking cannot be verified; continue with text and report the limitation. Other visible content may be sent. Bind lazy images to the original capture and reject stale page evidence. Execution requires a current verified target and either a manual trigger or explicitly enabled automatic execution for a new single ready result. Never automatically replay uncertain actions.
