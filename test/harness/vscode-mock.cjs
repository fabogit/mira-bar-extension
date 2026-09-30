// Minimal stand-in for the `vscode` module, enough to run the extension outside VS Code
// (test/bench-extension.mjs). It records status bar writes; it does not render anything, so the
// renderer-side cost of a tooltip update in real VS Code is not included in measurements.
'use strict';

const state = {
  items: [],
  cfg: {},
  listeners: [],
  cmds: {},
  textSets: 0,
  tooltipSets: 0,
  errors: [],
};

class Item {
  constructor(alignment, priority) {
    this.alignment = alignment;
    this.priority = priority;
    this.disposed = false;
    this._text = '';
    this._tooltip = undefined;
    state.items.push(this);
  }
  set text(v) {
    state.textSets++;
    this._text = v;
  }
  get text() {
    return this._text;
  }
  set tooltip(v) {
    state.tooltipSets++;
    this._tooltip = v;
  }
  get tooltip() {
    return this._tooltip;
  }
  show() {}
  hide() {}
  dispose() {
    this.disposed = true;
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

module.exports = {
  __state: state,
  __fireConfigChange: fireConfigChange,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  MarkdownString,
  window: {
    createStatusBarItem: (alignment, priority) => new Item(alignment, priority),
    createOutputChannel: () => ({ info() {}, error: (m) => state.errors.push(m), dispose() {} }),
    createWebviewPanel: () => {
      throw new Error('webview not available in the harness');
    },
    showInformationMessage() {},
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (k, d) => (k in state.cfg ? state.cfg[k] : d),
      inspect: (k) => ({ key: k, globalValue: state.cfg[k] }),
      update: async (k, v) => {
        if (v === undefined) delete state.cfg[k];
        else state.cfg[k] = v;
        setTimeout(fireConfigChange, 0);
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
    executeCommand: async () => {},
  },
  Uri: { joinPath: () => ({}) },
};
