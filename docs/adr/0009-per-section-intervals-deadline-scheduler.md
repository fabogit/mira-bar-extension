# ADR-0009: Per-section status bar and tooltip intervals with a deadline scheduler

- **Status**: Accepted. Supersedes the v1.1.0 tick decimation and the Phase 1.1 model (one status bar tick plus `refreshMs`).
- **Date**: 2026-09-30 (Phase 1.2)

## Context

v1.1.0 polled everything on one tick (`updatefrequencyms`) and decimated battery and disk. Phase 1.1 kept the tick and added per-section intervals for tooltips and slow sources, which needed a half-tick tolerance and woke the extension 5 times a second at 200 ms even when every section was slow. VS Code has no hover event, so tooltips must be built ahead of time. The user asked for a dedicated interval per section for both the status bar and the tooltip, with clear contexts of application.

## Decision

- **Two intervals per section.** `mirabar.statusBarMs`: how often the section reads its data and updates its text. `mirabar.tooltipMs`: how often its tooltip is rebuilt from the latest reading, in Static mode with auto-refresh. A tooltip never refreshes faster than its status bar interval (there is no newer reading), and a tooltip never triggers a read.
- **Live** rebuilds a tooltip with every read of its section (temperature only on a new sensor reading); **Static** on click and at the read closest to the tooltip interval; with auto-refresh off, only on click. Each tooltip shows the time of the reading it displays.
- **No global tick.** `ResourceMonitor` (`src/monitor.ts`) arms one timer at the earliest deadline among the visible sections; deadlines within 25 ms share a wake-up. Hidden sections are never read; with every section hidden no timer runs.
- A click reads every visible section and rebuilds every tooltip. Configuration changes are debounced (100 ms).
- The old `update()` was split (the deferred "Phase 4" lifecycle refactor): renderers per section in `src/sections.ts` (pure functions), helpers in `src/format.ts`, wiring in `src/extension.ts`.

## Alternatives considered

- **Keep a global tick with per-section multiples**: needs the tolerance hack, wakes up at the fastest interval even for slow sections.
- **One `setTimeout` per section**: up to six timers and no batching of close deadlines.
- **Compute tooltips on hover**: not possible with the stable API.
- **Live mode capped at once per second** (tried in Phase 1.1): contradicted the interval the user set; removed.

## Consequences

- Cost follows the configuration: all sections at 2 s or more means at most one wake-up every 2 s.
- Minimums apply to the status bar interval only, since that is where reads happen (ADR-0010).
- The beta settings stayed readable (ADR-0012) until ADR-0015 removed them.
