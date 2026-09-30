# Architectural Specification & Performance Design

## Overview

**Resource Monitor NG** is an ultra-lightweight, cross-platform (Linux & macOS Apple Silicon) extension for VS Code and Antigravity-IDE designed to replace legacy system monitoring extensions that rely on heavy subprocess spawning (e.g. `systeminformation` spawning `ps`, `df`, `free`, or `powermetrics`).

## Zero Subprocess Dual-Platform Architecture

Traditional Node.js system monitor extensions execute shell subprocesses every 1–2 seconds. On Linux and macOS, this causes constant process forks, context switches, thread pool starvation, and prevents CPU cores from entering deeper C-states (increasing power consumption and battery drain).

Resource Monitor NG enforces a strict **Zero-Subprocess Invariant** on all supported platforms:
- **Linux (`linux-x64`)**: Direct synchronous file descriptor reads from the virtual in-memory filesystems (`/proc` and `/sys`).
- **macOS Apple Silicon (`darwin-arm64`)**: Direct synchronous C/C++ kernel API calls via a standalone Node-API native addon (`darwin_telemetry.node`) compiled with Apple Clang, linking Mach, IOKit, and CoreFoundation.

```
┌────────────────────────────────────────────────────────────────────────┐
│                             Extension Host                             │
│                                                                        │
│   [CpuProvider]        [MemoryProvider]       [TempProvider]    ...    │
│         │                     │                      │                 │
│    ┌────┴─────────────────────┼──────────────────────┴────────────┐    │
│    │ Linux                    │ macOS Apple Silicon (darwin-arm64)│    │
│    ▼                          ▼                                   │    │
│  /proc & /sys            Mach kernel APIs (mach_host)             │    │
│  (in-memory VFS)         IOKit & IOHIDEventSystemClient           │    │
│                          AppleSmartBattery IOKit registry         │    │
└────┴──────────────────────────┴───────────────────────────────────┴────┘
```

### 1. CPU Load & Topology
- **Linux**: Reads `/proc/stat` delta counters across logical cores. Handles `iowait` as idle to avoid false I/O spikes.
- **Darwin (Apple Silicon)**: Calls `host_processor_info(PROCESSOR_CPU_LOAD_INFO)` via Mach host APIs to retrieve user, system, idle, and nice ticks per core.
  - **Cold-Start Pre-Sampling (Tick 0)**: Pre-samples CPU ticks during provider instantiation so that the first hover immediately displays valid per-core metrics rather than waiting for an arbitrary polling cycle.
  - **Asymmetric Topology**: Discovers Performance (P) and Efficiency (E) core clusters via `sysctlbyname("hw.perflevel0.logicalcpu")` and `sysctlbyname("hw.perflevel1.logicalcpu")`.

### 2. Clock Frequencies & System Load
- **Linux**: Dynamically discovers `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`, gracefully skipping parked/offline cores (`ENOENT`).
- **Darwin (Apple Silicon - System Load Average)**: Hardware frequency scaling on Apple Silicon is handled autonomously by Apple power firmware and not accessible to unprivileged userspace. Resource Monitor NG maps this slot to **Normalized System Load Average**:
  $$\text{Normalized Load \%} = \frac{\text{Load}_{1\text{m}}}{\text{Total Hardware Cores}} \times 100$$
  Toggleable between normalized percentage (`34.4% L`) and POSIX queue depth (`3.44 L`).

### 3. Hardware Thermal Discovery
- **Linux (`/sys/class/hwmon/`)**: One-time startup heuristic scanning AMD `k10temp`/`zenpower`, Intel `coretemp`, and ACPI thermal zones.
- **Darwin Apple Silicon (`IOHIDEventSystemClient`)**: Unprivileged kernel HID event tap matching `PrimaryUsagePage = 0xff00` and `PrimaryUsage = 0x5`. Samples 24 on-die SoC sensors (reporting both average and peak die temperatures), NAND SSD controller temperature, and battery cell temperature without root permissions.
  - **Background sampler**: one pass costs ~16-18 ms on an M4 (~0.6 ms of IPC per sensor), so a native worker thread (`ThermalSampler`) performs the reads. `getDieTemperature(maxAgeMs)` returns the latest reading in ~2 µs and wakes the worker when the reading is older than `maxAgeMs`; the extension host thread never waits for the sensors after the first reading.

### 4. Memory & Virtual Memory Subsystem
- **Linux (`/proc/meminfo`)**: Single-pass line scan extracting `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`.
- **Darwin (Mach 64-bit VM)**: Invokes `host_statistics64(HOST_VM_INFO64)` and `sysctl vm.swapusage`. Computes actively consumed RAM (`active + wired + compressed`) and available RAM (`inactive + free`), accurately capturing macOS memory compression dynamics.
  - **Memory pressure**: `100 - kern.memorystatus_level` as a percentage, and `kern.memorystatus_vm_pressure_level` (1 Normal, 2 Warning, 4 Critical) as the label, the same signals Activity Monitor uses. `vm.memory_pressure` is not a percentage and is no longer read.

