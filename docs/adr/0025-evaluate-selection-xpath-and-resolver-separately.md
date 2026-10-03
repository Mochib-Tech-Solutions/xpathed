# Evaluate model selection, XPath verification and Resolver E2E separately

The evaluation set has three categories: model selection from reviewed saved inputs, XPath construction and verification from controlled selections in a real browser, and the complete Resolver request with live inference. Reuse the existing cases and independent labels so each stage can be checked on its own and the full pipeline can be checked together. Keep category denominators separate; the XPath category supplies selections and makes no model-quality claim.

`pnpm evaluate` runs all three, including paid inference with the dedicated evaluation key. Separate category commands support focused runs. CI calls `evaluate:resolver` explicitly for the existing provider-free pipeline checks. Unit and integration tests for the other apps retain their commands and ownership. Release comparison, approval and activation keep their existing boundaries; the aggregate evaluation command does not approve a release.
