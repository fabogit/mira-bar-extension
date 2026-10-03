# ADR-0010: Refresh minimums derived from measurements

- **Status**: Accepted. Replaces the fixed 2000 ms minimums of Phase 1.1 (temperature; battery and disk unless unlocked).
- **Date**: 2026-09-30 (rule and values, Phase 1.2); 2026-10-03 (Linux measurements, minimums per platform, Phase 2)

## Context

Phase 1.1 used fixed minimums chosen by judgement: 2000 ms for temperature, and 2000 ms for battery and disk unless `allowFastBatteryDiskRefresh` was on. The user asked that limits be set on real measured values and explained in the options. The project budget (docs/ROADMAP.md) is 0.5% of one core for the whole extension.

## Decision

**Rule**: the minimum status bar interval of a section is the interval at which its reads alone would use the whole budget:

```
minimum = max(200 ms, (source CPU per read + extension CPU per read) / 0.005), rounded up to 100 ms
```

- *Source CPU per read* counts the whole machine, including the macOS services that answer (powerd, the HID event server): `test/bench-darwin.mjs`, from host CPU ticks against an idle baseline. On Linux: `test/bench-linux.mjs` (see below).
- *Extension CPU per read* is the extension host's work for one read with one section visible, Live mode (worst case): `test/bench-extension.mjs`. For temperature the worker thread's CPU, already in the system figure, is counted once.
- The defaults must keep the whole extension within the budget. `mirabar.allowFastRefresh` lowers every minimum to 200 ms; values below a minimum are kept and apply whenever it is on.

**Measured on an Apple M4 (macOS, Node 24), 2026-09-30:**

| Section | Source per read | Extension per read | Exact | Minimum | Default |
| :--- | ---: | ---: | ---: | ---: | ---: |
| CPU usage | 8.0 µs | 440 µs | 90 ms | 200 ms | 2 s |
| System load | 0.5 µs | 449 µs | 90 ms | 200 ms | 2 s |
| Temperature | 40.4 ms | 1.1 ms | 8314 ms | **8400 ms** | 10 s |
| Memory | 8.6 µs | 466 µs | 95 ms | 200 ms | 2 s |
| Battery | 20.1 µs | 442 µs | 92 ms | 200 ms | 10 s |
| Disk | 10.8 µs | 342 µs | 71 ms | 200 ms | 10 s |

Cost at the defaults: ~0.49% of one core with all six sections shown.

### Minimums per platform (2026-10-03)

The sources differ per platform, so the minimums do too: `MEASURED_MIN_STATUS_BAR_MS` in `src/config.ts` holds one set per measured platform, `measuredMinimums(platform)` picks the host's, and `minStatusBarMs()` takes the platform as an argument (the tests inject it). The macOS values are unchanged. A platform not measured yet (Windows) takes the higher measured value of each section, so no section can exceed the budget there by assumption. The panel, the gear tooltip and the setting descriptions show the host's minimums. `MIN_INTERVAL_MS` (200 ms) stays the absolute floor everywhere.

**Measured on an AMD Ryzen 7 7840U laptop (Linux 7.2, Node 24), 2026-10-03**, at the machine's usual load (load average 1.1-2.0), three runs of `test/bench-linux.mjs` and two of `test/bench-extension.mjs`. Each minimum comes from the run with the highest cost:

| Section | Source per read | Extension per read | Exact | Minimum | Default |
| :--- | ---: | ---: | ---: | ---: | ---: |
| CPU usage (`/proc/stat`) | 138-144 µs | 252-272 µs | 78-83 ms | 200 ms | 2 s |
| CPU frequency (16 cpufreq files) | 228-245 µs | 408-437 µs | 128-136 ms | 200 ms | 2 s |
| Temperature (CPU hwmon + component pass) | 1.2-1.7 ms | 0.44-0.87 ms | 321-505 ms | **600 ms** | 10 s |
| Memory (`/proc/meminfo`) | 28 µs | 171-203 µs | 40-46 ms | 200 ms | 2 s |
| Battery (ACPI `BAT1`) | 262-289 µs | 282-285 µs | 109-115 ms | 200 ms | 10 s |
| Disk (`statfs`) | 82-83 µs | 185-212 µs | 53-59 ms | 200 ms | 10 s |

