# Architecture Decision Records

Why MiraBar is built the way it is. Format and conventions: [ADR-0001](0001-record-architecture-decisions.md). How the system works: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

| ADR | Decision | Status | Phase |
| :--- | :--- | :--- | :--- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | — |
| [0002](0002-raii-native-core-and-addon-state.md) | RAII wrappers and per-environment state in the Darwin addon | Accepted | 1.1 |
| [0003](0003-thermal-sampling-background-thread.md) | Temperature read on a native background thread | Accepted | 1.1, 1.2 |
| [0004](0004-battery-data-sources.md) | Battery data sources and "Nominal vs Design" | Accepted | 1.1 |
| [0005](0005-memory-pressure-metric.md) | Memory pressure from the kernel memorystatus level | Accepted | 1.1 |
| [0006](0006-native-build-and-macos-target.md) | Native build flags and macOS 11 target | Accepted (open question) | 1.1 |
| [0007](0007-settings-panel-webview-frontend.md) | Settings gear widget and webview panel over the VS Code settings | Accepted | 1.1, 1.2 |
| [0008](0008-widget-order-priorities.md) | Configurable widget order mapped to status bar priorities | Accepted | 1.1 |
| [0009](0009-per-section-intervals-deadline-scheduler.md) | Per-section status bar and tooltip intervals, deadline scheduler | Accepted | 1.2 |
| [0010](0010-refresh-minimums-from-measurements.md) | Refresh minimums derived from measurements | Accepted | 1.2 |
| [0011](0011-disk-sampling-off-the-event-loop.md) | Disk sampled off the event loop turn, capped requests in flight | Accepted | 1.1, 1.2 |
| [0012](0012-legacy-settings-compatibility.md) | Compatibility with the beta interval settings | Superseded by [0015](0015-name-and-settings-namespace.md) | 1.2 |
| [0013](0013-packaging-and-workflow.md) | Packaging hygiene and development workflow | Accepted | 1.1 |
| [0014](0014-verification-strategy.md) | Verification without a Mac in the loop, measurements on the Mac | Accepted | 1.1, 1.2 |
| [0015](0015-name-and-settings-namespace.md) | Name MiraBar (`fabogit.mirabar`), `mirabar.*` namespace, beta settings removed, version 1.2.0 | Accepted | 1.3 |
| [0016](0016-linux-component-temperatures-async.md) | Linux component temperatures (SSD, RAM, Wi-Fi, battery) read asynchronously, sleeping devices not woken, CPU limit from the kernel | Accepted | 2 |

Open questions recorded in ADRs: macOS 11 support end (0006); fewer temperature sensors per pass (0003); per-platform minimums for Linux and Windows (0010).
