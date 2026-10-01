# Rename Plan: Resource Monitor NG → MiraBar

- **Status**: Proposed (2026-10-01)
- **Branch**: `chore/rename-mirabar` from `develop`
- **Scope**: extension identity, settings prefix, commands, UI strings, tests, packaging, docs. No change to telemetry, native code or behaviour.

## 1. Why

"Resource Monitor NG" reads as a fork of the older *Resource Monitor* extension, and `resmon` says nothing to a new user. Alternatives were discarded for collisions: *MIRA* exists (Markdown Inline Rendering Apparatus), *System Monitor Status Bar* / `sysmon` is `letermeflorent.sysmon-statusbar` (comparison in the Resmon project notes), *Sysmon* is Microsoft Sysinternals. The extension is still in beta and distributed as VSIX, so breaking the identity now costs nothing to users.

## 2. Target identity

| Item | Today | After |
| :--- | :--- | :--- |
| `package.json` `name` (ID) | `resource-monitor-ng` | `mirabar` |
| Full extension ID | `fabogit.resource-monitor-ng` | `fabogit.mirabar` |
| `displayName` | `Resource Monitor NG` | `MiraBar: System Monitor for the Status Bar` |
| `description` | Ultra-lightweight, zero-overhead Linux & macOS... | `CPU, memory pressure, temperature, battery and disk in the status bar. Native, zero subprocesses (macOS Apple Silicon, Linux).` |
| Settings prefix | `resmon.*` | `mirabar.*` |
| Command IDs | `resmon.refresh`, ... | `mirabar.refresh`, ... |
| Command titles | `Resource Monitor: Refresh Stats` | `category: "MiraBar"`, `title: "Refresh Stats"` |
| Configuration title | `Resource Monitor Configuration` | `MiraBar` |
| Output channel / log prefix | `Resource Monitor NG` / `[Resource Monitor NG]` | `MiraBar` / `[MiraBar]` |
| Status bar item names | `Resource Monitor: CPU usage`, `Resource Monitor Settings` | `MiraBar: CPU usage`, `MiraBar Settings` |
| Webview `viewType` / title | `resmon.settings` / `Resource Monitor Settings` | `mirabar.settings` / `MiraBar Settings` |
| VSIX file | `resource-monitor-ng-<target>-<ver>.vsix` | `mirabar-<target>-<ver>.vsix` (derived from `name`) |
| Config type | `ResMonConfig` | `MiraBarConfig` |
| Monitor class | `ResourceMonitor` | unchanged (describes what it does, not the brand) |
| Native addon | `darwin_telemetry.node` | unchanged |
| Spoken name | — | "Mira Bar" |

Why `mirabar.*` and not `mira.*`: setting keys are global across extensions, and the existing MIRA extension may already own `mira.*`.

## 3. Decisions to take before starting

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| D1 | Legacy settings (`updatefrequencyms`, `refreshMs`, `refreshSeconds`, `allowFastBatteryDiskRefresh`, ADR-0012) | **Drop them.** A new extension ID starts with no settings, so there is nothing to fall back to. Removes the fallback chain in `src/config.ts`, the migration in `src/settings/schema.ts` and its tests. ADR-0012 becomes *Superseded by ADR-0015*. |
| D2 | Import `resmon.*` values into `mirabar.*` on first activation | **No.** Only the developer has them; migrate `settings.json` by hand (§5, step 9). Possible later with `getConfiguration('resmon').inspect()`, which still reads keys no extension declares. |
| D3 | Version | **2.0.0**: every setting and command ID changes, which is a breaking change under semver, and it includes the unreleased Phases 1.1-1.2 (planned as v1.1.1). Milestones v1.2.0-v1.4.0 move to 2.1.0-2.3.0 when touched. |
| D4 | GitHub repository name | **Rename to `fabogit/mirabar`** as the last step. GitHub redirects old URLs and clones; update the local remote with `git remote set-url origin`. About 40 links in the docs point to the old name and keep working through the redirect; update them in the same commit anyway. |
| D5 | Icon | Out of scope; `images/icon.png` stays until a new one exists. |
| D6 | Historical documents | Do not rewrite ADR-0001 to 0014 or `docs/audit-darwin-memory-2026-09.md`: they record what was true then. Only forward-looking docs are updated. |

## 4. Prerequisites

1. Commit or stash the pending change to `pnpm-workspace.yaml` on `develop`.
2. Check that `mirabar` is free as an extension name on the **VS Code Marketplace** and on **Open VSX** (Antigravity, Cursor and VSCodium install from Open VSX), and that the `fabogit` namespace is available or owned there.
3. `git switch develop && git switch -c chore/rename-mirabar`.

## 5. Steps

One commit per step keeps the history readable and each step testable.

### Step 1: `package.json`

- `name`, `displayName`, `description`, `version` (D3), `keywords` (`cpu`, `memory`, `temperature`, `battery`, `disk`, `status bar`, `system monitor`, `apple silicon`), `categories` (`Visualization`, `Other`).
- `contributes.commands`: IDs `resmon.*` → `mirabar.*`; add `"category": "MiraBar"` and drop the `Resource Monitor:` prefix from titles.
- `contributes.configuration`: `title: "MiraBar"`; every key `resmon.*` → `mirabar.*`; delete the four legacy keys (D1).
- `repository.url` only if D4 is done in the same branch.

### Step 2: settings prefix and command IDs in `src/`

