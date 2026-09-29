# Copilot pull request review customization

Verified against GitHub's current documentation on 2026-09-29. These findings describe supported configuration; repository settings and actual review execution have not been verified here.

## Supported repository files

| File | Purpose |
| --- | --- |
| `.github/copilot-instructions.md` | Repository-wide Copilot rules. |
| `.github/instructions/**/*.instructions.md` | Rules scoped with `applyTo` glob frontmatter. |
| Root `AGENTS.md` | Standing context shared across agents. |
| `.github/skills/code-review/SKILL.md` | A review workflow loaded when relevant. |

GitHub explicitly recommends review-focused skill names such as `code-review`. A skill needs `name` and `description` YAML frontmatter and Markdown instructions. Although the general skill guide also lists other skill locations, `.github/skills` is the explicit PR-review setup path. [Skill setup](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills), [Review usage](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review).

Review instructions and skills are read from the **head branch**, including changes in the PR being reviewed. GitHub changed this behavior in July 2026; advice requiring the files to reach the base branch first is outdated. [GitHub changelog](https://github.blog/changelog/2026-07-17-copilot-code-review-customization-and-configurability-improvements/).

## Official example versus an official review skill

GitHub's Copilot SDK documentation contains a small `code-review` skill example covering security, performance, style, and tests. It is an official **format example**, not a complete installable PR-review policy. [SDK example](https://github.com/github/copilot-sdk/blob/main/docs/features/skills.md).

The GitHub-owned `awesome-copilot` repository is explicitly community-contributed. It contains specialized review skills and automation, but this research did not establish a GitHub-maintained universal review skill that should replace this project's requirements. [Repository](https://github.com/github/awesome-copilot), [Skill catalog](https://github.com/github/awesome-copilot/blob/main/docs/README.skills.md).

Recommendation: author a small repository-specific `code-review` skill using GitHub's supported format and example. Describe it as project guidance, not an official GitHub skill. Do not assume an existing local skill is invoked merely because it exists on a developer's machine.

## Activation, limits, and verification

- The repository setting **Use custom instructions when reviewing pull requests** is enabled by default and can be toggled under Settings → Copilot → Code review. File creation alone does not verify this setting. [Instructions setup](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions).
- Current instruction pages inspected here do not state the historical 4,000-character limit. GitHub recommends short, focused instructions and suggests about 1,000 lines as an upper guideline. Keep our files much shorter; do not treat that recommendation as guaranteed context capacity. Instructions cannot themselves enforce merging rules. [Writing review instructions](https://docs.github.com/en/copilot/tutorials/customize-code-review).
- Automatic review is configured separately through author settings or repository/organization rulesets. A repository ruleset can target the default branch and enable review of new pushes. This is separate from making checks required. [Automatic-review configuration](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review).
- Copilot code review is generally available with paid Copilot plans; agentic capabilities are enabled automatically for eligible plans. Runner failure or unavailability can reduce review capabilities. Copilot approvals are a separate public preview: they do not count toward required approvals by default, but can when explicitly enabled. [Availability and approval behavior](https://docs.github.com/en/copilot/concepts/agents/code-review).
- Verify adoption on an actual PR: inspect skill attribution on review comments and the linked review session. Absence of findings is not evidence that every check ran. [Review context verification](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review).

## Guidance to author for this project

Use one short global instruction file and one review skill; defer path-specific files until implementation paths are settled. Review these accepted requirements:

1. One selected target; every returned XPath must uniquely select that same element in its frame.
2. Treat XPath validity and target correctness as separate checks, with independently labeled expected targets.
3. Exclude application-hidden elements, including hidden upload inputs; preserve eligible off-screen elements and explicit instruction precedence over viewport preference.
4. Keep target identity, state validation, and user-controlled action execution separate.
5. Keep browser session/page identity consistent across client and resolver.
6. Keep evaluation labels out of model input; split related page families together and preserve all attempts.
7. Qualify the complete resolver configuration; do not silently promote a newly added model or weaken quality gates.
8. Keep provider outages and invalid model responses distinct from `not_found`.
9. Check secret handling, persisted page-data exposure, EF migrations, and changes to CI/evaluation gates.
10. Request concrete evidence for findings; use deterministic required checks for release enforcement.

These files can be authored now. Enabling paid features, setting rulesets, and proving reviews run require separate repository configuration and a real PR. No remote settings were changed by this research.
