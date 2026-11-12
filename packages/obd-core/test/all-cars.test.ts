/**
 * The engine against every emulated car type: CAN 11/29-bit, diesel, four ECUs,
 * all five K-line / J1850 protocols, and a car that supports almost nothing.
 * Each profile states what a correct scan finds (carProfiles.ts).
 */
import { describe, expect, it } from 'vitest';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { Elm327Emulator } from '../src/emulator/elm327.ts';
import { CAR_PROFILES, profileEcus, type CarProfile } from '../src/emulator/carProfiles.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';
import type { Reading } from '../src/obd/context.ts';
import { seeded } from './helpers.ts';

async function scanCar(p: CarProfile, liveSeconds = 30) {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator({ clock, ecus: profileEcus(p), protocol: p.protocol, random: seeded(5), writeLatencyMs: 40, bytesPerMs: 1.3 });
  const engine = new OBDCraftEngine({ clock });
  const readings: Reading[] = [];
  engine.on((ev) => {
    if (ev.type === 'readings') readings.push(...ev.readings);
  });
  const run = <T>(x: Promise<T>) => runVirtual(clock, x);
  await run(engine.connect(emu));
  const scan = await run(engine.fullScan());
  await run((async () => {
    await engine.startLive();
    await clock.sleep(liveSeconds * 1000);
    await engine.stopLive();
  })());
  return { emu, engine, scan, readings };
}

describe.each(CAR_PROFILES.map((p) => [p.id, p] as const))('%s', (_id, p) => {
  it(`${p.name}: protocol, ECUs, roles, codes, VIN, freeze frame, every advertised PID, live data`, async () => {
    const { emu, engine, scan, readings } = await scanCar(p);
    const x = p.expect;

    expect(engine.link!.protocol.number).toBe(p.protocol);
    expect(engine.link!.protocol.family).toBe(x.family);
    expect(engine.ecus.map((e) => e.id).sort()).toEqual([...x.ecus].sort());
    expect(engine.ecus.find((e) => e.role === 'engine')!.id).toBe(x.engineEcu);

    // fault codes per ECU (K-line: 3 per message, so 4 codes arrive in two messages)
    const stored = scan.dtcs.stored!;
    for (const [ecu, codes] of Object.entries(x.stored)) {
      const e = stored.perEcu.find((q) => q.ecu === ecu);
      expect(e, `stored ${ecu}`).toBeDefined();
      expect(e!.codes.map((c) => c.code), `stored ${ecu}`).toEqual(codes);
    }
    const anyStored = Object.values(x.stored).some((c) => c.length > 0);
    expect(stored.state).toBe(anyStored ? 'codes' : 'none');
    for (const [ecu, codes] of Object.entries(x.pending ?? {})) {
      expect(scan.dtcs.pending!.perEcu.find((q) => q.ecu === ecu)!.codes.map((c) => c.code), `pending ${ecu}`).toEqual(codes);
    }

    expect(scan.identity?.vin ?? null).toBe(x.vin);
    if (x.freezeDtc) {
      const f = scan.freeze!.perEcu.find((q) => q.ecu === x.engineEcu)!;
      expect(f.state).toBe('stored');
      expect(f.dtc!.code).toBe(x.freezeDtc);
      expect(f.readings.find((r) => r.key === 'rpm')?.value).toBeGreaterThan(0);
    }

    // the readiness monitors are named for the right engine type
    const ign = readings.find((r) => r.key === 'monitor_status_ignition' && r.ecu === x.engineEcu);
    expect(ign?.value).toBe(x.engineType === 'compression' ? 1 : 0);

    // every advertised PID was read and decoded (raw-bytes PIDs included), none silently skipped
    const cov = engine.coverage();
    const failed = cov.rows.filter((r) => r.decoded === 0).map((r) => `${r.ecu}:${r.pid}:${r.lastStatus}`);
    expect(failed).toEqual([]);
    expect(cov.neverRequested).toBe(0);

    expect(engine.liveRate().valuesPerSecond).toBeGreaterThan(x.family === 'legacy' ? 1 : 3);
    expect(engine.session!.stats.recoveryFailures).toBe(0);

    if (x.family === 'legacy') {
      // one PID per request on K-line / J1850, no CAN headers, no physical addressing, no mode 06
      expect(engine.tuner!.config.maxPids).toBe(1);
      expect(emu.log.filter((l) => /^AT\s*SH/i.test(l.cmd)).map((l) => l.cmd)).toEqual([]);
      expect(emu.log.some((l) => /^01([0-9A-F]{4,})$/i.test(l.cmd.replace(/\s/g, '')))).toBe(false);
      expect(scan.monitors?.perEcu.length ?? 0).toBe(0);
    }
  });
});

describe('diesel specifics', () => {
  it('shows DPF, EGR, NOx and AdBlue data; formula-less PIDs as raw bytes; an unlisted PID as raw', async () => {
    const p = CAR_PROFILES.find((q) => q.id === 'diesel-dpf')!;
    const { engine, readings } = await scanCar(p, 10);
    const latest = (key: string) => [...readings].reverse().find((r) => r.key === key);
    expect(latest('fuel_type')!.text).toMatch(/diesel/i);
    expect(latest('dpf_temp_in_b1')!.value).toBe(480);
    expect(latest('egt_b1_s1')!.value).toBe(410);
    expect(latest('def_tank_level')!.value).toBeCloseTo(70.2, 1);
    expect(latest('def_dosing_commanded')!.value).toBe(21);
    expect(latest('pid_7a_raw')!.text).toBe('07 00 C8 27 10 26 48');
    expect(latest('pid_83_raw')!.text).toBe('03 00 50 00 0A 00 00 00 00');
    const unlisted = latest('pid_95_raw')!;
    expect(unlisted.name).toBe("PID 95, raw bytes");
    expect(unlisted.text).toBe('12 34');
    expect(engine.coverage().rows.find((r) => r.pid === '95')!.decoded).toBeGreaterThan(0);
    // glow plug circuit fault is a known code
    expect(engine.lastScan!.dtcs.stored!.perEcu[0]!.codes[0]).toMatchObject({ code: 'P0671', known: true });
  });
});
