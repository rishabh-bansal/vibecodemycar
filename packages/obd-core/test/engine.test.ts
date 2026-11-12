import { describe, expect, it } from 'vitest';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { Elm327Emulator, type EmulatorOptions } from '../src/emulator/elm327.ts';
import { kushaqLikeEcus, kushaqLikeSpecs, DEMO_VIN } from '../src/emulator/presets.ts';
import { StandardEcu } from '../src/emulator/vehicle.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';
import { InMemoryTunerMemory } from '../src/engine/tuner.ts';
import { seeded } from './helpers.ts';

/** Timing calibrated to the real OBDBLE clone (about 4-6 requests/s at default settings). */
const BLE_LIKE: Partial<EmulatorOptions> = { writeLatencyMs: 40, bytesPerMs: 1.3 };

function setup(opts: Partial<EmulatorOptions> = {}, ecus = kushaqLikeEcus()) {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator({ clock, ecus, random: seeded(11), ...BLE_LIKE, ...opts });
  const engine = new OBDCraftEngine({ clock });
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  return { clock, emu, engine, run };
}

describe('connect and full scan', () => {
  it('releases the adapter when connecting fails after it opened (ignition off: no ECU answers)', async () => {
    const { emu, engine, run } = setup({}, []);
    await expect(run(engine.connect(emu))).rejects.toMatchObject({ reason: 'car_silent' });
    expect(emu.isOpen).toBe(false);
    expect(engine.state).toBe('error');
  });

  it('finds both ECUs and their advertised PIDs', async () => {
    const { emu, engine, run } = setup();
    const r = await run(engine.connect(emu));
    expect(r.adapter.identity).toBe('ELM327 v2.1');
    expect(engine.link!.protocol).toMatchObject({ number: 6, family: 'can11' });
    const ids = r.ecus.map((e) => e.id).sort();
    expect(ids).toEqual(['7E8', '7E9']);
    const e8 = engine.ecus.find((e) => e.id === '7E8')!;
    const adv = [...e8.pids].filter((p) => p % 0x20 !== 0).map((p) => p.toString(16).toUpperCase().padStart(2, '0'));
    expect(adv.join(' ')).toBe('01 03 04 05 06 07 0B 0C 0D 0E 0F 11 13 15 1C 1F 21 2E 2F 30 31 33 34 3C 41 42 43 44 45 46 47 49 4A 4C 51 56 67 68 6D 70');
    expect(e8.role).toBe('engine');
  });

  it('full scan reads every service and decodes every advertised PID with a name and unit', async () => {
    const { emu, engine, run, clock } = setup();
    await run(engine.connect(emu));
    const t0 = clock.now();
    const scan = await run(engine.fullScan());
    const minutes = (clock.now() - t0) / 60000;
    expect(minutes).toBeLessThan(2);
    // bug 1: service 09 requested as part of the scan
    expect(scan.identity?.vin).toBe(DEMO_VIN);
    const names = scan.identity!.items.filter((i) => i.pid === 0x0a).map((i) => i.text);
    expect(names.sort()).toEqual(['ECM-EngineControl', 'TCM-TransmisCtrl']);
    expect(scan.identity!.items.find((i) => i.pid === 0x04 && i.ecu === '7E8')?.text).toBe('04C906025EH38BEA');
    // DTCs: complete empty lists are "none", permanent NO DATA is "unavailable", not "empty"
    expect(scan.dtcs.stored!.state).toBe('none');
    expect(scan.dtcs.stored!.perEcu.every((e) => e.codes.length === 0 && e.declaredCount === 0)).toBe(true);
    expect(scan.dtcs.permanent!.state).toBe('unavailable');
    expect(scan.freeze!.perEcu.every((p) => p.state === 'none')).toBe(true);
    // bug 2: service 06 on by default, decoded with scaling and names
    const tests = scan.monitors!.perEcu.flatMap((e) => e.tests);
    // 15 records from 10 monitors (O2 B1S1/S2, catalyst, VVT, purge, O2 heaters, misfire cyl 1-3)
    expect(tests.length).toBe(15);
    expect(tests.find((t) => t.mid === 'A2' && t.tid === '0B')).toMatchObject({ midName: 'Misfire, cylinder 1', value: 15, passed: true });
    // bug 5: coverage derived live, every advertised PID decoded
    const cov = engine.coverage();
    expect(cov.decoded).toBe(cov.advertised);
    expect(cov.rows.every((r) => !/pid_/i.test(r.name))).toBe(true);
    // bug 4: PID 56 one-byte reply decodes
    expect(cov.rows.find((r) => r.ecu === '7E8' && r.pid === '56')!.decoded).toBeGreaterThan(0);
    expect(engine.store.latest.get('7E8:rpm')!.value).toBe(1813.5);
    expect(engine.store.latest.get('7E8:speed')!.value).toBe(73);
    // service 08 only queried, never run
    const sent08 = emu.log.filter((l) => l.cmd.replace(/\s/g, '').startsWith('08'));
    expect(sent08.map((l) => l.cmd)).toEqual(['0800']);
    // nothing outside read-only services was sent
    expect(emu.log.some((l) => /^04/.test(l.cmd))).toBe(false);
  });

  it('multi-frame items survive a clone that loses 23% of consecutive frames (bug 3)', async () => {
    const { emu, engine, run } = setup({ cfLoss: 0.23 });
    await run(engine.connect(emu));
    const scan = await run(engine.fullScan());
    const cov = engine.coverage();
    const row = (pid: string) => cov.rows.find((r) => r.ecu === '7E8' && r.pid === pid)!;
    for (const pid of ['6D', '70', '68']) expect(row(pid).decoded, pid).toBeGreaterThan(0);
    expect(scan.identity?.vin).toBe(DEMO_VIN);
    // the retries are visible in the request log
    const vinRec = engine.store.records.find((r) => r.service === 9 && r.params[0] === 2)!;
    expect(vinRec.attempts.length).toBeGreaterThanOrEqual(1);
    for (const a of vinRec.attempts) expect(a.timeoutMs).toBeGreaterThan(0);
  });

  it('replies to another tester on the bus are set aside, not decoded as ours', async () => {
    const { emu, engine, run } = setup({ foreignRate: 0.3 });
    await run(engine.connect(emu));
    await run(engine.fullScan());
    const cov = engine.coverage();
    expect(cov.decoded).toBe(cov.advertised);
    const withForeign = engine.store.records.filter((r) => r.foreign.length > 0);
    expect(withForeign.length).toBeGreaterThan(0);
    // a foreign 41 0C reply during a 0105 request never becomes our coolant value
    expect(engine.store.latest.get('7E8:coolant_temp')!.value).toBe(94);
  });

  it('a hanging adapter costs one timeout, not minutes (bug 6)', async () => {
    const { emu, engine, run, clock } = setup();
    await run(engine.connect(emu));
    emu.set({ hangRate: 0.05 });
    const t0 = clock.now();
    await run(engine.fullScan());
    const dur = clock.now() - t0;
    const timeouts = engine.store.records.flatMap((r) => r.attempts).filter((a) => a.outcome === 'timeout');
    expect(timeouts.length).toBeGreaterThan(0);
    for (const a of timeouts) {
      expect(a.durationMs).toBeLessThan(a.timeoutMs + 50);
      expect(a.recovery?.ok).toBe(true);
    }
    expect(dur).toBeLessThan(120_000);
  });
});

