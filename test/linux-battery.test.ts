// Linux battery time remaining against a mocked sysfs tree (#3): driver estimates, energy over power,
// charge over current (signed or not), states without a time, zero or missing rates, implausible
// values, several batteries, and the tooltip row.
//
// Usage (any OS):  pnpm run test:linux-battery (bundled with the vscode mock: sections.ts imports config.ts)
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BatteryProvider } from '../src/platform/linux/battery.js';
import { renderBattery } from '../src/sections.js';
import type { MiraBarConfig } from '../src/config.js';
import type { BatteryInfo } from '../src/types.js';

const roots: string[] = [];
const step = (name: string): void => console.log(`ok - ${name}`);

type Files = Record<string, string | number>;

/** Writes files into a battery directory (values as in sysfs, newline-terminated). */
function write(root: string, bat: string, files: Files): void {
  const dir = path.join(root, 'class/power_supply', bat);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), `${value}\n`);
  }
}

/** A fresh sysfs tree with the given batteries, and a provider that discovered it. */
function setup(batteries: Record<string, Files>): { root: string; provider: BatteryProvider } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
  roots.push(root);
  write(root, 'ACAD', { type: 'Mains', online: 0 });
  for (const [name, files] of Object.entries(batteries)) {
    write(root, name, { type: 'Battery', ...files });
  }
  return { root, provider: new BatteryProvider(root) };
}

/** Energy-reporting battery (µWh, µW): 40 of 50 Wh. */
const energy = (status: string, extra: Files = {}): Files => ({
  status,
  capacity: 80,
  energy_now: 40_000_000,
  energy_full: 50_000_000,
  energy_full_design: 60_000_000,
  ...extra,
});

/** Charge-reporting battery (µAh, µA): 2760 of 3678 mAh, as on the test laptop (BAT1). */
const charge = (status: string, extra: Files = {}): Files => ({
  status,
  capacity: 75,
  charge_now: 2_760_000,
  charge_full: 3_678_000,
  charge_full_design: 3_915_000,
  ...extra,
});

const time = (provider: BatteryProvider): number | undefined => provider.sample()!.timeRemainingMinutes;

