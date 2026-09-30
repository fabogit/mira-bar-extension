import { MAX_INTERVAL_MS, MAX_PRIORITY, MEASURED_MIN_STATUS_BAR_MS, MIN_INTERVAL_MS, MIN_PRIORITY } from '../config.js';

/** Limits shared with config.ts (single source), injected into the panel script and texts. */
const LIMITS = {
  intervalMin: MIN_INTERVAL_MS,
  intervalMax: MAX_INTERVAL_MS,
  measuredMin: MEASURED_MIN_STATUS_BAR_MS,
  priorityMin: MIN_PRIORITY,
  priorityMax: MAX_PRIORITY,
} as const;

/** Sections whose measured minimum is above the absolute one (the only ones the unlock affects). */
const LOCKED_SECTIONS = (Object.keys(MEASURED_MIN_STATUS_BAR_MS) as (keyof typeof MEASURED_MIN_STATUS_BAR_MS)[])
  .filter((s) => MEASURED_MIN_STATUS_BAR_MS[s] > MIN_INTERVAL_MS);

/** Section names for the explanatory texts (the panel script relabels 'freq' per platform). */
const TEXT_NAMES: Record<string, string> = {
  cpu: 'CPU usage', freq: 'system load / CPU frequency', temp: 'temperature', mem: 'memory', battery: 'battery', disk: 'disk',
};