describe('guarded service 04', () => {
  it('refuses without the typed confirmation, and when the engine runs', async () => {
    const { emu, engine, run } = setup();
    await run(engine.connect(emu));
    const a = await run(engine.clearCodes('yes', true));
    expect(a.sent).toBe(false);
    const b = await run(engine.clearCodes('CLEAR', true));
    expect(b.sent).toBe(false);
    expect(b.error).toMatch(/engine is running/);
    expect(emu.log.some((l) => l.cmd === '04')).toBe(false);
  });

  it('sends 04 once when engine off and stationary', async () => {
    const specs = kushaqLikeSpecs();
    for (const s of specs) {
      s.pids[0x0c] = () => [0, 0];
      s.pids[0x0d] = () => [0];
    }
    const { emu, engine, run } = setup({}, specs.map((s) => new StandardEcu(s)));
    await run(engine.connect(emu));
    const r = await run(engine.clearCodes('CLEAR', true));
    expect(r.sent).toBe(true);
    expect(r.acknowledgedBy).toContain('7E8');
    expect(emu.log.filter((l) => l.cmd === '04').length).toBe(1);
  });

  it('the policy blocks 04 sent any other way, and every write or state-changing service', async () => {
    const { emu, engine, run } = setup();
    await run(engine.connect(emu));
    for (const cmd of [[0x04], [0x08, 0x01], [0x27, 0x01], [0x2e, 0x01], [0x31, 0x01], [0x14, 0xff, 0xff, 0xff], [0x11, 0x01], [0x10, 0x02]]) {
      const rec = await run(engine.runner!.execute({ service: cmd[0]!, params: cmd.slice(1), purpose: 'manual' }));
      expect(rec.status).toBe('refused');
    }
    expect(emu.log.some((l) => /^(04|0801|27|2E|31|14|11|1002)/.test(l.cmd))).toBe(false);
  });

  it('manufacturer read services go out (the emulator answers them with a negative reply)', async () => {
    const { emu, engine, run } = setup();
    await run(engine.connect(emu));
    for (const cmd of [[0x22, 0xf1, 0x90], [0x19, 0x02, 0xaf], [0x10, 0x03]]) {
      const rec = await run(engine.runner!.execute({ service: cmd[0]!, params: cmd.slice(1), purpose: 'manual' }));
      expect(rec.status).not.toBe('refused');
    }
    expect(emu.log.some((l) => l.cmd === '22F190')).toBe(true);
  });
});