### 5. Battery Telemetry & State Discovery
- **Linux**: Scans `/sys/class/power_supply/BAT*` for charge percentage, AC state, `charge_full_design`/`energy_full_design`, and `cycle_count`.
- **Darwin (`IOPowerSources` & `AppleSmartBattery`)**:
  - `IOPowerSources` on every battery sample: percentage, charging state, time remaining (the internal battery is preferred over UPS devices).
  - `AppleSmartBattery` registry snapshot at most every 30 s (capacities change slowly). Recent macOS releases publish the mAh values only inside the `BatteryData` sub-dictionary (`DesignCapacity`, `NominalChargeCapacity`, `FullChargeCapacity`, `RemainingCapacity`), while the top-level `MaxCapacity` / `CurrentCapacity` are percentages; older releases expose `AppleRawMaxCapacity` / `AppleRawCurrentCapacity`, still used when present. `CycleCount` is read from either level.
  - **Nominal vs Design**: $\min(100, \frac{\text{NominalChargeCapacity}}{\text{DesignCapacity}} \times 100)$ (falls back to the full-charge capacity). macOS "Maximum Capacity" uses an internal calculation that apps cannot read, so the tooltip does not call this figure "Battery Health".
- **Desktop Auto-Disable**: On desktop workstations without battery hardware, the provider permanently disables itself at startup with zero subsequent runtime overhead.
- **Status Bar Iconography**: Dynamic iconography displaying `$(zap) %` when charging, `🔋 %` when discharging, and `$(plug) %` when connected to AC power at full capacity.

### 6. Storage & Multi-Disk Architecture
- Uses non-blocking asynchronous `statfs()` targeting active workspaces or user-configured mount points.
- **Multi-Disk Display Modes (`resmon.disk.multiDisplay`)**:
  - `'All'`: Displays compact percentages for all monitored filesystems on the status bar (e.g. `/ 24% | /data 55%`).
  - `'MostFull'`: Displays only the single filesystem with highest capacity utilization.
  - Quick-toggle via command `resmon.toggleDiskMultiDisplay`.
- **Smart Path Truncation (`truncatePath`)**: Intelligently truncates path strings by preserving directory boundaries and leaf folder names (e.g. `.../kind-newton` or `.../antigravity/kind-newton`) instead of blind character slicing, ensuring clear visual identification.

---

## Multi-Rate Polling

High-frequency telemetry (e.g. 200 ms) is valuable for observing short CPU load spikes, but harmful if applied uniformly to slow-moving or IPC-bound subsystems. The extension uses one clock and per-section, time-based intervals:

```
                  ┌───────────────────────────────────────────────┐
                  │ Status bar tick (resmon.updatefrequencyms,    │
                  │ 200 ms - 15 s)                                │
                  └───────────────────────┬───────────────────────┘
                                          │
                 ┌────────────────────────┴────────────────────────┐
                 ▼                                                 ▼
         [Every tick]                                   [Per-section interval]
       - CPU ticks, load / frequency                    resmon.refreshMs.<section>
       - Memory                                         elapsed since last sample?
       - Status bar text                                          │
       - Live tooltips                              Yes ──────────┴────────── No
                                                     │                        │
                                                     ▼                        ▼
                                            - Battery (IOPowerSources)   Reuse cached values
                                            - Disk (statfs)
                                            - Temperature (sampler age)
                                            - Static tooltips (auto-refresh)
```

- **Intervals** (`resmon.refreshMs`, 200 ms to 1 h, defaults 5 s; battery and disk 10 s) are measured in time, not in ticks, with a tolerance of half a tick so an interval equal to the tick fires on every tick. Intervals shorter than the tick run once per tick.
- **Floors**: temperature at least 2000 ms (a sampler pass costs ~16 ms of a background thread); battery and disk at least 2000 ms unless `resmon.allowFastBatteryDiskRefresh` is enabled, since every battery read is an XPC round trip to `powerd` and every disk read a `statfs` call.
- **Hidden widgets** are not sampled. A failed read is retried at its interval, not on every tick.
- **Manual refresh** (`resmon.refresh` or a click on any widget) samples every visible subsystem, rebuilds all tooltips and restarts the timer.
- **Configuration changes** are debounced (100 ms), so dragging a slider in the settings panel does not recreate the widgets on every step.

---

## UI Lifecycle & Hover Stabilization

