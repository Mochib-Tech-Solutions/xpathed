# Qualify complete resolver releases

Release selection is superseded by [ADR-0026](0026-use-the-release-branch-as-the-baseline.md). The following records the earlier decision.

Release triggers, acceptance and promotion are now defined by [ADR-0023](0023-simplify-release-evaluation.md). Complete resolver identity, retained rollback artifacts and alert-only drift monitoring remain in force.

Qualify the resolver's code, strategy, prompt, model/provider settings, and DOM processing together. A model name alone does not identify the behavior that clients receive. Keep experimental configurations separate from the approved default; changing the default requires successful qualification and explicit promotion, with the previous approved configuration retained for rollback. Repeat evaluation after merge and on a schedule because a hosted provider can change behavior without a repository commit. Dataset versions, evaluation settings, and observed provider metadata belong in the qualification evidence.

Scheduled drift failures fail the CI run and alert the maintainer; they never disable the running feature or automatically change the approved default. Failed qualification still prevents promotion of a new release. Full qualification runs from release branches, while main retains post-merge integration/regression checks and nightly drift checks use the frozen approved configuration.
