import * as vscode from 'vscode';
import { readStoredIntervals, TOOLTIP_SECTIONS, type MiraBarConfig, type TooltipSection } from './config.js';
import { formatClock, formatDuration, renderDynamicAsciiTable } from './format.js';
import {
  renderBattery,
  renderCpu,
  renderDisk,
  renderFreqOrLoad,
  renderMemory,
  renderTemp,
  SECTION_LABELS,
  type RenderContext,
  type Rendered,
} from './sections.js';
import type { TelemetryPlatformProvider } from './platform/interface.js';
import type { DiskProvider } from './disk/disk_provider.js';

/**
 * Sections due within this margin of a wake-up are read in it: timers never fire exactly on time, and
 * close deadlines then share one wake-up instead of two.
 */
const SCHEDULE_SLACK_MS = 25;

/**
 * Temperature on macOS: a background sensor pass (~16-18 ms on an M4) is requested this long before
 * the read, so the read shows a reading taken just before it instead of one a whole interval old.
 */
const TEMP_PREFETCH_MS = 100;

/** Disk requests allowed in flight at once: the current one plus one superseded (possibly hung) one. */
const MAX_DISK_IN_FLIGHT = 2;

const zeros = (): Record<TooltipSection, number> => ({ cpu: 0, freq: 0, temp: 0, mem: 0, battery: 0, disk: 0 });

/**
 * Owns the status bar widgets and their schedule.
 *
 * Each section has two intervals (config.ts): the status bar interval, at which it reads its source and
 * updates its text, and the tooltip interval (Static mode), at which its tooltip is rebuilt from the
 * latest reading. There is no global tick: one timer wakes up at the earliest deadline among the visible
 * sections, and hidden sections cost nothing.
 */
export class ResourceMonitor implements vscode.Disposable {
  private items: Record<TooltipSection, vscode.StatusBarItem>;
  private settingsItem: vscode.StatusBarItem | null = null;
  private readonly shown = new Set<vscode.StatusBarItem>();
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** Time of the last read per section (0 = never): the status bar schedule. */
  private readonly lastReadAt = zeros();
  /** Time of the last tooltip rebuild per section (0 = never). */
  private readonly lastTooltipAt = zeros();
  /** lastReadAt.temp for which the next pass was already requested (TEMP_PREFETCH_MS). */
  private tempPrefetchedFor = -1;
  /** Sequence number of the temperature reading in the current tooltip (Live rebuilds on change). */
  private tempTooltipSeq: number | undefined;
  /**
   * The disk sample in flight, if any. statfs can hang on a dead network mount: other sections keep
   * running, no new request for the same paths starts until it returns, and a change of paths starts
   * a new request whose result replaces the stale one.
   */
  private diskPending: { seq: number; key: string; withTooltip: boolean } | null = null;
  private diskSeq = 0;
  /**
   * Disk requests started and not yet settled, superseded ones included. Each hung statfs holds a libuv
   * pool thread (4 by default, shared by the whole extension host), so at most MAX_DISK_IN_FLIGHT run.
   */
  private diskInFlight = 0;
  /** Last error logged per section: each distinct error is logged once in a row. */
  private readonly lastErrors: Partial<Record<TooltipSection, string>> = {};
  private readonly isDarwin = process.platform === 'darwin';

  constructor(
    private readonly provider: TelemetryPlatformProvider,
    private readonly diskProvider: DiskProvider,
    private readonly log: vscode.LogOutputChannel,
    private config: MiraBarConfig
  ) {
    this.items = this.createItems();
    this.run(true);
  }

  /** Reads every visible section now and rebuilds every tooltip (click, command). */
  public refresh(): void {
    this.run(true);
  }

  /** Applies a new configuration: placement, gear tooltip, then a full refresh. */
  public applyConfig(next: MiraBarConfig): void {
    if (this.disposed) {
      return;
    }
    const placementChanged =
      next.priority !== this.config.priority ||
      next.alignment !== this.config.alignment ||
      next.showSettings !== this.config.showSettings ||
      next.order.join() !== this.config.order.join();
    this.config = next;
    if (placementChanged) {
      // VS Code cannot move an existing item: recreate them.
      this.disposeItems();
      this.items = this.createItems();
    } else if (this.settingsItem) {
      this.settingsItem.tooltip = trustedMarkdown(buildSettingsTooltip(next));
    }
    this.run(true);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.diskPending = null;
    this.disposeItems();
  }

  // --- widgets -------------------------------------------------------------------------------------

