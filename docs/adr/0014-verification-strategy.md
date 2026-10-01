# ADR-0014: Verification without a Mac in the loop, measurements on the Mac

- **Status**: Accepted
- **Date**: 2026-09-29 (Phase 1.1), extended 2026-10-01 (Phase 1.2)

## Context

Development ran partly in a Linux cloud environment, where the macOS addon cannot be compiled or run, and partly on an Apple M4 used for real measurements. Ownership, threading and lifecycle bugs need automatic checks; values and timings need the real hardware.

## Decision

- **Linux, automatic**: mocks of the Mach/CF/IOKit/IOHID APIs with reference counters, compiled with the real `addon.cc` under ASan/UBSan and TSan (leaked CF objects, host port references, VM regions, thread races). The mocks live outside the repository for now.
- **Extension logic, automatic and cross-platform**: `test/harness/vscode-mock.cjs` (returns `package.json` defaults like VS Code) and `test/extension.test.mjs` (`pnpm run test:extension`): schedule, tooltips, minimums, legacy settings, panel, disk isolation, lifecycle, heap growth.
- **Settings panel UI**: rendered in Chromium with both themes, narrow width, drag and drop (session tooling, not in the repository yet).
- **On the Mac**: `test:darwin` smoke test, `test/leak-darwin.mjs` (µs per call, RSS, Mach ports), `hid_bench`, `bench:darwin` and `bench:extension` for the minimums, then the VSIX in VS Code.
- Larger changes get an independent review pass before they are committed.

## Consequences

- Ownership and lifecycle bugs were caught before reaching the Mac (several in review).
- **Linux hardware paths (cpufreq, hwmon, battery sysfs) have only run in a VM without those devices.** They must be checked on a real Linux machine before `develop` is pushed (Phase 2).
- Follow-ups: move the Apple-API mocks and the panel UI test into the repository; run `test:extension` in CI (both jobs).
