# Architectural Specification & Performance Design

## Overview

> The reasons behind these designs, with the measurements and rejected alternatives, are in the ADRs: [`docs/adr/`](adr/README.md).

**MiraBar** is an ultra-lightweight, cross-platform (Linux & macOS Apple Silicon) extension for VS Code and Antigravity-IDE designed to replace legacy system monitoring extensions that rely on heavy subprocess spawning (e.g. `systeminformation` spawning `ps`, `df`, `free`, or `powermetrics`).

## Zero Subprocess Dual-Platform Architecture

Traditional Node.js system monitor extensions execute shell subprocesses every 1–2 seconds. On Linux and macOS, this causes constant process forks, context switches, thread pool starvation, and prevents CPU cores from entering deeper C-states (increasing power consumption and battery drain).

MiraBar enforces a strict **Zero-Subprocess Invariant** on all supported platforms:
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
- **Linux**: Reads `/proc/stat` delta counters across logical cores. Handles `iowait` as idle to avoid false I/O spikes. The constructor primes the counters (as on Darwin), so the first read already has the core count and, after ~50 ms, a real delta; reads closer than 5 jiffies per core return the previous result and keep the baseline.
- **Darwin (Apple Silicon)**: Calls `host_processor_info(PROCESSOR_CPU_LOAD_INFO)` via Mach host APIs to retrieve user, system, idle, and nice ticks per core.
  - **Cold-Start Pre-Sampling (Tick 0)**: Pre-samples CPU ticks during provider instantiation so that the first hover immediately displays valid per-core metrics rather than waiting for an arbitrary polling cycle.
  - **Asymmetric Topology**: Discovers Performance (P) and Efficiency (E) core clusters via `sysctlbyname("hw.perflevel0.logicalcpu")` and `sysctlbyname("hw.perflevel1.logicalcpu")`.

### 2. Clock Frequencies & System Load
- **Linux**: Dynamically discovers `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`, gracefully skipping parked/offline cores (`ENOENT`).
- **Darwin (Apple Silicon - System Load Average)**: Hardware frequency scaling on Apple Silicon is handled autonomously by Apple power firmware and not accessible to unprivileged userspace. MiraBar maps this slot to **Normalized System Load Average**:
  $$\text{Normalized Load \%} = \frac{\text{Load}_{1\text{m}}}{\text{Total Hardware Cores}} \times 100$$
  Toggleable between normalized percentage (`34.4% L`) and POSIX queue depth (`3.44 L`).

### 3. Hardware Thermal Discovery
- **Linux (`/sys/class/hwmon/`)**: One-time startup heuristic scanning AMD `k10temp`/`zenpower`, Intel `coretemp`, and ACPI thermal zones; the CPU limit is the kernel trip point (`temp*_crit`, else `temp*_max`, or the thermal zone `critical` trip), 100 °C when none is exposed.
  - **Components** (`src/platform/linux/components.ts`): NVMe drives (`nvme`), memory modules (`spd5118`, `jc42`), wireless adapters and batteries (`power_supply/BAT*/temp`), with their `temp1_max` / `temp1_crit` limits, found by a scan every 60 s. Their reads go through the device (NVMe up to ~41 ms, DIMM ~1.5 ms over I2C, Wi-Fi ~2 ms), so they run asynchronously, one at a time, with at most one pass in flight ([ADR-0016](adr/0016-linux-component-temperatures-async.md)).
  - **Sleeping devices** (`mirabar.temperature.componentSensors`): in the default `awake` mode, a sensor is read only when no `power/runtime_status` of its device chain (recorded at scan: the PCI function and port for NVMe and Wi-Fi, the SMBus/I2C controller for DIMMs) reads `suspended` / `suspending`; otherwise its row shows *asleep*. The check is a synchronous sysfs attribute read (~25 µs per file, no device access). `always` reads every sensor; `off` skips the scan and the reads (CPU row only). Applied live through the optional `setComponentSensors` provider method (no-op on macOS).
