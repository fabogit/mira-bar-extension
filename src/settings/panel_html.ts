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
  main { max-width: 780px; margin: 0 auto; }
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
  .refresh input[type="range"] { flex: 1 1 140px; }
  .refresh input[type="number"] { width: 66px; }
  .move { display: inline-flex; gap: 2px; }
  .icon-btn {
    font: inherit; line-height: 1; padding: 3px 6px; border-radius: 3px; cursor: pointer;
    color: var(--vscode-foreground); background: transparent; border: 1px solid transparent;
  }
  .icon-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .icon-btn:disabled { opacity: 0.35; cursor: default; }
  .note { color: var(--muted); font-size: 0.88em; margin: 10px 0 0; }

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

  @media (max-width: 560px) {
    body { padding: 16px; }
    .row { grid-template-columns: 1fr; gap: 6px; }
    .refresh input[type="range"] { display: none; }
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
      <div class="label">Refresh mode<span class="hint">Live follows every status bar tick</span></div>
      <div class="control">
        <div class="segmented" role="group" aria-label="Tooltip refresh mode" data-setting="tooltip.mode">
          <button type="button" data-value="Static">Static</button>
          <button type="button" data-value="Live">Live</button>
        </div>
      </div>
    </div>
    <div class="row" id="row-autorefresh">
      <div class="label">Auto-refresh<span class="hint">Static tooltips, at each section's interval below</span></div>
      <div class="control">
        <label class="switch"><input type="checkbox" id="autoRefresh"> <span id="autoRefreshText">On</span></label>
      </div>
    </div>
  </section>

  <section aria-labelledby="h-bar">
    <h2 id="h-bar">Status bar</h2>
    <div class="row">
      <div class="label">Update interval<span class="hint">CPU, load and memory values</span></div>
      <div class="control">
        <input type="range" id="freqRange" min="200" max="15000" step="100" aria-label="Update interval (milliseconds)">
        <input type="number" id="freqNumber" min="200" max="15000" step="100" aria-label="Update interval in milliseconds">
        <span class="unit">ms</span>
      </div>
    </div>
    <div class="row">
      <div class="label">Position</div>
      <div class="control">
        <div class="segmented" role="group" aria-label="Status bar side" data-setting="alignment">
          <button type="button" data-value="Left">Left</button>
          <button type="button" data-value="Right">Right</button>
        </div>
        <label>Priority <input type="number" id="priority" min="-10000" max="10000" step="1" aria-label="Status bar priority"></label>
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
          <th scope="col">Refresh</th>
          <th scope="col"><span hidden>Move</span></th>
        </tr>
      </thead>
      <tbody id="sections"></tbody>
    </table>
    <p class="note">Drag rows (or use the arrows) to reorder the widgets left to right. Refresh sets the Static tooltip
      auto-refresh; battery, disk and temperature are also sampled at that interval (temperature at least every 2 s).</p>
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
  const REFRESH_SLIDER_MAX = 60;
  const REFRESH_MAX = 3600;
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

  // Update interval: the slider previews while dragging and saves on release; the field saves on change.
  $('freqRange').addEventListener('input', function (e) { $('freqNumber').value = e.target.value; });
  $('freqRange').addEventListener('change', function (e) { send('updatefrequencyms', Number(e.target.value)); });
  $('freqNumber').addEventListener('change', function (e) {
    const v = clamp(Math.round(Number(e.target.value) || 2000), 200, 15000);
    e.target.value = v;
    $('freqRange').value = v;
    send('updatefrequencyms', v);
  });

  $('priority').addEventListener('change', function (e) {
    const v = clamp(Math.round(Number(e.target.value) || 0), -10000, 10000);
    e.target.value = v;
    send('priority', v);
  });

  $('diskDrives').addEventListener('change', function (e) {
    const paths = e.target.value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean);
    send('disk.drives', paths);
  });

  $('reset').addEventListener('click', function () { vscode.postMessage({ type: 'reset' }); });
  $('openJson').addEventListener('click', function () { vscode.postMessage({ type: 'openJson' }); });

  function sendRefresh(id, seconds) {
    const next = Object.assign({}, values.refreshSeconds);
    next[id] = seconds;
    values.refreshSeconds = next;
    send('refreshSeconds', next);
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

  function makeRow(id, index, count) {
    const meta = SECTIONS[id];
    const minSeconds = id === 'temp' ? 2 : 1;
    const seconds = values.refreshSeconds[id];
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
    show.checked = Boolean(values[meta.show]);
    show.setAttribute('aria-label', 'Show ' + meta.label);
    show.addEventListener('change', function () { send(meta.show, show.checked); });
    tdShow.appendChild(show);

    const tdName = document.createElement('td');
    tdName.className = 'name';
    tdName.textContent = meta.label;

    const tdRefresh = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'refresh';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(minSeconds);
    range.max = String(REFRESH_SLIDER_MAX);
    range.step = '1';
    range.value = String(Math.min(seconds, REFRESH_SLIDER_MAX));
    range.setAttribute('aria-label', meta.label + ' refresh (seconds)');
    const num = document.createElement('input');
    num.type = 'number';
    num.min = String(minSeconds);
    num.max = String(REFRESH_MAX);
    num.step = '1';
    num.value = String(seconds);
    num.setAttribute('aria-label', meta.label + ' refresh in seconds');
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = 's';
    range.addEventListener('input', function () { num.value = range.value; });
    range.addEventListener('change', function () { sendRefresh(id, Number(range.value)); });
    num.addEventListener('change', function () {
      const v = clamp(Math.round(Number(num.value) || minSeconds), minSeconds, REFRESH_MAX);
      num.value = v;
      range.value = String(Math.min(v, REFRESH_SLIDER_MAX));
      sendRefresh(id, v);
    });
    wrap.append(range, num, unit);
    tdRefresh.appendChild(wrap);

    const tdMove = document.createElement('td');
    const move = document.createElement('span');
    move.className = 'move';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'icon-btn';
    up.textContent = '\\u25B2';
    up.disabled = index === 0;
    up.setAttribute('aria-label', 'Move ' + meta.label + ' left');
    up.addEventListener('click', function () { moveSection(id, -1); });
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'icon-btn';
    down.textContent = '\\u25BC';
    down.disabled = index === count - 1;
    down.setAttribute('aria-label', 'Move ' + meta.label + ' right');
    down.addEventListener('click', function () { moveSection(id, 1); });
    move.append(up, down);
    tdMove.appendChild(move);

    tr.append(tdHandle, tdShow, tdName, tdRefresh, tdMove);

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
    return tr;
  }

  function renderSections() {
    const tbody = $('sections');
    const active = document.activeElement;
    // Do not rebuild while the user is editing a field in the table.
    if (active && tbody.contains(active) && active.tagName === 'INPUT' && active.type === 'number') { return; }
    const focusKey = active && tbody.contains(active) ? active.getAttribute('aria-label') : null;
    tbody.replaceChildren();
    values.order.forEach(function (id, i) { tbody.appendChild(makeRow(id, i, values.order.length)); });
    if (focusKey) {
      const again = Array.prototype.find.call(tbody.querySelectorAll('[aria-label]'), function (el) {
        return el.getAttribute('aria-label') === focusKey;
      });
      if (again && !again.disabled) { again.focus(); }
    }
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

    if (!isFocused($('freqNumber')) && !isFocused($('freqRange'))) {
      $('freqRange').value = values.updatefrequencyms;
      $('freqNumber').value = values.updatefrequencyms;
    }
    if (!isFocused($('priority'))) { $('priority').value = values.priority; }
    $('showSettings').checked = Boolean(values['show.settings']);
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
