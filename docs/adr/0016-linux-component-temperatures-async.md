# ADR-0016: Linux component temperatures read asynchronously, CPU limit from the kernel

- **Status**: Accepted
- **Date**: 2026-10-01 (Phase 2); sleeping devices section 2026-10-03

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
- Reading the NVMe temperature sends a command to the drive and can bring it out of a low power state once per temperature interval. See "Sleeping devices" below for `mirabar.temperature.componentSensors`.
- The pass's CPU counts in the Linux temperature minimum (600 ms, ADR-0010, measured with `test/bench-linux.mjs`, #5): off the thread, but counted in full.
- Covered by `test/linux-temp.test.ts` (`pnpm run test:linux-temp`, mocked sysfs tree: limits, labels, invalid values, rescan, tooltip rows, the three `componentSensors` modes) and by `test:linux` on real hardware. The battery `temp` file is verified only with the mock (absent on the test laptop).

## Sleeping devices (`mirabar.temperature.componentSensors`, 2026-10-03)

### Context

Each component reading is a request to the device (NVMe SMART log command, I2C transfer, Wi-Fi firmware command). When the kernel has runtime-suspended the device, or the controller in front of it, the read resumes it: once per temperature interval, which costs power on battery. Runtime PM state is visible in sysfs as `power/runtime_status` (`active`, `suspended`, `suspending`, `resuming`, `error`, or `unsupported` when runtime PM is disabled for that device).

On the test laptop (Framework, AMD, Arch Linux, kernel 7.2, 2026-10-03), walking up from the `realpath` of each `hwmonN/device`:

| Sensor | Chain (runtime_status) | Node that can be suspended |
| :--- | :--- | :--- |
| `nvme` | `nvme0` unsupported → PCI function `0000:02:00.0` active → PCIe port `0000:00:02.4` active → `pci0000:00` unsupported | PCI function (`/sys/class/nvme/nvme0/device`), and its port |
| `spd5118` (×2) | I2C client `21-0050` unsupported → adapter `i2c-21` (no runtime attributes: `pm_runtime_no_callbacks`) → SMBus controller `0000:00:14.0` (`piix4_smbus`) active | SMBus controller |
| `mt7921_phy0` | `phy0` unsupported → PCI function `0000:01:00.0` active → port `0000:00:02.2` active | PCI function, and its port |
| `BAT1` (ACPI) | all unsupported | none (no `temp` file here) |

