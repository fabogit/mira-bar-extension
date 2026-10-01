# ADR-0002: RAII wrappers and per-environment state in the Darwin addon

- **Status**: Accepted
- **Date**: 2026-09-29 (Phase 1.1)

## Context

The audit (`docs/audit-darwin-memory-2026-09.md`) found that `mach_host_self()` was called on every read and never released: about 3 Mach send-right references leaked per tick. CoreFoundation, IOKit and Mach objects were released by hand on each path, global variables held addon state, CF values were read without type checks (a wrong type could crash the Extension Host) and `napi_status` results were ignored.

## Decision

- Every owned native resource goes through an RAII wrapper: `CFRef<T>` (CoreFoundation), `IOObject` (IOKit), `MachSendRight` (Mach ports), `VmRegion` (kernel-allocated arrays released with `vm_deallocate`).
- The host port is acquired once per environment and released when the environment is torn down.
- All state lives in an `AddonState` attached with `napi_set_instance_data` and freed by its finalizer: no globals, safe with Node worker threads and addon reloads.
- CF values are read through type-checked getters (`GetInt`, `GetBool`, `GetUtf8`, `GetDictInt`); every N-API call is checked (`NAPI_CALL`) and failures throw instead of returning silent `null`.
- CPU ticks are written into a caller-owned `Uint32Array` (`getCpuTicks(out)`), with wrap-safe 32-bit deltas in TypeScript.

## Alternatives considered

- **Keep manual releases**: they were correct in most places but fragile; one missed early return leaks.
- **Call and release `mach_host_self()` on each use**: correct, but two extra system calls per read for nothing.
- **Return per-core JS objects**: about 50 allocations per tick.

## Consequences

- Measured on an Apple M4: host port references stay at +1 for the whole process (was ~30,000 after 10,000 calls); no RSS growth in `test/leak-darwin.mjs`.
- Ownership bugs are caught on Linux by the Apple-API mocks with reference counters under ASan (ADR-0014).
