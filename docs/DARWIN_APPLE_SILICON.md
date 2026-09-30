# Darwin & Apple Silicon (M-Series) Technical Specification & Implementation Architecture

This document formalizes the production architecture, C/Mach/IOKit kernel APIs, Clang toolchain, and verification methodology implemented for native macOS Apple Silicon (`darwin-arm64`) support in **Resource Monitor NG v1.1.x** on Apple M-Series hardware (M1, M2, M3, M4). Phase 1.1 (memory safety and native refactor) is documented in [`audit-darwin-memory-2026-09.md`](audit-darwin-memory-2026-09.md).

---

## 1. Architectural Comparison: Linux vs. Darwin (macOS)

| Subsystem | Linux Implementation | macOS / Darwin (XNU) Implementation |
| :--- | :--- | :--- |
| **Telemetry Source** | Virtual pseudo-filesystems (`/proc`, `/sys`) | C-based Kernel APIs (`Mach`, `sysctl`, `IOKit`, `IOHID`) |
| **Subprocess Cost** | Zero (pure synchronous `fs.readFileSync`) | Zero (pure synchronous Node-API C++ addon `darwin_telemetry.node`) |
| **CPU Architecture** | Uniform SMP or x86 SMT cores | Asymmetric big.LITTLE (Performance P-Cores + Efficiency E-Cores) |
| **Clock Frequencies** | `/sys/devices/system/cpu/cpu*/cpufreq/` | Normalized System Load Capacity % across hardware cores |
| **Thermal Sensors** | `/sys/class/hwmon/` | **Unprivileged `IOHIDEventSystemClient`** on a background thread: 24 SoC die sensors, NAND SSD & battery |
| **Memory Metrics** | `/proc/meminfo` (single-pass line scan) | Mach `host_statistics64(HOST_VM_INFO64)` + `sysctl vm.swapusage` + `kern.memorystatus_*` pressure |
| **Battery Metrics** | `/sys/class/power_supply/BAT*` | `IOKit.framework` (`IOPowerSources` + `AppleSmartBattery` health & cycles) |
| **Disk Space** | `node:fs/promises.statfs` | POSIX `statfs` (100% portable across Linux & Darwin) |

---

## 2. Kernel Telemetry Specifications (Darwin / XNU)

To maintain the strict **zero-subprocess** guarantee on macOS, all metrics are queried directly via C++ bindings through a standalone Node-API (N-API) addon compiled for `darwin-arm64`.

### 2.1. CPU Utilization & Core Topology
* **Framework / Header**: `<mach/mach_host.h>`, `<mach/processor_info.h>`, `<sys/sysctl.h>`
* **Topology Discovery**:
  * P-Cores: queried via `sysctlbyname("hw.perflevel0.logicalcpu", ...)`
  * E-Cores: queried via `sysctlbyname("hw.perflevel1.logicalcpu", ...)`
  * Total Cores: `sysctlbyname("hw.logicalcpu", ...)`
  * Chip Model: `sysctlbyname("machdep.cpu.brand_string", ...)` (e.g. `'Apple M4'`)
* **Mach Call**: `host_processor_info(host, PROCESSOR_CPU_LOAD_INFO, ...)` on the host port acquired once at module load (`mach_host_self()` returns a new send right on every call, so calling it per tick leaked 3 urefs per tick).
* **JavaScript API**: `getCpuTicks(out: Uint32Array): number` writes `user, system, idle, nice` for each core into a caller-owned buffer and returns the core count; nothing is allocated per tick. The provider keeps two buffers and swaps them.
* **Delta Calculation** (wrap-safe on the 32-bit counters: `(cur - prev) >>> 0`):
  $$\Delta \text{Total}_i = \Delta \text{user}_i + \Delta \text{system}_i + \Delta \text{idle}_i + \Delta \text{nice}_i$$
  $$\Delta \text{Active}_i = \Delta \text{user}_i + \Delta \text{system}_i + \Delta \text{nice}_i$$
  $$\text{Usage \%}_i = \frac{\Delta \text{Active}_i}{\Delta \text{Total}_i} \times 100$$
  Intervals with fewer than 5 ticks per core keep the previous value to avoid noise at 200 ms.
* **Deallocation**: the kernel-allocated array is owned by a `VmRegion` RAII wrapper and released with `vm_deallocate(mach_task_self(), ...)` on every path.

### 2.2. Memory & Swap Statistics
* **Physical RAM**: Queried via `sysctl({ CTL_HW, HW_MEMSIZE })`.
* **VM Page Breakdown**:
  ```c
  vm_statistics64_data_t vm_stat;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm_stat, &count);
  ```
  * **Used RAM**: `(vm_stat.active_count + vm_stat.wire_count + vm_stat.compressor_page_count) * page_size`
  * **Available RAM**: `(vm_stat.inactive_count + vm_stat.free_count) * page_size`
  * **Compressed Pages**: `vm_stat.compressor_page_count * page_size`
