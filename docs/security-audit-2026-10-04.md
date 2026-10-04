# Credential and workflow audit — 4 October 2026

The audit inspected tracked source, all reachable local Git refs, the two evaluation-data archive assets, sensitive configuration paths and the Actions credential boundary. It did not change repository visibility, remove datasets or delete archived evidence. The owner explicitly chose to retain those assets.

Gitleaks 8.30.1 processed 9,043 diff-bearing commits (9,182 commits enumerated across refs) and approximately 2.11 GB. Its 51 default-rule matches were reviewed: 39 source-file SHA256 provenance values, eight historical prose fragments and four exact dummy values in privacy tests. None were credentials. The configured scan passed with narrow rule-specific allowlists; source hashes and dummy values are not blanket file exclusions.

Archive-aware scanning of the two dataset gzip assets processed approximately 70.68 MB and flagged 1,645 inputKey hashes. They are input identities, not authentication credentials. No provider-specific token or private-key finding was detected. Dataset licensing, personal content and redistribution rights are outside this credential check.

Archive-aware scanning also covered all 26 retained release-evidence/monitoring artifacts in the saved inventory: 52.48 MB compressed and approximately 376.38 MB scanned. Its 1,284 matches were 51 source provenance hashes and 1,233 inputKey hashes; none were credentials. These artifacts were read, not changed or deleted.

Only .env.example was found among tracked sensitive-configuration filenames. Runtime provider keys and deployment private keys remain in ignored local files, private host configuration and Actions secrets. The history scan does not certify ignored files as empty of credentials: those files intentionally hold runtime configuration and access material and must stay untracked.

PR/merge-group jobs are provider-free and receive no deployment secret. Deployment credentials are scoped to the job after successful main push checks. Qualification, publication and monitoring are private-repository-only; there is no pull_request_target execution of untrusted PR source. Default workflow tokens are read-only and workflows cannot approve PR reviews. Native GitHub secret scanning and push protection were enabled and verified while visibility remained private. Dependency vulnerability alerts and automated security-fix PRs were enabled and their API requests succeeded.

The new Credential scan status uses a checksum-pinned scanner, redaction, and negative controls inside each allowlist category. Native main-branch protection is recorded in .github/branch-protection.json; enforcement must be verified through GitHub, independently of this audit or review instruction files. A stale review guide was aligned with the current-view/single-XPath contract.

Limits: no scanner proves the absence of every possible secret. Historical Actions log bytes, every provider-free CI artifact and retired Docker archives were not exhaustively rescanned; their retention remains unchanged. The owner-selected public demo permits paid requests without revealing the runtime key, and source origin checks do not authenticate visitors. Reverify protections and native secret-scanning availability before changing repository visibility.