  /**
   * Creates the metric widgets (plus the optional gear widget at the end) in the configured order.
   * VS Code places higher priorities further left on both sides, so priorities decrease along the order.
   */
  private createItems(): Record<TooltipSection, vscode.StatusBarItem> {
    const config = this.config;
    const align = config.alignment === 'Right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
    const slots = config.order.length + 1; // metrics + gear
    const top = config.alignment === 'Left' ? config.priority : config.priority + slots - 1;

    const created = {} as Record<TooltipSection, vscode.StatusBarItem>;
    config.order.forEach((section, index) => {
      const item = vscode.window.createStatusBarItem(align, top - index);
      item.command = 'mirabar.refresh';
      item.name = `MiraBar: ${SECTION_LABELS[section](this.isDarwin)}`;
      created[section] = item;
    });
    if (config.showSettings) {
      this.settingsItem = vscode.window.createStatusBarItem(align, top - config.order.length);
      this.settingsItem.text = '$(settings-gear)';
      this.settingsItem.command = 'mirabar.openSettings';
      this.settingsItem.name = 'MiraBar Settings';
      this.settingsItem.tooltip = trustedMarkdown(buildSettingsTooltip(config));
      this.settingsItem.show();
    }
    for (const section of TOOLTIP_SECTIONS) {
      this.lastTooltipAt[section] = 0; // new items have no tooltip yet
    }
    return created;
  }

  private disposeItems(): void {
    for (const item of Object.values(this.items)) {
      item.dispose();
    }
    this.shown.clear();
    if (this.settingsItem) {
      this.settingsItem.dispose();
      this.settingsItem = null;
    }
  }

  private hide(section: TooltipSection): void {
    const item = this.items[section];
    if (this.shown.delete(item)) {
      item.hide();
    }
  }

  /**
   * Writes a rendered section to its widget, touching only what changed: rewriting an unchanged
   * text or tooltip makes VS Code re-render the item and closes an open hover.
   */
  private apply(section: TooltipSection, rendered: Rendered, at: number): void {
    const item = this.items[section];
    if (item.text !== rendered.text) {
      item.text = rendered.text;
    }
    if (rendered.tooltip !== null) {
      this.lastTooltipAt[section] = at;
      const current = item.tooltip instanceof vscode.MarkdownString ? item.tooltip.value : item.tooltip;
      if (current !== rendered.tooltip) {
        item.tooltip = trustedMarkdown(rendered.tooltip);
      }
    }
    if (!this.shown.has(item)) {
      item.show();
      this.shown.add(item);
    }
  }

  // --- schedule ------------------------------------------------------------------------------------

  private visible(section: TooltipSection): boolean {
    const c = this.config;
    switch (section) {
      case 'cpu':
        return c.showCpuUsage;
      case 'freq':
        return c.showCpuFreq;
      case 'temp':
        return c.showCpuTemp;
      case 'mem':
        return c.showMem;
      case 'battery':
        if (!c.showBattery) {
          return false;
        }
        try {
          return this.provider.isBatteryAvailable();
        } catch {
          return false; // also called by schedule(), outside the per-section error handling
        }
      case 'disk':
        return c.showDisk;
    }
  }

  /** Whether the temperature pass can be requested ahead of the read (macOS sensors, Linux components; intervals of 400 ms or more). */
  private tempPrefetchEnabled(): boolean {
    return this.provider.requestTempRefresh !== undefined && this.config.statusBarMs.temp >= 4 * TEMP_PREFETCH_MS;
  }

