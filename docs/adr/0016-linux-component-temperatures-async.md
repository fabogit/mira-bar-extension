# ADR-0016: Linux component temperatures read asynchronously, CPU limit from the kernel

- **Status**: Accepted
- **Date**: 2026-10-01 (Phase 2)

## Context

On Linux the temperature tooltip showed only the CPU sensor, against a fixed 100 °C limit, while macOS also shows the NAND SSD and the battery cell. hwmon and power_supply expose more components: NVMe drives (`nvme`, Composite), DDR4/DDR5 modules (`jc42`, `spd5118`), wireless adapters (`mt7921_phy0`, `iwlwifi_*`, `ath*k`), and on some laptops the battery (`power_supply/BAT*/temp`, tenths of °C). Issues #4, #33-#36.

Measured on the test laptop (Framework, AMD, 2026-10-01; 200 synchronous reads per file):

| File | Median | p95 | Max | CPU per read |
| :--- | ---: | ---: | ---: | ---: |
| `k10temp` `temp1_input` (CPU) | 36 µs | 65 µs | 0.4 ms | 52 µs |
| `nvme` `temp1_input` (SMART log command) | 0.67 ms | 40.8 ms | 41.4 ms | 163 µs |
| `spd5118` `temp1_input` (I2C), each module | 1.46 ms | 2.2 ms | 2.7 ms | 364 µs |
| `mt7921_phy0` `temp1_input` (firmware command) | 2.10 ms | 2.5 ms | 3.0 ms | 166 µs |
| limit files (`temp1_max`, `temp1_crit`) | 31 µs | 47 µs | 1.4 ms | 44 µs |

The component reads go through the device and take milliseconds, up to ~41 ms for the NVMe drive (low power state). Read synchronously, as the CPU sensor is, they would block the extension host thread far beyond the 1 ms target.

## Decision

- **The CPU sensor stays synchronous** (~36 µs). Its limit is the `critical` trip point: `temp*_crit`, else `temp*_max`, next to the chosen input; for the thermal zone fallback, the trip point of type `critical`. Read once at discovery. Without one (e.g. `k10temp`), 100 °C as before.
- **Component sensors are read asynchronously** (`ComponentTempProvider`, `src/platform/linux/components.ts`): `fs.promises`, one file after the other, at most one pass in flight. A stuck device holds at most one libuv pool thread and never the extension host thread.
- The Linux provider implements `requestTempRefresh`, so the monitor starts the pass 100 ms before each temperature read, as on macOS (ADR-0003); `sampleTemp` merges the latest completed pass. When no pass was requested ahead (first read, click, intervals below 400 ms), `sampleTemp` starts one and the values appear at the next read. Readings older than three temperature intervals (at least 5 s) are not shown.
- Sensors and their `temp1_max` / `temp1_crit` limits are found by a scan every 60 s (hotplug, driver reloads); a sensor whose read fails is skipped for that pass.
- Tooltip: one row per component (NVMe SSD, RAM DIMM, Wi-Fi, Battery Cell; with several of a kind, the device name or the module index), Limit column from `crit`, else `max`, else a dash with the bar drawn against 100 °C. A reading at or above `max` is listed below the table ("Above the operating maximum"). Our own comparison is used instead of the driver's `*_alarm` files, which latch on some drivers.
- GPU sensors (`amdgpu`, `nouveau`) and embedded controller sensors (`cros_ec`) are not shown: not in the scope of the issues.

## Alternatives considered

- **Synchronous reads with a slower cadence**: the block per read (up to 41 ms) is the problem, not the frequency.
- **Parallel reads** (`Promise.all`): shorter pass, but up to five pool threads held at once, shared with the whole extension host.
- **Worker thread**: more code and memory for reads that the libuv pool already performs off the thread.
- **Driver alarm files** for the above-maximum note: `spd5118` reported `temp1_max_alarm=1` at 44.5 °C with max 55 °C (latched from an earlier excursion).

## Consequences

- Extension host thread per temperature read: ~45 µs (median, CPU plus merge). A component pass on the test laptop: ~8.7 ms wall (p95 37 ms, NVMe), ~3.3 ms of process CPU; at the 10 s default ~0.03% of one core.
- Reading the NVMe temperature sends a command to the drive and can bring it out of a low power state once per temperature interval. A setting to turn component sensors off can be added if it matters on battery.
- The Linux minimums are still the macOS ones (ADR-0010); the measurements above feed the per-platform minimums (#5).
- Covered by `test/linux-temp.test.ts` (`pnpm run test:linux-temp`, mocked sysfs tree: limits, labels, invalid values, rescan, tooltip rows) and by `test:linux` on real hardware. The battery `temp` file is verified only with the mock (absent on the test laptop).
