# ADR-0015: Rename to MiraBar

- **Status**: Accepted (supersedes ADR-0012)
- **Date**: 2026-10-01
- **Plan**: [docs/RENAME_MIRABAR_PLAN.md](../RENAME_MIRABAR_PLAN.md)

## Context

"Resource Monitor NG" reads as a fork of the older *Resource Monitor* extension, and the `resmon` prefix says nothing to a new user. Other names collided with existing projects: *MIRA* (Markdown Inline Rendering Apparatus, an existing extension that may own `mira.*`), *System Monitor Status Bar* / `sysmon` (`letermeflorent.sysmon-statusbar`), *Sysmon* (Microsoft Sysinternals). The extension is in beta and distributed as VSIX, so changing its identity now costs users nothing.

Checked on 2026-10-01: `fabogit.mirabar` does not exist on the VS Code Marketplace, and Open VSX has no extension named `mirabar` (the `fabogit` namespace does not exist there yet).

## Decision

- **Identity**: extension name `mirabar` (ID `fabogit.mirabar`), display name *MiraBar: System Monitor for the Status Bar*, spoken "Mira Bar".
- **Prefix**: settings `mirabar.*`, commands `mirabar.*` with the *MiraBar* category; output channel, status bar item names, settings panel and log prefix use *MiraBar*. `mirabar` rather than `mira` because setting keys are global across extensions.
- **D1 – Legacy settings dropped**: a new extension ID starts with no settings, so the fallbacks and the panel migration of ADR-0012 (`updatefrequencyms`, `refreshMs`, `refreshSeconds`, `allowFastBatteryDiskRefresh`) have nothing to read. They are removed from `package.json`, `src/config.ts`, `src/settings/schema.ts` and the tests. The panel keeps handling messages one at a time (a reset must not interleave with a later edit).
- **D2 – No automatic import** of `resmon.*` values: only the developer has them; README explains how to rename the keys by hand.
- **D3 – Version 2.0.0**: every setting and command ID changes (breaking under semver), and it includes the unreleased Phases 1.1-1.2 (planned as 1.1.1). Milestones v1.2.0-v1.4.0 become 2.1.0-2.3.0 when touched.
- **D4 – Repository** renamed to `fabogit/mirabar` as the last step, on GitHub (old URLs redirect); the remote and the remaining links follow.
- **D5 – Icon** unchanged until a new one exists.
- **D6 – History** kept: ADR-0001 to 0014 and the audit describe what was true then and keep the old names. Forward-looking docs use the new ones.
- Unchanged on purpose: `ResourceMonitor` (the class describes what it does), `darwin_telemetry.node`, telemetry and behaviour.

## Alternatives considered

- **Keep the name**: confusion with the older extension remains.
- **Keep `resmon.*` with a new display name**: settings and commands would carry the old brand forever.
- **Migrate `resmon.*` on first activation**: `getConfiguration('resmon').inspect()` could read undeclared keys, but it would write to the user's settings unasked, for a benefit only the developer gets.

## Consequences

- Users of Resource Monitor NG install MiraBar as a new extension, uninstall the old one, and rename their settings keys if they want to keep them (README, "Migrating from Resource Monitor NG").
- `src/config.ts` and `src/settings/schema.ts` lose the fallback chain and the migration; `test/extension.test.mjs` checks instead that only `mirabar.*` keys and commands are contributed.
- The VSIX files are named `mirabar-<target>-<version>.vsix`.
