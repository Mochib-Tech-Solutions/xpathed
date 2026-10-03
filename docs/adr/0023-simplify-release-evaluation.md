---

Release selection is superseded by [ADR-0026](0026-use-the-release-branch-as-the-baseline.md). The following records the earlier decision.
status: accepted
---

# Simplify release evaluation

The maintainer requested a release workflow suited to an interview assignment: one current resolver implementation, one current evaluation policy, a shared case collection, and a live comparison on pull requests targeting a release branch. Main should carry the current implementation; Git history and retained release artifacts preserve earlier implementations and results. The approved release remains the comparison baseline until its replacement is explicitly selected.

Consolidate overlapping cases without discarding their source identities or expected behavior. Browser observations and offline target-selection observations remain distinguishable in one evaluation report. Record reported costs and unknown charges without using cost amounts, forecasts, or missing billing metadata to stop testing or reject a release. Actual provider failures remain recorded failed attempts.

Every release comparison includes all approved browser cases and all reviewed, eligible imported dataset cases, including the existing reviewed PhraseNode collection. Original dataset splits remain provenance; there is no new held-out release gate. Freeze the selected case identities and inputs for each run, report exclusions, and keep raw corpus data private. Browser and offline correctness have separate denominators in the shared report because offline data cannot establish browser readiness.

The requested restructuring targets live Resolver evaluation. Existing unit, integration, and UI tests remain in ordinary CI and are prerequisites rather than duplicated release-evaluation jobs. Group live cases by the resolver behavior they verify, sharing case definitions and release orchestration rather than flattening every case into one file.

Live browser cases exercise the complete Resolver request: capture candidates, call the real model, construct and verify the XPath through Browser, and grade the final response against independent expectations. Normal browser verification remains in that path; there is no separate paid XPath algorithm suite. Chat, session, UI, forwarding and deterministic XPath edge-case tests remain in ordinary CI.

The agreed branch flow is feature pull requests into `main` for normal checks, then a pull request from `main` into a persistent `release` branch for the complete live comparison. Merging that release pull request selects the exact tested candidate as the new approval. Local activation remains explicit; updates to `main` alone do not replace the approved baseline.

The agreed acceptance rule blocks every lost baseline pass, while latency and cost remain descriptive. Both releases run against the same growing case collection and are assessed under the current policy. Safety violations, operational failures, missing required results, and artifact mismatches still fail evaluation; unavailable billing metadata does not. Remove the separate pilot phase and mandatory fresh held-out families; repeated cases establish regression coverage, not unseen-data generalization. Preserve independent expected targets and source provenance.

Keep nightly model-drift verification against the approved release, using its complete approved live collection and saved results. New cases enter nightly monitoring when approved with a release. Monitoring reports failures without changing the running application or approved baseline.

## Composition

Keep one evaluation entry point, current policy, case loader, grading/reporting path, and provider integration. Group live browser cases by targeting, scope, frames, and action/state, with one definition per case. Keep deterministic locator construction/reuse checks in CI rather than paying for inference to test those algorithms. Dataset adapters retain the source-specific mapping that those inputs require. Move shared accounting out of the executable dataset runner so browser evaluation does not depend on that runner.

```text
evaluation/
  cases/          # Browser cases grouped by behavior
  fixtures/       # Controlled pages and independent target oracles
  datasets/       # Source acquisition and import adapters
  research/       # Optional model, Stagehand, and context experiments
  run.mjs         # Shared orchestration
  grader.mjs
  policy.json     # The single current acceptance policy
  provider.mjs
scripts/release/  # Artifact packaging, approval, activation, rollback
```

Keep existing unit/integration locations. Small helpers and harness tests stay beside the code they cover. Private dataset payloads and generated reports remain outside tracked source. Existing research comparisons remain reproducible assignment deliverables, but are not additional mandatory release phases or a model matrix run on each release PR.

## Execution and migration

- Run on opening or updating a trusted same-repository `main` to `release` pull request. Require successful ordinary CI for the evaluated revision without duplicating its tests in release evaluation. Freeze the approved baseline and candidate images, cases, and current policy, then run the paired live browser/offline comparison. Keep one original attempt per case per arm, no automatic retries, every failure, and separate gains/losses and latency/cost summaries. Billing lookup or ledger availability must not prevent retaining and grading resolution results; loss of required evaluation evidence remains a verification failure.
- On merge, require successful checks for the tested source tree and the same approved baseline. Publish and approve the saved tested images without rebuilding. Retain both tested and final commit identities when GitHub's merge commit differs but the source tree is identical. A changed tree or baseline requires a new comparison. A manually merged failing PR cannot replace the approved release.
- Preserve `v1.0.0` and its exact Browser/Resolver images as the initial baseline for the new workflow. Run its existing offline selection entry point for imported cases with those same saved Resolver bytes. Resolver qualification does not claim whole-application image attestation.
- Replace current-runner historical policy switches and overlapping version-specific catalogs with the current policy and deduplicated behavior cases. Preserve unique relevant coverage when adapting legacy cases to current semantics. Old source, reports, and release artifacts retain their original meaning; do not reapprove or rewrite old results under the new policy. Keep only the migration support needed to use the existing approval. Retiring public legacy API contracts is outside this live-evaluation restructuring.
- Nightly monitoring restores the approved release and its frozen Resolver cases, compares current results with saved approval measurements, and reports lost passes or operational failures. It does not change the approved release, activate anything, use new unapproved cases, or repeat ordinary CI tests.

The maintainer accepted this design and authorized implementation. Acceptance records the decision; it does not establish hosted workflow execution, private dataset publication, successful live comparison, approval or deployment. Preserve those as separately verified operational outcomes.

This decision supersedes current release workflow and qualification requirements in ADR-0016, ADR-0021 and ADR-0022, and makes billing/accounting availability nonblocking under ADR-0019. Historical approvals, experiments and reports retain their original rules. The existing approved release keeps its archived runner and original monitoring collection until a new approval is verified.

[ADR-0024](0024-keep-one-resolution-implementation.md) supersedes the exception for retaining legacy API implementations and retires the old experiment runners. The release comparison and archived approval requirements above remain in force.