- **Darwin Apple Silicon (`IOHIDEventSystemClient`)**: Unprivileged kernel HID event tap matching `PrimaryUsagePage = 0xff00` and `PrimaryUsage = 0x5`. Samples 24 on-die SoC sensors (reporting both average and peak die temperatures), NAND SSD controller temperature, and battery cell temperature without root permissions.
  - **Background sampler**: one pass costs ~16-18 ms on an M4 (~0.6 ms of IPC per sensor), so a native worker thread (`ThermalSampler`) performs the reads. `getDieTemperature(maxAgeMs)` returns the latest reading in ~2 µs and wakes the worker when the reading is older than `maxAgeMs`; the extension host thread never waits for the sensors after the first reading. Each reading carries `sampleSeq` (changes with every pass), `ageMs`, and the cost of its pass (`passWallMs`, `passCpuMs`).

### 4. Memory & Virtual Memory Subsystem
- **Linux (`/proc/meminfo`)**: Single-pass line scan extracting `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`.
- **Darwin (Mach 64-bit VM)**: Invokes `host_statistics64(HOST_VM_INFO64)` and `sysctl vm.swapusage`. Computes actively consumed RAM (`active + wired + compressed`) and available RAM (`inactive + free`), accurately capturing macOS memory compression dynamics.
  - **Memory pressure**: `100 - kern.memorystatus_level` as a percentage, and `kern.memorystatus_vm_pressure_level` (1 Normal, 2 Warning, 4 Critical) as the label, the same signals Activity Monitor uses. `vm.memory_pressure` is not a percentage and is no longer read.

### 5. Battery Telemetry & State Discovery
- **Linux**: Scans `/sys/class/power_supply/BAT*` once for the files each battery exposes, then reads only those: charge percentage, `status`, `charge_full_design`/`energy_full_design`, and `cycle_count`.
  - **State**: the kernel `status` string (`Charging`, `Discharging`, `Not charging`, `Full`, `Unknown`); with several batteries the first of Charging, Discharging, Not charging, Full wins.
  - **Time remaining** (`Charging` and `Discharging` only): the driver's `time_to_empty_now` / `time_to_full_now` (seconds, single battery), else `energy_now` (or `energy_full - energy_now` when charging) over `power_now`, else the same with `charge_*` over `current_now` (absolute value: some drivers sign it), summed over batteries. Estimates above 48 h are discarded; discharging without an estimate (rate 0 or missing, e.g. right after unplugging) reports -1, shown as "Estimating..." as on macOS. `power_now` / `current_now` are refreshed by most drivers every few seconds.
- **Darwin (`IOPowerSources` & `AppleSmartBattery`)**:
  - `IOPowerSources` on every battery sample: percentage, charging state, time remaining (the internal battery is preferred over UPS devices).
  - `AppleSmartBattery` registry snapshot at most every 30 s (capacities change slowly). Recent macOS releases publish the mAh values only inside the `BatteryData` sub-dictionary (`DesignCapacity`, `NominalChargeCapacity`, `FullChargeCapacity`, `RemainingCapacity`), while the top-level `MaxCapacity` / `CurrentCapacity` are percentages; older releases expose `AppleRawMaxCapacity` / `AppleRawCurrentCapacity`, still used when present. `CycleCount` is read from either level.
  - **Nominal vs Design**: $\min(100, \frac{\text{NominalChargeCapacity}}{\text{DesignCapacity}} \times 100)$ (falls back to the full-charge capacity). macOS "Maximum Capacity" uses an internal calculation that apps cannot read, so the tooltip does not call this figure "Battery Health".
- **Desktop Auto-Disable**: On desktop workstations without battery hardware, the provider permanently disables itself at startup with zero subsequent runtime overhead.
- **Status Bar Iconography**: Dynamic iconography displaying `$(zap) %` when charging, `🔋 %` when discharging, and `$(plug) %` when connected to AC power at full capacity.

