# ADR-0003: Temperature read on a native background thread

- **Status**: Accepted (prefetch added in Phase 1.2)
- **Date**: 2026-09-29 (Phase 1.1), 2026-09-30 (Phase 1.2)

## Context

Apple Silicon temperatures come from `IOHIDEventSystemClient`: 24 SoC die sensors plus NAND and battery cell. Measured on an M4, `getDieTemperature()` took **18 ms per call** on the Extension Host thread, far above the 1 ms latency target. `native/darwin/tools/hid_bench.cc` showed the cost is evenly spread (~0.6 ms of IPC per sensor, ~16 ms per pass), with no single slow sensor to drop.

## Decision

- A native worker thread (`ThermalSampler`) owns the HID client and performs the passes. `getDieTemperature(maxAgeMs)` returns the latest reading without blocking (~2-3 µs) and wakes the worker when the reading is older than `maxAgeMs`. Only the very first call waits, at most 250 ms.
- The worker is joined when the addon state is destroyed; the HID objects never touch the N-API environment.
- Each reading carries `sampleSeq`, `ageMs`, `passWallMs` and `passCpuMs` (Phase 1.2), used by Live tooltips (rebuild only on a new reading), by the tooltip time (the time of the pass) and by `test/bench-darwin.mjs`.
- Phase 1.2: the monitor requests the pass 100 ms before each temperature read (`requestTempRefresh`), so the value shown is fresh without waiting and there is one pass per interval.

## Alternatives considered

- **`napi_async_work`**: runs on the libuv pool shared with every other extension and makes the API asynchronous.
- **Read 8 sensors per pass in rotation**: cheaper per pass, but the average and peak would mix readings of different ages.
- **SMC keys**: undocumented, different keys per chip.
- **Only read less often**: the 16-18 ms block on the Extension Host thread would remain.

## Consequences

- The Extension Host thread never waits for the sensors after the first reading.
- Phase 1.2 measured the full cost of a pass across the system: **40.4 ms of CPU** (the HID server works for each sensor), against ~1 ms on our worker. That figure drives the temperature minimum (ADR-0010).
- Follow-up (not done): read fewer sensors per pass to lower that cost; needs a measurement of the accuracy trade-off.
