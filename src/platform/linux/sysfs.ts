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

/** Whether a file exists: a stat, which neither reads the attribute nor reaches the device. */
export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/**
 * A sysfs attribute a provider reads at every sample (per-core cpufreq, the CPU sensor, the battery
 * files), found once by discovery. Each read opens the file by path; how it is read (e.g. keeping the
 * descriptor open and reading at offset 0) is decided here only.
 */
export class SysfsAttribute {
  constructor(public readonly file: string) {}

  /** The content without surrounding whitespace, or `null` if unreadable. */
  public readText(): string | null {
    return readText(this.file);
  }

  /** The value as an integer, or `NaN` if unreadable or not a number. */
  public readInt(): number {
    return readInt(this.file);
  }
}

/** The attribute `name` of `dir` if the file exists (checked with a stat, not read), else `undefined`. */
export function attribute(dir: string, name: string): SysfsAttribute | undefined {
  const file = path.join(dir, name);
  return exists(file) ? new SysfsAttribute(file) : undefined;
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