/** 'temperature 2000 ms, battery 2000 ms and disk 2000 ms' for the texts. */
function lockedList(): string {
  const parts = LOCKED_SECTIONS.map((s) => `${TEXT_NAMES[s]} ${MEASURED_MIN_STATUS_BAR_MS[s]} ms`);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** '3600000' -> '1 h', '2000' -> '2000 ms': compact labels for the explanatory texts. */
function label(ms: number): string {
  return ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${ms} ms`;
}

/**
 * HTML for the settings webview. Self-contained: no remote resources, strict CSP, a per-load
 * nonce for the inline style and script, and VS Code theme variables for every color so the
 * panel follows light, dark and high-contrast themes.
 *
 * The embedded script never builds HTML from data: labels are static and values are applied
 * through DOM properties.
 */
export function renderSettingsHtml(nonce: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Resource Monitor Settings</title>
<style nonce="${nonce}">
  :root {
    --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
    --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-button-background);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 28px 40px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.45;
  }
  main { max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h1 { font-size: 1.45em; font-weight: 600; margin: 0; }
  .status { color: var(--muted); font-size: 0.92em; min-height: 1.4em; transition: opacity 0.3s; }
  .status.error { color: var(--vscode-errorForeground); }
  section {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px 18px 16px;
    margin-bottom: 16px;
  }
  h2 { font-size: 0.8em; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  .row { display: grid; grid-template-columns: 210px 1fr; align-items: center; gap: 14px; padding: 7px 0; }
  .row + .row { border-top: 1px solid var(--border); }
  .label { font-weight: 500; }
  .hint { display: block; color: var(--muted); font-size: 0.88em; font-weight: 400; margin-top: 1px; }
  .control { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

  .segmented { display: inline-flex; border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; overflow: hidden; }
  .segmented button {
    border: 0; margin: 0; padding: 4px 14px; font: inherit; cursor: pointer;
    color: var(--vscode-foreground); background: var(--vscode-input-background);
  }
  .segmented button + button { border-left: 1px solid var(--vscode-input-border, var(--border)); }
  .segmented button[aria-pressed="true"] { background: var(--accent); color: var(--vscode-button-foreground); }
  .segmented button:disabled { opacity: 0.5; cursor: default; }

  input[type="range"] { flex: 1 1 180px; min-width: 120px; accent-color: var(--accent); }
  input[type="number"], select, textarea {
    font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; padding: 3px 6px;
  }
  input[type="number"] { width: 84px; text-align: right; }
  textarea { width: 100%; min-height: 54px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
  input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
  .unit { color: var(--muted); min-width: 1.6em; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  .disabled { opacity: 0.5; }

  table.sections { width: 100%; border-collapse: collapse; }
  table.sections th { text-align: left; font-weight: 500; color: var(--muted); font-size: 0.88em; padding: 0 6px 6px; }
  table.sections td { padding: 6px; border-top: 1px solid var(--border); vertical-align: middle; }
  table.sections tr.dragging td { opacity: 0.4; }
  table.sections tr.drop-before td { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  table.sections tr.drop-after td { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .handle { cursor: grab; color: var(--muted); user-select: none; font-size: 1.1em; padding: 0 2px; }
  .name { white-space: nowrap; }
  .refresh { display: flex; align-items: center; gap: 8px; }
  .refresh input[type="range"] { flex: 1 1 120px; min-width: 90px; }
  .refresh input[type="number"] { width: 92px; }
  .refresh input[type="number"]:disabled { opacity: 0.5; }
  .explain { margin: 12px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 0.88em; }
  .explain li + li { margin-top: 4px; }
  .explain b { color: var(--vscode-foreground); font-weight: 600; }
  .eff { display: block; color: var(--muted); font-size: 0.85em; margin-top: 2px; }
  .move { display: inline-flex; gap: 2px; }
  .icon-btn {
    font: inherit; line-height: 1; padding: 3px 6px; border-radius: 3px; cursor: pointer;
    color: var(--vscode-foreground); background: transparent; border: 1px solid transparent;
  }
  .icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .icon-btn:disabled { opacity: 0.35; cursor: default; }
  .note { color: var(--muted); font-size: 0.88em; margin: 10px 0 0; }
  .fast { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); font-weight: 600; }
  .warn-note { color: var(--muted); font-size: 0.88em; margin: 4px 0 0 24px; }

  footer { display: flex; gap: 10px; align-items: center; margin-top: 4px; }
  .btn {
    font: inherit; padding: 5px 14px; border-radius: 3px; cursor: pointer; border: 1px solid transparent;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, var(--vscode-input-background));
  }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .link { background: none; border: 0; padding: 0; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .link:hover { text-decoration: underline; }
  [hidden] { display: none !important; }

  .narrow-only { display: none; }
  @media (max-width: 560px) {
    body { padding: 16px; }
    section { padding: 12px 10px 14px; }
    .row { grid-template-columns: 1fr; gap: 6px; }
    .refresh input[type="range"] { display: none; }
    /* Compact table: no drag handle (the arrows reorder), units in the headers, names may wrap. */
    table.sections th:first-child, table.sections td:first-child { display: none; }
    table.sections td, table.sections th { padding-left: 3px; padding-right: 3px; }
    .refresh .unit { display: none; }
    .refresh input[type="number"] { width: 66px; }
    .name { white-space: normal; }
    .narrow-only { display: inline; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Resource Monitor</h1>
    <span id="status" class="status" role="status" aria-live="polite"></span>
  </header>

  <section aria-labelledby="h-tooltips">
    <h2 id="h-tooltips">Tooltips</h2>
    <div class="row">
      <div class="label">Tooltip mode<span class="hint">Static: at its own interval; Live: with every status bar update</span></div>
      <div class="control">
        <div class="segmented" role="group" aria-label="Tooltip refresh mode" data-setting="tooltip.mode">
          <button type="button" data-value="Static">Static</button>
          <button type="button" data-value="Live">Live</button>
        </div>
      </div>
    </div>
    <div class="row" id="row-autorefresh">
      <div class="label">Auto-refresh<span class="hint">Static tooltips, at each section's tooltip interval below</span></div>
      <div class="control">
        <label class="switch"><input type="checkbox" id="autoRefresh"> <span id="autoRefreshText">On</span></label>
      </div>
    </div>
  </section>

  <section aria-labelledby="h-bar">
    <h2 id="h-bar">Status bar</h2>
    <div class="row">
      <div class="label">Position</div>
      <div class="control">
        <div class="segmented" role="group" aria-label="Status bar side" data-setting="alignment">
          <button type="button" data-value="Left">Left</button>
          <button type="button" data-value="Right">Right</button>
        </div>
        <label>Priority <input type="number" id="priority" min="${LIMITS.priorityMin}" max="${LIMITS.priorityMax}" step="1" aria-label="Status bar priority"></label>
      </div>
    </div>
    <div class="row">
      <div class="label">Settings icon<span class="hint">Gear widget after the metrics</span></div>
      <div class="control">
        <label class="switch"><input type="checkbox" id="showSettings"> Show</label>
      </div>
    </div>
  </section>

  <section aria-labelledby="h-sections">
    <h2 id="h-sections">Sections</h2>
    <table class="sections">
      <thead>
        <tr>
          <th scope="col">Order</th>
          <th scope="col">Show</th>
          <th scope="col">Section</th>
          <th scope="col">Status bar<span class="narrow-only"> (ms)</span></th>
          <th scope="col">Tooltip<span class="narrow-only"> (ms)</span></th>
          <th scope="col"><span hidden>Move</span></th>
        </tr>
      </thead>
      <tbody id="sections"></tbody>
    </table>
    <ul class="explain">
      <li><b>Status bar</b>: how often the section reads its data and updates its text (${label(LIMITS.intervalMin)} to ${label(LIMITS.intervalMax)};
        the slider has preset steps, type any value in the field). Each read has a cost, so some sections have a measured
        minimum: ${lockedList()}.</li>
      <li><b>Tooltip</b>: in Static mode with auto-refresh, how often the tooltip is rebuilt from the latest reading. It never
        refreshes faster than its status bar, because there is no newer reading to show. In Live mode tooltips follow the
        status bar; with auto-refresh off they refresh on click.</li>
      <li>Drag rows (or use the arrows) to reorder the widgets left to right. The note under a value shows what actually
        applies when it differs from the value set.</li>
    </ul>
    <div class="fast">
      <label class="switch"><input type="checkbox" id="allowFast"> Allow status bar intervals below the measured minimums<span class="warn">*</span></label>
      <p class="warn-note"><span class="warn">* Performance impact.</span> The minimums (${lockedList()}) are the intervals at which each
        section's reads use its share of the extension's CPU budget (0.5% of one core for all six sections together).
        Below them, reads cost more CPU time and energy than that budget. With this on, every status bar interval can go down to
        ${label(LIMITS.intervalMin)}. Values set below a minimum are kept and apply whenever this is on.</p>
    </div>
  </section>

  <section aria-labelledby="h-display">
    <h2 id="h-display">Display</h2>
    <div class="row">
      <div class="label">CPU cores</div>
      <div class="control">
        <div class="segmented" role="group" aria-label="CPU core layout" data-setting="tooltip.cpuLayout">
          <button type="button" data-value="Table">Table</button>
          <button type="button" data-value="List">List</button>
        </div>
      </div>
    </div>
    <div class="row" data-platform="darwin">
      <div class="label">System load</div>
      <div class="control">
        <div class="segmented" role="group" aria-label="System load format" data-setting="loadFormat">
          <button type="button" data-value="Percent">Percent</button>
          <button type="button" data-value="Value">Value</button>
        </div>
      </div>
    </div>
    <div class="row" data-platform="linux">
      <div class="label">Frequency unit</div>
      <div class="control"><select id="freqUnit" data-select="freq.unit" aria-label="Frequency unit">
        <option>GHz</option><option>MHz</option><option>KHz</option><option>Hz</option>
      </select></div>
    </div>
    <div class="row">
      <div class="label">Memory unit</div>
      <div class="control"><select id="memUnit" data-select="mem.unit" aria-label="Memory unit">
        <option>GB</option><option>MB</option><option>KB</option><option>B</option>
      </select></div>
    </div>
    <div class="row">
      <div class="label">Disk value</div>
      <div class="control"><select id="diskFormat" data-select="disk.format" aria-label="Disk value format">
        <option value="PercentRemaining">Percent free</option>
        <option value="PercentUsed">Percent used</option>
        <option value="Remaining">Free space</option>
        <option value="UsedOutOfTotal">Used / total</option>
      </select></div>
    </div>
    <div class="row">
      <div class="label">Several disks</div>
      <div class="control">
        <div class="segmented" role="group" aria-label="Multiple disk display" data-setting="disk.multiDisplay">
          <button type="button" data-value="All">All</button>
          <button type="button" data-value="MostFull">Most full</button>
        </div>
      </div>
    </div>
    <div class="row">
      <div class="label">Disk paths<span class="hint">One per line; empty = workspace or /</span></div>
      <div class="control"><textarea id="diskDrives" spellcheck="false" aria-label="Disk paths, one per line"></textarea></div>
    </div>
  </section>

  <footer>
    <button type="button" class="btn" id="reset">Restore defaults</button>
    <button type="button" class="link" id="openJson">Open in VS Code Settings</button>
  </footer>
</main>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const SECTIONS = {
    cpu: { label: 'CPU usage', show: 'show.cpuusage' },
    freq: { label: 'System load', show: 'show.cpufreq' },
    temp: { label: 'Temperature', show: 'show.cputemp' },
    mem: { label: 'Memory', show: 'show.mem' },
    battery: { label: 'Battery', show: 'show.battery' },
    disk: { label: 'Disk', show: 'show.disk' }
  };
  // Slider presets (ms): denser at the low end, where precision matters; the number fields take any value.
  const STOPS = [200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000,
    45000, 60000, 120000, 300000, 600000, 1800000, 3600000];
  const LIMITS = ${JSON.stringify(LIMITS)};
  const MIN = LIMITS.intervalMin, MAX = LIMITS.intervalMax;

  /** Index of the preset closest to ms (log scale), for positioning a slider. */
  function nearestStop(stops, ms) {
    let best = 0;
    for (let i = 1; i < stops.length; i++) {
      if (Math.abs(Math.log(stops[i] / ms)) < Math.abs(Math.log(stops[best] / ms))) { best = i; }
    }
    return best;
  }
  let values = null;
  let platform = 'darwin';
  let dragId = null;
  let statusTimer = null;

  const $ = function (id) { return document.getElementById(id); };

  function send(key, value) {
    vscode.postMessage({ type: 'update', key: key, value: value });
  }

  function showStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('error', Boolean(isError));
    clearTimeout(statusTimer);
    if (!isError) {
      statusTimer = setTimeout(function () { el.textContent = ''; }, 1600);
    }
  }

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function isFocused(el) { return document.activeElement === el; }

  // Segmented controls (enums).
  document.querySelectorAll('.segmented[data-setting]').forEach(function (group) {
    group.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-value]');
      if (!btn || btn.disabled) { return; }
      send(group.dataset.setting, btn.dataset.value);
    });
  });

  // Selects (enums).
  document.querySelectorAll('select[data-select]').forEach(function (sel) {
    sel.addEventListener('change', function () { send(sel.dataset.select, sel.value); });
  });

  $('autoRefresh').addEventListener('change', function (e) { send('tooltip.autoRefresh', e.target.checked); });
  $('showSettings').addEventListener('change', function (e) { send('show.settings', e.target.checked); });
  $('allowFast').addEventListener('change', function (e) { send('allowFastRefresh', e.target.checked); });

  $('priority').addEventListener('change', function (e) {
    const v = clamp(Math.round(Number(e.target.value) || 0), LIMITS.priorityMin, LIMITS.priorityMax);
    e.target.value = v;
    send('priority', v);
  });

  $('diskDrives').addEventListener('change', function (e) {
    const paths = e.target.value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
    send('disk.drives', paths);
  });

  $('reset').addEventListener('click', function () { vscode.postMessage({ type: 'reset' }); });
  $('openJson').addEventListener('click', function () { vscode.postMessage({ type: 'openJson' }); });

  /** Minimum status bar interval of a section with the current unlock setting. */
  function minFor(id) {
    return values.allowFastRefresh ? MIN : Math.max(MIN, LIMITS.measuredMin[id]);
  }

  /** Status bar interval that applies for a stored value. */
  function effectiveBar(id, ms) { return Math.max(ms, minFor(id)); }

  /** Note under the status bar value, when what applies differs from the value set. */
  function barNote(id, ms) {
    const min = minFor(id);
    return ms < min ? 'locked at ' + min + ' ms (measured minimum)' : '';
  }

  /** Note under the tooltip value, when what applies differs from the value set. */
  function tooltipNote(id, tooltipMs, barMs) {
    if (values['tooltip.mode'] === 'Live') { return 'Live: follows the status bar'; }
    if (!values['tooltip.autoRefresh']) { return 'auto-refresh off: on click'; }
    const bar = effectiveBar(id, barMs);
    return tooltipMs < bar ? 'follows the status bar (' + bar + ' ms)' : '';
  }

  function setNote(el, text) {
    el.textContent = text;
    el.hidden = text === '';
  }

  /** Sends one section's value of an interval object ('statusBarMs' or 'tooltipMs'). */
  function sendInterval(key, id, ms) {
    const next = Object.assign({}, values[key]);
    next[id] = ms;
    values[key] = next;
    send(key, next);
  }

  function moveSection(id, delta) {
    const order = values.order.slice();
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) { return; }
    order.splice(from, 1);
    order.splice(to, 0, id);
    values.order = order;
    renderSections();
    send('order', order);
  }

  /** DOM references of each section row, so state updates can be applied in place. */
  const rows = {};

  /** Creates a section row (structure and listeners only); values are applied by updateRow(). */
  function makeRow(id) {
    const meta = SECTIONS[id];
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.id = id;

    const tdHandle = document.createElement('td');
    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.textContent = '\\u2261';
    handle.title = 'Drag to reorder';
    handle.setAttribute('aria-hidden', 'true');
    tdHandle.appendChild(handle);

    const tdShow = document.createElement('td');
    const show = document.createElement('input');
    show.type = 'checkbox';
    show.setAttribute('aria-label', 'Show ' + meta.label);
    show.addEventListener('change', function () { send(meta.show, show.checked); });
    tdShow.appendChild(show);

    const tdName = document.createElement('td');
    tdName.className = 'name';

    const tdBar = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'refresh';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(STOPS.length - 1);
    range.step = '1';
    range.setAttribute('aria-label', meta.label + ' status bar interval (preset steps)');
    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(MIN);
    num.max = String(MAX);
    num.step = '50';
    num.setAttribute('aria-label', meta.label + ' status bar interval in milliseconds');
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 'ms';
    const barEff = document.createElement('span');
    barEff.className = 'eff';
    function refreshNotes(barMs) {
      setNote(barEff, barNote(id, barMs));
      setNote(tipEff, tooltipNote(id, Number(tip.value) || values.tooltipMs[id], barMs));
    }
    // Steps below the minimum snap up to it while it is locked; the field accepts any value in bounds.
    function stepValue() { return Math.max(minFor(id), STOPS[Number(range.value)]); }
    range.addEventListener('input', function () { num.value = stepValue(); refreshNotes(stepValue()); });
    range.addEventListener('change', function () {
      const v = stepValue();
      range.value = String(nearestStop(STOPS, v));
      sendInterval('statusBarMs', id, v);
    });
    num.addEventListener('change', function () {
      const v = clamp(Math.round(Number(num.value) || minFor(id)), MIN, MAX);
      num.value = v;
      range.value = String(nearestStop(STOPS, v));
      refreshNotes(v);
      sendInterval('statusBarMs', id, v);
    });
    wrap.append(range, num, unit);
    tdBar.append(wrap, barEff);

    const tdTip = document.createElement('td');
    const tipWrap = document.createElement('div');
    tipWrap.className = 'refresh';
    const tip = document.createElement('input');
    tip.type = 'number';
    tip.min = String(MIN);
    tip.max = String(MAX);
    tip.step = '50';
    tip.setAttribute('aria-label', meta.label + ' tooltip interval in milliseconds');
    const tipUnit = document.createElement('span');
    tipUnit.className = 'unit';
    tipUnit.textContent = 'ms';
    const tipEff = document.createElement('span');
    tipEff.className = 'eff';
    tip.addEventListener('change', function () {
      const v = clamp(Math.round(Number(tip.value) || values.tooltipMs[id]), MIN, MAX);
      tip.value = v;
      setNote(tipEff, tooltipNote(id, v, values.statusBarMs[id]));
      sendInterval('tooltipMs', id, v);
    });
    tipWrap.append(tip, tipUnit);
    tdTip.append(tipWrap, tipEff);

    const tdMove = document.createElement('td');
    const move = document.createElement('span');
    move.className = 'move';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'icon-btn';
    up.textContent = '\\u25B2';
    up.setAttribute('aria-label', 'Move ' + meta.label + ' left');
    up.addEventListener('click', function () { moveSection(id, -1); });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'icon-btn';
    down.textContent = '\\u25BC';
    down.setAttribute('aria-label', 'Move ' + meta.label + ' right');
    down.addEventListener('click', function () { moveSection(id, 1); });
    move.append(up, down);
    tdMove.appendChild(move);

    tr.append(tdHandle, tdShow, tdName, tdBar, tdTip, tdMove);

    tr.addEventListener('dragstart', function (e) {
      dragId = id;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    tr.addEventListener('dragend', function () {
      dragId = null;
      document.querySelectorAll('#sections tr').forEach(function (r) {
        r.classList.remove('dragging', 'drop-before', 'drop-after');
      });
    });
    tr.addEventListener('dragover', function (e) {
      if (!dragId || dragId === id) { return; }
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      tr.classList.toggle('drop-after', after);
      tr.classList.toggle('drop-before', !after);
    });
    tr.addEventListener('dragleave', function () { tr.classList.remove('drop-before', 'drop-after'); });
    tr.addEventListener('drop', function (e) {
      e.preventDefault();
      if (!dragId || dragId === id) { return; }
      const after = tr.classList.contains('drop-after');
      const order = values.order.filter(function (s) { return s !== dragId; });
      const target = order.indexOf(id) + (after ? 1 : 0);
      order.splice(target, 0, dragId);
      values.order = order;
      dragId = null;
      renderSections();
      send('order', order);
    });

    rows[id] = { tr: tr, show: show, name: tdName, range: range, num: num, barEff: barEff, tip: tip, tipEff: tipEff, up: up, down: down };
    return tr;
  }

  /** Applies the current state to a row, leaving a field the user is editing untouched. */
  function updateRow(id, index, count) {
    const r = rows[id];
    const meta = SECTIONS[id];
    const bar = values.statusBarMs[id];
    const tooltip = values.tooltipMs[id];
    r.name.textContent = meta.label;
    r.show.checked = Boolean(values[meta.show]);
    if (!isFocused(r.num) && !isFocused(r.range)) {
      r.num.value = String(bar);
      r.range.value = String(nearestStop(STOPS, bar));
    }
    if (!isFocused(r.tip)) { r.tip.value = String(tooltip); }
    r.tip.disabled = values['tooltip.mode'] === 'Live' || !values['tooltip.autoRefresh'];
    const barShown = isFocused(r.num) ? Number(r.num.value) || bar : bar;
    setNote(r.barEff, barNote(id, barShown));
    setNote(r.tipEff, tooltipNote(id, isFocused(r.tip) ? Number(r.tip.value) || tooltip : tooltip, barShown));
    r.up.disabled = index === 0;
    r.down.disabled = index === count - 1;
  }

  /**
   * Renders the section rows. Rows are updated in place on every state message (so typing, focus and
   * drag and drop are never interrupted); the table is rebuilt only when the order changes.
   */
  function renderSections() {
    const tbody = $('sections');
    const shown = Array.prototype.map.call(tbody.children, function (tr) { return tr.dataset.id; });
    if (shown.join() !== values.order.join()) {
      const active = document.activeElement;
      const focusKey = active && tbody.contains(active) ? active.getAttribute('aria-label') : null;
      tbody.replaceChildren();
      values.order.forEach(function (id) { tbody.appendChild(rows[id] ? rows[id].tr : makeRow(id)); });
      if (focusKey) {
        const again = Array.prototype.find.call(tbody.querySelectorAll('[aria-label]'), function (el) {
          return el.getAttribute('aria-label') === focusKey;
        });
        if (again) { again.focus(); }
      }
    }
    values.order.forEach(function (id, i) { updateRow(id, i, values.order.length); });
  }

  function render() {
    SECTIONS.freq.label = platform === 'darwin' ? 'System load' : 'CPU frequency';
    document.querySelectorAll('[data-platform]').forEach(function (el) {
      el.hidden = el.dataset.platform !== (platform === 'darwin' ? 'darwin' : 'linux');
    });

    document.querySelectorAll('.segmented[data-setting]').forEach(function (group) {
      const current = values[group.dataset.setting];
      group.querySelectorAll('button[data-value]').forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.dataset.value === current));
      });
    });
    document.querySelectorAll('select[data-select]').forEach(function (sel) {
      if (!isFocused(sel)) { sel.value = values[sel.dataset.select]; }
    });

    const live = values['tooltip.mode'] === 'Live';
    const auto = $('autoRefresh');
    auto.checked = Boolean(values['tooltip.autoRefresh']);
    auto.disabled = live;
    $('autoRefreshText').textContent = live ? 'Not used in Live mode' : (auto.checked ? 'On' : 'Off (refresh on click)');
    $('row-autorefresh').classList.toggle('disabled', live);

    if (!isFocused($('priority'))) { $('priority').value = values.priority; }
    $('showSettings').checked = Boolean(values['show.settings']);
    $('allowFast').checked = Boolean(values.allowFastRefresh);
    if (!isFocused($('diskDrives'))) { $('diskDrives').value = (values['disk.drives'] || []).join('\\n'); }

    if (!dragId) { renderSections(); }
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'state') {
      values = msg.values;
      platform = msg.platform;
      render();
    } else if (msg.type === 'saved') {
      showStatus('Saved', false);
    } else if (msg.type === 'error') {
      showStatus(String(msg.message), true);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
