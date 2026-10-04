// Formatting helpers (src/format.ts): sizes, durations, clock, bars, table cells, path truncation and
// the box-drawing tables, with the edge cases fixed in #47 (rounding before the unit is chosen, values
// that cannot be formatted, columns narrower than the truncation marker) kept as regressions.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  barCell,
  formatBytes,
  formatClock,
  formatDuration,
  formatMinutes,
  padNum,
  renderBar,
  renderCoreList,
  renderDynamicAsciiTable,
  renderMonospaceTable,
  truncatePath,
} from '../../src/format.js';

/** U+2007 figure space, the padding of numbers in proportional fonts. */
const FS = '\u2007';

/** Checks every [input, expected] pair of a table against `fn`. */
function table<I>(fn: (input: I) => string, cases: readonly (readonly [I, string])[]): void {
  for (const [input, expected] of cases) {
    assert.equal(fn(input), expected, `input ${JSON.stringify(input) ?? String(input)}`);
  }
}

describe('formatDuration', () => {
  test('values that cannot be formatted (#47)', () => {
    // Negative, NaN and infinite durations show a dash instead of '-1 ms' or 'NaN min'.
    table(formatDuration, [
      [-1, '—'],
      [Number.NaN, '—'],
      [Number.POSITIVE_INFINITY, '—'],
    ]);
  });

  test('unit chosen after rounding (#47)', () => {
    // 999.5 ms rounds to 1000 ms, so it is '1 s'; 59950 ms rounds to 60.0 s, so it is '1 min'.
    table(formatDuration, [
      [0, '0 ms'],
      [0.4, '0 ms'],
      [999.4, '999 ms'],
      [999.5, '1 s'],
      [999.96, '1 s'],
      [1000, '1 s'],
      [1500, '1.5 s'],
      [59949, '59.9 s'],
      [59950, '1 min'],
      [59999, '1 min'],
      [60000, '1 min'],
      [90000, '1.5 min'],
    ]);
  });

  test('minutes stay the largest unit', () => {
    // No hours: one hour is '60 min', 100 hours '6000 min'.
    table(formatDuration, [
      [3540000, '59 min'],
      [3599999, '60 min'],
      [3600000, '60 min'],
      [359999999, '6000 min'],
    ]);
  });
});

describe('formatBytes', () => {
  test('values that cannot be formatted, negative values (#47)', () => {
    // NaN and infinities show a dash; a negative size scales like a positive one.
    table(formatBytes, [
      [Number.NaN, '—'],
      [Number.POSITIVE_INFINITY, '—'],
      [Number.NEGATIVE_INFINITY, '—'],
      [-1, '-1.00 B'],
      [-2048, '-2.00 KB'],
    ]);
  });

  test('unit chosen after rounding (#47)', () => {
    // A value that rounds to 1024 of a unit is shown as 1 of the next one, never as '1024.00'.
    table(formatBytes, [
      [0, '0.00 B'],
      [1023.994, '1023.99 B'],
      [1023.995, '1.00 KB'],
      [1023.999, '1.00 KB'],
      [1024, '1.00 KB'],
      [1048575, '1.00 MB'],
      [1048575.999, '1.00 MB'],
      [1024 ** 2 * 1023.999, '1.00 GB'],
      [16.42 * 1024 ** 3, '16.42 GB'],
    ]);
  });

  test('TB is the top unit', () => {
    // Above 1024 TB the value grows in TB instead of switching to a unit the helper does not have.
    table(formatBytes, [
      [1024 ** 4 * 1023.999, '1024.00 TB'],
      [5 * 1024 ** 5, '5120.00 TB'],
    ]);
  });

  test('precision 0 (#47)', () => {
    // The rounding rule holds with any precision: 1023.6 B is '1 KB', 999.5 B stays in bytes.
    const whole = (bytes: number): string => formatBytes(bytes, 0);
    table(whole, [
      [1023.6, '1 KB'],
      [1023.4, '1023 B'],
      [1048575, '1 MB'],
      [999.5, '1000 B'],
    ]);
  });
});

describe('formatMinutes', () => {
  test('whole minutes, hours from 60 (#47)', () => {
    // Rounded to whole minutes before splitting: 59.6 min is '1h 0m', 1439.9 min '24h 0m'.
    table(formatMinutes, [
      [0, '0m'],
      [0.4, '0m'],
      [0.5, '1m'],
      [59.4, '59m'],
      [59.6, '1h 0m'],
      [60, '1h 0m'],
      [90.5, '1h 31m'],
      [119.5, '2h 0m'],
      [1439.9, '24h 0m'],
    ]);
  });

  test('no estimate (#47)', () => {
    // Negative (the -1 of "still estimating") and non-finite values.
    table(formatMinutes, [
      [-0.5, 'Estimating...'],
      [-1, 'Estimating...'],
      [Number.NaN, 'Estimating...'],
      [Number.POSITIVE_INFINITY, 'Estimating...'],
    ]);
  });
});

