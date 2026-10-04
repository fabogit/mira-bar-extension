// Linux battery time remaining against a mocked sysfs tree (#3): driver estimates, energy over power,
// charge over current (signed or not), states without a time, zero or missing rates, implausible
// values, several batteries, discovery (system batteries only, rescan while none is found, #45), and
// the tooltip row.
//
// Usage (any OS):  pnpm test
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { BatteryProvider } from '../../src/platform/linux/battery.js';
import { renderBattery } from '../../src/sections.js';
import type { MiraBarConfig } from '../../src/config.js';
import type { BatteryInfo } from '../../src/types.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
function setup(batteries: Record<string, Files>, now?: () => number): { root: string; provider: BatteryProvider } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirabar-sysfs-'));
  roots.push(root);
  write(root, 'ACAD', { type: 'Mains', online: 0 });
  for (const [name, files] of Object.entries(batteries)) {
    write(root, name, { type: 'Battery', ...files });
  }
  return { root, provider: new BatteryProvider(root, now) };
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

test('energy_now / power_now, discharging and charging', () => {
  // Energy over power: 40 Wh / 10 W = 4 h; charging: (50 - 40) Wh / 20 W = 30 min.
  const { root, provider } = setup({ BAT0: energy('Discharging', { power_now: 10_000_000 }) });
  assert.equal(time(provider), 240);
  write(root, 'BAT0', { status: 'Charging', power_now: 20_000_000 });
  assert.equal(time(provider), 30);
});

test('time_to_empty_now / time_to_full_now first', () => {
  // The driver's estimate wins; 0 (no estimate) falls back to the rate.
  const { root, provider } = setup({ BAT0: energy('Discharging', { power_now: 10_000_000, time_to_empty_now: 3600, time_to_full_now: 900 }) });
  assert.equal(time(provider), 60);
  write(root, 'BAT0', { time_to_empty_now: 0 });
  assert.equal(time(provider), 240, 'time_to_empty_now 0: rate');
  write(root, 'BAT0', { status: 'Charging' });
  assert.equal(time(provider), 15, 'time_to_full_now');
});

test('charge_now / current_now, negative current', () => {
  // Charge over current, signed or not: 2760 mAh / 1380 mA = 2 h; (3678 - 2760) mAh / 918 mA = 1 h.
  const { root, provider } = setup({ BAT1: charge('Discharging', { current_now: -1_380_000 }) });
  assert.equal(time(provider), 120);
  write(root, 'BAT1', { current_now: 1_380_000 });
  assert.equal(time(provider), 120);
  write(root, 'BAT1', { status: 'Charging', current_now: 918_000 });
  assert.equal(time(provider), 60);
});

test('Full, Not charging, Unknown: no time', () => {
  // No time when the battery is idle, whatever the rate says.
  const { root, provider } = setup({ BAT1: charge('Charging', { current_now: 918_000 }) });
  for (const status of ['Full', 'Not charging', 'Unknown']) {
    write(root, 'BAT1', { status, current_now: 918_000 });
    const info = provider.sample()!;
    assert.equal(info.status, status);
    assert.equal(info.isCharging, false);
    assert.equal(info.timeRemainingMinutes, undefined, status);
  }
});

test('zero, unreadable or missing rate', () => {
  // Discharging without a usable rate: -1 (estimating), as macOS. Charging: no time.
  const { root, provider } = setup({ BAT1: charge('Discharging', { current_now: 0 }) });
  assert.equal(time(provider), -1, 'current_now 0');
  write(root, 'BAT1', { current_now: 'garbage' });
  assert.equal(time(provider), -1, 'unreadable current_now');
  fs.rmSync(path.join(root, 'class/power_supply/BAT1/current_now'));
  assert.equal(time(provider), -1, 'current_now removed after discovery');
  assert.equal(provider.sample()!.currentCapacity, 2760, 'the other values are still read');
  assert.equal(time(setup({ BAT0: energy('Discharging') }).provider), -1, 'no power_now');
  assert.equal(time(setup({ BAT0: energy('Charging') }).provider), undefined, 'charging without power_now');
});

