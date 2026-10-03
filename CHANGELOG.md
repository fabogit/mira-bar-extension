# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/). Decisions behind the changes: [docs/adr/](docs/adr/README.md).

## [1.3.0] - 2026-10-03

Linux parity (roadmap Phase 2, milestone [v1.3.0](https://github.com/fabogit/mira-bar-extension/milestone/3)): component temperatures, battery time remaining, CPU cold start and refresh minimums measured on Linux.

### Added

- Linux: NVMe SSD, RAM module (`spd5118`, `jc42`), Wi-Fi adapter and battery cell temperatures in the temperature tooltip, with the limits the drivers report and a note for readings above the operating maximum (#33, #34, #35, #36). They are read asynchronously, off the extension host thread ([ADR-0016](docs/adr/0016-linux-component-temperatures-async.md)).
- `mirabar.temperature.componentSensors` (Linux): `awake` (default) does not read component sensors whose device is runtime-suspended and shows them as *asleep*, so a sleeping drive is not woken; `always` reads them every interval; `off` shows the CPU temperature only. Applied without a reload, also in the settings panel. The check reads the kernel's runtime PM state from sysfs without touching the device (~25 µs); it does not keep an awake NVMe drive in its deepest idle state (APST): choose `off` if that matters on battery.
- Linux: battery time remaining, from the driver's `time_to_empty_now` / `time_to_full_now`, else computed from `power_now` / `current_now` (signed currents handled); *Estimating...* while discharging without a rate, nothing when full, not charging or unknown (#3).
- Development: `test:linux-temp` and `test:linux-battery` (mocked sysfs trees), `bench:linux` (cost per read of every Linux source, latency at 200 ms polling, V8 heap and GC) (#5).

### Changed

- Linux: the CPU temperature limit comes from the kernel (`temp*_crit` / `temp*_max`, thermal zone `critical` trip point) instead of a fixed 100 °C, which remains the fallback (#4).
- Refresh minimums per platform. Linux, measured on a Ryzen 7 7840U: temperature 600 ms (was the macOS 8400 ms), the rest 200 ms; macOS unchanged; platforms not measured yet use the highest value per section. The settings panel and the setting descriptions show the host's minimums ([ADR-0010](docs/adr/0010-refresh-minimums-from-measurements.md)) (#5).
- Linux: the CPU counters are primed when the provider is created, so the first CPU tooltip shows every core instead of an empty table, and the second read comes 500 ms after activation instead of a whole interval; reads less than ~50 ms apart keep the previous result, as on macOS (#1).

### Fixed

- Linux: the battery state is the kernel's (*Not charging*, *Unknown*) instead of *Discharging*, so a laptop held at its charge limit on AC shows the plug icon.
- The temperature defaults were declared as 5 s in `package.json` and the README; the extension has applied 10 s since 1.2.0.

## [1.2.0] - 2026-10-01

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
