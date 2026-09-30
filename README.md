# Resource Monitor NG (Next-Generation)

Ultra-fast, zero-subprocess, lightweight resource monitor for VS Code and Antigravity-IDE status bar on Linux & macOS Apple Silicon (M1/M2/M3/M4).

![Resource Monitor](images/icon.png)

## Features

- **CPU Usage (`$(pulse)`)**: Instant overall and per-core utilization parsed directly from `/proc/stat` (Linux) or Mach host APIs (macOS Apple Silicon). Pre-samples on startup (Tick 0) to eliminate empty hover tables.
- **CPU Frequency / System Load (`$(dashboard)`)**: Dynamic clock speeds read directly from `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` on Linux, and normalized capacity System Load Average on macOS Apple Silicon.
- **CPU & SoC Temperature (`$(flame)`)**: Native discovery for AMD Ryzen (`k10temp`, `zenpower`) and Intel (`coretemp`) on Linux; 24-sensor SoC die average/peak, NAND SSD, and battery cell temperature on macOS Apple Silicon via unprivileged `IOHIDEventSystemClient`.
- **Memory & Swap (`$(ellipsis)`)**: Live physical RAM and swap statistics parsed from `/proc/meminfo` on Linux; 64-bit Mach VM stats (active, wired, compressed) and `vm.swapusage` on macOS.
- **Battery Health & Telemetry (`$(zap)` / `🔋` / `$(plug)`)**: Real-time charging state, nominal factory design capacity (mAh), calibrated maximum capacity (mAh), current residual capacity (mAh), cycle count, and calculated health percentage via `/sys/class/power_supply` (Linux) and `AppleSmartBattery` (macOS). Auto-disabled on desktop systems.
- **Storage & Multi-Disk (`$(database)`)**: Non-blocking `statfs` monitoring with smart path truncation (preserving directory boundaries like `.../antigravity/kind-newton`). Supports multi-disk aggregation modes (`All` vs `MostFull`).
- **100% Unified Monospace ASCII Tables**: Deterministic box-drawing tables (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) rendered in monospace across all 6 telemetry tooltips for pixel-perfect column alignment in all VS Code themes.
- **Modular Widgets & Dedicated Tooltips**: Each resource component is an independent status bar widget with its own focused tooltip.
- **Fixed-Width Tabular Rendering**: Unicode Figure Space (`\u2007`) padding prevents UI jitter and shifts as values change digits.
- **Multi-Rate Polling (Tick Decimation)**: High-speed polling (down to 200 ms) for CPU and RAM, with automatic decimation to $\ge 1000$ ms for Battery and Disk to prevent VFS/sysfs overhead.
- **Tooltip Hover Stability**: Content diffing prevents active tooltips from flickering or collapsing during background refresh cycles.
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

## Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `resmon.refresh` | Resource Monitor: Refresh Stats | Immediately samples all providers (bypassing decimation) and restarts the polling timer. Also triggered by clicking on any status bar widget. |
| `resmon.toggleTooltipMode` | Resource Monitor: Toggle Tooltip Mode (Static / Live) | Toggles tooltip update mode between `Static` (flicker-free, updated on click) and `Live` (continuous real-time updates). Also accessible via link in tooltips. |
| `resmon.toggleCpuLayout` | Resource Monitor: Toggle CPU Tooltip Layout (Table / List) | Toggles CPU per-core breakdown layout between `Table` (monospaced side-by-side grid) and `List` (vertical clusters). |
| `resmon.toggleLoadFormat` | Resource Monitor: Toggle System Load Format (Percent / Value) | Toggles System Load display on Darwin between normalized capacity percentage (`34.4% L`) and raw POSIX queue depth (`3.44 L`). |
| `resmon.toggleDiskMultiDisplay` | Resource Monitor: Toggle Multi-Disk Display Mode (All / MostFull) | Toggles multi-disk status bar display between showing all monitored mount points (`All`) and showing only the fullest volume (`MostFull`). |

