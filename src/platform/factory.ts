import type { PlatformLogger, TelemetryPlatformProvider } from './interface.js';
import { DarwinTelemetryProvider } from './darwin/darwin_provider.js';
import { LinuxTelemetryProvider } from './linux/linux_provider.js';

/**
 * Creates the telemetry provider for the runtime OS (process.platform only; the architecture is not
 * checked). macOS gets the darwin provider, every other OS the Linux one (/proc, /sys): on an OS without
 * them (e.g. Windows) its reads return null and those sections stay hidden; activation does not fail.
 *
 * @param log - Where the providers report non-fatal problems (the MiraBar output channel).
 * @returns The TelemetryPlatformProvider for the active system.
 */
export function createPlatformProvider(log: PlatformLogger): TelemetryPlatformProvider {
  if (process.platform === 'darwin') {
    return new DarwinTelemetryProvider(log);
  }

  return new LinuxTelemetryProvider();
}