### 6. Storage & Multi-Disk Architecture
- Uses non-blocking asynchronous `statfs()` targeting active workspaces or user-configured mount points.
- **Multi-Disk Display Modes (`mirabar.disk.multiDisplay`)**:
  - `'All'`: Displays compact percentages for all monitored filesystems on the status bar (e.g. `/ 24% | /data 55%`).
  - `'MostFull'`: Displays only the single filesystem with highest capacity utilization.
  - Quick-toggle via command `mirabar.toggleDiskMultiDisplay`.
- **Smart Path Truncation (`truncatePath`)**: Intelligently truncates path strings by preserving directory boundaries and leaf folder names (e.g. `.../kind-newton` or `.../antigravity/kind-newton`) instead of blind character slicing, ensuring clear visual identification.

---

## Refresh Model

Every section has two intervals, set per section in the settings panel or in `settings.json`:

| Setting | What it controls | Applies to | Range |
| :--- | :--- | :--- | :--- |
| `mirabar.statusBarMs` | How often the section **reads its data** and updates its status bar text | Both tooltip modes; Live tooltips follow it | 200 ms to 1 h, never below the section's measured minimum |
| `mirabar.tooltipMs` | How often the section's **tooltip is rebuilt** from the latest reading | Static mode with `mirabar.tooltip.autoRefresh` on | 200 ms to 1 h, never below the section's status bar interval |
| `mirabar.allowFastRefresh` | Lowers every measured minimum to 200 ms | `mirabar.statusBarMs` only | on / off (default off) |

