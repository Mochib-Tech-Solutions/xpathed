# Evaluation, release gates, and action coverage

Primary sources and read-only repository checks performed on 2026-09-29. The policies below are proposals for specification issue #1, not configured repository protections or agreed acceptance thresholds.

Subsequent decisions put full qualification on release branches, regression evaluation on main, and alert-only drift checks on the approved configuration. Hidden targets, including hidden file inputs, are excluded without exception. Instruction-driven execution is outside scope. Follow specification issue #1 and ADR-0004 where earlier proposals below differ.

## Evaluation layers

Independently score candidate coverage, semantic target selection, XPath uniqueness/node identity, action-specific state reporting, absent/unsupported/error handling, and latency/cost. If extraction filters the DOM, measure whether an acceptable target survives filtering. An accurate selector for an incorrectly selected node is still a semantic failure.

Mind2Web separates element selection from operation quality and evaluates generalization across tasks, websites, and domains. Its task formulation differs from this single-instruction resolver; adapting its data does not produce directly comparable benchmark scores. [Mind2Web](https://arxiv.org/html/2306.06070v2)

Use reviewed fixtures with explicit viewport/frame/state expectations and unfamiliar page structures. Keep expected-target mappings independent of the resolver's XPath generator and out of model input. Split data by site/template family; keep related paraphrases and mutations in the same split. Once a held-out failure informs tuning, treat it as regression coverage and refresh the holdout.

Two different robustness tests are necessary: reuse previously generated XPath expressions after a DOM mutation, and resolve the instruction afresh after that mutation. Score these separately. Include target removal/replacement, not only benign changes. The initial stable-page assumption applies within a resolution request and does not prevent controlled changes between test runs.

Record code, prompt, extraction, model/provider/configuration, dataset, browser, and package versions, plus timestamps and every attempt. Repeated paired trials expose variability. Provider aliases and live websites can change without a code commit. [AgentLab reproducibility](https://github.com/ServiceNow/AgentLab#-reproducibility)

## Proposed CI and promotion stages

- Every PR: deterministic unit/browser/contract tests, build/type/static checks, and PostgreSQL integration/migration checks.
- Relevant trusted PRs: bounded live-model comparison with the approved baseline; evaluate the exact reviewed revision.
- Every main merge: integration checks and the agreed full model evaluation on the merged commit; publish case-level evidence and aggregate results.
- Scheduled runs: check the unchanged approved configuration for provider/environment drift.
- Promotion: passing tests makes a versioned resolver configuration eligible for activation. Keep activation distinct from adding a model to the experiment catalog, and retain the previous approved configuration for rollback.

Set model-quality tolerances after baseline measurement and product trade-offs. Deterministic invariant failures and critical known regressions can be immediate blockers. A provider outage should remain an inconclusive/failed qualification, not a passing result or incorrect-target result.

## GitHub findings and constraints

The repository is private and organization-owned; main is the default branch and the current identity has admin permission. It has zero Actions workflows and zero deployment environments. Ruleset/protection reads returned HTTP 403 with an upgrade message; this did not reveal an empty protection configuration. The exact organization plan is unverified.

Private organization repository rulesets ordinarily require GitHub Team or Enterprise eligibility. Upgrading a personal account to Pro does not upgrade an organization. [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)

Copilot reviews default to comments. Current documentation describes opt-in approval behavior in public preview that can satisfy approval rules. Our recommendation is advisory Copilot review alongside required tests, with independent human approval only if another reviewer is available. [Copilot review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review#pull-request-approvals-from-copilot)

Required deployment reviewers for private repositories have different plan restrictions from branch rules; Team does not automatically provide that gate. A trusted manual promotion workflow is possible but is not an independent-review approval control. [Deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

Do not execute unreviewed PR code with model credentials through a privileged trigger. Fork PRs normally lack repository secrets; trusted live evaluation needs an explicit reviewed-revision path. [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## Expanded instruction vocabulary

Playwright documents text entry, checkboxes and radio buttons, selecting options, click variants, hover, key presses, file upload and focus. These browser operations provide a concrete starting point for the instruction vocabulary; the project specification determines which target-resolution requests are supported. Supporting an instruction does not add automatic action execution. [Playwright actions](https://playwright.dev/dotnet/docs/input)

Propose single-target resolution for click/double/right/middle-click, hover, fill/clear, select, check/uncheck/radio, press, focus/blur, upload, and element inspection. Resolving a target for wait/validate/scroll does not execute that action or create an XPath for a node that does not yet exist. Navigation and timed pause have no element target; drag-and-drop has two and needs a separate contract decision.

State rules must depend on action. File upload commonly targets a hidden file input, so it conflicts with the current general exclusion of hidden targets. Decide that exception explicitly. Focus/keyboard handling and event success cannot be proven through inspection alone; unsupported checks need an unknown state. [Actionability](https://playwright.dev/dotnet/docs/actionability)