In VS Code (Electron/Chromium), mutating properties on a `vscode.StatusBarItem` sends IPC messages that invalidate the renderer DOM node. Unconditional reassignments or redundant `item.show()` invocations destroy active `HoverWidget` popups, causing noticeable flickering or sudden closing while hovering.

Resource Monitor NG enforces two UI stability invariants:

1. **Content Diffing**:
   - `item.text` is written only if `item.text !== nextText`.
   - `item.tooltip` is written only if `(item.tooltip as vscode.MarkdownString)?.value !== nextMarkdown`.
2. **Idempotent Show/Hide**:
   - `item.show()` is invoked strictly upon creation or when transitioning from hidden to visible. It is never called unconditionally during regular polling ticks.
3. **Fixed-Width Figure Space (`\u2007`)**:
   - Numeric percentages and values are padded with Unicode Figure Space (U+2007), which has the exact width of a digit in tabular numbers. This completely prevents horizontal status bar jitter as values fluctuate between single, double, and triple digits.
4. **Dual Tooltip Modes (`Static` vs `Live`)**:
   - VS Code exposes no hover event, so tooltips are rebuilt ahead of time and a hover shows the last version.
   - **`Static` (Default)**: tooltips are rebuilt on click and, with `resmon.tooltip.autoRefresh` (default on), at each section interval, so they change rarely while the status bar text keeps streaming.
   - **`Live`**: tooltips are rebuilt on every status bar tick.
   - Every tooltip ends with its update time (tenths of a second when the tick is below 1000 ms) and links to *Settings* and *Refresh*.
   - Switchable via `resmon.toggleTooltipMode` / `resmon.toggleTooltipAutoRefresh` or from the gear widget's tooltip.
5. **Unified Monospace ASCII Table Engine (`renderDynamicAsciiTable`)**:
   - Standard GitHub-Flavored Markdown tables rendered in VS Code hover popups rely on proportional system fonts and browser table layout algorithms, frequently causing misaligned columns, awkward line wraps, or excessive horizontal expansion.
   - Resource Monitor NG replaces all HTML/Markdown tables with a 100% deterministic ASCII box-drawing engine (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) rendered inside fenced `text` blocks.
   - Dynamically calculates maximum column widths, enforces numeric right-alignment and textual left-alignment, and ensures pixel-perfect column alignment across all VS Code themes.
   - Standardized across all 6 subsystems: CPU per-core breakdown, System Load / Frequency, Thermal die matrix, Memory & Swap breakdown, Storage filesystems, and Battery health & capacity.
6. **Settings Widget & Panel**:
   - The gear widget shows the current options with one-click toggles; clicking it opens a webview panel (`src/settings/`) with preset sliders, millisecond fields, section visibility, drag-and-drop order (`resmon.order`, mapped to status bar priorities) and units.
   - The panel is only a front-end: messages are validated against a whitelist (`EDITABLE_SETTINGS`) and written to the user settings, which remain the single source of truth. Values the user did not touch are never rewritten.
   - Strict Content Security Policy with a per-load nonce; rows are updated in place so a configuration change never interrupts typing or dragging.
7. **Deterministic Tooltip Footer Formatting**:
   - In VS Code hover tooltips (Chromium CommonMark implementation), single line breaks within paragraphs are collapsed into a continuous single line, causing wide tooltips when command links are placed on successive lines.
   - Footers are strictly formatted as Markdown lists (`- **Field**: [Action](command:...)`), guaranteeing clean vertical line separation and preserving compact tooltip widths.
8. **Modern Activation Lifecycle (`onStartupFinished`)**:
   - Replaced legacy global wildcard (`"*"`) activation with `"onStartupFinished"`.
   - Prevents the extension from contending with critical VS Code startup tasks (language server initialization, workspace scanning), achieving zero impact on editor launch time.

---

## Benchmarks & Runtime Footprint

| Metric | Legacy (`systeminformation`) | Resource Monitor NG (Linux) | Resource Monitor NG (Darwin Apple Silicon) |
| :--- | :--- | :--- | :--- |
| **Subprocesses spawned / tick** | 3 to 6 (`df`, `ps`, `free`) | **0** | **0** |
| **Telemetry mechanism** | Shell commands | `/proc` & `/sys` VFS | Mach / IOKit / IOHID Node-API |
| **Execution time / tick** | 60 – 120 ms | **< 0.1 ms** | **< 0.15 ms** (temperature from the background sampler: ~2 µs) |
| **Extension Host CPU usage** | ~1.5% – 3.0% | **< 0.05%** | **< 0.05%** |
| **Runtime dependencies** | Multi-MB `node_modules` | **Zero** | **Zero** |
| **Production bundle size** | ~1.2 MB | **~66 KB** (JS bundle, incl. settings panel) | **~66 KB** JS + native `.node` |

