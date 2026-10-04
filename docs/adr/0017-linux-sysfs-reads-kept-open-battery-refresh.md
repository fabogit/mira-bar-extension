# ADR-0017: Linux sysfs files kept open, cpufreq per policy, ACPI battery refreshed ahead of the read

- **Status**: Accepted
- **Date**: 2026-10-04 (v1.3.1, issue #40)

## Context

Issue #5 set a target for the time one read blocks the extension host thread: 250 µs at 200 ms polling. `bench:linux` on the test laptop (Ryzen 7 7840U, 16 threads, `amd-pstate-epp`, ACPI battery `BAT1`) found two sources above it in v1.3.0 (#40): CPU frequency (16 `scaling_cur_freq` files, p95 238-256 µs at 200 ms, 401-421 µs every 2 s) and the battery (p95 304-311 µs at 200 ms, 359-395 µs every 2 s).

Every sample opened, read and closed each file by path. The two sources differ in where the time goes:

- **CPU frequency**: sixteen opens and closes per sample. The value itself is cheap for the driver.
- **Battery**: the ACPI battery driver (`drivers/acpi/battery.c`) caches the battery state for `battery.cache_time` = 1000 ms. Once the cache has expired, the first read of *any* battery attribute (`capacity`, `status`, `charge_now`, even `charge_full_design`) evaluates the ACPI `_BST` method, which queries the **embedded controller** (EC), a microcontroller on the mainboard; the reads that follow within 1 s are served from the cache. At the 10 s default every read finds the cache expired; at 200 ms one read in five does.

### Measurements

Test laptop, machine idle (load average 0.1-0.5), 2026-10-04. A first series run while the machine was in use gave battery figures about twice as high and was discarded; all the figures below come from the rerun. Ranges are across two runs.

**The ACPI cache, one file read on its own** (open + read + close, 100 ms or more after the previous read, median of 8):

| File | Cache expired | Cache valid | EC query |
| :--- | ---: | ---: | ---: |
| `capacity` | 389-484 µs | 152-190 µs | ~250 µs |
| `status` | 398-443 µs | 116-170 µs | ~280 µs |
| `charge_now` | 376-450 µs | 179-199 µs | ~220 µs |
| `charge_full_design` | 428-442 µs | 171-184 µs | ~250 µs |

The EC query costs **~250 µs**, whichever file triggers it. The ~170 µs of a cached read are mostly the cost of running on a thread that has been idle for 100 ms: a call that does almost nothing (`os.loadavg()`) costs 57-71 µs in the same conditions.

**Descriptors kept open, cpufreq per policy** (`bench:linux`, develop at 915c53b against this change, runs alternated):

| Source | Measure | Before | After |
| :--- | :--- | ---: | ---: |
| CPU frequency, 16 files | reads back to back | 95-101 µs | 17 µs |
| CPU frequency | p95 every 200 ms | 313-319 µs | 160 µs |
| CPU frequency | median every 2 s | 267-282 µs | 96-133 µs |
| Battery | reads back to back | 49-50 µs | 7.7 µs |
| Battery | p95 every 200 ms | 354-358 µs | 273-326 µs |
| Battery | median every 2 s | 323-327 µs | 268-308 µs |
| CPU temperature | p95 every 200 ms | 40 µs | 23-25 µs |

Keeping the descriptors open removes the opens and closes: CPU frequency falls well under the target. The battery keeps the EC query.

**Battery, refreshed ahead of the read** (a separate script, the sample through `BatteryProvider`; "blocked" adds up the two moments the thread is busy):

| Regime | Approach | Blocked, median | p95 | Process CPU per sample |
| :--- | :--- | ---: | ---: | ---: |
| cache expired (the 10 s default) | read on the thread | 353-375 µs | 481-484 µs | 364-385 µs |
| | refresh with `fs.promises.readFile`, 100 ms ahead | 197-211 µs | 321-328 µs | 970-995 µs |
| | refresh with `fs.read` on the open descriptor, 100 ms ahead | 152-158 µs | 233-240 µs | 872-893 µs |
| every 200 ms | read on the thread | 104-106 µs | 379-384 µs | 151-164 µs |
| | refresh with `fs.promises.readFile` | 196-197 µs | 395-486 µs | 773-830 µs |
| | refresh with `fs.read` on the open descriptor | 143-152 µs | 278-377 µs | 394-457 µs |

With the descriptor refresh, the 152 µs are two separate stalls 100 ms apart: ~40 µs to request the refresh, ~110 µs for the read. The refresh itself takes 0.4-0.6 ms on the libuv pool, well within the 100 ms margin.

**The implementation, measured by `bench:linux`** (step 5: the two ways of reading the battery alternated, each every 3 s so the cache has always expired; 20 reads each, so the p95 is the slowest read; load average 0.1-0.6):

| | Blocked, median | p95 | Longest stall, p95 | Process CPU per read |
| :--- | ---: | ---: | ---: | ---: |
| read on the thread (intervals below 1 s) | 277-309 µs | 313-386 µs | 313-386 µs | 290-331 µs |
| refreshed 100 ms ahead (1 s and more) | 134-149 µs | 223-375 µs | 159-280 µs | 597-908 µs |

The first run had a disturbance during its 200 ms phase, visible on every source, including those this change does not touch (`/proc/stat` p95 554 µs against 231 µs in the second run); its 375 µs is one slow read out of 20.

## Decision

- **Descriptors kept open** (`SysfsAttribute`, `src/platform/linux/sysfs.ts`): every file read at each sample (cpufreq, the CPU sensor, the battery files) is opened at its first read and read again with one `pread` at offset 0, which makes sysfs produce the value again. Checked on the laptop: the values match a fresh `readFileSync` at every read. A failed read closes the descriptor and retries once with a fresh one (device removed and back, core offlined). Rescans reuse the descriptors of the files still present and close the others; the monitor closes them all through the optional `TelemetryPlatformProvider.dispose()`. About 30 descriptors stay open on the test laptop.
- **cpufreq once per policy**: `cpuN/cpufreq` links to the core's policy; cores that share a policy (clusters) share one read, whose value goes to each of them. On the test laptop every core has its own policy, so the gain there comes from the open descriptors; on clustered CPUs it also cuts the number of reads.
- **Battery refreshed ahead of the read**, from a 1 s battery interval up (`BATTERY_PREFETCH_MIN_MS`, `src/monitor.ts`): 100 ms before the read (`PREFETCH_MS`, the same scheduling as the temperature pass) the monitor calls the optional `requestBatteryRefresh()`. The Linux provider reads `capacity` with `fs.read` on its open descriptor, on the libuv pool. That read pays the EC query off the extension host thread; the read 100 ms later is served from the driver's cache.
- **No refresh below 1 s**: most reads hit the cache anyway, and the refresh would add its cost to every read (median 104 → 143-152 µs at 200 ms, p95 not reliably better). At 200 ms the battery keeps one EC query per second on the thread (p95 ~300-380 µs).

## Alternatives considered

- **Accept the EC cost as a limit of the driver**: the cost cannot be removed, since the driver decides when the EC is queried. It can still be moved off the thread, which is what the refresh does, for ~40 µs of request on the thread.
- **Refresh with `fs.promises.readFile`**: opens and closes the file on the pool at each refresh. It costs more (process CPU ~980 µs per sample, ~90 µs on the thread to start) and gains less (p95 321-328 µs).
- **Battery read entirely off the thread**, like the component temperatures (ADR-0016): it would also remove the ~110 µs read, but the section would show the previous completed reading and need its own state and staleness handling, for ~110 µs every 10 s.
- **Refresh at every interval**: worse at 200 ms (see above).
- **Read only the files that change** (move `charge_full_design` and `cycle_count` out of the sample): no gain, because the first file read after the cache expires pays the EC query, whatever the file.

## Consequences

- At the 10 s default the battery blocks the thread for ~135-160 µs per read, in two stalls (p95 ~225-240 µs in the clean runs), instead of ~280-375 µs (p95 ~315-485 µs). CPU frequency stays below the target at 200 ms (p95 ~160 µs).
- At intervals below 1 s the battery stays above the target once per second, because the driver queries the EC then. This only happens with `mirabar.allowFastRefresh`, and the time is spent waiting for the hardware.
- Process CPU of the battery rises from ~0.3 ms to ~0.6-0.9 ms per read with the refresh (a second wake-up and the pool thread): at the 10 s default ~0.006% of one core more, against a budget of 0.5%. `bench:linux` estimates 0.11-0.12% of one core for the whole extension at the defaults.
- The descriptors of a removed device are closed on the next failed read or rescan, and all of them when the monitor is disposed.
- `bench:linux` measures both ways of reading the battery with the cache expired (step 5), and `test:linux-sysfs` covers the descriptors (current value at each read, retry, deferred close during a refresh, cpufreq per policy, rescans).
