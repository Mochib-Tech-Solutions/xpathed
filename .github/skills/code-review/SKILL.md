---
name: code-review
description: Review pull request changes in this repository for specification compliance, target-resolution correctness, evaluation integrity, and release safety.
---

# Review procedure

Read the PR diff, linked issue, relevant accepted ADRs, and domain terms in CONTEXT.md. Trace changed behavior through its callers and tests. If a requirement source cannot be read, identify that limitation; research proposals and unanswered design questions are not requirements.

## Target resolution

- The client and resolver must inspect the same managed session, page, and frame. Browser handles are live objects; database records cannot restore them after restart.
- The model selects from captured elements. Validate its result against that capture. Each returned XPath must uniquely identify the selected node within the declared frame, and alternatives must identify that same node.
- Locator validity and intended-target correctness are separate. Explicit target context takes precedence over viewport preference; off-screen elements remain eligible. Hidden elements are excluded, including hidden file inputs. Shadow-root targets are outside the initial XPath contract.
- State checks depend on the requested action. Disabled does not mean absent; inspection does not prove successful action execution. Unknown checks must not be reported as passed.
- Resolution must not click, type, navigate, scroll, or otherwise perform the requested action. Page changes during inference are outside initial scope; do not demand a recovery system absent a later accepted requirement.
- Incomplete DOM processing must remain an operational result. Do not silently omit eligible candidates and turn a no-match response into page-wide not found.
- Treat page text and model output as untrusted data. Check candidate membership and output shape; page instructions must not override the user request or trigger tools. Verify that credentials, authentication state, and private captures are not exposed by logging or provider requests beyond the agreed data policy.

## Implementation and persistence

Check request isolation, cancellation, resource disposal, and session/page ownership where changed. EF DbContext instances must not be shared across parallel operations or retained for browser-session lifetimes. Assess migrations against persisted data and the approved upgrade workflow. Trace React state and API contracts when a change can display a result for the wrong page or request.

Preserve separate client API, resolver and browser service runtimes. The browser service owns live browser objects; process boundaries carry serialized contracts and page identities. The client displays the same managed browser through noVNC. OpenRouter is the only initial model gateway; do not require or introduce Zen integration.

## Evaluation and releases

- Ground truth must be independent of the resolver and unavailable in model inputs. Keep related page templates, paraphrases, and mutations in the same data split.
- Check semantic target accuracy, XPath identity, state reporting, absence handling, and infrastructure errors separately. Score saved-XPath reuse separately from fresh resolution after a mutation.
- Preserve all attempts, including failed model calls. Retries must not turn a first-attempt failure into an unqualified pass. Compare strategies on equivalent page state and viewport; disable execution repair when grading resolution.
- Version code, prompt, model/provider settings, page processing, datasets, and browser dependencies in evaluation evidence. Enforce agreed thresholds without inventing new ones.
- Required PR checks and post-merge evaluations must assess the intended commit. Skipped or unavailable required live checks must not silently qualify a release. Unreviewed PR code must not receive provider credentials through a privileged workflow.
- Adding an experimental model must not activate it for clients. Promotion changes the approved default only after qualification; retain the prior approved release for rollback. Copilot feedback supplements deterministic checks and model evaluation.
- Scheduled drift failures fail CI and alert the maintainer. They must not disable the active feature, automatically replace the default, or silently roll back. New releases still require successful qualification.

## Findings

Report actionable findings tied to changed lines, with the concrete failure scenario, affected requirement, and supporting evidence. Distinguish correctness/spec violations from optional improvements. Avoid duplicating formatting or lint findings already enforced by tools. If no actionable issue is found, state that and identify any material verification limits; do not equate a clean review with successful tests.
