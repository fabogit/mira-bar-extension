# ADR-0010: Refresh minimums derived from measurements

- **Status**: Accepted. Replaces the fixed 2000 ms minimums of Phase 1.1 (temperature; battery and disk unless unlocked).
- **Date**: 2026-09-30 (rule and values, Phase 1.2)

## Context

Phase 1.1 used fixed minimums chosen by judgement: 2000 ms for temperature, and 2000 ms for battery and disk unless `allowFastBatteryDiskRefresh` was on. The user asked that limits be set on real measured values and explained in the options. The project budget (docs/ROADMAP.md) is 0.5% of one core for the whole extension.

## Decision

**Rule**: the minimum status bar interval of a section is the interval at which its reads alone would use the whole budget:

```
minimum = max(200 ms, (source CPU per read + extension CPU per read) / 0.005), rounded up to 100 ms
```

- *Source CPU per read* counts the whole machine, including the macOS services that answer (powerd, the HID event server): `test/bench-darwin.mjs`, from host CPU ticks against an idle baseline.
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

## Alternatives considered

- **Split the budget six ways** (0.083% each, all six at their minimum within the budget): temperature costs ~90 times more than any other section, so its minimum would be ~50 s while the other shares stay unused. Rejected by the user in favour of the whole-budget rule.
- **Keep fixed minimums**: not based on measurement; the battery/disk lock turned out to protect against a cost of ~0.01% of one core.
- **Minimums from the source refresh rate**: temperature changes on every pass, so it gives no bound; the battery driver (60 s) is used for the default reasoning instead (ADR-0004).

## Consequences

- Temperature default raised from 5 s (which cost ~0.8% of one core, more than the whole budget) to 10 s (~0.42%).
- The battery/disk lock is removed; `mirabar.allowFastRefresh` replaces `allowFastBatteryDiskRefresh` and in practice only unlocks temperature.
- The setting descriptions, the panel and README quote the rule and the numbers; `MEASURED_MIN_STATUS_BAR_MS` in `src/config.ts` cites the measurement.
- **The values are macOS measurements and currently apply on every platform.** Linux reads temperature from sysfs at a much lower cost, so 8400 ms is likely too conservative there. Per-platform minimums are a Phase 2 / Phase 3 task, using the same rule.
- The renderer-side cost of status bar updates in VS Code is not measurable outside VS Code and is not included.