  /**
   * One wake-up: requests the temperature pass if it is due, reads every section whose status bar
   * interval has elapsed (all of them when forced) and schedules the next wake-up.
   */
  private run(force: boolean): void {
    if (this.disposed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const now = Date.now();
    if (!force && this.config.showCpuTemp && this.tempPrefetchEnabled() && this.tempPrefetchedFor !== this.lastReadAt.temp) {
      const prefetchAt = this.lastReadAt.temp + this.config.statusBarMs.temp - TEMP_PREFETCH_MS;
      if (now + SCHEDULE_SLACK_MS >= prefetchAt) {
        this.tempPrefetchedFor = this.lastReadAt.temp;
        this.provider.requestTempRefresh!();
      }
    }
    for (const section of TOOLTIP_SECTIONS) {
      try {
        this.processSection(section, now, force);
        this.lastErrors[section] = undefined;
      } catch (err) {
        // Keep the previous display; log each distinct error once in a row.
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        if (message !== this.lastErrors[section]) {
          this.lastErrors[section] = message;
          this.log.error(`${SECTION_LABELS[section](this.isDarwin)}: ${message}`);
        }
      }
    }
    this.schedule();
  }

  /** Arms one timer at the earliest deadline among the visible sections (none when all are hidden). */
  private schedule(): void {
    let next = Number.POSITIVE_INFINITY;
    for (const section of TOOLTIP_SECTIONS) {
      if (this.visible(section)) {
        next = Math.min(next, this.lastReadAt[section] + this.config.statusBarMs[section]);
      }
    }
    if (this.config.showCpuTemp && this.tempPrefetchEnabled() && this.tempPrefetchedFor !== this.lastReadAt.temp) {
      next = Math.min(next, this.lastReadAt.temp + this.config.statusBarMs.temp - TEMP_PREFETCH_MS);
    }
    if (!Number.isFinite(next)) {
      return;
    }
    this.timer = setTimeout(() => this.run(false), Math.max(0, next - Date.now()));
    this.timer.unref();
  }

  /**
   * Whether a section's tooltip is rebuilt with the reading taken now.
   * Live: with every reading. Static: on click, and with auto-refresh at the read closest to the tooltip
   * interval (so the update time in the tooltip is always the time of its reading).
   */
  private tooltipDue(section: TooltipSection, now: number, force: boolean): boolean {
    const c = this.config;
    if (force || this.lastTooltipAt[section] === 0 || c.tooltipMode === 'Live') {
      return true;
    }
    if (!c.tooltipAutoRefresh) {
      return false;
    }
    return now - this.lastTooltipAt[section] >= c.tooltipMs[section] - c.statusBarMs[section] / 2;
  }

  private context(at: number, section: TooltipSection): RenderContext {
    return {
      config: this.config,
      updatedAt: formatClock(new Date(at), this.config.statusBarMs[section] < 1000),
      topology: section === 'cpu' ? this.provider.getTopologyDescription?.() : undefined,
    };
  }

  private processSection(section: TooltipSection, now: number, force: boolean): void {
    if (!this.visible(section)) {
      this.hide(section);
      return;
    }
    const interval = this.config.statusBarMs[section];
    if (!force && this.lastReadAt[section] !== 0 && now - this.lastReadAt[section] + SCHEDULE_SLACK_MS < interval) {
      return;
    }
    this.lastReadAt[section] = now;
    let withTooltip = this.tooltipDue(section, now, force);
    const ctx = this.context(now, section);

    switch (section) {
      case 'cpu': {
        const cpu = this.provider.sampleCpu();
        return cpu ? this.apply(section, renderCpu(cpu, ctx, withTooltip), now) : this.hide(section);
      }
      case 'freq': {
        const info = this.provider.sampleFreqOrLoad();
        return info ? this.apply(section, renderFreqOrLoad(info, ctx, withTooltip), now) : this.hide(section);
      }
      case 'temp': {
        // Accept the reading requested ahead of this read; without one, request a pass for the next read.
        const temp = this.provider.sampleTemp(interval / 2);
        if (!temp) {
          return this.hide(section);
        }
        if (this.config.tooltipMode === 'Live' && !force && temp.sampleSeq !== undefined && temp.sampleSeq === this.tempTooltipSeq) {
          withTooltip = false; // same reading as the current tooltip
        }
        if (withTooltip) {
          this.tempTooltipSeq = temp.sampleSeq;
        }
        // The tooltip shows when the sensors were read, which can precede this read (cached reading).
        const tempCtx = temp.ageMs ? this.context(now - temp.ageMs, section) : ctx;
        return this.apply(section, renderTemp(temp, tempCtx, withTooltip), now);
      }
      case 'mem': {
        const mem = this.provider.sampleMemory();
        return mem ? this.apply(section, renderMemory(mem, ctx, withTooltip), now) : this.hide(section);
      }
      case 'battery': {
        const battery = this.provider.sampleBattery();
        return battery ? this.apply(section, renderBattery(battery, ctx, withTooltip), now) : this.hide(section);
      }
      case 'disk':
        return this.readDisk(withTooltip);
    }
  }

  /** Starts a disk sample off the event loop turn; the widget is rendered when the result arrives. */
  private readDisk(withTooltip: boolean): void {
    const drives = this.config.diskDrives;
    const defaultPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/';
    const key = JSON.stringify([drives, defaultPath]);
    if (this.diskPending && this.diskPending.key === key) {
      this.diskPending.withTooltip ||= withTooltip; // same paths in flight: its result serves this read
      return;
    }
    if (this.diskInFlight >= MAX_DISK_IN_FLIGHT) {
      return; // earlier requests still hung: retried at the next disk read
    }
    const seq = ++this.diskSeq;
    this.diskPending = { seq, key, withTooltip };
    this.diskInFlight++;
    const settled = (): void => {
      this.diskInFlight--;
    };
    this.diskProvider.sample(drives, defaultPath).finally(settled).then(
      (disks) => {
        if (this.disposed || this.diskPending?.seq !== seq) {
          return; // disposed, or superseded by a request for other paths
        }
        const rebuild = this.diskPending.withTooltip;
        this.diskPending = null;
        if (!this.config.showDisk) {
          return;
        }
        if (disks.length === 0) {
          return this.hide('disk');
        }
        const at = Date.now();
        this.apply('disk', renderDisk(disks, this.context(at, 'disk'), rebuild), at);
      },
      () => {
        if (this.diskPending?.seq === seq) {
          this.diskPending = null;
        }
      }
    );
  }
}

function trustedMarkdown(value: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(value, true);
  md.isTrusted = true;
  return md;
}

/**
 * Tooltip of the settings (gear) widget, as two tables: the sections (shown, status bar and tooltip
 * intervals in effect, in status bar order) and the display options with one-click toggles, plus a
 * link to the full panel.
 */
export function buildSettingsTooltip(config: MiraBarConfig): string {
  const isDarwin = process.platform === 'darwin';
  const mode = config.tooltipMode;
  const shown: Record<TooltipSection, boolean> = {
    cpu: config.showCpuUsage,
    freq: config.showCpuFreq,
    temp: config.showCpuTemp,
    mem: config.showMem,
    battery: config.showBattery,
    disk: config.showDisk,
  };
  // Stored values, to flag where what applies differs from what is set.
  const stored = readStoredIntervals();
  let raised = false;
  const barCell = (section: TooltipSection): string => {
    if (config.statusBarMs[section] > stored.statusBarMs[section]) {
      raised = true;
      return `${formatDuration(config.statusBarMs[section])} *`;
    }
    return formatDuration(config.statusBarMs[section]);
  };
  const tooltipCell = (section: TooltipSection): string => {
    if (mode === 'Live' || (config.tooltipAutoRefresh && stored.tooltipMs[section] < config.statusBarMs[section])) {
      return 'with bar'; // Live, or a tooltip interval shorter than the status bar
    }
    return config.tooltipAutoRefresh ? formatDuration(config.tooltipMs[section]) : 'on click';
  };
  const sectionRows = config.order.map((section) => [
    SECTION_LABELS[section](isDarwin),
    shown[section] ? 'yes' : 'no',
    barCell(section),
    tooltipCell(section),
  ]);
  const notes: string[] = [];
  if (raised) {
    notes.push('\\* raised to its measured minimum ([details](command:mirabar.openSettings))');
  }

  // Options: a Markdown table, because the toggles are command links (not possible in a code block).
  const option = (name: string, current: string, action: string, command: string): string =>
    `| ${name} | ${current} | [${action}](command:${command}) |`;
  const options = [
    '| Option | Current | |',
    '| :--- | :--- | :--- |',
    option('Tooltip mode', mode, `switch to ${mode === 'Static' ? 'Live' : 'Static'}`, 'mirabar.toggleTooltipMode'),
  ];
  if (mode === 'Static') {
    options.push(option('Auto-refresh', config.tooltipAutoRefresh ? 'on' : 'off',
      `turn ${config.tooltipAutoRefresh ? 'off' : 'on'}`, 'mirabar.toggleTooltipAutoRefresh'));
  }
  options.push(option('CPU cores', config.cpuTooltipLayout,
    `switch to ${config.cpuTooltipLayout === 'Table' ? 'List' : 'Table'}`, 'mirabar.toggleCpuLayout'));
  if (isDarwin) {
    options.push(option('System load', config.loadFormat,
      `switch to ${config.loadFormat === 'Percent' ? 'Value' : 'Percent'}`, 'mirabar.toggleLoadFormat'));
  }
  options.push(option('Several disks', config.diskMultiDisplay === 'All' ? 'All' : 'Most full',
    `switch to ${config.diskMultiDisplay === 'All' ? 'Most full' : 'All'}`, 'mirabar.toggleDiskMultiDisplay'));

  return [
    '### MiraBar Settings',
    '',
    ...renderDynamicAsciiTable(
      [
        { header: 'Section', align: 'left' },
        { header: 'Shown', align: 'left' },
        { header: 'Status bar', align: 'right' },
        { header: 'Tooltip', align: 'right' },
      ],
      sectionRows
    ),
    ...notes,
    '',
    ...options,
    '',
    '---',
    '[$(settings-gear) Open settings panel](command:mirabar.openSettings)',
  ].join('\n');
}
