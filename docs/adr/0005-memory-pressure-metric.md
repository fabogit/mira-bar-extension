# ADR-0005: Memory pressure from the kernel memorystatus level

- **Status**: Accepted
- **Date**: 2026-09-29 (Phase 1.1)

## Context

The memory tooltip showed `vm.memory_pressure` as a percentage with 60/80 thresholds. Measured on the M4: `vm.memory_pressure = 6` while `kern.memorystatus_vm_pressure_level = 2` (Warning) and `kern.memorystatus_level = 36`, i.e. the UI said 6% "Normal" while the kernel reported Warning at ~64% pressure. `vm.memory_pressure` is a counter, not a percentage.

## Decision

- `pressurePercent = 100 - kern.memorystatus_level`.
- `pressureLevel = kern.memorystatus_vm_pressure_level` (1 Normal, 2 Warning, 4 Critical) drives the label, as Activity Monitor does.

## Alternatives considered

- **Keep `vm.memory_pressure` with thresholds**: measured to be wrong.

## Consequences

- After the fix the M4 showed 62% "Warning", matching the kernel.
- Linux keeps its `/proc/meminfo` figures; it has no equivalent label (Phase 2 may consider PSI, `/proc/pressure/memory`).