test('formatClock: 24h, zero-padded, tenths on request', () => {
  // Local time fields, so the result does not depend on the host's time zone or locale.
  const date = new Date(2026, 0, 2, 3, 4, 5, 678);
  assert.equal(formatClock(date), '03:04:05');
  assert.equal(formatClock(date, true), '03:04:05.6', 'tenths truncated, not rounded');
  assert.equal(formatClock(new Date(2026, 0, 2, 23, 59, 59, 999), true), '23:59:59.9');
  assert.equal(formatClock(new Date(2026, 0, 2, 0, 0, 0, 0), true), '00:00:00.0');
});

describe('renderBar', () => {
  test('clamped to 0-100 (regression)', () => {
    // NaN and negative values draw an empty bar, values above 100 a full one.
    const bar = (pct: number): string => renderBar(pct, 6, false);
    table(bar, [
      [Number.NaN, '[░░░░░░]'],
      [-1, '[░░░░░░]'],
      [0, '[░░░░░░]'],
      [150, '[██████]'],
    ]);
  });

  test('rounded fill, default width and code ticks', () => {
    // 42.9% of 6 cells is 2.57, drawn as 3; the default is 8 cells inside Markdown code ticks.
    assert.equal(renderBar(42.9, 6, false), '[███░░░]');
    assert.equal(renderBar(50), '[`████░░░░`]');
    assert.equal(renderBar(100, 4), '[`████`]');
  });
});

test('barCell: bar and right-aligned percentage (#47)', () => {
  // Default gap of two spaces, then the percentage padded to 5 characters (one decimal).
  assert.equal(barCell(42.9), '[███░░░]   42.9%');
  assert.equal(barCell(42.9, 1), '[███░░░]  42.9%');
  assert.equal(barCell(100), '[██████]  100.0%');
  assert.equal(barCell(0), '[░░░░░░]    0.0%');
});

test('renderCoreList: one line per core, figure-space padding (#47)', () => {
  // The two characters before 7.3 are figure spaces: the bars stay aligned in proportional fonts.
  assert.deepEqual(renderCoreList([{ label: 'P6', pct: 7.25 }]), [`- **Core P6**: [\`░░░░░░\`] ${FS}${FS}7.3%`]);
  assert.deepEqual(renderCoreList([]), []);
  assert.deepEqual(renderCoreList([{ label: '0', pct: 100 }, { label: '1', pct: 50 }]), [
    '- **Core 0**: [`██████`] 100.0%',
    `- **Core 1**: [\`███░░░\`] ${FS}50.0%`,
  ]);
});

test('padNum: figure spaces on the left', () => {
  assert.equal(padNum('8.45', 5), `${FS}8.45`);
  assert.equal(padNum('100.00', 5), '100.00', 'longer strings unchanged');
  assert.equal(padNum('', 2), `${FS}${FS}`);
});

describe('truncatePath', () => {
  test('fits: unchanged; no room: empty (#47)', () => {
    assert.equal(truncatePath('/abc/def', 8), '/abc/def');
    assert.equal(truncatePath('/abc/def', 100), '/abc/def');
    // A width of 0 or less leaves no room at all: the path used to come back whole.
    assert.equal(truncatePath('/abc/def', 0), '');
    assert.equal(truncatePath('/abc/def', -1), '');
  });

  test('up to 4 characters: the tail of the path', () => {
    // Too narrow for '.../' plus a character: the last characters, as the table cells need.
    assert.equal(truncatePath('/abc/def', 2), 'ef');
    assert.equal(truncatePath('/abc/def', 4), '/def');
  });

  test('POSIX separator: whole trailing segments after "..."', () => {
    const p = '/home/user/projects/kind-newton';
    assert.equal(truncatePath(p, 20), '.../kind-newton');
    assert.equal(truncatePath(p, 24), '.../projects/kind-newton');
    assert.equal(truncatePath(p, 30), '.../user/projects/kind-newton');
    // A trailing separator is dropped when that is enough to fit.
    assert.equal(truncatePath('/abc/def/', 8), '/abc/def');
  });

  test('Windows separator: whole trailing segments after "..."', () => {
    const p = 'C:\\Users\\fabo\\Projects\\kind-newton';
    assert.equal(truncatePath(p, 20), '...\\kind-newton');
    assert.equal(truncatePath(p, 24), '...\\Projects\\kind-newton');
    assert.equal(truncatePath('D:\\data\\', 7), 'D:\\data');
  });

  test('leaf longer than the width: cut inside the leaf, "..." kept', () => {
    // The last characters of the leaf after '.../' (or '...\'), never wider than asked.
    assert.equal(truncatePath('/a/verylongdirectoryname', 10), '.../ryname');
    assert.equal(truncatePath('C:\\verylongdirectoryname', 10), '...\\ryname');
    assert.equal(truncatePath('/verylongdirectoryname', 5), '.../e');
  });
});

