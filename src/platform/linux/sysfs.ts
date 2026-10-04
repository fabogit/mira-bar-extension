import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * Shared sysfs and procfs access for the Linux providers. No helper throws: an unreadable file or
 * directory (device gone, driver failing the read with ENODATA, no permission) reads as `null`, `NaN`
 * or an empty list.
 *
 * The synchronous helpers serve discovery and the reads on the extension host thread (attributes
 * served from kernel memory, a few µs each); the asynchronous ones serve the component sensors, whose
 * reads go through the device (ADR-0016).
 */

/** Readings outside this range (°C) are treated as invalid. */
export const MIN_VALID_CELSIUS = -40;
export const MAX_VALID_CELSIUS = 150;
/** Limits (max, crit, trip points) above this (°C) are treated as invalid. */
const MAX_LIMIT_CELSIUS = MAX_VALID_CELSIUS + 50;

// --- synchronous -----------------------------------------------------------------------------------

/** A file's content without surrounding whitespace, or `null` if unreadable. */
export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** An integer attribute (`parseInt`), or `NaN` if the file is unreadable or not a number. */
export function readInt(file: string): number {
  try {
    return parseInt(fs.readFileSync(file, 'utf8'), 10);
  } catch {
    return NaN;
  }
}

/** A directory's entries in the order the kernel lists them, or `[]` if it is missing or unreadable. */
export function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The canonical path (symlinks resolved), or `null` if it does not exist. */
export function realpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Whether a file exists: a stat, which neither reads the attribute nor reaches the device. */
export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/**
 * Read buffer shared by every {@link SysfsAttribute}: reads are synchronous, so it is never used by
 * two reads at once. A sysfs attribute is at most one page.
 */
const ATTRIBUTE_BUFFER = Buffer.allocUnsafe(4096);
/** Where {@link SysfsAttribute.refreshAsync} reads: the value is dropped, so concurrent reads may share it. */
const REFRESH_BUFFER = Buffer.allocUnsafe(64);

/** Closes a descriptor, ignoring an already invalid one. */
function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // already invalid: nothing to release
  }
}

/**
 * A sysfs attribute a provider reads at every sample (per-core cpufreq, the CPU sensor, the battery
 * files), found once by discovery. The file is opened at the first read and kept open: each read is a
 * single `pread` at offset 0, which makes the kernel produce the value again, instead of
 * open + read + close (issue #40, bench:linux: the 16 cpufreq files in 20 µs instead of 114, the
 * battery in 9 µs instead of 57, reads back to back).
 * A failed read closes the descriptor and retries once with a fresh one (device removed and back,
 * core offlined); `close()` releases it when the provider drops the attribute.
 */
export class SysfsAttribute {
  private fd = -1;
  private refreshing = false;
  /** A descriptor closed while a refresh was reading it: closed when that read completes. */
  private closeAfterRefresh = -1;

  constructor(public readonly file: string) {}

  /** The content without surrounding whitespace, or `null` if unreadable. */
  public readText(): string | null {
    const length = this.read();
    return length < 0 ? null : ATTRIBUTE_BUFFER.toString('utf8', 0, length).trim();
  }

  /** The value as an integer, or `NaN` if unreadable or not a number. */
  public readInt(): number {
    const length = this.read();
    return length < 0 ? NaN : parseInt(ATTRIBUTE_BUFFER.toString('latin1', 0, length), 10);
  }

  /**
   * Reads the attribute on the libuv pool and drops the value, so that the driver refreshes what it
   * caches off the extension host thread. ACPI battery (issue #40): the first read after the driver's
   * 1 s cache expires queries the embedded controller (~250 µs); after this refresh the next synchronous
   * read is served from the cache. Does nothing before the first synchronous read (no descriptor yet)
   * or while a refresh is in flight.
   */
  public refreshAsync(): void {
    if (this.fd < 0 || this.refreshing) {
      return;
    }
    this.refreshing = true;
    fs.read(this.fd, REFRESH_BUFFER, 0, REFRESH_BUFFER.length, 0, () => {
      this.refreshing = false;
      if (this.closeAfterRefresh >= 0) {
        closeQuietly(this.closeAfterRefresh);
        this.closeAfterRefresh = -1;
      }
    });
  }

