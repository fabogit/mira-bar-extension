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

/**
 * A sysfs attribute a provider reads at every sample (per-core cpufreq, the CPU sensor, the battery
 * files), found once by discovery. The file is opened at the first read and kept open: each read is a
 * single `pread` at offset 0, which makes the kernel produce the value again, instead of
 * open + read + close (issue #40: about 2 µs per file instead of 12 for the 16 cpufreq files).
 * A failed read closes the descriptor and retries once with a fresh one (device removed and back,
 * core offlined); `close()` releases it when the provider drops the attribute.
 */
export class SysfsAttribute {
  private fd = -1;

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

  /** Closes the descriptor, if open; a later read opens it again. */
  public close(): void {
    if (this.fd >= 0) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // already invalid: nothing to release
      }
      this.fd = -1;
    }
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
