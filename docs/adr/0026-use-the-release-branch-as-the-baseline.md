# Use the release branch as the baseline

The commit merged into `release` is the release and the baseline for the next comparison. Required ordinary CI and the complete comparison with live provider inference run before merge; publication verifies source-tree equality and publishes the tested artifacts without a separate approval state or configuration selection.

Docker or the deployment environment supplies OpenRouter credentials, endpoint, model and provider. Evaluation records its nonsecret effective settings as evidence; artifacts never install those settings into a deployment. Rollback is a Git revert followed by the same checks and release flow. This replaces the approval, promotion and activation decisions in ADR-0004, ADR-0021, ADR-0022 and ADR-0023.

The old release is retired. The first replacement `v1.0.0` establishes fresh measurements after complete checks with live provider inference, without running an old-contract adapter or old baseline comparison. This transition is tied to the existing release branch commit; subsequent releases must use the exact preceding published images. Git release tags remain distribution names, with no runtime prompt or configuration selectors.