- **Reads happen only at the status bar interval.** A tooltip never triggers a read: it shows the latest reading, so a tooltip interval shorter than the status bar interval changes nothing and applies as the status bar interval (the panel says so under the value).
- **Live** rebuilds a tooltip with every read of its section (temperature only when the sensors produced a new reading). **Static** rebuilds it on click and, with auto-refresh, at the read closest to its tooltip interval. With auto-refresh off, Static tooltips change only on click.
- **Every tooltip shows the time of the reading it displays** (tenths of a second when the section's status bar interval is below 1000 ms). For temperature this is the time of the sensor pass, which can precede the read.
- **A click** on any widget (or *MiraBar: Refresh Stats*) reads every visible section and rebuilds every tooltip.

### Scheduler

There is no global tick. `ResourceMonitor` (`src/monitor.ts`) keeps, per section, the time of its last read and arms **one timer at the earliest deadline** among the visible sections. At each wake-up it reads the sections that are due; sections due within 25 ms of the wake-up are read in it, so close deadlines share one wake-up. Hidden sections are never read, and with every section hidden no timer runs at all.

```
 time ──────────────────────────────────────────────────────────────────►
 cpu   (2 s)   ●───────────●───────────●───────────●───────────●
 mem   (2 s)   ●───────────●───────────●───────────●───────────●
 temp  (5 s)   ●──────────────────────────────○●────────────────
 disk (10 s)   ●··········(statfs off the event loop turn)·······
 timer         ▲           ▲           ▲      ▲▲   ▲           ▲
               one wake-up per distinct deadline (○ = temperature pass requested ahead)
```

- **Temperature (macOS)**: a sensor pass takes ~16-18 ms on the native worker thread, so the monitor asks for it 100 ms before the read (`requestTempRefresh`); the read then shows a reading taken just before it, without waiting and with one pass per interval.
- **Temperature (Linux)**: the CPU sensor is read at the read (~36 µs); `requestTempRefresh` starts the asynchronous pass over the component sensors 100 ms before it (none with `mirabar.temperature.componentSensors` set to `off`), and the read merges the latest completed pass.
- **Disk**: `statfs` is started without awaiting it and the widget is rendered when the result arrives. A call hung on a dead network mount leaves the other sections running; no new request for the same paths starts until it returns, a change of `mirabar.disk.drives` starts one at once and drops the stale result, and at most two requests are in flight (each hung `statfs` holds one of the 4 libuv pool threads shared by the extension host).
- **Configuration changes** are debounced (100 ms), so dragging a slider in the settings panel applies once.

### Refresh Floors

The measured minimums (`MEASURED_MIN_STATUS_BAR_MS` in `src/config.ts`, one set per platform) follow one rule:

> The minimum status bar interval of a section is the interval at which **its reads alone would use the whole project budget**: 0.5% of one core (docs/ROADMAP.md). The default intervals keep the whole extension within that budget.

$$\text{minimum}_s = \max\left(200\ \text{ms},\ \frac{\text{source CPU per read}_s + \text{extension CPU per read}_s}{0.005}\right)$$

The budget is not split six ways because the costs are very uneven: temperature costs about 90 times more per read than any other section, so an equal split would push its minimum to ~50 s while leaving the others' shares unused. With the whole budget as the cap, no single section can exceed it, and the defaults (temperature 10 s, the others 2-10 s) add up to less than the budget.

- *Source CPU per read* counts the whole machine: the calling thread plus the system services that answer the request (on macOS powerd for the battery, the HID event server for temperature; on Linux the kernel). `test/bench-darwin.mjs` and `test/bench-linux.mjs` measure it from host CPU ticks (busy ticks while reading in a loop, minus the idle baseline); for temperature it includes the background pass over the sensors.
- *Extension CPU per read* is the extension host's work for one read: waking up, sampling through the provider, rendering the text and, in the worst case (Live mode), the tooltip. `test/bench-extension.mjs` measures it with one section visible at a time.
- The result is rounded up to the next 100 ms. The renderer-side cost of a status bar update in VS Code is not included (it cannot be measured outside VS Code).
- The minimums are per platform, because the sources are different (`measuredMinimums()` in `src/config.ts`). A platform not measured yet (Windows) takes the higher of the measured values, section by section. The settings panel, the gear tooltip and the setting descriptions show the minimums of the host platform.

#### macOS

Measured on an Apple M4 (macOS, Node 24), 30 September 2026:

| Section | Source | Source CPU per read | Extension CPU per read | Exact | Minimum | Default | Source refresh |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | :--- |
| CPU usage | `host_processor_info` | 8.0 µs | 440 µs | 90 ms | 200 ms | 2 s | continuous |
| System load | `os.loadavg` | 0.5 µs | 449 µs | 90 ms | 200 ms | 2 s | kernel, every 5 s |
| Temperature | 26 HID sensors, one pass | 40.4 ms | 1.1 ms | 8314 ms | **8400 ms** | 10 s | changes on every pass |
| Memory | `host_statistics64` + sysctls | 8.6 µs | 466 µs | 95 ms | 200 ms | 2 s | continuous |
| Battery | `IOPowerSources` (60 µs waiting on powerd) | 20.1 µs | 442 µs | 92 ms | 200 ms | 10 s | driver every 60 s |
| Disk | `statfs` | 10.8 µs | 342 µs | 71 ms | 200 ms | 10 s | continuous |

- **Temperature is the only expensive source.** One pass keeps our worker thread busy for only ~1 ms (19 ms of wall time, mostly waiting for IPC), but costs 40.4 ms of CPU across the system: the HID event server works for each of the 26 sensors. The extension host adds 1.1 ms per read (2.1 ms measured, minus the worker's 1 ms already in the system figure). The previous default of 5 s cost ~0.8% of one core, more than the whole budget; at the 10 s default it costs ~0.42%.
- **Extension CPU per read** is measured with one section alone, so it includes a whole wake-up of the scheduler; with all six sections sharing wake-ups it drops to ~0.14 ms per read (measured: 14 ms/s for 30 reads/s at 200 ms, temperature excluded). The minimums use the larger, single-section figure.
- **Battery**: the driver publishes new capacity, cycle and charge data every 60 s (`UpdateTime`), so a faster interval only catches power adapter changes sooner. The 10 s default shows a plug or unplug within 10 s.
- **Cost at the defaults**: 0.49% of one core with all six sections shown (0.42% temperature, 0.07% the other five together), within the 0.5% budget; disk is hidden by default. The renderer-side cost of status bar updates in VS Code comes on top and cannot be measured outside VS Code.

The same bench measures how often the sources refresh (temperature sensors, battery driver `UpdateTime`): reading faster than that only returns the same values, so the defaults are set at or above those periods. `mirabar.allowFastRefresh` lowers every minimum to 200 ms; values set below a minimum are kept in the settings and apply whenever it is on.

#### Linux

Measured on an AMD Ryzen 7 7840U laptop (16 threads; `k10temp`, NVMe, two `spd5118` DIMM sensors, `mt7921` Wi-Fi, ACPI battery `BAT1`, `amd-pstate-epp` cpufreq; Arch Linux, kernel 7.2, Node 24), 3 October 2026, at the machine's usual load (desktop session, load average 1.1-2.0). Three runs of `bench:linux` and two of `bench:extension`; ranges are across the runs, and each minimum comes from the run with the highest cost:

| Section | Source | Thread, per read (median / p95 at 200 ms) | Source CPU per read | Extension CPU per read | Exact | Minimum | Default |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| CPU usage | `/proc/stat` | 119-131 / 149-153 µs | 138-144 µs | 252-272 µs | 78-83 ms | 200 ms | 2 s |
| CPU frequency | 16 × `cpufreq/scaling_cur_freq` | 202-208 / 238-256 µs | 228-245 µs | 408-437 µs | 128-136 ms | 200 ms | 2 s |
| Temperature | CPU `hwmon` (sync) + component pass (async) | 22-27 / 27-32 µs | 0.03 + 1.1-1.7 ms | 0.44-0.87 ms | 321-505 ms | **600 ms** | 10 s |
| Memory | `/proc/meminfo` | 26 / 29-39 µs | 28 µs | 171-203 µs | 40-46 ms | 200 ms | 2 s |
| Battery | `power_supply/BAT1` (ACPI) | 86-87 / 304-311 µs | 262-289 µs | 282-285 µs | 109-115 ms | 200 ms | 10 s |
| Disk | `statfs` (async) | off the thread | 82-83 µs | 185-212 µs | 53-59 ms | 200 ms | 10 s |

- **Source CPU is process CPU**, the largest of three regimes: reads back to back, every 200 ms and every 2 s (kernel caches expired, slower clock between reads). It holds the kernel's work inside our syscalls (65-90% of it: generating `/proc/stat`, the cpufreq reads, the ACPI battery method, the I2C and NVMe commands of the component pass). The system-wide figure from `/proc/stat` agrees with it within ±2-20 µs per synchronous read: on Linux the work happens in the calling thread's syscall, with no server process answering elsewhere.
- **Load matters**: a first series on the same laptop with a file indexer running (load average 1.7-5.9) gave costs two to three times higher, and minimums of 900 ms for temperature, 400 ms for CPU frequency and 300 ms for the battery. The minimums use the usual load, as on macOS; on a busy machine a section at its minimum can cost up to about three times its share of the budget.
- **Temperature** is a CPU sensor read on the extension host thread (~9 µs back to back, ~27 µs at 200 ms) plus the component pass (ADR-0016): four files read one after the other on the libuv pool, 6-7 ms of wall time back to back and 9-21 ms every 2 s (NVMe 0.6-0.7 ms, each DIMM 1.7-2.0 ms over I2C, Wi-Fi 1.7-2.3 ms through the firmware; up to 41-72 ms when the SSD leaves a low power state). That wall time is mostly the devices working, not CPU, so it does not count against the CPU budget. The pass costs 0.9-1.0 ms of CPU back to back and 1.1-1.7 ms every 2 s. `bench:extension` measures the pass inside the extension host process, so the pass is subtracted from the extension figure and counted once, in the source figure. Total: up to 2.5 ms per read, 600 ms minimum. The 10 s default stays: the pass sends a command to the SSD at every read and can wake it from a low power state, so a short interval costs energy beyond the CPU figure.
- **Rescan**: every 60 s the component sensors are found again (hwmon and power_supply, limits): 6.7-8.8 ms of CPU and 44-123 ms of wall time, ~0.015% of one core, whatever the interval. It is not per read and does not change the minimum.
- **CPU frequency** reads one file per core: 16 reads, each one handled by the cpufreq driver. **Battery**: the ACPI battery driver caches its readings for 1 s (`battery.cache_time`), after which a read runs the ACPI method through the embedded controller (~0.3 ms instead of ~0.05 ms). At 200 ms one read in five does that, and at the defaults every read does.
- **Thread latency (issue #5, 250 µs target at 200 ms polling)**: CPU usage, memory, CPU temperature and load stay below it (p95 ≤ 153 µs); CPU frequency is at the limit (p95 238-256 µs); the battery exceeds it once the ACPI cache has expired (p95 304-311 µs). Every 2 s, with cold kernel caches, CPU frequency (p95 401-421 µs) and the battery (359-395 µs) exceed it. Disk and the component sensors never block the thread.
- **V8 heap**: bytes allocated per read are 15 KB for `/proc/stat`, 3-5 KB for cpufreq, memory and disk, 1.3 KB for the battery, 0.3 KB for the CPU sensor and 46 KB per component pass. With every source read every 200 ms: 33 KB per tick, 10 scavenges per minute, 1.1-1.3 ms of GC pause per minute (0.002% of one core), heap between 6.1 and 6.9 MB, 41 KB retained after a full GC (code compiled once for the read paths, not growth). Every 2 s with the component pass: 1.5 scavenges per minute, 0.2-0.25 ms of GC pause per minute. In the extension, `test:extension` measures ~60 KB of heap growth over 15 s with every section at 200 ms Live.
- **Cost at the defaults**: 0.05% of one core measured by `bench:extension` with all six sections shown, 0.10-0.11% estimated by `bench:linux` from the per-read costs (rescan included); a fifth of the macOS figure or less.

---

## UI Lifecycle & Hover Stabilization

In VS Code (Electron/Chromium), mutating properties on a `vscode.StatusBarItem` sends IPC messages that invalidate the renderer DOM node. Unconditional reassignments or redundant `item.show()` invocations destroy active `HoverWidget` popups, causing noticeable flickering or sudden closing while hovering.

MiraBar enforces two UI stability invariants:

1. **Content Diffing**:
   - `item.text` is written only if `item.text !== nextText`.
   - `item.tooltip` is written only if `(item.tooltip as vscode.MarkdownString)?.value !== nextMarkdown`.
2. **Idempotent Show/Hide**:
   - `item.show()` is invoked strictly upon creation or when transitioning from hidden to visible. It is never called unconditionally during regular polling ticks.
3. **Fixed-Width Figure Space (`\u2007`)**:
   - Numeric percentages and values are padded with Unicode Figure Space (U+2007), which has the exact width of a digit in tabular numbers. This completely prevents horizontal status bar jitter as values fluctuate between single, double, and triple digits.
4. **Dual Tooltip Modes (`Static` vs `Live`)**:
   - VS Code exposes no hover event, so tooltips are rebuilt ahead of time and a hover shows the last version.
   - **`Static` (Default)**: tooltips are rebuilt on click and, with `mirabar.tooltip.autoRefresh` (default on), every `mirabar.tooltipMs` of their section, so they change rarely while the status bar text keeps updating.
   - **`Live`**: tooltips are rebuilt with every read of their section (`mirabar.statusBarMs`).
   - Every tooltip ends with the time of its reading (tenths of a second below 1000 ms) and links to *Settings* and *Refresh* (see "Refresh Model").
   - Switchable via `mirabar.toggleTooltipMode` / `mirabar.toggleTooltipAutoRefresh` or from the gear widget's tooltip.
5. **Unified Monospace ASCII Table Engine (`renderDynamicAsciiTable`)**:
   - Standard GitHub-Flavored Markdown tables rendered in VS Code hover popups rely on proportional system fonts and browser table layout algorithms, frequently causing misaligned columns, awkward line wraps, or excessive horizontal expansion.
   - MiraBar replaces all HTML/Markdown tables with a 100% deterministic ASCII box-drawing engine (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) rendered inside fenced `text` blocks.
   - Dynamically calculates maximum column widths, enforces numeric right-alignment and textual left-alignment, and ensures pixel-perfect column alignment across all VS Code themes.
   - Standardized across all 6 subsystems: CPU per-core breakdown, System Load / Frequency, Thermal die matrix, Memory & Swap breakdown, Storage filesystems, and Battery health & capacity.
6. **Settings Widget & Panel**:
   - The gear widget's tooltip holds two tables: the sections in status bar order (shown, status bar and tooltip intervals in effect, `*` where a value was raised to its measured minimum, "with bar" where the tooltip follows the status bar) and the display options with one-click toggles (a Markdown table, since command links cannot live in a code block). Clicking the gear opens a webview panel (`src/settings/`): per section a status bar interval (preset slider plus millisecond field) and a tooltip interval, with a note under a value when what applies differs from what is set; visibility, drag-and-drop order (`mirabar.order`, mapped to status bar priorities), units and disk options.
   - The panel is only a front-end: messages are validated against a whitelist (`EDITABLE_SETTINGS`) and written to the user settings, which remain the single source of truth. Values the user did not touch are never rewritten.
   - Strict Content Security Policy with a per-load nonce; rows are updated in place so a configuration change never interrupts typing or dragging.
7. **Tooltip Footer**:
   - In VS Code hover tooltips (Chromium CommonMark implementation), single line breaks within paragraphs are collapsed into one line, so the footer separates the reading time and the *Settings* / *Refresh* links with a blank line.
8. **Code Layout**:
   - `src/extension.ts` wires commands and settings to VS Code; `src/monitor.ts` owns the widgets and the scheduler; `src/sections.ts` renders each section's text and tooltip from one reading (pure functions); `src/format.ts` holds the formatting helpers; `src/config.ts` reads and validates the settings.
9. **Modern Activation Lifecycle (`onStartupFinished`)**:
   - Replaced legacy global wildcard (`"*"`) activation with `"onStartupFinished"`.
   - Prevents the extension from contending with critical VS Code startup tasks (language server initialization, workspace scanning), achieving zero impact on editor launch time.

---

## Benchmarks & Runtime Footprint

| Metric | Legacy (`systeminformation`) | MiraBar (Linux) | MiraBar (Darwin Apple Silicon) |
| :--- | :--- | :--- | :--- |
| **Subprocesses spawned / tick** | 3 to 6 (`df`, `ps`, `free`) | **0** | **0** |
| **Telemetry mechanism** | Shell commands | `/proc` & `/sys` VFS | Mach / IOKit / IOHID Node-API |
| **Execution time / tick** | 60 – 120 ms | **< 0.1 ms** | **< 0.15 ms** (temperature from the background sampler: ~2 µs) |
| **Extension Host CPU usage** | ~1.5% – 3.0% | **< 0.05%** | **< 0.05%** |
| **Runtime dependencies** | Multi-MB `node_modules` | **Zero** | **Zero** |
| **Production bundle size** | ~1.2 MB | **~66 KB** (JS bundle, incl. settings panel) | **~66 KB** JS + native `.node` |

