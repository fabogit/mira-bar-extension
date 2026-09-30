import * as vscode from 'vscode';
import { getConfig } from './config.js';
import { ResourceMonitor } from './monitor.js';
import { SettingsPanel } from './settings/panel.js';
import { createPlatformProvider } from './platform/factory.js';
import { DiskProvider } from './disk/disk_provider.js';

// Layout: config.ts reads and validates the settings; monitor.ts owns the widgets and their schedule
// (per-section status bar and tooltip intervals); sections.ts renders texts and tooltips; format.ts
// holds the formatting helpers; settings/ is the settings panel. This file wires them to VS Code.

/** Configuration changes arrive in bursts (e.g. "Restore defaults" writes ~20 keys): apply them once. */
const CONFIG_CHANGE_DEBOUNCE_MS = 100;

let monitor: ResourceMonitor | null = null;
let configChangeTimer: NodeJS.Timeout | null = null;

/**
 * Extension entry point invoked by VS Code when the extension is activated.
 *
 * @param context - Extension runtime context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Resource Monitor NG', { log: true });
  context.subscriptions.push(log);
  log.info('Activated');

  const current = new ResourceMonitor(createPlatformProvider(), new DiskProvider(), log, getConfig());
  monitor = current;
  context.subscriptions.push(current, { dispose: () => SettingsPanel.disposeCurrent() });

  /** Registers a command that flips one setting between two values and confirms the change. */
  const registerToggle = <T extends string | boolean>(
    command: string,
    key: string,
    read: () => T,
    flip: (value: T) => T,
    message: (value: T) => string
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async () => {
        const next = flip(read());
        await vscode.workspace.getConfiguration('resmon').update(key, next, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Resource Monitor: ${message(next)}`);
      })
    );
  };

  context.subscriptions.push(
    // Also the click action of every metric widget.
    vscode.commands.registerCommand('resmon.refresh', () => current.refresh()),
    // Settings panel (intervals, sections, order, units); also the click action of the gear widget.
    vscode.commands.registerCommand('resmon.openSettings', () => SettingsPanel.show(process.platform))
  );
  registerToggle('resmon.toggleTooltipMode', 'tooltip.mode', () => getConfig().tooltipMode,
    (v) => (v === 'Static' ? 'Live' : 'Static'), (v) => `Tooltip mode set to ${v}`);
  registerToggle('resmon.toggleTooltipAutoRefresh', 'tooltip.autoRefresh', () => getConfig().tooltipAutoRefresh,
    (v) => !v, (v) => `Static tooltip auto-refresh ${v ? 'on' : 'off'}`);
  registerToggle('resmon.toggleCpuLayout', 'tooltip.cpuLayout', () => getConfig().cpuTooltipLayout,
    (v) => (v === 'Table' ? 'List' : 'Table'), (v) => `CPU layout set to ${v}`);
  registerToggle('resmon.toggleLoadFormat', 'loadFormat', () => getConfig().loadFormat,
    (v) => (v === 'Percent' ? 'Value' : 'Percent'), (v) => `Load format set to ${v}`);
  registerToggle('resmon.toggleDiskMultiDisplay', 'disk.multiDisplay', () => getConfig().diskMultiDisplay,
    (v) => (v === 'All' ? 'MostFull' : 'All'), (v) => `Multi-disk display set to ${v}`);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('resmon')) {
        return;
      }
      if (configChangeTimer) {
        clearTimeout(configChangeTimer);
      }
      configChangeTimer = setTimeout(() => {
        configChangeTimer = null;
        if (monitor === current) {
          current.applyConfig(getConfig());
          SettingsPanel.notifyConfigChanged();
        }
      }, CONFIG_CHANGE_DEBOUNCE_MS);
    })
  );
}

/**
 * Cleans up when the extension is deactivated (VS Code also disposes `context.subscriptions`).
 */
export function deactivate(): void {
  if (configChangeTimer) {
    clearTimeout(configChangeTimer);
    configChangeTimer = null;
  }
  SettingsPanel.disposeCurrent();
  monitor?.dispose();
  monitor = null;
}
