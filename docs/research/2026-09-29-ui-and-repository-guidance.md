# UI and repository guidance

Reviewed 2026-09-29. These choices preserve xpathed's full-page chat/browser workflow and give future implementation work concise, current project context.

## UI conventions

shadcn/ui supports existing Vite projects with Tailwind and a matching TypeScript/Vite import alias. Its recommended CSS-variable approach supplies semantic surface, text, border and focus tokens; dark mode overrides those same tokens. xpathed keeps shared primitives in `src/Web/src/components/ui/`, neutral tokens in `style.css`, and feature-specific behavior under `features/`. The `components.json` file records the local aliases and neutral base color. [Vite integration](https://ui.shadcn.com/docs/installation/vite), [theming](https://ui.shadcn.com/docs/theming)

The local button, input, dropdown and alert-dialog components adapt the official React/Tailwind registry source. They retain the individual Radix primitives while omitting unused variants, exports and animations. The upstream [MIT notice](../../src/Web/src/components/ui/LICENSE) is kept with the copied components. The app uses neutral surface tokens, with a separate error color, and keeps its existing full-page split layout. [Button source](https://ui.shadcn.com/r/styles/new-york-v4/button.json), [input source](https://ui.shadcn.com/r/styles/new-york-v4/input.json), [dropdown source](https://ui.shadcn.com/r/styles/new-york-v4/dropdown-menu.json), [dialog source](https://ui.shadcn.com/r/styles/new-york-v4/alert-dialog.json)

The documented Vite theme provider uses a System/Light/Dark preference, local storage and a root dark class. xpathed adds a listener for system preference changes, guards unavailable browser storage, and applies the stored preference before the initial paint. Theme changes affect the application shell; the remote page keeps its own website styling. [Dark mode with Vite](https://ui.shadcn.com/docs/dark-mode/vite)

Vitest fits the existing Vite toolchain and supports a non-watching CI command. React Testing Library works independently of Jest; its user-event companion models user interactions rather than isolated event dispatch. Use accessible queries and observable behavior for component checks. Browser transport verification remains separate from a simulated DOM. [Vitest](https://vitest.dev/guide/), [React Testing Library setup](https://testing-library.com/docs/react-testing-library/setup/), [user-event](https://testing-library.com/docs/user-event/intro/)

## Repository instructions

The official AGENTS.md guidance recommends project setup and working conventions at the repository root, with more specific instructions only where needed. Review rules should describe meaningful behavior to flag; formatting belongs in configured checks. xpathed keeps a single concise root guide with commands, ownership, product constraints and pointers to authoritative documents. [Repository instruction guidance](https://developers.openai.com/codex/guides/agents-md)

OpenAI's guidance also recommends contextual document pointers, removing stale instructions and avoiding repeated process rules that add work without improving the result. Accordingly, issue-driven implementation refreshes its target and dependencies; a small unrelated edit does not require rereading every issue and research note. README explains the project for people, while AGENTS.md records the working context. [Maintaining useful repository guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

The parent specification and implementation issues #1–#11 were read live, including comments and native dependency links. GitHub remains the live source for status and blockers; the README links roadmap capabilities without copying a status table. Accepted follow-ups in the current runtime supersede the older fixture/Smoke wording in #2. Future work must refresh the relevant issue, compare it with current user scope and code, and update affected documentation in the same change. No automatic issue synchronization is implemented or claimed.
