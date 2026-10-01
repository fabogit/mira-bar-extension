# ADR-0007: Settings gear widget and webview panel over the VS Code settings

- **Status**: Accepted
- **Date**: 2026-09-30 (Phase 1.1), tables in the gear tooltip 2026-10-01 (Phase 1.2)

## Context

The data tooltips had accumulated mode and layout toggles, and interval settings were only editable as raw numbers in `settings.json`. The user asked for a dedicated status bar icon holding all toggles and option values, with sliders and millisecond fields, so the data tooltips show only data.

## Decision

- A gear widget after the metrics (`resmon.show.settings`). Its tooltip holds two tables: the sections in status bar order (shown, status bar and tooltip intervals in effect, `*` where a value was raised to its measured minimum) and the display options with one-click toggles (a Markdown table, because command links cannot live in a code block). A click opens the panel.
- A webview panel (`src/settings/`), singleton, that is **only a front-end**: every message is checked against a whitelist (`EDITABLE_SETTINGS`), validated and clamped, then written to the user settings. `settings.json` stays the single source of truth; edits made there are reflected in the panel.
- Strict Content Security Policy with a per-load nonce, no remote resources, VS Code theme variables only.
- Rows are updated in place (a state message never interrupts typing or dragging); stored values that the user did not edit are never rewritten; messages are handled one at a time.
- Data tooltips end with the reading time and *Settings* / *Refresh* links only.

## Alternatives considered

- **Toggles inside the data tooltips**: noise in every tooltip.
- **A sidebar view**: takes space permanently for something used rarely.
- **Only the VS Code Settings UI**: no sliders, no per-section overview, no notes on effective values.

## Consequences

- One panel to keep in sync with `package.json`; `test/extension.test.mjs` checks the whitelist, validation, migration and CSP.
- The panel test in Chromium (theme, narrow width, drag and drop) runs outside the repository for now (ADR-0014).
