# ADR-0001: Record architecture decisions

- **Status**: Accepted
- **Date**: 2026-10-01

## Context

Phases 1.1 and 1.2 (September–October 2026) changed the native addon, the refresh model and the settings UI. The reasons behind those choices (measurements, rejected alternatives, user preferences) were spread across commit messages, the audit and a working plan. Linux (Phase 2) and Windows (Phase 3) work will build on them and needs to know which constraints are deliberate.

## Decision

Architecture decisions are recorded as short ADRs in `docs/adr/`, one file per decision, numbered in order: `NNNN-title.md` with **Status**, **Date**, **Context**, **Decision**, **Alternatives considered** and **Consequences**. A decision that replaces another sets the old one to *Superseded by ADR-NNNN*. `docs/adr/README.md` is the index.

Measured numbers live in the ADR that relies on them, with the tool and date of the measurement, so they can be repeated.

## Consequences

- `docs/ARCHITECTURE.md` describes how the system works; the ADRs say why it is built that way.
- New platform work (Phase 2, Phase 3) starts by reading the ADRs that mention it.
