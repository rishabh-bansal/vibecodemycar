import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { Elm327Emulator } from '../src/emulator/elm327.ts';
import { ecusFromProfile, type VehicleProfile } from '../src/emulator/profile.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';
import { seeded } from './helpers.ts';

const file = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/demo/kushaq-demo.profile.json');
const profile = JSON.parse(readFileSync(file, 'utf8')) as VehicleProfile;

describe('demo vehicle from the recorded drive', () => {
  it('is marked demo and carries a synthetic VIN only', () => {
    expect(profile.demo).toBe(true);
    expect(profile.vin).toBe('TMBDEMO0OBDCRAFT1');
    // the VIN reply in the profile is the synthetic one
    const vinHex = profile.statics['7E8']!['0902']!;
    const text = String.fromCharCode(...vinHex.slice(6).match(/../g)!.map((h) => parseInt(h, 16)));
    expect(text).toBe(profile.vin);
  });

  it('a full scan of the demo car decodes everything it advertises', async () => {
    const clock = new VirtualClock();
    const emu = new Elm327Emulator({ clock, ecus: ecusFromProfile(profile), random: seeded(5), writeLatencyMs: 40, bytesPerMs: 1.3, startSeconds: 300 });
    const engine = new OBDCraftEngine({ clock });
    await runVirtual(clock, engine.connect(emu));
    const scan = await runVirtual(clock, engine.fullScan());
    const cov = engine.coverage();
    expect(cov.rows.filter((r) => r.decoded === 0)).toEqual([]);
    expect(scan.identity?.vin).toBe(profile.vin);
    expect(scan.monitors!.perEcu[0]!.tests.length).toBeGreaterThanOrEqual(13);
    expect(engine.ecus.find((e) => e.id === '7E8')!.name).toBe('ECM-EngineControl');
  });

  it('live values move with the recorded drive', async () => {
    const clock = new VirtualClock();
    const emu = new Elm327Emulator({ clock, ecus: ecusFromProfile(profile), random: seeded(6), writeLatencyMs: 40, bytesPerMs: 1.3 });
    const engine = new OBDCraftEngine({ clock });
    await runVirtual(clock, engine.connect(emu));
    await runVirtual(clock, engine.startLive());
    await runVirtual(clock, clock.sleep(240_000));
    await runVirtual(clock, engine.stopLive());
    const speeds = engine.store.history.get('7E8:speed')!.map((p) => p.v);
    expect(Math.max(...speeds)).toBeGreaterThan(20);
    expect(new Set(speeds).size).toBeGreaterThan(5);
    expect(engine.liveRate().valuesPerSecond).toBeGreaterThan(15);
  });
});