| File | Change |
| :--- | :--- |
| `src/config.ts` | `getConfiguration('resmon')` (2×) → `'mirabar'`; remove `legacySectionMs`, the `updatefrequencyms` fallback and `allowFastBatteryDiskRefresh`; `ResMonConfig` → `MiraBarConfig`; doc comments |
| `src/settings/schema.ts` | `getConfiguration('resmon')` (2×); remove `LEGACY_INTERVAL_KEYS` and the migration branch; doc comments |
| `src/settings/panel.ts` | `viewType` `mirabar.settings`, title `MiraBar Settings`, `openSettings` search filter `mirabar.`; simplify the message queue comment (no legacy migration left; keep the queue) |
| `src/settings/panel_html.ts` | `<title>` and `<h1>` |
| `src/extension.ts` | output channel name, toast prefix `MiraBar:`, `affectsConfiguration('mirabar')`, the 7 command IDs |
| `src/monitor.ts` | item names, settings item name, command links (`mirabar.refresh`, `mirabar.openSettings`, toggles), gear tooltip heading |
| `src/sections.ts` | command links in the tooltip footer; `MiraBarConfig` import |
| `src/platform/darwin/native_loader.ts` | log prefix `[MiraBar]` (2×) |
| `src/platform/linux/linux_provider.ts` | doc comment `mirabar.statusBarMs.temp` |

### Step 3: tests

- `test/harness/vscode-mock.cjs`: regex `^resmon\.` → `^mirabar\.`.
- `test/extension.test.mjs`: item names, command IDs, gear table string. Delete the legacy fallback cases (lines ~116-131). In the panel test (lines ~157-170) drop the legacy assertions but keep the two back-to-back edits: they check that panel messages are serialized, which still matters. Add a check that the four legacy keys are absent from `package.json`.
- `test/integration.ts`, `test/smoke-linux.ts`: banner strings.

### Step 4: build and packaging

- `release.yml`, `.vscodeignore`, `esbuild.js`, `native/darwin/*`: no change needed (globs and neutral names); confirm with the grep in §6.
- Delete the stale `resource-monitor-ng-darwin-arm64-1.1.0.vsix` from the repository root (ignored by git).

### Step 5: user-facing docs

- `README.md`: title, intro, install commands with the new VSIX names and `fabogit.mirabar`, command and settings tables, "Migrating from Resource Monitor NG" note (uninstall the old extension, settings are not carried over).
- `CHANGELOG.md`: create it (there is none yet) with 2.0.0: rename, new prefix, removed legacy keys, plus Phases 1.1-1.2.

### Step 6: architecture docs

- `docs/ARCHITECTURE.md`, `docs/DARWIN_APPLE_SILICON.md`, `docs/LINUX_IMPLEMENTATION_PLAN.md`, `docs/ROADMAP.md`: product name and setting keys. Drop the legacy-settings paragraph in ARCHITECTURE ("The first interval edit with pre-release settings..."). ROADMAP: vision line, status table, a "Rename to MiraBar (v2.0.0)" entry, release follow-up updated.
- `docs/adr/0015-rename-to-mirabar.md`: new ADR (context, the collisions in §1, D1-D6). Mark ADR-0012 *Superseded by ADR-0015* in its status line and in `docs/adr/README.md`; update the README intro line.

### Step 7: verify (§6)

### Step 8: repository rename (D4)

On GitHub, then `git remote set-url origin https://github.com/fabogit/mirabar.git`; replace the remaining `resource-monitor_code-extension` links in docs and `package.json`.

### Step 9: local switch on the Mac

1. Uninstall `fabogit.resource-monitor-ng` from Antigravity and VS Code, otherwise both extensions run side by side.
2. In the user `settings.json`, rename the keys: `sed -i '' 's/"resmon\./"mirabar./' "$HOME/Library/Application Support/Antigravity/User/settings.json"` (check the path; same for VS Code under `Code/User`), and delete the legacy keys if present.
3. Install `mirabar-darwin-arm64-2.0.0.vsix`.

## 6. Verification

1. No leftover names outside historical docs:
   ```bash
   grep -rnI -iE 'resmon|resource[ -]?monitor ng|resource-monitor-ng|ResMonConfig' \
     --exclude-dir={node_modules,dist,.git} --exclude=pnpm-lock.yaml --exclude='*.vsix' . \
     | grep -vE '^./docs/(adr/00(0[1-9]|1[0-4])-|audit-darwin-memory|RENAME_MIRABAR_PLAN)'
   ```
   Expected: no output (before D4, also allow `resource-monitor_code-extension` URLs).
2. `pnpm run typecheck && pnpm run build && pnpm run test:extension && pnpm run test:integration`; on the Mac also `pnpm run test:darwin`.
3. `pnpm run package:darwin-arm64` produces `mirabar-darwin-arm64-2.0.0.vsix`; `npx vsce ls` shows no unexpected files.
4. In Antigravity on the M4:
   - Extensions view shows *MiraBar: System Monitor for the Status Bar*, ID `fabogit.mirabar`.
   - Command palette: commands grouped under *MiraBar*; every toggle works.
   - Settings UI: section *MiraBar*, keys `mirabar.*`, no deprecated keys.
   - Status bar right-click menu: items named *MiraBar: ...*.
   - Output panel channel *MiraBar*; gear tooltip links and settings panel (title, search filter `mirabar.`) work.
   - Changing `mirabar.order` and intervals applies live.
5. CI: `gh workflow run release.yml --ref chore/rename-mirabar`, both jobs green, artifacts named `mirabar-*.vsix`.

## 7. Effort and risk

- 19 files touched today by the grep in §6.1, plus the new ADR and CHANGELOG; mostly mechanical; the only logic change is removing the legacy fallbacks (D1), which shrinks `config.ts`, `schema.ts` and the tests. Estimate: half a day including verification on the Mac.
- Risk: a missed `resmon.` string in a command link or `affectsConfiguration` makes a button or a live update silently do nothing. The grep in §6.1 and the tooltip-link assertions in `test/extension.test.mjs` cover it.
- Rollback: drop the branch; nothing is published until the release tag.