  /** Closes the descriptor, if open; a later read opens it again. */
  public close(): void {
    if (this.fd < 0) {
      return;
    }
    if (this.refreshing) {
      this.closeAfterRefresh = this.fd; // the refresh still reads it: its number must not be reused yet
    } else {
      closeQuietly(this.fd);
    }
    this.fd = -1;
  }

  /** Reads the attribute into the shared buffer: the number of bytes, or -1 if unreadable. */
  private read(): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = this.fd < 0;
      try {
        if (reopened) {
          this.fd = fs.openSync(this.file, 'r');
        }
        return fs.readSync(this.fd, ATTRIBUTE_BUFFER, 0, ATTRIBUTE_BUFFER.length, 0);
      } catch {
        this.close();
        if (reopened) {
          return -1; // a fresh descriptor failed too: missing file or the driver refuses the read
        }
      }
    }
    return -1;
  }
}

/** Closes the attributes no longer in use after a rediscovery (those of `previous` not in `current`). */
export function closeDropped(previous: Iterable<SysfsAttribute | undefined>, current: Iterable<SysfsAttribute | undefined>): void {
  const kept = new Set(current);
  for (const attr of previous) {
    if (attr && !kept.has(attr)) {
      attr.close();
    }
  }
}

/**
 * The attribute `name` of `dir` if the file exists (checked with a stat, not read), else `undefined`.
 *
 * @param reuse - Attributes of the previous discovery by path: the same file keeps its open descriptor.
 */
export function attribute(dir: string, name: string, reuse?: ReadonlyMap<string, SysfsAttribute>): SysfsAttribute | undefined {
  const file = path.join(dir, name);
  if (!exists(file)) {
    return undefined;
  }
  return reuse?.get(file) ?? new SysfsAttribute(file);
}

// --- asynchronous (libuv pool) ---------------------------------------------------------------------

/** A file's content without surrounding whitespace, or `null` if unreadable. */
export async function readTextAsync(file: string): Promise<string | null> {
  try {
    return (await fsp.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** A numeric attribute (`Number`, so trailing garbage is rejected), or `null` if unreadable, empty or not finite. */
export async function readNumberAsync(file: string): Promise<number | null> {
  const text = await readTextAsync(file);
  if (text === null || text === '') {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A directory's entries in the order the kernel lists them, or `[]` if it is missing or unreadable. */
export async function listDirAsync(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** Whether a file exists: a stat, which neither reads the attribute nor reaches the device. */
export async function existsAsync(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** The canonical path (symlinks resolved), or `null` if it does not exist. */
export async function realpathAsync(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

// --- shared rules ----------------------------------------------------------------------------------

/** Whether a temperature reading (°C) is plausible. */
export function plausibleCelsius(celsius: number): boolean {
  return celsius > MIN_VALID_CELSIUS && celsius <= MAX_VALID_CELSIUS;
}

/**
 * A temperature limit (`temp*_max`, `temp*_crit`, a trip point) in °C.
 *
 * @param raw - Value read from the file (`null` or `NaN` when unreadable).
 * @param divisor - From the file's unit to °C (1000 for m°C).
 * @returns The limit, or `undefined` when missing or implausible (some drivers report 0 or garbage).
 */
export function plausibleLimit(raw: number | null, divisor: number): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const celsius = raw / divisor;
  return celsius > 0 && celsius <= MAX_LIMIT_CELSIUS ? celsius : undefined;
}

/**
 * Whether a `/sys/class/power_supply` entry is a system battery: `type` Battery and a `scope` other
 * than Device (a mouse, keyboard or game controller reports its own battery). ACPI batteries have no
 * `scope`. The same rule for the battery section and the battery temperature sensor; `scope` is read
 * only for batteries.
 */
export function isSystemBattery(dir: string): boolean {
  return readText(path.join(dir, 'type')) === 'Battery' && readText(path.join(dir, 'scope')) !== 'Device';
}

/** {@link isSystemBattery}, read on the libuv pool. */
export async function isSystemBatteryAsync(dir: string): Promise<boolean> {
  return (await readTextAsync(path.join(dir, 'type'))) === 'Battery' && (await readTextAsync(path.join(dir, 'scope'))) !== 'Device';
}
