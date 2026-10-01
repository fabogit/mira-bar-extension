# ADR-0008: Configurable widget order mapped to status bar priorities

- **Status**: Accepted
- **Date**: 2026-09-30 (Phase 1.1)

## Context

The user asked to reorder the sections. VS Code orders status bar items by priority and cannot move an existing item.

## Decision

- `mirabar.order` is a list of section ids. It is translated into descending priorities from `mirabar.priority` (higher priority = further left on both sides). Unknown or duplicate ids are dropped and missing sections keep their default position, so a partial list never hides a widget.
- A change of order, alignment, base priority or gear visibility recreates the widgets; other changes update them in place.
- The panel reorders by drag and drop or with arrow buttons.

## Alternatives considered

- **One priority setting per widget**: harder to understand and easy to make inconsistent.

## Consequences

- Recreating widgets closes an open hover; it happens only on placement changes, debounced (ADR-0009).
