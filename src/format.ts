/**
 * Pure formatting helpers for status bar texts and tooltip Markdown (no VS Code dependency).
 */

/** Shown instead of a size or duration that cannot be formatted (NaN, infinite, negative duration). */
const NO_VALUE = '—';

/** Truncation marker of table cells. */
const ELLIPSIS = '...';

/**
 * Formats a raw byte count into a human-readable string with dynamic unit scaling (B, KB, MB, GB, TB).
 * The unit is chosen after rounding, so 1023.999 B is '1.00 KB', not '1024.00 B'.
 *
 * @param bytes - The size in bytes to format.
 * @param precision - Number of decimal places to include (default: 2).
 * @returns Formatted size string (e.g. '16.42 GB'), or '—' when not finite.
 */
export function formatBytes(bytes: number, precision = 2): string {
  if (!Number.isFinite(bytes)) {
    return NO_VALUE;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let unitIndex = 0;

  while (Math.abs(Number(val.toFixed(precision))) >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }

  return `${val.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Formats a duration in minutes, rounded to whole minutes, into a human-readable string (e.g. '1h 24m').
 *
 * @param minutes - Total duration in minutes.
 * @returns Formatted duration string, or 'Estimating...' when negative or not finite.
 */
export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return 'Estimating...';
  }
  const total = Math.round(minutes);
  const hrs = Math.floor(total / 60);
  const mins = total % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Formats a duration in milliseconds compactly: '200 ms', '1.5 s', '10 s', '2 min' (minutes are the
 * largest unit: one hour is '60 min'). The unit is chosen after rounding, so 59999 ms is '1 min', not '60 s'.
 *
 * @param ms - Duration in milliseconds.
 * @returns Human-readable duration, or '—' when negative or not finite.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return NO_VALUE;
  }
  const wholeMs = Math.round(ms);
  if (wholeMs < 1000) {
    return `${wholeMs} ms`;
  }
  const seconds = Number((ms / 1000).toFixed(1));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return `${Number((ms / 60_000).toFixed(1))} min`;
}

/**
 * Formats a local wall-clock time as HH:MM:SS (24h), independent of the host locale, with tenths of
 * a second when refreshes happen faster than once per second (otherwise they look identical).
 *
 * @param date - Time to format.
 * @param withTenths - Append tenths of a second ('16:15:27.4').
 * @returns Formatted time string (e.g. '16:15:27').
 */
export function formatClock(date: Date, withTenths = false): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withTenths ? `${base}.${Math.floor(date.getMilliseconds() / 100)}` : base;
}

/**
 * Renders a fixed-width Unicode progress bar (e.g. '[████░░░░]').
 *
 * @param percent - Value between 0 and 100.
 * @param width - Character length of the bar (default: 8).
 * @param codeWrapped - Whether to wrap the inner bar in markdown code ticks (default: true).
 * @returns Formatted progress bar string.
 */
export function renderBar(percent: number, width = 8, codeWrapped = true): string {
  const clamped = Number.isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;
  const bar = `${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}`;
  return codeWrapped ? `[\`${bar}\`]` : `[${bar}]`;
}

/** Width of the bars inside tooltip tables and per-core lists. */
const TABLE_BAR_WIDTH = 6;

/**
 * Renders a plain bar followed by its right-aligned percentage, the value cell of the tooltip tables
 * (e.g. '[███░░░]   42.9%').
 *
 * @param pct - Value between 0 and 100.
 * @param gap - Spaces between the bar and the percentage (default: 2).
 * @returns Formatted cell string.
 */
export function barCell(pct: number, gap = 2): string {
  return `${renderBar(pct, TABLE_BAR_WIDTH, false)}${' '.repeat(gap)}${pct.toFixed(1).padStart(5, ' ')}%`;
}

/** Load of one core as listed in the CPU tooltip (e.g. { label: 'P6', pct: 42.9 }). */
export interface CoreLoad {
  label: string;
  pct: number;
}

/**
 * Renders per-core loads as a Markdown list, one '- **Core X**: bar pct%' line per core, with the
 * percentage padded by figure spaces so the bars stay aligned in proportional fonts.
 *
 * @param cores - Cores to list, in display order.
 * @returns Markdown list lines.
 */
export function renderCoreList(cores: CoreLoad[]): string[] {
  return cores.map((c) => `- **Core ${c.label}**: ${renderBar(c.pct, TABLE_BAR_WIDTH)} ${padNum(c.pct.toFixed(1), 5)}%`);
}

/**
 * Renders two columns of core utilization in a fixed-width monospace block
 * using box-drawing characters for pixel-perfect vertical alignment without horizontal jitter.
 *
 * @param leftTitle - Header title for the left column.
 * @param rightTitle - Header title for the right column.
 * @param leftCores - List of cores for the left column.
 * @param rightCores - List of cores for the right column.
 * @returns Formatted Markdown code block lines.
 */
export function renderMonospaceTable(
  leftTitle: string,
  rightTitle: string,
  leftCores: CoreLoad[],
  rightCores: CoreLoad[]
): string[] {
  const colWidth = 23;
  const maxRows = Math.max(leftCores.length, rightCores.length);
  const lines: string[] = ['```text'];
  const cell = (core: CoreLoad | undefined): string => (core ? `${core.label.padEnd(3, ' ')}: ${barCell(core.pct, 1)}` : '');

  const leftHeader = leftTitle.padEnd(colWidth, ' ');
  const rightHeader = rightTitle.padEnd(colWidth, ' ');
  lines.push(`${leftHeader} │ ${rightHeader}`);
  lines.push(`${'─'.repeat(colWidth)}─┼─${'─'.repeat(colWidth)}`);

  for (let r = 0; r < maxRows; r++) {
    lines.push(`${cell(leftCores[r]).padEnd(colWidth, ' ')} │ ${cell(rightCores[r])}`);
  }

  lines.push('```');
  return lines;
}

/**
 * Truncates a filesystem path preserving directory boundaries and at least one leading slash.
 * If space permits, additional parent directory segments are included.
 *
 * @param path - Absolute or relative filesystem path.
 * @param maxLength - Maximum allowed string length.
 * @returns Truncated path string (e.g. '.../kind-newton' or '.../antigravity/kind-newton').
 */
export function truncatePath(path: string, maxLength: number): string {
  if (path.length <= maxLength) {
    return path;
  }
  if (maxLength <= 0) {
    return '';
  }
  if (maxLength <= 4) {
    return path.slice(-maxLength);
  }

  const sep = path.includes('\\') ? '\\' : '/';
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const parts = trimmed.split(sep).filter(Boolean);
  if (parts.length === 0) {
    return path.slice(-maxLength);
  }

  let result = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = sep + parts[i] + result;
    if (3 + candidate.length <= maxLength) {
      result = candidate;
    } else {
      break;
    }
  }

  if (result.length > 0) {
    return '...' + result;
  }

  // If even the leaf directory with .../ exceeds maxLength, truncate inside leaf but keep .../
  const lastPart = parts[parts.length - 1]!;
  const prefix = '...' + sep;
  if (maxLength > prefix.length) {
    return prefix + lastPart.slice(-(maxLength - prefix.length));
  }
  return path.slice(-maxLength);
}

/**
 * Definition of a column for dynamic ASCII table generation.
 */
export interface ColumnDef {
  header: string;
  align?: 'left' | 'right';
  minWidth?: number;
  maxWidth?: number;
  truncatePath?: boolean;
}

/**
 * Fits a cell value into a column width: paths keep their trailing segments, other values end with
 * '...' (or are cut short when the column is narrower than the marker itself).
 *
 * @param val - Cell value.
 * @param width - Column width in characters.
 * @param asPath - Truncate as a filesystem path (ColumnDef.truncatePath).
 * @returns The value, at most `width` characters long.
 */
function fitCell(val: string, width: number, asPath = false): string {
  if (val.length <= width) {
    return val;
  }
  if (asPath) {
    return truncatePath(val, width);
  }
  return width >= ELLIPSIS.length ?val.slice(0, width - ELLIPSIS.length) + ELLIPSIS : val.slice(0, width);
}

/**
 * Renders an ASCII table inside a markdown code block with automatically calculated
 * column widths, boundary clamping, and box-drawing characters.
 *
 * @param columns - Array of column definitions.
 * @param rows - 2D array of string cell values.
 * @returns Formatted Markdown code block lines.
 */
export function renderDynamicAsciiTable(
  columns: ColumnDef[],
  rows: string[][]
): string[] {
  // 1. Calculate optimal width for each column
  const colWidths = columns.map((col, cIdx) => {
    let maxLen = col.header.length;
    for (const row of rows) {
      const val = col.maxWidth ? fitCell(row[cIdx] ?? '', col.maxWidth, col.truncatePath) : (row[cIdx] ?? '');
      if (val.length > maxLen) {
        maxLen = val.length;
      }
    }
    if (col.minWidth && maxLen < col.minWidth) {
      maxLen = col.minWidth;
    }
    if (col.maxWidth && maxLen > col.maxWidth) {
      maxLen = col.maxWidth;
    }
    return maxLen;
  });

  const lines: string[] = ['```text'];

  // Fits a value into its column (a header too, when maxWidth is below its length) and aligns it.
  const cell = (val: string, idx: number, asPath?: boolean): string => {
    const w = colWidths[idx]!;
    const fitted = fitCell(val, w, asPath);
    return columns[idx]!.align === 'right' ? fitted.padStart(w, ' ') : fitted.padEnd(w, ' ');
  };

  // 2. Format header
  lines.push(columns.map((col, idx) => cell(col.header, idx)).join(' │ '));

  // 3. Format divider line
  const dividerCells = colWidths.map((w) => '─'.repeat(w));
  lines.push(dividerCells.join('─┼─'));

  // 4. Format rows
  for (const row of rows) {
    lines.push(columns.map((col, idx) => cell(row[idx] ?? '', idx, col.truncatePath)).join(' │ '));
  }

  lines.push('```');
  return lines;
}

/**
 * Pads a numeric string with Unicode Figure Spaces (U+2007) so it maintains fixed tabular width
 * in proportional UI fonts without collapsing or jittering when numbers shift between digits.
 *
 * @param str - The formatted number string (e.g. '8.45').
 * @param targetLength - Desired character count for the numeric part.
 * @returns String padded with figure spaces on the left.
 */
export function padNum(str: string, targetLength: number): string {
  return str.padStart(targetLength, '\u2007');
}