Cost at the defaults: 0.05% of one core measured with all six sections shown (0.10-0.11% estimated from the per-read costs).

- **Source CPU on Linux is process CPU**, the largest of three regimes (reads back to back, every 200 ms, every 2 s with kernel caches expired). It includes the kernel's work inside our syscalls (65-90% of it), and the libuv pool threads of the async reads. The bench also measures the whole machine from `/proc/stat` against idle windows, as on macOS; at the usual load it agrees with the process figure. On Linux nothing like the HID event server answers in another process: the work happens in the calling thread's syscall, which is counted.
- **Usual load, not a busy machine**: a first series with a file indexer running (load average 1.7-5.9) measured costs two to three times higher (temperature 900 ms, CPU frequency 400 ms, battery 300 ms). The minimums follow the usual load, as the macOS ones do; the busy figures are recorded in docs/ARCHITECTURE.md as the upper bound.
- **Temperature, honestly accounted**: the CPU sensor is read on the extension host thread (~27 µs at 200 ms); the SSD, RAM and Wi-Fi sensors are read in a background pass on the libuv pool (ADR-0016). The pass is off the thread, but its CPU is real and counted in full (1.1-1.7 ms per pass every 2 s, 0.9-1.0 ms back to back, the higher one used). `bench:extension` runs in the same process, so its temperature figure already holds the pass: the pass is subtracted from it and counted once, as for the macOS worker. The pass's 9-21 ms of wall time (up to ~70 ms when the SSD leaves a low power state) is device time, not CPU, and is outside the CPU budget. That device time and the SSD wake-ups are why the default stays at 10 s, well above the 600 ms minimum. The sensor rescan (7-9 ms of CPU every 60 s, ~0.015% of one core) does not depend on the interval and does not change the minimum.

## Alternatives considered

- **Split the budget six ways** (0.083% each, all six at their minimum within the budget): temperature costs ~90 times more than any other section, so its minimum would be ~50 s while the other shares stay unused. Rejected by the user in favour of the whole-budget rule.
- **Keep fixed minimums**: not based on measurement; the battery/disk lock turned out to protect against a cost of ~0.01% of one core.
- **Minimums from the source refresh rate**: temperature changes on every pass, so it gives no bound; the battery driver (60 s) is used for the default reasoning instead (ADR-0004).
- **One set of minimums for every platform** (the macOS values, until 2026-10-03): 8400 ms for a Linux temperature read that costs ~2.5 ms, fourteen times more conservative than the rule. Not chosen.
- **Defaults per platform** (e.g. a lower temperature default on Linux): VS Code settings have one default per key (`package.json`), and the 10 s temperature default is justified on Linux too (SSD wake-ups). Not chosen: the defaults are the same everywhere and above every platform's minimum.

## Consequences

- Temperature default raised from 5 s (which cost ~0.8% of one core, more than the whole budget) to 10 s (~0.42%).
- The battery/disk lock is removed; `mirabar.allowFastRefresh` replaces `allowFastBatteryDiskRefresh` and in practice only unlocks temperature.
- The setting descriptions, the panel and README quote the rule and the numbers; `MEASURED_MIN_STATUS_BAR_MS` in `src/config.ts` cites the measurement.
- ~~The values are macOS measurements and currently apply on every platform.~~ Since 2026-10-03 the minimums are per platform: macOS unchanged, Linux measured (temperature 600 ms, the others 200 ms).
- **Open question: Windows.** Not measured; it takes the higher value of each section (temperature 8400 ms, the others 200 ms) until a Windows provider and a bench exist (Phase 3), with the same rule.
- The Linux figures come from one laptop. Other hardware may differ (more cores mean more cpufreq files and a longer `/proc/stat`; other component sensors), so `bench:linux` should be repeated on other machines before the Linux minimums are lowered.
- The renderer-side cost of status bar updates in VS Code is not measurable outside VS Code and is not included.