describe('adaptive throughput tuner (no fixed cap)', () => {
  it('finds faster settings on a capable adapter and beats the baseline several times over', async () => {
    const { emu, engine, run, clock } = setup();
    await run(engine.connect(emu));
    await run(engine.startLive());
    await run(clock.sleep(90_000));
    await run(engine.stopLive());
    const s = engine.tuner!.summary();
    const base = engine.tuner!.events.find((e) => e.kind === 'measure')!.rate!;
    expect(s.accepted).toContain('count');
    expect(s.config.maxPids).toBeGreaterThan(1);
    expect(s.bestRate).toBeGreaterThan(base * 2.5);
    expect(s.bestQuality).toBeGreaterThan(0.95);
  });

  it('on a clone without multi-PID support it stays single-PID but still uses what works', async () => {
    const { emu, engine, run, clock } = setup({ multiPid: 'reject' });
    await run(engine.connect(emu));
    await run(engine.startLive());
    await run(clock.sleep(90_000));
    await run(engine.stopLive());
    const s = engine.tuner!.summary();
    expect(s.config.maxPids).toBe(1);
    expect(s.rejected).toContain('multi2');
    expect(s.accepted).toContain('count');
  });

  it('remembers settings per adapter; a different adapter is tuned from scratch', async () => {
    const memory = new InMemoryTunerMemory();
    const clock = new VirtualClock();
    const emuA = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(3), ...BLE_LIKE, id: 'adapter-A' });
    const engA = new OBDCraftEngine({ clock, tunerMemory: memory });
    await runVirtual(clock, engA.connect(emuA));
    await runVirtual(clock, engA.startLive());
    await runVirtual(clock, clock.sleep(90_000));
    await runVirtual(clock, engA.stopLive());
    expect(memory.load(engA.adapterKey())).not.toBeNull();
    const emuB = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(4), ...BLE_LIKE, id: 'adapter-B', responseCount: false });
    const engB = new OBDCraftEngine({ clock, tunerMemory: memory });
    await runVirtual(clock, engB.connect(emuB));
    expect(memory.load(engB.adapterKey())).toBeNull();
    await runVirtual(clock, engB.startLive());
    await runVirtual(clock, clock.sleep(60_000));
    await runVirtual(clock, engB.stopLive());
    // this adapter rejects the count digit: the tuner notices and keeps it off
    expect(engB.tuner!.summary().config.responseCount).toBe(false);
  });

  it('backs off when quality drops in steady state', async () => {
    const { emu, engine, run, clock } = setup();
    await run(engine.connect(emu));
    await run(engine.startLive());
    await run(clock.sleep(90_000));
    const before = engine.tuner!.summary();
    expect(before.config.maxPids).toBeGreaterThan(1);
    // the clone starts losing most multi-frame replies
    emu.set({ cfLoss: 0.9 });
    await run(clock.sleep(60_000));
    await run(engine.stopLive());
    const after = engine.tuner!.summary();
    expect(engine.tuner!.events.some((e) => e.kind === 'backoff')).toBe(true);
    expect(after.config.maxReplyBytes).toBe(7);
  });
});
