import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readSettingsSnapshot, resetSettings, validateSetting, writeSetting } from './schema.js';
import { renderSettingsHtml } from './panel_html.js';

type PanelMessage =
  | { type: 'ready' }
  | { type: 'update'; key: string; value: unknown }
  | { type: 'reset' }
  | { type: 'openJson' };

function isPanelMessage(msg: unknown): msg is PanelMessage {
  if (msg === null || typeof msg !== 'object') {
    return false;
  }
  const m = msg as { type?: unknown; key?: unknown };
  switch (m.type) {
    case 'ready':
    case 'reset':
    case 'openJson':
      return true;
    case 'update':
      return typeof m.key === 'string';
    default:
      return false;
  }
}

/**
 * Singleton settings panel (editor tab). It is a front-end for the regular VS Code settings:
 * every change is validated against EDITABLE_SETTINGS and written to the user settings, and the
 * panel re-renders from the effective configuration on every change (including edits made in
 * settings.json), so there is a single source of truth.
 */
export class SettingsPanel implements vscode.Disposable {
  private static current: SettingsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /**
   * Messages are handled one at a time: a reset awaits several settings updates, and a later edit
   * must apply after it, not interleave with it.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Opens the panel, or reveals it if it is already open.
   *
   * @param platform - Host platform, used to label platform-specific sections.
   */
  public static show(platform: NodeJS.Platform): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'mirabar.settings',
      'MiraBar Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: false }
    );
    SettingsPanel.current = new SettingsPanel(panel, platform);
  }

  /** Pushes the effective configuration to the open panel, if any. */
  public static notifyConfigChanged(): void {
    SettingsPanel.current?.postState();
  }

  /** Closes the open panel, if any (extension deactivation). */
  public static disposeCurrent(): void {
    SettingsPanel.current?.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly platform: NodeJS.Platform
  ) {
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = renderSettingsHtml(nonce, panel.webview.cspSource, platform);
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: unknown) => {
        this.queue = this.queue.then(() => this.onMessage(msg));
      })
    );
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!isPanelMessage(msg)) {
      return;
    }
    try {
      switch (msg.type) {
        case 'ready':
          this.postState();
          break;
        case 'update': {
          const result = validateSetting(msg.key, msg.value);
          if (!result.ok) {
            void this.panel.webview.postMessage({ type: 'error', message: result.reason });
            this.postState();
            return;
          }
          await writeSetting(msg.key, result.value);
          void this.panel.webview.postMessage({ type: 'saved' });
          break;
        }
        case 'reset':
          await resetSettings();
          void this.panel.webview.postMessage({ type: 'saved' });
          break;
        case 'openJson':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'mirabar.');
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ type: 'error', message: `Could not save: ${message}` });
    }
  }

  private postState(): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({
      type: 'state',
      platform: this.platform,
      values: readSettingsSnapshot(),
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (SettingsPanel.current === this) {
      SettingsPanel.current = undefined;
    }
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }
}
