# Scoped repository guidance

Research checked on 2026-09-30 for the backend diagnostics work in issue #5.

The official [AGENTS.md documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md) describes an instruction chain from repository root to the working directory, with nearer instructions taking precedence. It recommends concise service-specific review rules near the code. A root pointer is still useful for sessions launched at the repository root: nested guidance is not a recursive automatic scan.

The official [skills documentation](https://learn.chatgpt.com/docs/build-skills) describes repository discovery through `.agents/skills`, progressive loading through name/description, and instruction-only skills as the default. It recommends focused descriptions and testing trigger behavior. The existing local skill-creator and writing-for-agents instructions similarly favor maintained pointers over duplicate manuals.

Applied here: small scoped guides in each service and `tests/`, plus two workflows for resolution verification and backend diagnostics. Shared product rules remain in root guidance and the existing runtime/resolution documents. No personal configuration or global skills are changed.

The inspected folder layout already separates Browser session/display ownership, Resolver strategies/provider transport, ClientApi HTTP/data ownership, and Web feature state/shared controls. Keep these boundaries; add diagnostics-specific code within its owning service. A repository-wide folder move would add churn without resolving a demonstrated ownership problem. This is a codebase-specific judgment, not a requirement imposed by the documentation.

Validation should check skill frontmatter, existing reference targets and the actual workflow boundaries. Runtime discovery in a future session is distinct from validating files on disk.