* **Swap Space**: Queried via `sysctlbyname("vm.swapusage", &swap, &len, NULL, 0)`.
* **Memory Pressure**: `pressurePercent = 100 - kern.memorystatus_level`; `pressureLevel = kern.memorystatus_vm_pressure_level` (1 Normal, 2 Warning, 4 Critical). `vm.memory_pressure` is a counter, not a percentage, and is not used.

### 2.3. Battery Health, Nominal Capacity & Power State
* **Framework / Headers**: `<IOKit/ps/IOPowerSources.h>`, `<IOKit/ps/IOPSKeys.h>`, `<IOKit/IOKitLib.h>`
* **State & Time Remaining**: `IOPSCopyPowerSourcesInfo` / `IOPSGetPowerSourceDescription` on every battery sample (an XPC round trip to `powerd`): percentage, charging state and minutes to empty/full. The internal battery is preferred over UPS devices.
* **Health & Capacity (Kernel Registry)**: one `IORegistryEntryCreateCFProperties` snapshot of `AppleSmartBattery` at most every 30 s. Recent macOS releases (verified on an M4) publish the mAh values only inside the `BatteryData` sub-dictionary; the top-level `MaxCapacity` / `CurrentCapacity` are percentages and must not be used:
  * `DesignCapacity`: factory design capacity (mAh).
  * `NominalChargeCapacity`: nominal full-charge capacity (mAh).
  * `FullChargeCapacity` (or `AppleRawMaxCapacity` on older releases): current full-charge capacity (mAh).
  * `RemainingCapacity` (or `AppleRawCurrentCapacity`): residual charge (mAh).
  * `CycleCount`: completed charge cycles.
  * **Nominal vs Design**:
    $$\min\left(100, \frac{\text{NominalChargeCapacity}}{\text{DesignCapacity}} \times 100\right)$$
    falling back to the full-charge capacity. macOS "Maximum Capacity" is computed internally (100% vs 99.4% on the test M4), so the tooltip does not label this figure "Battery Health".

### 2.4. Unprivileged Thermal Telemetry (`IOHIDEventSystemClient`)
* **Framework**: `IOKit.framework` (HID Event System).
* **Mechanism**: Registers an `IOHIDEventSystemClient` with matching dictionary `PrimaryUsagePage = 0xff00` (Apple vendor-defined) and `PrimaryUsage = 0x5` (Thermal sensor).
* **Zero Privileges**: Operates entirely in unprivileged userspace (no `sudo`, no `powermetrics` process spawning).
* **Metrics Read**:
  * 24 SoC die thermal sensors (SoC Die Average, SoC Die Peak).
  * NAND Flash SSD thermal sensor.
  * Battery cell temperature sensor.
* **Cost & Background Sampler**: one pass costs ~16-18 ms on an M4, evenly spread (~0.6 ms of IPC per sensor, measured with `native/darwin/tools/hid_bench.cc`). The client and the classified sensor list are cached, and a native worker thread (`ThermalSampler`) performs the passes. `getDieTemperature(maxAgeMs)` returns the latest reading in ~2 µs and wakes the worker when it is older than `maxAgeMs`; only the very first call waits for a reading. The worker is joined when the addon is unloaded.
* **Freshness**: the monitor requests the pass 100 ms before each temperature read (`requestTempRefresh`, i.e. `getDieTemperature(0)`), so the read shows a reading taken just before it. Each reading reports `sampleSeq`, `ageMs` (the tooltip shows the time of the pass) and the cost of its pass (`passWallMs`, `passCpuMs`), used by `test/bench-darwin.mjs`.

---

## 3. Production Architecture & Layout

```
resource-monitor/
├── src/
│   ├── extension.ts               # Activation, commands, settings listener
│   ├── monitor.ts                 # ResourceMonitor: widgets and per-section scheduler
│   ├── sections.ts                # Status bar text and tooltip of each section (pure renderers)
│   ├── format.ts                  # Formatting helpers (bars, ASCII tables, durations)
│   ├── config.ts                  # ResMonConfig, intervals and measured minimums, widget order
│   ├── types.ts                   # BatteryInfo, CpuUsageInfo, MemoryInfo, etc.
│   ├── settings/
│   │   ├── schema.ts              # Editable settings whitelist, validation, read/write
│   │   ├── panel.ts               # Settings webview panel (singleton)
│   │   └── panel_html.ts          # Panel markup, CSP and client script
│   ├── platform/
│   │   ├── factory.ts             # Instantiates Linux vs. Darwin providers dynamically
│   │   ├── interface.ts           # Universal TelemetryPlatformProvider interface
│   │   ├── linux/                 # Zero-subprocess /proc and /sys synchronous providers
│   │   └── darwin/                # macOS N-API Native Bridge
│   │       ├── native_loader.ts   # N-API loader (extension-relative paths only)
│   │       └── darwin_provider.ts # TelemetryPlatformProvider implementation
│   └── disk/
│       └── disk_provider.ts       # Pure POSIX statfs provider (zero VS Code coupling)
├── native/
│   └── darwin/
│       ├── compile.sh             # Direct Clang compilation script (DEBUG=1: ASan)
│       ├── binding.gyp            # node-gyp alternative with the same flags
│       ├── src/
│       │   └── addon.cc           # N-API module: RAII wrappers, thermal sampler, battery snapshot
│       └── tools/
│           └── hid_bench.cc       # Standalone thermal sensor cost benchmark
├── test/
│   ├── smoke-darwin.mjs           # Native assertions on macOS
│   ├── leak-darwin.mjs            # Native leak & cost probe (µs/call, RSS, Mach ports)
│   ├── bench-darwin.mjs           # Cost per read and refresh period of each source (refresh minimums)
│   ├── bench-extension.mjs        # Extension CPU per configuration and per section
│   ├── extension.test.mjs         # Extension behaviour outside VS Code
│   ├── harness/                   # Stand-in vscode module and bundle loader
│   ├── smoke-linux.ts             # Linux smoke test
│   └── integration.ts             # Cross-platform provider integration test
└── package.json
```