function run(): void {
  // Energy over power: 40 Wh / 10 W = 4 h; charging: (50 - 40) Wh / 20 W = 30 min.
  let { root, provider } = setup({ BAT0: energy('Discharging', { power_now: 10_000_000 }) });
  assert.equal(time(provider), 240);
  write(root, 'BAT0', { status: 'Charging', power_now: 20_000_000 });
  assert.equal(time(provider), 30);
  step('energy_now / power_now, discharging and charging');

  // The driver's estimate wins; 0 (no estimate) falls back to the rate.
  ({ root, provider } = setup({ BAT0: energy('Discharging', { power_now: 10_000_000, time_to_empty_now: 3600, time_to_full_now: 900 }) }));
  assert.equal(time(provider), 60);
  write(root, 'BAT0', { time_to_empty_now: 0 });
  assert.equal(time(provider), 240, 'time_to_empty_now 0: rate');
  write(root, 'BAT0', { status: 'Charging' });
  assert.equal(time(provider), 15, 'time_to_full_now');
  step('time_to_empty_now / time_to_full_now first');

  // Charge over current, signed or not: 2760 mAh / 1380 mA = 2 h; (3678 - 2760) mAh / 918 mA = 1 h.
  ({ root, provider } = setup({ BAT1: charge('Discharging', { current_now: -1_380_000 }) }));
  assert.equal(time(provider), 120);
  write(root, 'BAT1', { current_now: 1_380_000 });
  assert.equal(time(provider), 120);
  write(root, 'BAT1', { status: 'Charging', current_now: 918_000 });
  assert.equal(time(provider), 60);
  step('charge_now / current_now, negative current');

  // No time when the battery is idle, whatever the rate says.
  for (const status of ['Full', 'Not charging', 'Unknown']) {
    write(root, 'BAT1', { status, current_now: 918_000 });
    const info = provider.sample()!;
    assert.equal(info.status, status);
    assert.equal(info.isCharging, false);
    assert.equal(info.timeRemainingMinutes, undefined, status);
  }
  step('Full, Not charging, Unknown: no time');

  // Discharging without a usable rate: -1 (estimating), as macOS. Charging: no time.
  write(root, 'BAT1', { status: 'Discharging', current_now: 0 });
  assert.equal(time(provider), -1, 'current_now 0');
  write(root, 'BAT1', { current_now: 'garbage' });
  assert.equal(time(provider), -1, 'unreadable current_now');
  fs.rmSync(path.join(root, 'class/power_supply/BAT1/current_now'));
  assert.equal(time(provider), -1, 'current_now removed after discovery');
  assert.equal(provider.sample()!.currentCapacity, 2760, 'the other values are still read');
  ({ provider } = setup({ BAT0: energy('Discharging') }));
  assert.equal(time(provider), -1, 'no power_now');
  ({ provider } = setup({ BAT0: energy('Charging') }));
  assert.equal(time(provider), undefined, 'charging without power_now');
  step('zero, unreadable or missing rate');

  // Implausible: 40 Wh at 0.5 W is 80 h (cap 48 h); a 1-week driver estimate falls back to the rate.
  ({ root, provider } = setup({ BAT0: energy('Discharging', { power_now: 500_000 }) }));
  assert.equal(time(provider), -1);
  write(root, 'BAT0', { status: 'Charging', power_now: 100_000 });
  assert.equal(time(provider), undefined, '10 Wh at 0.1 W: 100 h');
  ({ provider } = setup({ BAT0: energy('Discharging', { power_now: 10_000_000, time_to_empty_now: 7 * 86400 }) }));
  assert.equal(time(provider), 240);
  step('estimates above 48 h discarded');

  // Two batteries draining one after the other: summed energy over summed power, per-battery times ignored.
  ({ provider } = setup({
    BAT0: energy('Discharging', { energy_now: 20_000_000, power_now: 10_000_000, time_to_empty_now: 7200 }),
    BAT1: energy('Unknown', { energy_now: 30_000_000, power_now: 0 }),
  }));
  let info: BatteryInfo = provider.sample()!;
  assert.equal(info.status, 'Discharging');
  assert.equal(info.timeRemainingMinutes, 300);
  ({ provider } = setup({ BAT0: energy('Charging', { power_now: 20_000_000 }), BAT1: energy('Not charging', { power_now: 0 }) }));
  info = provider.sample()!;
  assert.equal(info.status, 'Charging');
  assert.equal(info.timeRemainingMinutes, 60, '(100 - 80) Wh / 20 W');
  ({ provider } = setup({ BAT0: energy('Full'), BAT1: energy('Not charging') }));
  assert.equal(provider.sample()!.status, 'Not charging');
  step('several batteries');

  // Tooltip row: same field and rendering as macOS.
  const ctx = { config: {} as MiraBarConfig, updatedAt: '12:00:00' };
  const row = (bat: BatteryInfo): string => renderBattery(bat, ctx, true).tooltip!.split('\n').find((l) => l.startsWith('Power State'))!;
  ({ root, provider } = setup({ BAT0: energy('Discharging', { power_now: 9_000_000 }) }));
  assert.match(row(provider.sample()!), /Discharging\s+│ 4h 27m \(remaining\)/);
  write(root, 'BAT0', { status: 'Charging', power_now: 20_000_000 });
  assert.match(row(provider.sample()!), /Charging\s+│ 30m \(until full\)/);
  write(root, 'BAT0', { status: 'Discharging', power_now: 0 });
  assert.match(row(provider.sample()!), /Discharging\s+│ Estimating\.\.\./);
  write(root, 'BAT0', { status: 'Not charging' });
  const notCharging = provider.sample()!;
  assert.match(row(notCharging), /Not charging\s+│ AC Connected/);
  assert.ok(renderBattery(notCharging, ctx, false).text.startsWith('$(plug)'), 'not charging: plug icon, not the battery');
  step('tooltip row and icon');

  console.log('\nAll Linux battery tests passed.');
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
