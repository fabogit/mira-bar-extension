# Project Roadmap & Implementation Milestones

## 1. Vision & Core Architectural Principles

Resource Monitor NG is designed as an ultra-lightweight, zero-overhead hardware telemetry monitor for the Visual Studio Code Status Bar.

* **Strict SLA Budget**: Target total CPU overhead must remain strictly below **0.5% of a single core**, with instantaneous sampling latency under **1 ms**.
* **Zero Child Process Spawning**: Invocations of external shell utilities (`top`, `htop`, `df`, `vm_stat`, `wmic`, `powershell`) are strictly prohibited to prevent process creation overhead, IPC lag, and CPU spikes.
* **In-Process Telemetry**:
  * **POSIX/Darwin**: Direct Mach kernel system calls, `IOKit` framework bindings, and POSIX `statfs`.
  * **POSIX/Linux**: In-process virtual filesystem parsing (`/proc`, `/sys`) with microsecond-range I/O and zero-allocation string scanning, evaluated empirically against native C++ bindings.
  * **Win32/Windows**: Direct Win32 API bindings (PDH, `GlobalMemoryStatusEx`, `GetSystemPowerStatus`, `GetDiskFreeSpaceExW`).
* **Decoupled Platform Architecture**: Telemetry collection is isolated behind the `PlatformProvider` abstraction (`src/types.ts`), allowing the UI status bar items, configuration system, and tooltip rendering to remain platform-agnostic while presenting a modular, platform-tailored view.

---

## 2. Phase 0: Foundation & Linux Genesis (v1.0.0 – v1.0.1) [COMPLETED]

