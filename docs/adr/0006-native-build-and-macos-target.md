# ADR-0006: Native build flags and macOS 11 target

- **Status**: Accepted, with one open question
- **Date**: 2026-09-29 (Phase 1.1)

## Context

The released binary is built by `native/darwin/compile.sh`, not by `binding.gyp`, so settings in `binding.gyp` did not apply. The code used `kIOMainPortDefault`, which exists only from macOS 12, while the deployment target is macOS 11: the addon would fail to load there.

## Decision

- `compile.sh` builds with `-mmacosx-version-min=11.0 -DNAPI_VERSION=8 -Wall -Wextra -Wunguarded-availability-new -fvisibility=hidden`; `binding.gyp` uses the same warnings and visibility. `DEBUG=1` builds with AddressSanitizer for leak testing on the Mac.
- `MACH_PORT_NULL` replaces `kIOMainPortDefault` (same value, available on macOS 11).

## Alternatives considered

- **Raise the minimum to macOS 12**: would allow `kIOMainPortDefault` but drops macOS 11 users for no functional gain. **Open**: decide when macOS 11 support ends.

## Consequences

- Availability warnings make a future macOS 12+ API use visible at compile time.