describe('renderDynamicAsciiTable', () => {
  /** Header, divider and body lines, without the code fence. */
  const body = (lines: string[]): string[] => {
    assert.equal(lines[0], '```text');
    assert.equal(lines.at(-1), '```');
    return lines.slice(1, -1);
  };

  test('widths from the longest cell, alignment, separators', () => {
    // Left and right alignment, ' │ ' between cells, '─┼─' in the divider, missing cells empty.
    const lines = body(renderDynamicAsciiTable(
      [{ header: 'Name', align: 'left' }, { header: 'Size', align: 'right' }],
      [['root', '1.00 GB'], ['a']]
    ));
    assert.deepEqual(lines, [
      'Name │    Size',
      '─────┼────────',
      'root │ 1.00 GB',
      'a    │        ',
    ]);
  });

  test('minWidth widens, maxWidth truncates with "..."', () => {
    const lines = body(renderDynamicAsciiTable(
      [{ header: 'A', minWidth: 5 }, { header: 'Value', maxWidth: 6 }],
      [['x', 'abcdefghij']]
    ));
    assert.deepEqual(lines, [
      'A     │ Value ',
      '──────┼───────',
      'x     │ abc...',
    ]);
  });

  test('maxWidth below the marker width (#47)', () => {
    // One column, empty header, value 'abcdef': a column narrower than '...' cuts the value short
    // instead of overflowing with the marker; maxWidth 0 means no limit.
    const cell = (maxWidth: number): string => body(renderDynamicAsciiTable([{ header: '', maxWidth }], [['abcdef']]))[2]!;
    table(cell, [
      [0, 'abcdef'],
      [1, 'a'],
      [2, 'ab'],
      [3, '...'],
      [4, 'a...'],
      [6, 'abcdef'],
    ]);
  });

  test('header wider than maxWidth is cut too (#47)', () => {
    const lines = body(renderDynamicAsciiTable([{ header: 'Mount', maxWidth: 2 }], [['/']]));
    assert.deepEqual(lines, ['Mo', '──', '/ ']);
  });

  test('path columns keep the trailing segments', () => {
    // truncatePath instead of '...' at the end, the rest of the table as usual.
    const cell = (path: string, maxWidth: number): string =>
      body(renderDynamicAsciiTable([{ header: 'Mount', minWidth: 5, maxWidth, truncatePath: true }], [[path]]))[2]!;
    assert.equal(cell('/abc/def', 2), 'ef');
    assert.equal(cell('/home/user/projects/kind-newton', 20), '.../kind-newton', 'as wide as the fitted cell, not maxWidth');
    assert.equal(cell('C:\\Users\\fabo\\Projects\\kind-newton', 24), '...\\Projects\\kind-newton');
    assert.equal(cell('/', 28), '/    ', 'minWidth');
  });
});

test('renderMonospaceTable: two fixed 23-character columns', () => {
  // Rows up to the longer column; a missing cell is blank, the left one padded to the column width.
  const lines = renderMonospaceTable('Performance Cores', 'Efficiency Cores',
    [{ label: 'P0', pct: 42.9 }, { label: 'P1', pct: 100 }, { label: 'P10', pct: 0 }],
    [{ label: 'E2', pct: 7.25 }]);
  assert.deepEqual(lines, [
    '```text',
    'Performance Cores       │ Efficiency Cores       ',
    '────────────────────────┼────────────────────────',
    'P0 : [███░░░]  42.9%    │ E2 : [░░░░░░]   7.3%',
    'P1 : [██████] 100.0%    │ ',
    'P10: [░░░░░░]   0.0%    │ ',
    '```',
  ]);
  assert.deepEqual(renderMonospaceTable('L', 'R', [], []).length, 4, 'header and divider only');
});
