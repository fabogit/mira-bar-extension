# Project Roadmap & Implementation Milestones

## 1. Vision & Core Architectural Principles

MiraBar (formerly Resource Monitor NG) is designed as an ultra-lightweight, zero-overhead hardware telemetry monitor for the Visual Studio Code Status Bar.

* **Strict SLA Budget**: Target total CPU overhead must remain strictly below **0.5% of a single core**, with instantaneous sampling latency under **1 ms**.
* **Zero Child Process Spawning**: Invocations of external shell utilities (`top`, `htop`, `df`, `vm_stat`, `wmic`, `powershell`) are strictly prohibited to prevent process creation overhead, IPC lag, and CPU spikes.
* **In-Process Telemetry**:
  * **POSIX/Darwin**: Direct Mach kernel system calls, `IOKit` framework bindings, and POSIX `statfs`.
  * **POSIX/Linux**: In-process virtual filesystem parsing (`/proc`, `/sys`) with microsecond-range I/O and zero-allocation string scanning, evaluated empirically against native C++ bindings.
  * **Win32/Windows**: Direct Win32 API bindings (PDH, `GlobalMemoryStatusEx`, `GetSystemPowerStatus`, `GetDiskFreeSpaceExW`).
* **Decoupled Platform Architecture**: Telemetry collection is isolated behind the `PlatformProvider` abstraction (`src/types.ts`), allowing the UI status bar items, configuration system, and tooltip rendering to remain platform-agnostic while presenting a modular, platform-tailored view.

* **Decisions**: the reasons behind the architecture are recorded as ADRs in [`docs/adr/`](adr/README.md).

### Status at a glance (2026-10-01)

