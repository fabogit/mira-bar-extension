// Minimal stand-in for the `vscode` module, enough to run the extension outside VS Code
// (test/extension.test.mjs, test/bench-extension.mjs). It records status bar writes, settings writes
// and webview messages; it renders nothing, so the renderer-side cost of an update in real VS Code is
// not part of any measurement.
'use strict';

const path = require('node:path');

/** Contributed defaults (package.json), returned by get() for keys the user did not set, like VS Code. */
const DEFAULTS = Object.fromEntries(
  Object.entries(require(path.join(__dirname, '..', '..', 'package.json')).contributes.configuration.properties)
    .filter(([, spec]) => 'default' in spec)
    .map(([key, spec]) => [key.replace(/^mirabar\./, ''), spec.default])
);

const state = {
  items: [],
  cfg: {},
  listeners: [],
  cmds: {},
  textSets: 0,
  tooltipSets: 0,
  errors: [],
  infos: [],
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

function fireConfigChange() {
  for (const cb of state.listeners) cb({ affectsConfiguration: () => true });
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
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  MarkdownString,
  window: {
    createStatusBarItem: (alignment, priority) => new Item(alignment, priority),
    createOutputChannel: () => ({ info: (m) => state.infos.push(m), error: (m) => state.errors.push(m), dispose() {} }),
    createWebviewPanel,
    showInformationMessage() {},
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (k, d) => (k in state.cfg ? state.cfg[k] : k in DEFAULTS ? DEFAULTS[k] : d),
      inspect: (k) => ({ key: k, defaultValue: DEFAULTS[k], globalValue: state.cfg[k] }),
      update: async (k, v) => {
        state.writes.push([k, v]);
        if (v === undefined) delete state.cfg[k];
        else state.cfg[k] = v;
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
