# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/). Decisions behind the changes: [docs/adr/](docs/adr/README.md).

## [1.2.0] - unreleased

First release as **MiraBar** (`fabogit.mirabar`): settings and commands `mirabar.*`, commands grouped under the *MiraBar* category ([ADR-0015](docs/adr/0015-name-and-settings-namespace.md)). It includes the work of roadmap Phases 1.1 and 1.2.

Earlier versions are betas: 1.0.0 and 1.0.1 are VSIX packages on GitHub Releases (nothing on a marketplace), 1.1.0 was not released. They use a different extension ID and settings: uninstall a beta before installing 1.2.0; its settings are not carried over.

### Changed

- Status bar intervals are set per section with `mirabar.statusBarMs` (read and text) and `mirabar.tooltipMs` (Static tooltips) ([ADR-0009](docs/adr/0009-per-section-intervals-deadline-scheduler.md)). The single interval `updatefrequencyms` and the development keys `refreshMs`, `refreshSeconds` and `allowFastBatteryDiskRefresh` are removed.
- Minimum status bar intervals come from measurements on an Apple M4: temperature 8400 ms (default 10 s, was 5 s), every other section 200 ms; `mirabar.allowFastRefresh` unlocks them ([ADR-0010](docs/adr/0010-refresh-minimums-from-measurements.md)).

### Added

- Settings gear widget: tooltip with a sections table and an options table; click opens a settings panel with per-section intervals, visibility, drag-and-drop order, units and disk options ([ADR-0007](docs/adr/0007-settings-panel-webview-frontend.md)).
- Configurable widget order (`mirabar.order`) ([ADR-0008](docs/adr/0008-widget-order-priorities.md)).
- Static tooltips refresh automatically at their interval (`mirabar.tooltip.autoRefresh`, command *Toggle Static Tooltip Auto-Refresh*); every tooltip shows the time of its reading.
- Memory pressure label from the kernel (Normal / Warning / Critical) on macOS ([ADR-0005](docs/adr/0005-memory-pressure-metric.md)).
- Battery capacities in mAh on recent macOS releases, shown as *Nominal vs Design* ([ADR-0004](docs/adr/0004-battery-data-sources.md)).
- Development tools: `test:extension`, `bench:darwin`, `bench:extension`, `test/leak-darwin.mjs`, `native/darwin/tools/hid_bench.cc`.

### Fixed

- Mach host port reference leaked on every read (about 3 references per tick) in the macOS addon ([ADR-0002](docs/adr/0002-raii-native-core-and-addon-state.md)).
- Polling could restart after deactivation; recreated status bar items accumulated in the extension's subscriptions.
- Memory pressure showed `vm.memory_pressure` (6% "Normal" while the kernel reported Warning at ~64%).
- The addon failed to load on macOS 11 (`kIOMainPortDefault`) ([ADR-0006](docs/adr/0006-native-build-and-macos-target.md)).
- A dead network mount could freeze every widget (`statfs` awaited on the tick) ([ADR-0011](docs/adr/0011-disk-sampling-off-the-event-loop.md)).
- Linux: failing reads on every tick for cores without cpufreq.

### Performance

- Temperature read on a native background thread: 18 ms per read on the Extension Host thread → ~3 µs ([ADR-0003](docs/adr/0003-thermal-sampling-background-thread.md)).
- No global polling tick: one timer at the earliest section deadline; hidden sections are never read; no timer at all when every section is hidden.
- Live tooltips are rebuilt only when their data changes; the macOS battery registry is read at most every 30 s.

## [1.1.0] - 2026-09-20 (beta, not released)

- Native macOS Apple Silicon support through a Node-API addon (Mach, IOKit, IOHID): CPU per P/E cluster, system load, SoC temperatures, memory, battery health; dual-runner release pipeline (macOS + Linux).

## [1.0.1] - 2026-09-09 / [1.0.0] - 2026-09-07 (beta, GitHub Releases)

- First release: Linux status bar widgets for CPU, frequency, temperature, memory, battery and disk, with monospace tooltip tables and quick toggles.
