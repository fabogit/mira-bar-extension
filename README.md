# Resource Monitor NG (Next-Generation)

Ultra-fast, zero-subprocess, lightweight resource monitor for VS Code and Antigravity-IDE status bar on Linux & macOS Apple Silicon (M1/M2/M3/M4).

![Resource Monitor](images/icon.png)

## Features

- **CPU Usage (`$(pulse)`)**: Instant overall and per-core utilization parsed directly from `/proc/stat` (Linux) or Mach host APIs (macOS Apple Silicon). Pre-samples on startup (Tick 0) to eliminate empty hover tables.
- **CPU Frequency / System Load (`$(dashboard)`)**: Dynamic clock speeds read directly from `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` on Linux, and normalized capacity System Load Average on macOS Apple Silicon.
- **CPU & SoC Temperature (`$(flame)`)**: Native discovery for AMD Ryzen (`k10temp`, `zenpower`) and Intel (`coretemp`) on Linux; 24-sensor SoC die average/peak, NAND SSD, and battery cell temperature on macOS Apple Silicon via unprivileged `IOHIDEventSystemClient`, read on a native background thread so the extension host never waits for the sensors.
- **Memory & Swap (`$(ellipsis)`)**: Live physical RAM and swap statistics parsed from `/proc/meminfo` on Linux; 64-bit Mach VM stats (active, wired, compressed), `vm.swapusage` and the kernel memory pressure level on macOS.
- **Battery Health & Telemetry (`$(zap)` / `🔋` / `$(plug)`)**: Real-time charging state, design, nominal and full-charge capacity (mAh), remaining charge (mAh), cycle count and health ratio via `/sys/class/power_supply` (Linux) and `IOPowerSources` + `AppleSmartBattery` (macOS, shown as *Nominal vs Design*). Auto-disabled on desktop systems.
- **Storage & Multi-Disk (`$(database)`)**: Non-blocking `statfs` monitoring with smart path truncation (preserving directory boundaries like `.../antigravity/kind-newton`). Supports multi-disk aggregation modes (`All` vs `MostFull`).
- **100% Unified Monospace ASCII Tables**: Deterministic box-drawing tables (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) rendered in monospace across all 6 telemetry tooltips for pixel-perfect column alignment in all VS Code themes.
- **Modular Widgets & Dedicated Tooltips**: Each resource component is an independent status bar widget with its own focused tooltip.
- **Fixed-Width Tabular Rendering**: Unicode Figure Space (`\u2007`) padding prevents UI jitter and shifts as values change digits.
- **Per-Section Refresh**: Each section has its own status bar interval (how often it reads its data) and tooltip interval, from 200 ms to 1 h. Minimums come from measured costs (see [Refresh intervals](#refresh-intervals)). Hidden sections are never read, and there is no global polling tick.
- **Tooltip Hover Stability**: Content diffing prevents active tooltips from flickering or collapsing during background refresh cycles.
- **Settings Panel**: A gear widget with quick toggles and a panel with sliders, millisecond fields and drag-and-drop widget order.
- **Zero Process Spawning**: No `df`, `ps`, `free`, or `powermetrics` subprocesses. Zero `node_modules` runtime dependencies.

## Installation

### Method 1: Install from VSIX via GUI (Recommended)
This method ensures the extension is installed into your currently active VS Code profile:
1. Open VS Code or Antigravity-IDE.
2. Open the Extensions sidebar (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the **`...`** (Views and More Actions) menu in the upper-right corner of the Extensions panel.
4. Select **Install from VSIX...**.
5. Select the platform-specific package:
   - macOS Apple Silicon: `resource-monitor-ng-darwin-arm64-1.1.0.vsix`
   - Linux x64: `resource-monitor-ng-linux-x64-1.1.0.vsix`
6. Reload the window (`Developer: Reload Window`) if prompted.

### Method 2: Command Line Installation

Install for macOS Apple Silicon:
```bash
code --install-extension resource-monitor-ng-darwin-arm64-1.1.0.vsix
```

Install for Linux x64:
```bash
code --install-extension resource-monitor-ng-linux-x64-1.1.0.vsix
```

For Antigravity-IDE:
```bash
antigravity --install-extension resource-monitor-ng-darwin-arm64-1.1.0.vsix
```

## Settings Panel

The gear widget at the end of the status bar group collects the options:

- **Hover** it for two tables: the sections in status bar order (shown or not, status bar and tooltip intervals in effect, `*` where a value was raised to its measured minimum) and the display options with one-click toggles (tooltip mode, Static auto-refresh, CPU core layout, load format, multi-disk display).
- **Click** it (or run *Resource Monitor: Open Settings Panel*) to open the settings panel: for each section a status bar interval (preset slider plus millisecond field) and a tooltip interval, section visibility, drag-and-drop widget order, units and disk options. A note under a value shows what actually applies when it differs from what you set (for example a value below the measured minimum).

The panel is only a front-end for the regular settings below: every change is validated and written to your user `settings.json`, and edits made there are reflected in the panel. The data tooltips keep only the metrics, the time of their last update and links to *Settings* and *Refresh*.

## Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `resmon.refresh` | Resource Monitor: Refresh Stats | Immediately samples all providers and restarts the polling timer. Also triggered by clicking on any metric widget. |
| `resmon.openSettings` | Resource Monitor: Open Settings Panel | Opens the settings panel (also the gear widget's click action). |
| `resmon.toggleTooltipMode` | Resource Monitor: Toggle Tooltip Mode (Static / Live) | Toggles tooltip update mode between `Static` (updated on click and, with auto-refresh, every `resmon.tooltipMs` of the section) and `Live` (updated with every read of the section, `resmon.statusBarMs`). Also available in the gear widget's tooltip. |
| `resmon.toggleTooltipAutoRefresh` | Resource Monitor: Toggle Static Tooltip Auto-Refresh | Static mode: turns the per-section automatic tooltip refresh on or off (off = click only). Also available in the gear widget's tooltip. |
| `resmon.toggleCpuLayout` | Resource Monitor: Toggle CPU Tooltip Layout (Table / List) | Toggles CPU per-core breakdown layout between `Table` (monospaced side-by-side grid) and `List` (vertical clusters). |
| `resmon.toggleLoadFormat` | Resource Monitor: Toggle System Load Format (Percent / Value) | Toggles System Load display on Darwin between normalized capacity percentage (`34.4% L`) and raw POSIX queue depth (`3.44 L`). |
| `resmon.toggleDiskMultiDisplay` | Resource Monitor: Toggle Multi-Disk Display Mode (All / MostFull) | Toggles multi-disk status bar display between showing all monitored mount points (`All`) and showing only the fullest volume (`MostFull`). |

## Configuration Settings

Configure these settings from the settings panel or directly in your VS Code / Antigravity-IDE `settings.json`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `resmon.show.cpuusage` | `boolean` | `true` | Toggle CPU usage percentage |
| `resmon.show.cpufreq` | `boolean` | `true` | Toggle CPU clock frequency (Linux) or System Load (Darwin) |
| `resmon.show.cputemp` | `boolean` | `true` | Toggle CPU temperature |
| `resmon.show.mem` | `boolean` | `true` | Toggle memory consumption |
| `resmon.show.battery` | `boolean` | `true` | Toggle battery percentage (auto-hidden on desktops) |
| `resmon.show.disk` | `boolean` | `false` | Toggle disk space information |
| `resmon.show.settings` | `boolean` | `true` | Show the settings (gear) widget after the metrics |
| `resmon.order` | `string[]` | `["cpu","freq","temp","mem","battery","disk"]` | Left-to-right widget order; missing entries keep their default position |
| `resmon.statusBarMs` | `object` | `{cpu:2000, freq:2000, temp:5000, mem:2000, battery:10000, disk:10000}` | Status bar interval per section (ms, 200 ms to 1 h): how often the section reads its data and updates its text. Never below the section's measured minimum unless `resmon.allowFastRefresh` is on (see [Refresh intervals](#refresh-intervals)) |
| `resmon.tooltipMs` | `object` | `{cpu:5000, freq:5000, temp:5000, mem:5000, battery:10000, disk:10000}` | Tooltip interval per section (ms, 200 ms to 1 h), Static mode with auto-refresh: how often the tooltip is rebuilt from the latest reading. Never faster than the section's status bar interval |
| `resmon.allowFastRefresh` | `boolean` | `false` | **Performance impact:** allows status bar intervals below the measured minimums, down to 200 ms |
| `resmon.freq.unit` | `string` | `"GHz"` | Unit for CPU frequency (`GHz`, `MHz`, `KHz`, `Hz`) |
| `resmon.mem.unit` | `string` | `"GB"` | Unit for memory display (`GB`, `MB`, `KB`, `B`) |
| `resmon.disk.format` | `string` | `"PercentRemaining"` | Disk display format |
| `resmon.disk.drives` | `string[]`| `[]` | Custom mount paths to monitor |
| `resmon.disk.multiDisplay` | `string` | `"All"` | Multi-disk status bar display mode: `"All"` (all disks) or `"MostFull"` (single fullest volume) |
| `resmon.priority` | `number` | `100` | Base priority for status bar positioning (lower/negative shifts right) |
| `resmon.alignment` | `string` | `"Left"` | Status bar alignment (`"Left"` or `"Right"`) |
| `resmon.tooltip.mode` | `string` | `"Static"` | `"Static"`: tooltips rebuilt on click and, with auto-refresh, every `resmon.tooltipMs`. `"Live"`: rebuilt with every read (`resmon.statusBarMs`; temperature only when the sensors produced a new reading). Each tooltip shows the time of its reading, with tenths of a second below 1000 ms |
| `resmon.tooltip.autoRefresh` | `boolean` | `true` | Static mode: rebuild tooltips automatically every `resmon.tooltipMs` (otherwise only on click) |
| `resmon.updatefrequencyms` | `number` | `2000` | *Deprecated*, replaced by `resmon.statusBarMs`. Still applies to CPU usage, system load / frequency and memory (and keeps temperature, battery and disk at least as slow) while `resmon.statusBarMs` does not set them |
| `resmon.tooltip.cpuLayout` | `string` | `"Table"` | CPU core layout in tooltips: `"Table"` (compact monospace grid) or `"List"` (vertical cluster list) |
| `resmon.loadFormat` | `string` | `"Percent"` | System Load display format on Darwin: `"Percent"` (`34.4% L`) or `"Value"` (`3.44 L`) |

## Refresh Intervals

Each section has two intervals. They control different things:

| | Status bar interval (`resmon.statusBarMs`) | Tooltip interval (`resmon.tooltipMs`) |
| :--- | :--- | :--- |
| **Controls** | How often the section reads its data and updates its status bar text | How often its tooltip is rebuilt from the latest reading |
| **Applies** | Always (both tooltip modes) | Static mode with auto-refresh on. Live tooltips follow the status bar; with auto-refresh off they refresh on click |
| **Cost** | Every read costs CPU (see below) | Rebuilding text only, no extra read |
| **Limits** | 200 ms to 1 h, never below the section's measured minimum | 200 ms to 1 h, never faster than its status bar interval |

A click on any widget reads every visible section and rebuilds every tooltip.

**Measured minimums.** The minimum status bar interval of a section is the interval at which its reads use its share of the extension's CPU budget: 0.5% of one core for all six sections together, so 0.083% each. The cost of a read includes the macOS services that answer it and the extension's own work to show it; both are measured on an Apple M4 with `pnpm run bench:darwin` and `pnpm run bench:extension`:

| Section | Cost per read (M4) | Minimum | Default |
| :--- | ---: | ---: | ---: |
| CPU usage, system load, memory, battery, disk | under 30 µs to read, plus 0.34-0.47 ms to show | 200 ms | 2 s (battery and disk 10 s) |
| Temperature | ~42 ms of CPU across the system (26 sensors through the HID server) | 8400 ms | 10 s |

Temperature is the only expensive source: at the old 5 s default it alone cost ~0.8% of one core. At the defaults the whole extension uses ~0.49% of one core with all six sections shown. The battery driver publishes new data every 60 s, so a shorter battery interval only shows power adapter changes sooner.

`resmon.allowFastRefresh` lowers every minimum to 200 ms, at the cost of exceeding that budget. The derivation is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#refresh-floors).

## System Load Average (on macOS / Apple Silicon)

On Apple Silicon (M-Series: M1/M2/M3/M4), dynamic core clock frequencies (GHz) are managed entirely in hardware power firmware and are not exposed to unprivileged userspace (retrieving them requires `sudo powermetrics`, violating zero-subprocess and unprivileged security constraints).

To provide actionable telemetry without generating inaccurate estimates, Resource Monitor NG implements:
- The frequency slot is dynamically mapped to the **System Load Average** (`load1`, `load5`, `load15`).
- **Normalized Capacity %**: Calculated as $\frac{\text{Load}}{\text{Total Hardware Cores}} \times 100$. For example, a load of `3.44` on a 10-core M4 represents `34.4%` utilization of the available hardware capacity.
- **Queue Semantics**: Unlike standard CPU utilization (clamped at 100%), POSIX Load Average measures the total count of threads running plus threads waiting in the queue. Values $> 100\%$ indicate that the CPU is fully saturated and processes are queued for execution.
- Toggle between normalized percentage (`34.4% L`) and classic raw queue depth (`3.44 L`) via `resmon.loadFormat` or the command palette.

## Project Status & Documentation

- **macOS (Apple Silicon)**: memory-safety fixes, per-section refresh and measured minimums are done and verified on an M4 (unreleased, will ship as v1.1.1).
- **Linux**: works with the same features; the code shared with macOS changed and still needs a check on real hardware, then Linux parity work (Phase 2).
- **Windows**: not started (Phase 3).

| Document | Content |
| :--- | :--- |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases, what is done and what is left |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works: sources, refresh model, scheduler, minimums, UI |
| [docs/adr/](docs/adr/README.md) | Architecture decisions and their reasons |
| [docs/DARWIN_APPLE_SILICON.md](docs/DARWIN_APPLE_SILICON.md) | macOS native addon: APIs, build, verification |
| [docs/LINUX_IMPLEMENTATION_PLAN.md](docs/LINUX_IMPLEMENTATION_PLAN.md) | Linux plan and checklist |
| [docs/audit-darwin-memory-2026-09.md](docs/audit-darwin-memory-2026-09.md) | Memory and performance audit of the Darwin addon, with resolutions |

## Build, Testing & Packaging

### Local Development & Testing

Compile native Apple Silicon telemetry addon (on macOS):
```bash
pnpm run compile:native
```

Run test suite locally:
```bash
# Linux telemetry smoke test (verifies /proc and /sys on Linux):
pnpm run test:linux

# Darwin native telemetry assertion smoke test (on macOS):
pnpm run test:darwin

# Cross-platform end-to-end integration test:
pnpm run test:integration

# Extension behaviour outside VS Code (schedule, tooltips, minimums, settings panel, lifecycle):
pnpm run test:extension

# Native leak & cost probe (on macOS): µs per call, RSS growth, Mach host port refs
node --expose-gc test/leak-darwin.mjs

# Measurements behind the refresh minimums (on macOS):
pnpm run bench:darwin      # cost per read of each source, sensor and battery refresh periods
pnpm run bench:extension   # extension CPU per read, per section and per configuration

# AddressSanitizer build of the native addon (on macOS):
DEBUG=1 pnpm run compile:native
```

Typecheck (`src/` and `test/`) and build the production bundle:
```bash
pnpm run typecheck
pnpm run build
```

Package platform-specific `.vsix` packages:
```bash
# Package for macOS Apple Silicon (darwin-arm64):
pnpm run package:darwin-arm64

# Package for Linux (linux-x64):
pnpm run package:linux-x64
```

### Multi-Platform CI/CD Testing (GitHub Actions)

The release pipeline ([`.github/workflows/release.yml`](.github/workflows/release.yml)) uses a dual-runner matrix (`macos-14` for Apple Silicon ARM64 + `ubuntu-latest` for Linux x64) to compile and test native bundles in isolated cloud environments.

You can trigger a test build on demand without releasing or tagging:

```bash
# Trigger the dual-runner workflow manually via GitHub CLI:
gh workflow run release.yml --ref develop

# Monitor the build execution in real-time:
gh run watch

# Download the generated .vsix artifacts (darwin-arm64 and linux-x64):
gh run download <run-id>
```

When pushing a version tag (e.g. `git tag v1.2.0 && git push origin v1.2.0`), the workflow compiles both native packages and automatically attaches them to a formal GitHub Release.

