/**
 * Pure formatting helpers for status bar texts and tooltip Markdown (no VS Code dependency).
 */

/**
 * Formats a raw byte count into a human-readable string with dynamic unit scaling (B, KB, MB, GB, TB).
 *
 * @param bytes - The size in bytes to format.
 * @param precision - Number of decimal places to include (default: 2).
 * @returns Formatted size string (e.g. '16.42 GB').
 */
export function formatBytes(bytes: number, precision = 2): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let unitIndex = 0;

  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }

  return `${val.toFixed(precision)} ${units[unitIndex]}`;
}

/**
 * Formats a duration in minutes into a human-readable string (e.g. '1h 24m').
 *
 * @param minutes - Total duration in minutes.
 * @returns Formatted duration string or 'Estimating...'.
 */
export function formatMinutes(minutes: number): string {
  if (minutes < 0) {
    return 'Estimating...';
  }
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}m`;
}

/**
 * Formats a duration in milliseconds compactly: '200 ms', '1.5 s', '10 s', '2 min'.
 *
 * @param ms - Duration in milliseconds.
 * @returns Human-readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  if (ms < 60_000) {
    return `${Number((ms / 1000).toFixed(1))} s`;
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
  const clamped = isNaN(percent) ? 0 : Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;
  const bar = `${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}`;
  return codeWrapped ? `[\`${bar}\`]` : `[${bar}]`;
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
  leftCores: { label: string; pct: number }[],
  rightCores: { label: string; pct: number }[]
): string[] {
  const colWidth = 23;
  const maxRows = Math.max(leftCores.length, rightCores.length);
  const lines: string[] = ['```text'];

  const leftHeader = leftTitle.padEnd(colWidth, ' ');
  const rightHeader = rightTitle.padEnd(colWidth, ' ');
  lines.push(`${leftHeader} │ ${rightHeader}`);
  lines.push(`${'─'.repeat(colWidth)}─┼─${'─'.repeat(colWidth)}`);

  for (let r = 0; r < maxRows; r++) {
    const left = leftCores[r];
    const right = rightCores[r];

    let leftCell = ''.padEnd(colWidth, ' ');
    if (left) {
      const label = left.label.padEnd(3, ' ');
      const bar = renderBar(left.pct, 6, false);
      const pctStr = left.pct.toFixed(1).padStart(5, ' ');
      leftCell = `${label}: ${bar} ${pctStr}%`.padEnd(colWidth, ' ');
    }

    let rightCell = '';
    if (right) {
      const label = right.label.padEnd(3, ' ');
      const bar = renderBar(right.pct, 6, false);
      const pctStr = right.pct.toFixed(1).padStart(5, ' ');
      rightCell = `${label}: ${bar} ${pctStr}%`;
    }

    lines.push(`${leftCell} │ ${rightCell}`);
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
      let val = row[cIdx] ?? '';
      if (col.maxWidth && val.length > col.maxWidth) {
        val = col.truncatePath
          ? truncatePath(val, col.maxWidth)
          : val.slice(0, Math.max(0, col.maxWidth - 3)) + '...';
      }
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

  // 2. Format header
  const headerCells = columns.map((col, idx) => {
    const w = colWidths[idx]!;
    return col.align === 'right' ? col.header.padStart(w, ' ') : col.header.padEnd(w, ' ');
  });
  lines.push(headerCells.join(' │ '));

  // 3. Format divider line
  const dividerCells = colWidths.map((w) => '─'.repeat(w));
  lines.push(dividerCells.join('─┼─'));

  // 4. Format rows
  for (const row of rows) {
    const rowCells = columns.map((col, idx) => {
      const w = colWidths[idx]!;
      let val = row[idx] ?? '';
      if (val.length > w) {
        val = col.truncatePath
          ? truncatePath(val, w)
          : val.slice(0, Math.max(0, w - 3)) + '...';
      }
      return col.align === 'right' ? val.padStart(w, ' ') : val.padEnd(w, ' ');
    });
    lines.push(rowCells.join(' │ '));
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