The NVMe, Wi-Fi and SMBus PCI functions have `power/control` = `on` (runtime PM forbidden), so they are never runtime-suspended on this laptop: in `/sys/class/nvme/nvme0/device/power/`, `runtime_status` is `active`, `runtime_suspended_time` 0 and `runtime_active_time` 5 627 666 ms. Other devices do suspend: 55 of 1129 nodes were `suspended` (e.g. the `i2c-designware` controllers `AMDI0010:0x`). Power tools (TLP `RUNTIME_PM_ON_BAT=auto`, powertop) set `control` to `auto`, and then PCI devices and controllers with runtime PM support (e.g. Intel's `i2c-i801` SMBus controller, in front of the DIMM sensors) can suspend.

Reading `runtime_status` does not touch the device: the attribute prints the kernel's runtime PM bookkeeping (`dev->power.runtime_status`, `disable_depth`, `runtime_error`) and does not resume. Checked on a suspended controller (`AMDI0010:00`): 10 000 reads left it `suspended`, with `runtime_active_time` unchanged. Cost (Node 24, 2000-5000 reads):

| Read of `power/runtime_status` | Median | p95 | CPU per read |
| :--- | ---: | ---: | ---: |
| `fs.readFileSync` | 25 µs | 34 µs | 29 µs |
| `fs.promises.readFile` | 215 µs | 476 µs | 267 µs |

### Decision

- New setting `mirabar.temperature.componentSensors`, applied live (`setComponentSensors`, optional in the provider interface; macOS does not implement it, the setting has no effect there):
  - `awake` (default): before each sensor read, its device chain is checked; a `suspended` or `suspending` node means the sensor is not read. `active`, `resuming`, `error`, `unsupported` or a missing file: read as before.
  - `always`: the behaviour before this setting.
  - `off`: no scan, no reads, no rows; the CPU sensor only. A pass running when it is set is dropped.
- The chain is the device and its ancestors below `/sys/devices`, recorded at each scan (every 60 s) keeping only the nodes whose runtime PM is enabled (not `unsupported`): `unsupported` changes when a driver binds or unbinds, which the next scan picks up. Every enabled node is checked, not only the nearest: a child whose runtime PM is disabled does not keep its parent awake, and some parents ignore their children (the I2C adapter), so a controller can suspend whatever the state of the nodes below it.
- The check is synchronous, like the CPU sensor: it cannot block on hardware, and through `fs.promises` it would cost ten times more CPU than the reads it guards. It runs right before each sensor's read, not once per pass, so a device that suspends during the pass is still caught.
- The scan follows the same rule: for a sleeping device it only checks that the input file exists (a stat, not a read) and keeps the limits from the previous scan; without previous limits (asleep since startup) they are read by the first pass that finds the device awake. For NVMe `temp1_max` is itself a command (Get Features), `temp1_crit` is cached by the driver.
- Tooltip: a sleeping sensor keeps its row with "asleep" in the Temp column, no bar, and its limit; a note below names it (*Asleep (runtime-suspended), not read so as not to wake it: …*). The last value is not shown: a temperature from before the device slept would read as current, and the row's time is the pass time. Rows do not disappear and reappear as devices sleep and wake.
- The battery follows the same rule. An ACPI battery (`PNP0C0A`, EC) has no node with runtime PM in its chain, so it is always read; a fuel gauge on I2C/SMBus (`sbs-battery`, `bq27xxx`) is behind a controller that can be suspended, and is then skipped like a DIMM.

### Not covered: NVMe APST

APST (Autonomous Power State Transitions) is the drive's own idle management, independent of runtime suspend: the PCI function stays `active` while the drive drops to its non-operational power states. An admin command such as the SMART log read brings it back to an operational state for a moment, and the idle timer starts again. `awake` does not prevent that: it avoids waking a runtime-suspended device, it does not keep an awake drive in its deepest idle state. Users who care choose `off`; the setting's description says so.

Likewise the mt7921 firmware power save (mt76 `runtime-pm`) is internal to the driver and not visible in `runtime_status`: a Wi-Fi reading wakes the chip from it as before.

### Consequences

- In a component pass on the test laptop, `awake` adds 6 checks (NVMe 2, each DIMM 1, Wi-Fi 2), ~44 µs each within a pass, ~0.26 ms on the extension host thread per pass (~0.003% of one core at the 10 s default); pass CPU 2.0 ms against 1.8 ms with `always` (200 passes each). Here nothing is ever skipped (`control` = `on`), so the readings are those of `always`.
- When a device is skipped, the read it would have caused (up to ~41 ms and a device wake-up for NVMe) is not made.
- A device that suspends between its check and its read is still read once (a window of microseconds; autosuspend delays are hundreds of milliseconds or more).

## SATA drives (`drivetemp`), 2026-10-03

### Context

SATA drives expose a temperature only through the `drivetemp` hwmon driver, which is not loaded by default (it needs `modprobe drivetemp`, as root). A hard disk in standby has its spindle stopped: waking it every temperature interval would spin it up (seconds of motor work, wear, noise, energy), which is the opposite of what MiraBar should do.

Measured on the Garuda desktop (kernel 7.2 zen) on its non-system SATA drives: two Samsung SSD 870 QVO 2 TB (ntfs3) and a Seagate ST8000DM004 8 TB hard disk (exfat). Each read starts from standby (`smartctl -s standby,now`); the state after it comes from `smartctl -n standby` (CHECK POWER MODE, which does not wake the drive). Three trials per read and drive, identical results on the two SSDs. All three drives report SCT Status support (`smartctl -c`) and no APM feature (`smartctl -g apm`: unavailable).

| Read, drive in standby | SSD 870 QVO (×2) | HDD ST8000DM004 |
| :--- | :--- | :--- |
| `statfs` on the mounted file system (the disk section) | stays in standby, 1 ms | stays in standby, 1 ms |
| `drivetemp` `temp1_input` | stays in standby, 2-3 ms (29 °C) | stays in standby, 2 ms (31 °C) |
| SMART attributes (`smartctl -A`, SMART READ DATA) | wakes up, 13-14 ms | spins up, 9.5 s |

- The file system answers `statfs` from memory: the disk section never wakes a drive.
- All three answer `drivetemp` through SCT Status, served by the drive's controller without leaving standby.
- Reading the SMART attributes, which `drivetemp` does on drives without SCT Status, wakes all three, and spins the hard disk up for 9.5 s.
- `power/runtime_status` of the SCSI devices is `active` while the drives are in standby: ATA standby is not runtime PM, so the `awake` mode of `componentSensors` cannot see it.

### Decision

SATA drives are not read. `drivetemp` is not in the component classes.

- Whether a reading is harmless depends on the drive: with SCT Status it stays in standby, without it `drivetemp` falls back to the SMART attributes and a hard disk spins up for seconds at every temperature interval. SCT support is not exposed in sysfs, so the extension cannot tell which case it is in before reading.
- Knowing whether a drive is in standby needs an ATA command through `SG_IO` (CHECK POWER MODE), which needs root: the extension cannot ask first.
- The module is not loaded by default, so the feature would show nothing to most users and invite them to load a driver as root.

To revisit only as an explicit opt-in, after testing drives without SCT.