test('estimates above 48 h discarded', () => {
  // Implausible: 40 Wh at 0.5 W is 80 h (cap 48 h); a 1-week driver estimate falls back to the rate.
  const { root, provider } = setup({ BAT0: energy('Discharging', { power_now: 500_000 }) });
  assert.equal(time(provider), -1);
  write(root, 'BAT0', { status: 'Charging', power_now: 100_000 });
  assert.equal(time(provider), undefined, '10 Wh at 0.1 W: 100 h');
  assert.equal(time(setup({ BAT0: energy('Discharging', { power_now: 10_000_000, time_to_empty_now: 7 * 86400 }) }).provider), 240);
});

test('several batteries', () => {
  // Two batteries draining one after the other: summed energy over summed power, per-battery times ignored.
  let { provider } = setup({
    BAT0: energy('Discharging', { energy_now: 20_000_000, power_now: 10_000_000, time_to_empty_now: 7200 }),
    BAT1: energy('Unknown', { energy_now: 30_000_000, power_now: 0 }),
  });
  let info: BatteryInfo = provider.sample()!;
  assert.equal(info.status, 'Discharging');
  assert.equal(info.timeRemainingMinutes, 300);
  ({ provider } = setup({ BAT0: energy('Charging', { power_now: 20_000_000 }), BAT1: energy('Not charging', { power_now: 0 }) }));
  info = provider.sample()!;
  assert.equal(info.status, 'Charging');
  assert.equal(info.timeRemainingMinutes, 60, '(100 - 80) Wh / 20 W');
  ({ provider } = setup({ BAT0: energy('Full'), BAT1: energy('Not charging') }));
  assert.equal(provider.sample()!.status, 'Not charging');
});

test('system batteries only (type Battery, scope not Device)', () => {
  // Discovery by type, not by name: a fuel gauge battery counts, a mouse battery (scope Device) does not.
  const { provider } = setup({
    'bq27500-0': charge('Discharging', { current_now: 1_380_000 }),
    hidpp_battery_0: { scope: 'Device', status: 'Discharging', capacity: 5 },
  });
  const info = provider.sample()!;
  assert.deepEqual([info.percent, info.timeRemainingMinutes], [75, 120], 'the mouse battery is not averaged in');
});

test('battery appearing after activation found by the rescan (#45)', () => {
  // No battery at activation (inserted or driver loaded later): rescanned at most once a minute.
  let now = 1_000_000;
  const { root, provider } = setup({}, () => now);
  assert.equal(provider.isAvailable, false);
  write(root, 'BAT0', { type: 'Battery', ...energy('Discharging', { power_now: 10_000_000 }) });
  now += 59_999;
  assert.equal(provider.isAvailable, false, 'no rescan before 60 s');
  assert.equal(provider.sample(), null);
  now += 1;
  assert.equal(provider.isAvailable, true);
  assert.equal(time(provider), 240);
});

test('tooltip row and icon', () => {
  // Tooltip row: same field and rendering as macOS.
  const ctx = { config: {} as MiraBarConfig, updatedAt: '12:00:00' };
  const row = (bat: BatteryInfo): string => renderBattery(bat, ctx, true).tooltip!.split('\n').find((l) => l.startsWith('Power State'))!;
  const { root, provider } = setup({ BAT0: energy('Discharging', { power_now: 9_000_000 }) });
  assert.match(row(provider.sample()!), /Discharging\s+│ 4h 27m \(remaining\)/);
  write(root, 'BAT0', { status: 'Charging', power_now: 20_000_000 });
  assert.match(row(provider.sample()!), /Charging\s+│ 30m \(until full\)/);
  write(root, 'BAT0', { status: 'Discharging', power_now: 0 });
  assert.match(row(provider.sample()!), /Discharging\s+│ Estimating\.\.\./);
  write(root, 'BAT0', { status: 'Not charging' });
  const notCharging = provider.sample()!;
  assert.match(row(notCharging), /Not charging\s+│ AC Connected/);
  assert.ok(renderBattery(notCharging, ctx, false).text.startsWith('$(plug)'), 'not charging: plug icon, not the battery');
});
