# Contributing to Cutline

Thanks for helping! Cutline is a small, focused project: a timeline that is a
JSON document, edited by humans and AI agents through the same operations.

## Setup

```bash
git clone https://github.com/Aepzie/cutline.git
cd cutline
pnpm install
pnpm dev
```

Requirements: Node.js ≥ 22, pnpm 10 (`npm i -g pnpm` or `corepack enable`),
and ffmpeg on your `PATH` for the perception tools and server-side export.
Run `pnpm fixtures` to generate the synthetic test media.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- `packages/core`: schema + pure operations. **Every change here needs tests**;
  coverage is enforced at 100 %.
- `packages/engine`: browser rendering (WebCodecs, Mediabunny, PixiJS).
- `packages/mcp-server`: MCP tools, sync hub, storage, media services.
- `apps/web`: the React editor.

## Golden rules

1. **No GUI-only features.** If the UI can do it, there must be an operation in
   `@cutline/core` and a way to reach it via MCP (a dedicated tool or
   `apply_operations`).
2. **Operations are pure.** No I/O in `@cutline/core`.
3. **Errors are for LLMs too.** Throw `CutlineError` with a hint that tells the
   caller what to do next.
4. **Licenses.** Only add dependencies under MIT, Apache-2.0, BSD, ISC or
   similarly permissive licenses (MPL-2.0 is accepted for unmodified
   dependencies). Update [docs/licenses.md](docs/licenses.md).
5. **No copyrighted media.** Test media is generated (`pnpm fixtures`) or CC0
   with its source documented.

## Workflow

- Branch from `main`, open a PR. CI must be green.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`, `refactor:`).
- User-facing changes need a changeset: `pnpm changeset`.
- Pre-commit hooks run ESLint and Prettier on staged files.

## Useful commands

| Command           | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `pnpm dev`        | server on :4100 + editor on :5173               |
| `pnpm test`       | unit + integration tests (Vitest)               |
| `pnpm e2e`        | Playwright smoke test                           |
| `pnpm lint`       | ESLint                                          |
| `pnpm typecheck`  | `tsc --noEmit` in every package                 |
| `pnpm docs:tools` | regenerate `docs/mcp-tools.md` from the schemas |

## Reporting bugs

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md).
