# ADR-0012: Compatibility with released and pre-release interval settings

- **Status**: Superseded by [ADR-0015](0015-rename-to-mirabar.md) (the rename drops every legacy key)
- **Date**: 2026-10-01 (Phase 1.2)

## Context

`resmon.updatefrequencyms` exists in released versions (v1.0, v1.1.0). The development branches added `resmon.refreshSeconds`, then `resmon.refreshMs` and `resmon.allowFastBatteryDiskRefresh`, never released but present in the developer's settings. ADR-0009 and ADR-0010 replace all of them.

## Decision

- **Read as fallbacks** while the new keys do not set a section:
  - `updatefrequencyms` for CPU, load and memory; temperature, battery and disk stay at least that slow (in released versions they also followed the single tick).
  - `refreshMs` (or `refreshSeconds` × 1000) for tooltips, and for the status bar of temperature, battery and disk (their sampling interval in Phase 1.1).
  - `allowFastBatteryDiskRefresh` for `allowFastRefresh`.
- User values are read with `inspect()`, not `get()`: `get()` returns the `package.json` default object, which would hide every fallback (bug found in review before release).
- **Migration**: the first interval edit in the panel writes `statusBarMs`, `tooltipMs` and `allowFastRefresh` as they are in effect and removes the legacy keys, so nothing changes except the edited value. Panel messages are serialized so two quick edits cannot race the migration.
- The legacy keys stay in `package.json` with `deprecationMessage`.

## Alternatives considered

- **Migrate automatically on activation**: writes to the user's settings without any action from the user.
- **Ignore the pre-release keys**: only the developer has them, but they would linger silently without effect.

## Consequences

- No released user loses `updatefrequencyms`; `test/extension.test.mjs` covers fallbacks and migration, with the mock returning `package.json` defaults like VS Code.
