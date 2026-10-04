// Minimal stand-in for the `vscode` module, enough to run the extension outside VS Code
// (test/host/extension.test.mjs, test/bench-extension.mjs; bundles resolve `vscode` here through
// test/harness/bundle.mjs). It records status bar writes, settings writes, output channel lines and
// webview messages, keeps settings per scope like VS Code (`cfg` user, `workspaceCfg`, `folderCfg`; the
// most specific one that sets a key applies) and reports which settings a change event affects; it renders
// nothing, so the renderer-side cost of an update in real VS Code is not part of any measurement.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The extension's package.json: the nearest one above this file. */
function findManifest() {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) return file;
    if (path.dirname(dir) === dir) throw new Error(`vscode-mock: no package.json above ${__dirname}`);
  }
}

/** Contributed defaults (package.json), returned by get() for keys the user did not set, like VS Code. */
const DEFAULTS = Object.fromEntries(
  Object.entries(require(findManifest()).contributes.configuration.properties)
    .filter(([, spec]) => 'default' in spec)
    .map(([key, spec]) => [key.replace(/^mirabar\./, ''), spec.default])
);

const state = {
  items: [],
  /** User (global) settings. */
  cfg: {},
  /** Workspace settings. */
  workspaceCfg: {},
  /** Workspace folder settings. */
  folderCfg: {},
  listeners: [],
  cmds: {},
  textSets: 0,
  tooltipSets: 0,
  /** Output channel errors and writes to disposed items: a test run should end with none. */
  errors: [],
  infos: [],
  warnings: [],
  /** Output channel trace/debug lines and append/appendLine text. */
  logs: [],
  notifications: [],
  panels: [],
  posted: [],
  executed: [],
  writes: [],
};

class Item {
  constructor(alignment, priority) {
    this.alignment = alignment;
    this.priority = priority;
    this.disposed = false;
    this.visible = false;
    this.tooltipSetCount = 0;
    this._text = '';
    this._tooltip = undefined;
    state.items.push(this);
  }
  set text(v) {
    if (this.disposed) state.errors.push(`text written to disposed item ${this.name}`);
    state.textSets++;
    this._text = v;
  }
  get text() {
    return this._text;
  }
  set tooltip(v) {
    if (this.disposed) state.errors.push(`tooltip written to disposed item ${this.name}`);
    state.tooltipSets++;
    this.tooltipSetCount++;
    this._tooltip = v;
  }
  get tooltip() {
    return this._tooltip;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  dispose() {
    this.disposed = true;
    this.visible = false;
  }
}

class MarkdownString {
  constructor(value, supportThemeIcons) {
    this.value = value;
    this.supportThemeIcons = Boolean(supportThemeIcons);
  }
}

/** The value get() returns for a key: the most specific scope that sets it, else the default. */
function effective(k) {
  for (const scope of [state.folderCfg, state.workspaceCfg, state.cfg]) {
    if (k in scope) return scope[k];
  }
  return DEFAULTS[k];
}

function snapshot() {
  const keys = new Set([...Object.keys(DEFAULTS), ...Object.keys(state.cfg), ...Object.keys(state.workspaceCfg), ...Object.keys(state.folderCfg)]);
  return Object.fromEntries([...keys].map((k) => [k, JSON.stringify(effective(k))]));
}
/** Effective values at the last change event, to tell listeners which settings changed. */
let lastSeen = snapshot();

/**
 * Notifies the configuration listeners, as VS Code does after a settings change. The event affects the
 * `mirabar.*` keys whose effective value changed since the last such event, or, when given, `keys` (full
 * names, e.g. `editor.fontSize` to check that a listener ignores other sections; the change tracking is
 * left as it was).
 *
 * @param {string[]} [keys]
 */
function fireConfigChange(keys) {
  let changed = keys;
  if (!changed) {
    const now = snapshot();
    changed = [...new Set([...Object.keys(now), ...Object.keys(lastSeen)])].filter((k) => now[k] !== lastSeen[k]).map((k) => `mirabar.${k}`);
    lastSeen = now;
  }
  const event = { affectsConfiguration: (section) => changed.some((k) => k === section || k.startsWith(`${section}.`)) };
  for (const cb of state.listeners) cb(event);
}

function createWebviewPanel(viewType, title) {
  const disposeCbs = [];
  const panel = {
    viewType,
    title,
    disposed: false,
    reveals: 0,
    listeners: [],
    webview: {
      html: '',
      cspSource: 'vscode-webview://test',
      postMessage: (m) => {
        state.posted.push(m);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb) => {
        panel.listeners.push(cb);
        return { dispose() {} };
      },
    },
    onDidDispose: (cb) => {
      disposeCbs.push(cb);
      return { dispose() {} };
    },
    reveal() {
      panel.reveals++;
    },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      for (const cb of disposeCbs) cb();
    },
    /** Test helper: delivers a message as if the webview had posted it. */
    receive(msg) {
      for (const cb of panel.listeners) cb(msg);
    },
  };
  state.panels.push(panel);
  return panel;
}

module.exports = {
  __state: state,
  __fireConfigChange: fireConfigChange,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1 },
  MarkdownString,
  window: {
    createStatusBarItem: (alignment, priority) => new Item(alignment, priority),
    // A LogOutputChannel (`{ log: true }`), the kind the extension creates.
    createOutputChannel: (name) => ({
      name,
      logLevel: 3, // LogLevel.Info
      onDidChangeLogLevel: () => ({ dispose() {} }),
      trace: (m) => state.logs.push(m),
      debug: (m) => state.logs.push(m),
      info: (m) => state.infos.push(m),
      warn: (m) => state.warnings.push(m),
      error: (m) => state.errors.push(m instanceof Error ? m.message : m),
      append: (m) => state.logs.push(m),
      appendLine: (m) => state.logs.push(m),
      replace() {},
      clear() {},
      show() {},
      hide() {},
      dispose() {},
    }),
    createWebviewPanel,
    showInformationMessage: (m) => {
      state.notifications.push(m);
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: (_section, resource) => ({
      get: (k, d) => {
        const v = effective(k);
        return v === undefined ? d : v;
      },
      inspect: (k) => ({
        key: k,
        defaultValue: DEFAULTS[k],
        globalValue: state.cfg[k],
        workspaceValue: state.workspaceCfg[k],
        workspaceFolderValue: state.folderCfg[k],
      }),
      update: async (k, v, target = 1) => {
        const scope = { 1: state.cfg, 2: state.workspaceCfg, 3: state.folderCfg }[target === true ? 1 : target === false ? 2 : target];
        if (target === 3 && !resource) {
          // Like VS Code: folder settings need a configuration obtained for a resource.
          throw new Error('Unable to write to Folder Settings because no resource is provided.');
        }
        state.writes.push([k, v, target]);
        if (v === undefined) delete scope[k];
        else scope[k] = v;
        setTimeout(fireConfigChange, 0); // VS Code notifies listeners asynchronously
      },
    }),
    onDidChangeConfiguration: (cb) => {
      state.listeners.push(cb);
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand: (name, cb) => {
      state.cmds[name] = cb;
      return { dispose() {} };
    },
    executeCommand: async (name, ...args) => {
      state.executed.push([name, ...args]);
    },
  },
};
