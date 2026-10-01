# ADR-0011: Disk sampled off the event loop turn, with a cap on requests in flight

- **Status**: Accepted
- **Date**: 2026-09-30 (final check of Phase 1.1, refined in Phase 1.2)

## Context

The tick awaited `statfs` before re-arming itself. The default disk path is the workspace folder: on a dead SMB/NFS mount `statfs` can hang indefinitely, which froze every widget. Each hung `statfs` also holds one thread of the libuv pool (4 by default), shared by the whole Extension Host.

## Decision

- `statfs` is started without awaiting it; the disk widget is rendered when the result arrives, and its tooltip waits for that result so the reading time never labels old data.
- At most one request is pending for the same paths; a change of `mirabar.disk.drives` (or of the workspace folder) starts a new request and drops the stale result.
- At most two requests are in flight at once (the current one and one superseded, possibly hung).
- A failed read is retried at the next disk interval, not on every wake-up.

## Alternatives considered

- **Await with a timeout**: the hung call still holds a pool thread, and each timeout would start another.
- **Retry on every wake-up**: piles up hung requests until the pool is exhausted.

## Consequences

- A dead mount leaves the other sections running; removing it from `mirabar.disk.drives` recovers at once.
- Covered by `test/extension.test.mjs` ("disk isolation") with a simulated hung `statfs`.
