# ADR-0012: Compatibility with the beta interval settings

- **Status**: Superseded by [ADR-0015](0015-name-and-settings-namespace.md) (the beta keys are removed before the first MiraBar release)
- **Date**: 2026-10-01 (Phase 1.2)

## Context

`updatefrequencyms` exists in the beta builds (v1.0.x on GitHub Releases, v1.1.0 unreleased). The development branches added `refreshSeconds`, then `refreshMs` and `allowFastBatteryDiskRefresh`, present in the developer's settings. ADR-0009 and ADR-0010 replace all of them.

## Decision

- **Read as fallbacks** while the new keys do not set a section:
  - `updatefrequencyms` for CPU, load and memory; temperature, battery and disk stay at least that slow (in the betas they also followed the single tick).
  - `refreshMs` (or `refreshSeconds` × 1000) for tooltips, and for the status bar of temperature, battery and disk (their sampling interval in Phase 1.1).
  - `allowFastBatteryDiskRefresh` for `allowFastRefresh`.
- User values are read with `inspect()`, not `get()`: `get()` returns the `package.json` default object, which would hide every fallback (bug found in review before release).
- **Migration**: the first interval edit in the panel writes `statusBarMs`, `tooltipMs` and `allowFastRefresh` as they are in effect and removes the legacy keys, so nothing changes except the edited value. Panel messages are serialized so two quick edits cannot race the migration.
- The legacy keys stay in `package.json` with `deprecationMessage`.

## Alternatives considered

- **Migrate automatically on activation**: writes to the user's settings without any action from the user.
- **Ignore the development keys**: only the developer has them, but they would linger silently without effect.

## Consequences

- No beta user loses `updatefrequencyms`; `test/extension.test.mjs` covers fallbacks and migration, with the mock returning `package.json` defaults like VS Code.
