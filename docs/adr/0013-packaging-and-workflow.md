# ADR-0013: Packaging hygiene and development workflow

- **Status**: Accepted
- **Date**: 2026-09-29 (Phase 1.1)

## Context

`vsce package` failed with `EISDIR` on the `.claude/skills` symlinks, and the macOS packaging script shipped a stale `dist/extension.js`. The work was done on one Mac and will be continued on a Linux machine, by the same developer.

## Decision

- `.vscodeignore` excludes agent files (`.claude/**`, `.agents/**`, `skills-lock.json`), `pnpm-workspace.yaml`, `.DS_Store` and bench/test bundles left in `dist/`.
- `vscode:prepublish` rebuilds the production bundle before every `vsce package`.
- Agent skills are not versioned (they can be downloaded again); the audit and the docs are.
- Branches start from `develop`; commits stay local until the code has been verified on the platforms it touches. Phases 1.1 and 1.2 were merged into the local `develop` on 2026-10-01 (`12e90e6`), not pushed, pending a check on Linux.

## Consequences

- The darwin VSIX contains only the extension files (36 KB when measured in Phase 1.1).
- Pushing `develop` waits for the Linux check (docs/ROADMAP.md, Phase 2).
