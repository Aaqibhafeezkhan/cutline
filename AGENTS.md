# Notes for AI coding agents

Working on Cutline with an AI assistant? Read [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. The essentials:

- **One source of truth.** Every edit is an operation in `packages/core/src/operations`
  (Zod schema in `schemas.ts`, pure handler, registered in `apply.ts`). The UI and the MCP tools
  only dispatch operations. A new editing capability therefore means: operation + tests in core,
  then UI and/or MCP tool. Never mutate a `Project` outside an operation.
- **Core stays pure and fully covered.** No DOM/Node APIs in `packages/core`.
  `pnpm --filter @cutline/core test` enforces 100 % coverage.
- **Resolver = rendering contract.** `resolveFrame` / `resolveAudioSegments` define what is shown
  and heard. The browser engine and the ffmpeg renderer must both follow it.
- **Errors are UX for LLMs.** Throw `CutlineError(code, message, { hint })` with a hint that says
  how to fix the call.
- **Tool docs are generated.** After changing tool or operation schemas, run `pnpm docs:tools`.
- **Media for tests** comes from `pnpm fixtures` (synthetic, CC0). Do not add third-party media.
- Before committing: `pnpm lint && pnpm typecheck && pnpm test` (and `pnpm e2e` for UI changes).
  Conventional Commit messages are enforced by a commit hook.