## Configuration Settings

Configure these settings in your VS Code / Antigravity-IDE `settings.json`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `resmon.show.cpuusage` | `boolean` | `true` | Toggle CPU usage percentage |
| `resmon.show.cpufreq` | `boolean` | `true` | Toggle CPU clock frequency (Linux) or System Load (Darwin) |
| `resmon.show.cputemp` | `boolean` | `true` | Toggle CPU temperature |
| `resmon.show.mem` | `boolean` | `true` | Toggle memory consumption |
| `resmon.show.battery` | `boolean` | `true` | Toggle battery percentage (auto-hidden on desktops) |
| `resmon.show.disk` | `boolean` | `false` | Toggle disk space information |
| `resmon.updatefrequencyms`| `number` | `2000` | Status bar polling interval in milliseconds (200-15000) |
| `resmon.freq.unit` | `string` | `"GHz"` | Unit for CPU frequency (`GHz`, `MHz`, `KHz`, `Hz`) |
| `resmon.mem.unit` | `string` | `"GB"` | Unit for memory display (`GB`, `MB`, `KB`, `B`) |
| `resmon.disk.format` | `string` | `"PercentRemaining"` | Disk display format |
| `resmon.disk.drives` | `string[]`| `[]` | Custom mount paths to monitor |
| `resmon.disk.multiDisplay` | `string` | `"All"` | Multi-disk status bar display mode: `"All"` (all disks) or `"MostFull"` (single fullest volume) |
| `resmon.priority` | `number` | `100` | Base priority for status bar positioning (lower/negative shifts right) |
| `resmon.alignment` | `string` | `"Left"` | Status bar alignment (`"Left"` or `"Right"`) |
| `resmon.tooltip.mode` | `string` | `"Static"` | Tooltip mode: `"Static"` (updated on click and, with auto-refresh, at each section interval) or `"Live"` (every polling tick, at most once per second) |
| `resmon.tooltip.autoRefresh` | `boolean` | `true` | Static mode: regenerate tooltips automatically at each section interval (otherwise only on click) |
| `resmon.refreshSeconds` | `object` | `{cpu:5, freq:5, temp:5, mem:5, battery:10, disk:10}` | Seconds per section: Static tooltip refresh; battery, disk and temperature are also sampled at this interval (temperature min 2 s) |
| `resmon.tooltip.cpuLayout` | `string` | `"Table"` | CPU core layout in tooltips: `"Table"` (compact monospace grid) or `"List"` (vertical cluster list) |
| `resmon.loadFormat` | `string` | `"Percent"` | System Load display format on Darwin: `"Percent"` (`34.4% L`) or `"Value"` (`3.44 L`) |

## System Load Average (on macOS / Apple Silicon)

On Apple Silicon (M-Series: M1/M2/M3/M4), dynamic core clock frequencies (GHz) are managed entirely in hardware power firmware and are not exposed to unprivileged userspace (retrieving them requires `sudo powermetrics`, violating zero-subprocess and unprivileged security constraints).

To provide actionable telemetry without generating inaccurate estimates, Resource Monitor NG implements:
- The frequency slot is dynamically mapped to the **System Load Average** (`load1`, `load5`, `load15`).
- **Normalized Capacity %**: Calculated as $\frac{\text{Load}}{\text{Total Hardware Cores}} \times 100$. For example, a load of `3.44` on a 10-core M4 represents `34.4%` utilization of the available hardware capacity.
- **Queue Semantics**: Unlike standard CPU utilization (clamped at 100%), POSIX Load Average measures the total count of threads running plus threads waiting in the queue. Values $> 100\%$ indicate that the CPU is fully saturated and processes are queued for execution.
- Toggle between normalized percentage (`34.4% L`) and classic raw queue depth (`3.44 L`) via `resmon.loadFormat` or the command palette.

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
```

Build production bundle and typecheck:
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

