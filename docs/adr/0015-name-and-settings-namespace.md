# ADR-0015: Name MiraBar, `mirabar.*` namespace, beta settings removed

- **Status**: Accepted (supersedes ADR-0012)
- **Date**: 2026-10-01

## Context

Before its first public release the extension needs a name and a namespace for settings and commands that say what it is and do not collide with existing projects. Names considered and discarded: *MIRA* (Markdown Inline Rendering Apparatus, an existing extension that may own `mira.*`), *System Monitor Status Bar* / `sysmon` (`letermeflorent.sysmon-statusbar`), *Sysmon* (Microsoft Sysinternals). The builds so far (1.0.x, 1.1.0 and the development branches) are betas distributed as VSIX and never published on a marketplace, so there are no users to stay compatible with.

Checked on 2026-10-01: `fabogit.mirabar` does not exist on the VS Code Marketplace, and Open VSX has no extension named `mirabar` (the `fabogit` namespace does not exist there yet).

## Decision

- **Identity**: extension name `mirabar` (ID `fabogit.mirabar`), display name *MiraBar: System Monitor for the Status Bar*, spoken "Mira Bar".
- **Namespace**: settings `mirabar.*`, commands `mirabar.*` with the *MiraBar* category; output channel, status bar item names, settings panel and log prefix use *MiraBar*. `mirabar` rather than `mira` because setting keys are global across extensions.
- **Beta settings removed**: the single interval `updatefrequencyms` and the development keys `refreshMs`, `refreshSeconds` and `allowFastBatteryDiskRefresh` are gone from `package.json`, together with their fallbacks in `src/config.ts`, the panel migration in `src/settings/schema.ts` and their tests. The panel keeps handling messages one at a time (a reset must not interleave with a later edit).
- **Version 1.2.0** for the first public release: it continues the numbering of the betas and adds the features of Phases 1.1-1.2 (planned as 1.1.1), hence a minor. The milestones for Linux, Windows and localization move one minor up: 1.3.0, 1.4.0, 1.5.0.
- **Repository** renamed to `fabogit/mirabar` on GitHub by hand (old URLs redirect); the remote and the links in the docs follow.
- **Icon** unchanged until a new one exists.
- Unchanged on purpose: the `ResourceMonitor` class (the name describes what it does), `darwin_telemetry.node`, telemetry and behaviour.

## Alternatives considered

- **Shorter `mira` prefix**: collides with an existing extension in a namespace shared by every extension.
- **Version 2.0.0**: would signal new setting and command IDs, but there is no installed base to warn, and every milestone would be renumbered.
- **Keep the beta settings as fallbacks** (ADR-0012): code, a migration and tests for keys that only the developer has.

## Consequences

- `src/config.ts` and `src/settings/schema.ts` lose the fallback chain and the migration; `test/extension.test.mjs` checks instead that only `mirabar.*` keys and commands are contributed.
- The VSIX files are named `mirabar-<target>-<version>.vsix`.