> Milestone: [**`v1.0.1 - Foundation & Linux Genesis`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/1) • **Status: Closed** (Tags: [`v1.0.0`](https://github.com/fabogit/resource-monitor_code-extension/releases/tag/v1.0.0), [`v1.0.1`](https://github.com/fabogit/resource-monitor_code-extension/releases/tag/v1.0.1))

The foundational phase established the core extension functionality, UI widgets, configuration toggles, and initial Linux telemetry engine.

- [x] [#17](https://github.com/fabogit/resource-monitor_code-extension/issues/17) **Initial Linux Telemetry Architecture**:
  - Implemented initial virtual filesystem readers for `/proc/stat` and `/proc/meminfo`.
- [x] [#18](https://github.com/fabogit/resource-monitor_code-extension/issues/18) **Hardware Thermal Detection**:
  - Prototyped hardware thermal detection across `/sys/class/hwmon` and `/sys/class/thermal`.
- [x] [#19](https://github.com/fabogit/resource-monitor_code-extension/issues/19) **Battery Telemetry**:
  - Built battery status detection via `/sys/class/power_supply`.
- [x] [#20](https://github.com/fabogit/resource-monitor_code-extension/issues/20) **Multi-Item Status Bar UI Engine**:
  - Modular status bar items for CPU Usage, CPU Frequency, CPU Temperature, RAM Usage, Battery Level, and Primary Disk Utilization.
  - Priority ordering and alignment within the VS Code Status Bar (`vscode.StatusBarAlignment.Right`).
- [x] [#21](https://github.com/fabogit/resource-monitor_code-extension/issues/21) **Interactive Command & Configuration System**:
  - Granular toggles (`resmon.show.*`) for each metric.
  - Configurable update intervals and alert thresholds.
  - Interactive commands registered in `package.json`:
    - `resmon.refresh`: Force immediate telemetry refresh.
    - `resmon.toggleTooltipMode`: Switch between Live and Static tooltips.
    - `resmon.toggleCpuLayout`: Toggle CPU per-core layout (Table vs List).
    - `resmon.toggleLoadFormat`: Toggle system load format (Percent vs Value).
    - `resmon.toggleDiskMultiDisplay`: Toggle multi-disk display (All vs Most-Full).
- [x] [#22](https://github.com/fabogit/resource-monitor_code-extension/issues/22) **Rich Markdown Tooltip Layout**:
  - ASCII visual gauge bars for RAM, Swap, and Storage capacity.
  - Tabular layout for per-core CPU breakdown.
- [x] **Production Distribution**: Initial deployment to the Visual Studio Code Marketplace.

---

## 3. Phase 1: Apple Silicon Native Overhaul & Core Refactoring (v1.1.0) [COMPLETED]

> Milestone: [**`v1.1.0 - Apple Silicon Native Overhaul & Core Refactoring`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/2) • **Status: Closed** (Commit: [`f4bd90c`](https://github.com/fabogit/resource-monitor_code-extension/commit/f4bd90c))

Phase 1 restructured the codebase into a strict modular architecture, eliminated technical debt, decoupled storage tracking, and introduced an ultra-fast C++ native addon for Darwin on Apple Silicon.

- [x] [#23](https://github.com/fabogit/resource-monitor_code-extension/issues/23) **Architectural Modernization & Cleanup**:
  - Formulated the unified `PlatformProvider` interface (`src/types.ts`).
  - Implemented dynamic runtime factory resolution (`src/platform/factory.ts`).
  - Purged 5 legacy orphaned providers (`src/providers/` v1.0.1 dead code).
- [x] [#24](https://github.com/fabogit/resource-monitor_code-extension/issues/24) **Decoupled POSIX Disk Provider (`src/disk/disk_provider.ts`)**:
  - Replaced legacy filesystem readers with Node.js `fs.promises.statfs`.
  - Completely decoupled disk telemetry from VS Code runtime APIs for cross-platform POSIX execution.
- [x] [#25](https://github.com/fabogit/resource-monitor_code-extension/issues/25) **Native C++ Mach/IOKit Addon (`darwin_telemetry.node`)**:
  - Direct Mach kernel `host_processor_info` calls for instantaneous CPU core ticks.
  - In-process Apple Silicon SMC/PMU thermal telemetry (monitoring 24 die sensors with peak detection).
  - Apple Smart Battery telemetry via IOKit (cycle count, actual capacity, design capacity, discharge rate, health %).
  - Mach virtual memory statistics (`host_statistics64`) capturing memory pressure, wired RAM, and compressed memory.
- [x] [#26](https://github.com/fabogit/resource-monitor_code-extension/issues/26) **Hardware Topology Detection**:
  - Distinguishing Performance (P-Cores) and Efficiency (E-Cores) via `sysctlbyname`.
- [x] [#27](https://github.com/fabogit/resource-monitor_code-extension/issues/27) **Normalized System Load Average**:
  - Calculated across available physical execution cores, toggleable between percentage and raw queue depth.
- [x] [#28](https://github.com/fabogit/resource-monitor_code-extension/issues/28) **In-Process SoC Thermal Telemetry**:
  - Unprivileged `IOHIDEventSystemClient` event tap sampling 24 die sensors with peak detection.
- [x] [#29](https://github.com/fabogit/resource-monitor_code-extension/issues/29) **Apple Smart Battery Telemetry**:
  - IOKit registry query extracting cycle count, actual capacity, design capacity, discharge rate, and health %.
- [x] [#30](https://github.com/fabogit/resource-monitor_code-extension/issues/30) **Mach Virtual Memory Statistics**:
  - Capturing memory pressure, wired RAM, and compressed memory dynamics.
- [x] [#31](https://github.com/fabogit/resource-monitor_code-extension/issues/31) **Toolchain & Automated Test Suite**:
  - Zero-dependency Clang compilation script (`native/darwin/compile.sh`).
  - Native Apple Silicon smoke test (`test/smoke-darwin.mjs`).
  - Cross-platform end-to-end integration test (`test/integration.ts`).
  - Linux baseline smoke test (`test/smoke-linux.ts`).
- [x] [#32](https://github.com/fabogit/resource-monitor_code-extension/issues/32) **Ecosystem & Build Modernization**:
  - Modernized engine requirements: `engines.vscode: ^1.105.0`, `engines.node: >=20.0.0`.
  - Aligned development dependencies: `@types/node: ^22.0.0`, `@types/vscode: ~1.105.0`, `@vscode/vsce: ^3.9.0`.
  - Automated targeted packaging for `darwin-arm64`.

---

## 4. Phase 1.1: Darwin Memory Safety & Native Refactor (v1.1.1) [IN PROGRESS]

> Branch: `fix/darwin-memory` (from `develop`) • **Status: In progress** • Audit: [`docs/audit-darwin-memory-2026-09.md`](audit-darwin-memory-2026-09.md)

Phase 1.1 fixes the resource leaks and per-tick overhead found in the Darwin native addon and in the extension lifecycle, and corrects the memory pressure metric. Every step is verified on Apple Silicon with `test/leak-darwin.mjs`, `lsmp`, `leaks` and an optional ASan build.

- [x] **Build & Test Baseline**:
  - `compile.sh` flags: `-mmacosx-version-min=11.0`, `NAPI_VERSION=8`, `-Wextra`, availability warnings, hidden visibility; `DEBUG=1` ASan variant.
  - Native leak & cost probe `test/leak-darwin.mjs` (µs/call, RSS growth, Mach host port refs).
- [x] **Leak Fixes**:
  - Host port acquired once and released (`mach_host_self()` send-right leak, 3 urefs per tick).
  - Polling timer can no longer be re-armed after `deactivate()`.
  - Recreated status bar items no longer accumulate in `context.subscriptions`.
- [x] **RAII Native Core**:
  - `CFRef<T>`, `IOObject`, `MachSendRight`, `VmRegion` wrappers; per-env `AddonState` with `napi_set_instance_data` finalizer.
  - Type-checked CoreFoundation getters; `napi_status` checked on every call.
- [x] **Per-Tick Overhead Reduction**:
  - Hidden widgets are not sampled.
  - Cached `IOHIDEventSystemClient` and classified thermal sensors.
  - Battery presence cached; AppleSmartBattery keys read individually instead of copying the whole registry dictionary.
  - Zero-allocation CPU ticks (`Uint32Array` double buffer, wrap-safe 32-bit deltas).
- [x] **Correctness**:
  - Memory pressure from `kern.memorystatus_level` / `kern.memorystatus_vm_pressure_level` (replaces `vm.memory_pressure`, which is not a percentage).
  - macOS 11 compatibility (`MACH_PORT_NULL` instead of `kIOMainPortDefault`).
  - Native loader no longer resolves `.node` files from `process.cwd()`.
- [x] **Thermal Sampling Off the Extension Host Thread**:
  - Measured on Apple M4: `getDieTemperature()` costs ~18 ms per call (24 tdie + NAND + battery sensors), above the 1 ms SLA.
  - Profiled with `native/darwin/tools/hid_bench.cc`: cost evenly spread (~0.6 ms per sensor IPC), no single slow sensor.
  - Native background sampler (`ThermalSampler`): `getDieTemperature()` returns the latest reading without blocking; readings at most 5 s old (~0.3% of one core).
  - Battery and disk sampled on a time basis (5 s / 10 s) instead of tick decimation; a click refreshes everything.
- [ ] **Extension Lifecycle Refactor**:
  - `ResourceMonitor` class implementing `vscode.Disposable`; `update()` split into per-widget renderers; cached configuration; throttled Live tooltips.

**Follow-ups (after the hardening work):**

- [x] **Static Tooltip Freshness**:
  - In `Static` mode tooltips are regenerated only on click/refresh, so hovering shows the values from the last refresh (or from the switch out of `Live`) while the status bar text keeps updating.
  - VS Code exposes no hover event, so tooltips cannot be computed on hover. Static regenerates tooltips on click and, with `resmon.tooltip.autoRefresh` (default on, toggle from the tooltip or the command palette), at per-section intervals from `resmon.tooltip.refreshSeconds` (default 5 s; battery and disk 10 s). Live regenerates at most once per second.
  - Every tooltip ends with the update time and the refresh hint on separate lines.
- [ ] **Configurable Widget Order**:
  - New setting (e.g. `resmon.order`: ordered list of `cpu`, `freq`/`load`, `temp`, `mem`, `battery`, `disk`) mapped to status bar priorities, applied live on configuration change; unknown or missing entries fall back to the default order.

---

## 5. Phase 2: Linux Telemetry Modernization & Parity (v1.2.0) [IN PROGRESS]

> Milestone: [**`v1.2.0 - Linux Telemetry Modernization & Parity`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/3) • **Status: Open** (Active Target)

Phase 2 focuses on bringing the Linux implementation up to the v1.1.0 architectural standard, establishing empirical performance baselines, and verifying telemetry directly on a native Linux workstation.

- [ ] [#1](https://github.com/fabogit/resource-monitor_code-extension/issues/1) **CPU Cold-Start Synchronization (Tick 0)**:
  - Pre-sample `/proc/stat` in constructor of `CpuProvider` to prime tick counters immediately.
- [ ] [#2](https://github.com/fabogit/resource-monitor_code-extension/issues/2) **CPU Frequency Monospace Table Layout**:
  - Convert Markdown bulleted core frequency list into compact monospace ASCII cluster table for `freqOrLoad.kind === 'freq'`.
- [ ] [#3](https://github.com/fabogit/resource-monitor_code-extension/issues/3) **Battery Autonomy & Time Remaining**:
  - Parse sysfs `power_now` / `current_now` and `time_to_empty_now` / `time_to_full_now` to calculate `timeRemainingMinutes`.
- [ ] [#4](https://github.com/fabogit/resource-monitor_code-extension/issues/4) **Dynamic Hardware Thermal Trip Points**:
  - Detect `temp*_crit` / `temp*_max` from `/sys/class/hwmon/` to dynamically populate `critCelsius` instead of hardcoded 100 °C.
- [ ] [#5](https://github.com/fabogit/resource-monitor_code-extension/issues/5) **Empirical Benchmarking & Scientific Evaluation**:
  - Measure execution latency of TypeScript VFS reader at 200 ms polling intervals (`performance.now()`) against the < 250 µs SLA budget.
  - Profile V8 garbage collection overhead and heap allocation stability.
- [x] [#6](https://github.com/fabogit/resource-monitor_code-extension/issues/6) **Cross-Platform Dual-Runner CI/CD**:
  - Configured `.github/workflows/release.yml` with decoupled dual-runner matrix (`macos-14` + `ubuntu-latest`), hardened least-privilege permissions, concurrency controls, and `workflow_dispatch` manual build testing.

---

## 6. Phase 3: Windows NT Architecture & Win32 Telemetry (v1.3.0) [PLANNED]

> Milestone: [**`v1.3.0 - Windows NT Architecture & Win32 Telemetry`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/4) • **Status: Open** (Future Roadmap)

Phase 3 introduces native Windows support through direct Win32 API bindings, adhering to the modular UI strategy and pragmatic hardware constraints.

- [ ] [#7](https://github.com/fabogit/resource-monitor_code-extension/issues/7) **Architectural Blueprint & Toolchain**:
  - Design `WindowsTelemetryProvider` conforming to `TelemetryPlatformProvider`.
  - Design native C++ Win32 addon (`windows_telemetry.node`) compiled via MSVC without subprocess spawning.
- [ ] [#8](https://github.com/fabogit/resource-monitor_code-extension/issues/8) **CPU Utilization**:
  - Query per-core and aggregate CPU utilization using Performance Data Helper (PDH) or `GetSystemProcessorPerformanceInformation` via `ntdll.dll`.
- [ ] [#9](https://github.com/fabogit/resource-monitor_code-extension/issues/9) **Memory Statistics**:
  - Instantaneous RAM, pagefile, and commit charge querying via `GlobalMemoryStatusEx`.
- [ ] [#10](https://github.com/fabogit/resource-monitor_code-extension/issues/10) **Battery Telemetry**:
  - AC line status, discharge state, and percentage via `GetSystemPowerStatus`.
- [ ] [#11](https://github.com/fabogit/resource-monitor_code-extension/issues/11) **Drive Storage**:
  - Enumerate active logical drives and query storage via `GetDiskFreeSpaceExW`.
- [ ] [#12](https://github.com/fabogit/resource-monitor_code-extension/issues/12) **Thermal Telemetry Pragmatic Strategy**:
  - Evaluate non-blocking fallback to `MSAcpi_ThermalZoneTemperature` (WMI) where supported by OEM BIOS.
- [ ] [#13](https://github.com/fabogit/resource-monitor_code-extension/issues/13) **Windows Packaging & Distribution**:
  - Build pipeline for `win32-x64` and `win32-arm64` with dedicated Windows integration tests.

---

## 7. Phase 4: Internationalization & Localization (v1.4.0) [NICE TO HAVE]

> Milestone: [**`v1.4.0 - Internationalization & Localization`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/5) • **Status: Open** (Backlog)

Phase 4 externalizes and translates user-facing strings once the underlying telemetry data models across Darwin, Linux, and Windows are fully consolidated.

- [ ] [#14](https://github.com/fabogit/resource-monitor_code-extension/issues/14) **Localization Infrastructure**:
  - Integrate VS Code official `vscode.l10n` API.
  - Extract all hardcoded strings from `src/extension.ts` into source bundle `l10n/bundle.core.json`.
  - Localize command titles, categories, and configuration settings in `package.nls.json`.
- [ ] [#15](https://github.com/fabogit/resource-monitor_code-extension/issues/15) **Translation Bundles**:
  - Italian (`bundle.core.it.json`), German (`bundle.core.de.json`), French (`bundle.core.fr.json`), Spanish (`bundle.core.es.json`), Japanese (`bundle.core.ja.json`), Simplified Chinese (`bundle.core.zh-cn.json`).
- [ ] [#16](https://github.com/fabogit/resource-monitor_code-extension/issues/16) **Layout Resilience**:
  - Audit Markdown tooltip tables and ASCII progress bars to prevent visual wrapping or layout misalignment caused by variable-length translated strings.
