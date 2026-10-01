import type { TelemetryPlatformProvider } from './interface.js';
import { DarwinTelemetryProvider } from './darwin/darwin_provider.js';
import { LinuxTelemetryProvider } from './linux/linux_provider.js';

/**
 * Creates the appropriate platform telemetry provider based on runtime OS and architecture.
 *
 * @returns An instance of TelemetryPlatformProvider tuned for the active system.
 */
export function createPlatformProvider(): TelemetryPlatformProvider {
  if (process.platform === 'darwin') {
    return new DarwinTelemetryProvider();
  }

  // Default to Linux provider (/proc, /sys)
  return new LinuxTelemetryProvider();
}