| Phase | Platform | Status | Next step |
| :--- | :--- | :--- | :--- |
| 0 – Foundation & Linux genesis (v1.0.x) | Linux | Done, released | — |
| 1 – Apple Silicon native overhaul (v1.1.0) | macOS | Done, released | — |
| 1.1 – Darwin memory safety & native refactor (v1.2.0) | macOS (shared code) | Done, verified on an M4 | Check the shared code on Linux |
| 1.2 – Per-section refresh & measured minimums (v1.2.0) | All platforms (measured on macOS) | Done, verified on an M4 | Check on Linux; per-platform minimums |
| 1.3 – Rename to MiraBar (v1.2.0) | All | Done, merged locally | Rename the GitHub repository, release |
| 2 – Linux modernization & parity (v1.3.0) | Linux | Open | Start with the Linux check below |
| 3 – Windows (v1.4.0) | Windows | Not started | Blueprint (#7) |
| 4 – Localization (v1.5.0) | All | Backlog | — |
| Cross-platform backlog | All | Planned, unscheduled | Inactive window first (smallest change, also the base for sharing across windows) |

Phases 1.1 to 1.3 are merged into the local `develop` (`c5ebaba`, `7b4c977`, 2026-10-01) and **not pushed**: the code they changed outside `native/darwin` runs on Linux too and has only been tested there in a VM without sensors, battery or cpufreq. They ship as **1.2.0**, the first MiraBar release, after that check; release notes are in [CHANGELOG.md](../CHANGELOG.md).

The rename ([ADR-0015](adr/0015-rename-to-mirabar.md)) changed every setting and command prefix from `resmon.` to `mirabar.`. The rename release takes 1.2.0, so the later milestones move one minor up: Linux 1.3.0, Windows 1.4.0, localization 1.5.0 (the GitHub milestones keep their old titles until renamed). Phase 0 and 1 below use the current `mirabar.` keys; legacy keys removed in 1.2.0 are named without prefix.

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
  - Granular toggles (`mirabar.show.*`) for each metric.
  - Configurable update intervals and alert thresholds.
  - Interactive commands registered in `package.json`:
    - `mirabar.refresh`: Force immediate telemetry refresh.
    - `mirabar.toggleTooltipMode`: Switch between Live and Static tooltips.
    - `mirabar.toggleCpuLayout`: Toggle CPU per-core layout (Table vs List).
    - `mirabar.toggleLoadFormat`: Toggle system load format (Percent vs Value).
    - `mirabar.toggleDiskMultiDisplay`: Toggle multi-disk display (All vs Most-Full).
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

## 4. Phase 1.1: Darwin Memory Safety & Native Refactor (v1.2.0) [COMPLETED]

> Branch: `fix/darwin-memory` (from `develop`, local commits) • **Status: Done, verified in VS Code on Apple Silicon (2026-10-01)** • Audit: [`docs/audit-darwin-memory-2026-09.md`](audit-darwin-memory-2026-09.md)

Phase 1.1 fixes the resource leaks and per-tick overhead found in the Darwin native addon and in the extension lifecycle, corrects the memory pressure and battery metrics, and reworks the refresh model and settings UI. Native changes are verified on Apple Silicon with `test/leak-darwin.mjs`, `lsmp` and `leaks`, and on Linux with mocked Apple APIs under ASan/UBSan/TSan.

- [x] **Build & Test Baseline**:
  - `compile.sh` flags: `-mmacosx-version-min=11.0`, `NAPI_VERSION=8`, `-Wextra`, availability warnings, hidden visibility; `DEBUG=1` ASan variant. Same warnings in `binding.gyp`.
  - Native leak & cost probe `test/leak-darwin.mjs` (µs/call, RSS growth, Mach host port refs).
  - `pnpm run typecheck` covers `src/` and `test/` (`test/tsconfig.json`); the stale `test/smoke.mjs` (imported the removed `src/providers/`) is gone.
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
  - Battery: `IOPowerSources` on each battery sample, `AppleSmartBattery` registry snapshot at most every 30 s (on the M4 the mAh values live in the `BatteryData` sub-dictionary, so single-key reads are not enough).
  - Zero-allocation CPU ticks (`Uint32Array` double buffer, wrap-safe 32-bit deltas).
- [x] **Correctness**:
  - Memory pressure from `kern.memorystatus_level` / `kern.memorystatus_vm_pressure_level` (replaces `vm.memory_pressure`, which is not a percentage).
  - Battery capacities in mAh from `BatteryData`; "Nominal vs Design" instead of "Battery Health" (macOS "Maximum Capacity" uses an internal calculation not exposed to apps: 100% vs 99.4% on the test M4).
  - macOS 11 compatibility (`MACH_PORT_NULL` instead of `kIOMainPortDefault`).
  - Native loader no longer resolves `.node` files from `process.cwd()`.
- [x] **Thermal Sampling Off the Extension Host Thread**:
  - Measured on Apple M4: `getDieTemperature()` cost ~18 ms per call (24 tdie + NAND + battery sensors), above the 1 ms SLA.
  - Profiled with `native/darwin/tools/hid_bench.cc`: cost evenly spread (~0.6 ms per sensor IPC), no single slow sensor.
  - Native background sampler (`ThermalSampler`): `getDieTemperature(maxAgeMs)` returns the latest reading in ~2 µs and asks the worker for a new pass when it is older than requested.
- [x] **Refresh Model** (superseded by the per-section model of Phase 1.2):
  - `updatefrequencyms` (200-15000 ms, removed in 1.2.0) is the clock: status bar values every tick, Live tooltips every tick.
  - `refreshMs` per section (200 ms to 1 h, removed in 1.2.0): Static tooltip auto-refresh and sampling interval for battery, disk and temperature. Minimum 2000 ms for temperature; minimum 2000 ms for battery and disk unless `allowFastBatteryDiskRefresh` is enabled (flagged as a performance cost). Replaced the pre-release `refreshSeconds`.
  - Half-tick tolerance so an interval equal to the tick fires every tick; update time with tenths of a second below 1000 ms; a click refreshes everything.
  - Configuration changes debounced (100 ms) so slider drags do not recreate the widgets on every step.
- [x] **Final Check**:
  - Hidden CPU, load and memory widgets are no longer sampled (only temperature and battery were gated before).
  - Live tooltips of battery, disk and temperature rebuilt only when a new reading arrives (was 5 times a second at 200 ms).
  - `statfs` off the tick: a dead network mount cannot freeze the status bar; at most one pending request per set of paths, and removing the mount from `mirabar.disk.drives` recovers at once.
  - Configuration read once per change instead of twice per tick; activation generation guard for late callbacks.
  - Linux: cores without `cpufreq` skipped (no failing reads per tick), cores rescanned once a minute for hotplug.
- [x] **Settings Widget & Panel**:
  - Gear status bar widget: tooltip with the current values and quick toggles; click opens a webview settings panel (preset sliders plus millisecond fields, visibility, drag-and-drop order, units, disk options). Strict CSP with nonce; rows updated in place so external changes never interrupt typing or dragging.
  - The panel writes validated values to the user settings (single source of truth); stored values are never rewritten by unrelated edits. Data tooltips keep only metrics, update time and Settings / Refresh links.
- [x] **Configurable Widget Order**:
  - `mirabar.order` mapped to status bar priorities, applied live; unknown or duplicate entries are dropped and missing ones keep their default position.
- [x] **Verification in VS Code on Apple Silicon** (2026-10-01): VSIX installed on an M4; settings panel and Static/Live tooltips checked (the battery/disk lock it also covered was later removed by Phase 1.2).
- [x] **Extension Lifecycle Refactor**: done in Phase 1.2 below.

Decisions: ADR-0002 (RAII, addon state), ADR-0003 (thermal background thread), ADR-0004 (battery sources), ADR-0005 (memory pressure), ADR-0006 (build, macOS 11), ADR-0007 (settings panel), ADR-0008 (widget order), ADR-0011 (disk off the event loop), ADR-0013 (packaging, workflow), ADR-0014 (verification).

---

## 4b. Phase 1.2: Per-Section Refresh & Measured Minimums (v1.2.0) [COMPLETED]

> Branch: `feat/per-section-refresh` (from `fix/darwin-memory`, local commits) • **Status: Done, measured and verified in VS Code on Apple Silicon (2026-10-01)**

Each section gets its own status bar and tooltip intervals, and the minimums are derived from measured costs instead of fixed values.

- [x] **Measurement Tools**:
  - `test/bench-darwin.mjs`: cost per read of every source on the calling thread and system-wide (host CPU ticks, macOS services included), temperature pass cost and sensor refresh period, battery driver refresh period (`UpdateTime`).
  - `test/bench-extension.mjs`: extension-host CPU per configuration and per section (one section alone, Live).
  - Native temperature readings carry `sampleSeq`, `ageMs`, `passWallMs`, `passCpuMs`.
- [x] **Per-Section Intervals**:
  - `mirabar.statusBarMs` (reads and status bar text) and `mirabar.tooltipMs` (Static tooltips, never faster than the status bar); `mirabar.allowFastRefresh` lowers the minimums to 200 ms.
  - Pre-release keys were read as fallbacks and migrated by the panel, and the released `updatefrequencyms` kept working (ADR-0012); the rename to MiraBar removed all of them (ADR-0015).
- [x] **Deadline Scheduler & Lifecycle Refactor**:
  - `ResourceMonitor` (`src/monitor.ts`, `vscode.Disposable`): one timer at the earliest section deadline, no global tick, no timer when every section is hidden.
  - Renderers per section (`src/sections.ts`, pure functions) and formatting helpers (`src/format.ts`); `src/extension.ts` only wires commands and settings.
  - Temperature pass requested 100 ms before its read on macOS, so the value shown is fresh without waiting.
  - Disk requests capped at two in flight (a hung `statfs` holds a libuv pool thread); panel messages handled one at a time.
- [x] **Settings Panel**: two intervals per section with notes on what applies, measured minimums and the budget rule explained in place.
- [x] **Tests**: `test/extension.test.mjs` (schedule, tooltips, minimums, settings namespace, panel, disk isolation, lifecycle, heap) runnable with `pnpm run test:extension`.
- [x] **Measured Minimums** (Apple M4, 2026-09-30; rule and table in docs/ARCHITECTURE.md, "Refresh Floors"):
  - Rule: a section's reads alone may use at most the whole budget (0.5% of one core); the defaults keep the extension within it (~0.49% with all six sections shown).
  - Temperature: 40.4 ms of system CPU per pass (HID server) + 1.1 ms in the extension host: minimum 8400 ms, default 10 s (was 5 s, ~0.8% of one core).
  - CPU, load, memory, battery, disk: 0.34-0.47 ms per read, minimum 200 ms. The 2000 ms battery/disk lock of Phase 1.1 is removed; `mirabar.allowFastRefresh` now only unlocks temperature.
  - Battery driver publishes new data every 60 s; the 10 s default only serves power adapter changes.
- [x] **Verification in VS Code on Apple Silicon** (2026-10-01): per-section intervals, settings panel, gear tooltip tables, minimums.

Decisions: ADR-0009 (per-section intervals, scheduler), ADR-0010 (minimums from measurements), ADR-0012 (legacy settings, superseded by ADR-0015), ADR-0007 (gear tooltip tables).

**Follow-ups (macOS):**

- [ ] **Release 1.2.0**: version and CHANGELOG are ready; date the CHANGELOG entry, push `develop` and tag once the Linux check passes.
- [ ] **Fewer temperature sensors per pass**: a pass costs 40.4 ms of system CPU for 26 sensors; measure accuracy and cost with a subset, then revisit the 8400 ms minimum (ADR-0003, ADR-0010).
- [ ] **macOS 11 support**: decide when to raise the deployment target (ADR-0006).
- [ ] **Repeat `bench:darwin`** on an idle Mac to confirm the temperature figure (single run so far).

---

## 4c. Phase 1.3: Rename to MiraBar (v1.2.0) [COMPLETED]

> Branch: `chore/rename-mirabar` (from `develop`, merged locally in `7b4c977`) • Plan: [`docs/RENAME_MIRABAR_PLAN.md`](RENAME_MIRABAR_PLAN.md) • Decision: [ADR-0015](adr/0015-rename-to-mirabar.md)

- [x] **Identity**: extension `fabogit.mirabar`, display name *MiraBar: System Monitor for the Status Bar*, version 1.2.0, VSIX `mirabar-<target>-<version>.vsix`.
- [x] **Prefix**: settings and commands `mirabar.*`, command category *MiraBar*; output channel, status bar item names, settings panel and log prefix renamed.
- [x] **Legacy settings removed**: `updatefrequencyms`, `refreshMs`, `refreshSeconds`, `allowFastBatteryDiskRefresh`, their fallbacks and the panel migration (a new extension ID has no old values to read).
- [x] **Docs**: README with "Migrating from Resource Monitor NG", CHANGELOG, forward-looking docs; ADR-0001 to 0014 keep the old names.
- [ ] **GitHub repository** renamed to `fabogit/mirabar` (old URLs redirect), then `git remote set-url` and the remaining links (`package.json` `repository`, milestone and issue links in this file).
- [ ] **Milestones** renamed on GitHub: Linux v1.2.0 → v1.3.0, Windows v1.3.0 → v1.4.0, localization v1.4.0 → v1.5.0.

---

## 5. Phase 2: Linux Telemetry Modernization & Parity (v1.3.0) [IN PROGRESS]

> Milestone: [**`v1.2.0 - Linux Telemetry Modernization & Parity`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/3) • **Status: Open** (Active Target)

Phase 2 focuses on bringing the Linux implementation up to the v1.1.0 architectural standard, establishing empirical performance baselines, and verifying telemetry directly on a native Linux workstation. Details and checklist: [`docs/LINUX_IMPLEMENTATION_PLAN.md`](LINUX_IMPLEMENTATION_PLAN.md).

**First: check what Phases 1.1 and 1.2 changed (blocks pushing `develop`):**

- [ ] On a Linux machine with real sensors: `pnpm run typecheck`, `test:linux`, `test:integration`, `test:extension`, `package:linux-x64`; install the VSIX and check the status bar, the settings panel, the gear tooltip, Static/Live tooltips.
- [ ] Linux-specific code changed in Phase 1.1/1.2: `cpufreq` skips cores without `scaling_cur_freq` and rescans every 60 s; temperature is cached per interval and reports `sampleSeq` / `ageMs`. Check on hardware with cpufreq and hwmon, and on a laptop (battery).
- [ ] **Per-platform refresh minimums** (ADR-0010): the minimums are macOS measurements applied everywhere (temperature 8400 ms). Measure Linux with `bench:extension` plus a Linux source bench (sysfs/procfs read cost), and make `MEASURED_MIN_STATUS_BAR_MS` per platform.
- [ ] **CI**: run `test:extension` in both release jobs.

**Linux parity items:**

- [ ] [#1](https://github.com/fabogit/resource-monitor_code-extension/issues/1) **CPU Cold-Start Synchronization (Tick 0)**:
  - Pre-sample `/proc/stat` in constructor of `CpuProvider` to prime tick counters immediately.
- [ ] [#2](https://github.com/fabogit/resource-monitor_code-extension/issues/2) **CPU Frequency Monospace Table Layout**:
  - Convert Markdown bulleted core frequency list into compact monospace ASCII cluster table for `freqOrLoad.kind === 'freq'` (now in `renderFreqOrLoad`, `src/sections.ts`).
- [ ] [#3](https://github.com/fabogit/resource-monitor_code-extension/issues/3) **Battery Autonomy & Time Remaining**:
  - Parse sysfs `power_now` / `current_now` and `time_to_empty_now` / `time_to_full_now` to calculate `timeRemainingMinutes`.
- [ ] [#4](https://github.com/fabogit/resource-monitor_code-extension/issues/4) **Dynamic Hardware Thermal Trip Points**:
  - Detect `temp*_crit` / `temp*_max` from `/sys/class/hwmon/` to dynamically populate `critCelsius` instead of hardcoded 100 °C (limit column in `renderTemp`, `src/sections.ts`).
- [ ] [#5](https://github.com/fabogit/resource-monitor_code-extension/issues/5) **Empirical Benchmarking & Scientific Evaluation**:
  - Measure execution latency of TypeScript VFS reader at 200 ms polling intervals (`performance.now()`) against the < 250 µs SLA budget.
  - Profile V8 garbage collection overhead and heap allocation stability.
  - Tools available since Phase 1.2: `pnpm run bench:extension` (extension CPU per configuration and per section) and the heap check in `pnpm run test:extension`; the result feeds the per-platform minimums above.
- [x] [#6](https://github.com/fabogit/resource-monitor_code-extension/issues/6) **Cross-Platform Dual-Runner CI/CD**:
  - Configured `.github/workflows/release.yml` with decoupled dual-runner matrix (`macos-14` + `ubuntu-latest`), hardened least-privilege permissions, concurrency controls, and `workflow_dispatch` manual build testing.

---

## 6. Phase 3: Windows NT Architecture & Win32 Telemetry (v1.4.0) [PLANNED]

> Milestone: [**`v1.3.0 - Windows NT Architecture & Win32 Telemetry`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/4) • **Status: Open** (Future Roadmap)

Phase 3 introduces native Windows support through direct Win32 API bindings, adhering to the modular UI strategy and pragmatic hardware constraints.

What Phases 1.1–1.2 already provide: the platform-independent monitor, renderers, settings panel and scheduler (ADR-0009) only need a `TelemetryPlatformProvider` (`src/platform/interface.ts`; `requestTempRefresh` is optional, for sources that read asynchronously). Native code should follow ADR-0002 (RAII, per-environment state) and ADR-0003 if a source is slow; minimums are measured on Windows with the ADR-0010 rule (a WMI thermal query is likely the expensive source).

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

## 7. Phase 4: Internationalization & Localization (v1.5.0) [NICE TO HAVE]

> Milestone: [**`v1.4.0 - Internationalization & Localization`**](https://github.com/fabogit/resource-monitor_code-extension/milestone/5) • **Status: Open** (Backlog)

Phase 4 externalizes and translates user-facing strings once the underlying telemetry data models across Darwin, Linux, and Windows are fully consolidated.

- [ ] [#14](https://github.com/fabogit/resource-monitor_code-extension/issues/14) **Localization Infrastructure**:
  - Integrate VS Code official `vscode.l10n` API.
  - Extract all hardcoded strings (now in `src/sections.ts`, `src/monitor.ts` and `src/settings/panel_html.ts`) into source bundle `l10n/bundle.core.json`.
  - Localize command titles, categories, and configuration settings in `package.nls.json`.
- [ ] [#15](https://github.com/fabogit/resource-monitor_code-extension/issues/15) **Translation Bundles**:
  - Italian (`bundle.core.it.json`), German (`bundle.core.de.json`), French (`bundle.core.fr.json`), Spanish (`bundle.core.es.json`), Japanese (`bundle.core.ja.json`), Simplified Chinese (`bundle.core.zh-cn.json`).
- [ ] [#16](https://github.com/fabogit/resource-monitor_code-extension/issues/16) **Layout Resilience**:
  - Audit Markdown tooltip tables and ASCII progress bars to prevent visual wrapping or layout misalignment caused by variable-length translated strings.

---

## 8. Cross-Platform Backlog (unscheduled) [PLANNED]

Improvements independent of the platform phases; each one gets a milestone when scheduled.

- [ ] **Accessibility**:
  - Every status bar item already has a `name` (*MiraBar: CPU usage*, *MiraBar Settings*: the label of the status bar context menu).
  - Add `accessibilityInformation` to every item: a spoken label with the current value instead of the visible text with icons (e.g. "CPU usage 23 percent", "Memory pressure Warning"), updated together with the text; role `button` for items that run a command on click.
  - Check with VoiceOver (macOS), Orca (Linux) and NVDA (Windows).
- [ ] **Inactive window**:
  - Slow down or pause sampling while the window has no focus (`vscode.window.state.focused`, `onDidChangeWindowState`). The status bar of an unfocused window can still be on screen, so it is a setting: keep the intervals, multiply them, or pause.
  - On focus, refresh at once every section whose reading is older than its interval.
  - In the deadline scheduler it is a factor on the section deadlines; no change to the sources.
- [ ] **Multiple windows**:
  - Every VS Code window runs its own extension host and reads every source on its own: with N windows the cost is N times (on the M4 a temperature pass costs 40.4 ms of system CPU per window).
  - Optional (setting, off by default): share the readings of machine-wide sources (CPU, load, memory, temperature, battery) between windows. One window samples and publishes timestamped snapshots (e.g. a file in `globalStorageUri` or a local socket), the others render them; the sampler is chosen with a lock and a heartbeat, and another window takes over when it closes or stops. Disk stays per window (its paths can come from workspace settings).
  - Builds on the inactive-window item: the focused window is the natural sampler. Measure the gain with `bench:extension` and `bench:darwin` before making it the default.