---

## 4. Native C++ Addon Build Pipeline

The native module [`native/darwin/src/addon.cc`](../native/darwin/src/addon.cc) is compiled directly with Apple Clang, avoiding heavy `node-gyp` runtime and packaging dependencies:

```bash
# Compile native darwin_telemetry.node using Clang
pnpm run compile:native
# (or bash native/darwin/compile.sh)
```

Compilation details:
* Uses Apple Clang targeting Apple Silicon `arm64`, C++17.
* Flags: `-O3 -Wall -Wextra -Wunguarded-availability-new -mmacosx-version-min=11.0 -DNAPI_VERSION=8 -fvisibility=hidden -shared -undefined dynamic_lookup`.
* `DEBUG=1` builds with `-O1 -g -fsanitize=address` for leak and memory-error testing.
* Links: `-framework CoreFoundation -framework IOKit`.
* Outputs directly to `dist/native/darwin_telemetry.node`.

---

## 5. Verification & Testing on Apple Silicon

1. **Native Telemetry Smoke Test**:
   ```bash
   pnpm run test:darwin
   ```
   Validates P/E core topology, Mach tick deltas, Mach 64-bit VM page stats, IOKit `AppleSmartBattery` health/nominal capacity, and IOHID die temperatures with strict runtime assertions.

2. **Cross-Platform Integration Test**:
   ```bash
   pnpm run test:integration
   ```
   Exercises `createPlatformProvider()` on Darwin, validating cold-start Tick 0 instantaneous sampling, system load average calculations and non-blocking `statfs` filesystem checks.

3. **Native Leak & Cost Probe**:
   ```bash
   node --expose-gc test/leak-darwin.mjs          # add --pause to inspect with lsmp / leaks
   ```
   Reports µs per call, RSS growth after warm-up and Mach host port references for every exported function. Reference results on an M4 after Phase 1.1: host port refs stable, no RSS growth, `getDieTemperature` ~2 µs (was ~18 ms).

4. **Thermal Sensor Benchmark**: `native/darwin/tools/hid_bench.cc` (build command in the file header) times each sensor read to locate the cost of a sampler pass.

5. **Refresh Minimums**:
   ```bash
   pnpm run bench:darwin      # cost per read (thread and whole system), sensor and battery refresh periods
   pnpm run bench:extension   # extension-host CPU per read, per section
   ```
   Their results set `MEASURED_MIN_STATUS_BAR_MS` in `src/config.ts` by the rule in [ARCHITECTURE.md](ARCHITECTURE.md#refresh-floors).

---

## 6. Platform-Specific VSIX Packaging

Platform-specific VSIX packages are built using VS Code's official target architecture flag:

```bash
# Package for Apple Silicon Mac (compiles and bundles darwin_telemetry.node binary):
pnpm run package:darwin-arm64
```

Output: `resource-monitor-ng-darwin-arm64-<version>.vsix`. `vscode:prepublish` rebuilds the production bundle, and `.vscodeignore` excludes local agent files (`.claude/`, `.agents/`, `skills-lock.json`).

---

## 7. UI Presentation & Tooltip Engineering

* **100% Monospace ASCII Box-Drawing Tables**:
  Replaces proportional Markdown tables with deterministic monospace tables (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) in hover popups across all 6 widgets (CPU, System Load, Thermals, Memory, Storage, Battery).
* **Cold-Start (Tick 0) Synchronization**:
  Pre-samples Mach processor ticks in the `DarwinTelemetryProvider` constructor, ensuring that hover popups display valid core percentages and hardware topologies on first hover without waiting for an interval tick.
* **Semantic Battery Iconography**:
  Dynamically maps power state to `$(zap) %` (actively charging), `🔋 %` (discharging on battery), and `$(plug) %` (connected to AC power at full capacity).
* **Tooltip Footers**:
  Every data tooltip ends with its update time and links to *Settings* and *Refresh* on separate lines; options and toggles live in the gear widget's tooltip and in the settings panel.
