# ADR-0004: Battery data sources and "Nominal vs Design"

- **Status**: Accepted
- **Date**: 2026-09-29 (Phase 1.1)

## Context

The battery widget read `IOPowerSources` and copied the whole `AppleSmartBattery` registry dictionary on every tick, twice (once for presence). On the M4 the capacity keys cannot be read one by one, and the mAh values exist only inside the `BatteryData` sub-dictionary; the top-level `MaxCapacity` / `CurrentCapacity` are percentages. macOS Settings showed "Maximum Capacity 100%" while nominal / design gave 99.4%: Apple does not publish its formula.

## Decision

- `IOPowerSources` on every battery read: percentage, charging state, time remaining. The internal battery is preferred over UPS devices; battery presence is cached by the provider.
- One full `AppleSmartBattery` snapshot at most every 30 s. mAh values from `BatteryData` (`DesignCapacity`, `NominalChargeCapacity`, `FullChargeCapacity`, `RemainingCapacity`), with the older top-level `AppleRaw*` keys used first where present. `CycleCount` from either level.
- The health row is labelled **"Nominal vs Design"** (nominal full-charge capacity / design capacity, mAh shown next to it) instead of "Battery Health" (user choice, 2026-09-29).

## Alternatives considered

- **Per-key reads**: do not work on the M4.
- **Full snapshot on every tick**: dozens of keys copied twice per tick for values that change slowly.
- **Imitate macOS "Maximum Capacity"**: its calculation is not exposed; showing our own figure under Apple's name would be misleading.

## Consequences

- Phase 1.2 measured `getBatteryStats` at 20 µs of CPU per read (60 µs of wall time waiting on powerd), and found that the driver publishes new data every **60 s** (`UpdateTime`). Shorter intervals only show power adapter changes sooner; the default stays at 10 s for that reason (ADR-0010).
