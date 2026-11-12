/**
 * Regression against the v1 browser capture of the Kushaq (private, never committed):
 * 50 minutes of Web Bluetooth driving, 3,895 raw exchanges, including the
 * recorded 143 s adapter hang on 0170 and the 6D/70 replies that lost a frame.
 * Skipped automatically when the file is absent. File: $OBDCRAFT_BROWSER_CAPTURE, else the
 * git-ignored fixtures/private/elm327-capture-20261015-023733-PRIVATE-raw.json.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { OBD, pidDef, decodePid } from '@obdcraft/definitions';
import { parseFrameLine } from '../src/can/frames.ts';
import { reassemble } from '../src/can/isotp.ts';
import { splitMode01 } from '../src/obd/services/service01.ts';
import { ReplayTransport } from '../src/transport/replay.ts';
import { exchangesFromAny } from '../src/transport/captureFormats.ts';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';
import type { Reading } from '../src/obd/context.ts';

const FILE = process.env.OBDCRAFT_BROWSER_CAPTURE
  ?? new URL('../../../fixtures/private/elm327-capture-20261015-023733-PRIVATE-raw.json', import.meta.url).pathname;
const have = existsSync(FILE);
const text = have ? readFileSync(FILE, 'utf8') : '';

/** Every complete single-ECU reply in the capture for one mode 01 PID, decoded by OBDCraft. */
function decodedAll(pidHex: string, ecu = '7E8') {
  const pid = parseInt(pidHex, 16);
  const def = pidDef(pid)!;
  const out: ReturnType<typeof decodePid>[] = [];
  for (const e of exchangesFromAny(text)) {
    if (e.cmd.replace(/\s/g, '') !== '01' + pidHex) continue;
    const lines = e.rx.split(/[\r\n>]+/).map((x) => x.trim()).filter((x) => /^[0-9A-F]{3} /.test(x));
    const msgs = reassemble(lines.map((l) => parseFrameLine(l, { family: 'can11', headers: true })!), 'can11');
    for (const m of msgs) {
      if (m.ecu !== ecu || !m.complete || m.bytes[0] !== 0x41 || m.bytes[1] !== pid) continue;
      const parts = splitMode01(m.bytes, [pid], undefined);
      if (parts?.[0]) out.push(decodePid(OBD, def, parts[0].data));
    }
  }
  return out;
}
const field = (d: ReturnType<typeof decodePid>, i = 0) => d.fields[i]!;

describe.skipIf(!have)('v1 browser capture regression (private data)', () => {
  it('reads the file: 3,895 raw exchanges, every one with a command', () => {
    const ex = exchangesFromAny(text);
    expect(ex.length).toBe(3895);
    // two recorded timeouts (0170 after 143 s, the final 010D) plus the exchange cut off at disconnect
    expect(ex.filter((e) => e.hang).map((e) => e.cmd)).toEqual(['0170', '010D', 'ATRV']);
  });

  it('41 56 7F decodes to -0.8 % (long-term secondary O2 trim, bank 1), 80 to 0 %', () => {
    const v = decodedAll('56').map((d) => field(d).value);
    expect(v.length).toBeGreaterThanOrEqual(12);
    expect(new Set(v.map((x) => x!.toFixed(4)))).toEqual(new Set(['-0.7813', '0.0000']));
  });

  it('distance since codes cleared rises 1876 -> 1890 km', () => {
    const v = decodedAll('31').map((d) => field(d).value!);
    expect(v[0]).toBe(1876);
    expect(v.at(-1)).toBe(1890);
    expect(Math.min(...v)).toBe(1876);
    expect(Math.max(...v)).toBe(1890);
  });

  it('timing advance reaches -16.5 deg (retard is normal on a turbo petrol at low load)', () => {
    const v = decodedAll('0E').map((d) => field(d).value!);
    expect(Math.min(...v)).toBe(-16.5);
    expect(Math.max(...v)).toBe(35);
  });

  it('intake air 45-52 C while ambient reads 26-27 C (heat-soaked intake, not a fault)', () => {
    const iat = decodedAll('0F').map((d) => field(d).value!);
    expect([Math.min(...iat), Math.max(...iat)]).toEqual([45, 52]);
    const amb = decodedAll('46').map((d) => field(d).value!);
    expect(new Set(amb)).toEqual(new Set([26, 27]));
  });

  it('commanded lambda FF FF decodes to the 2.0 ceiling (deceleration fuel cut), never above', () => {
    const v = decodedAll('44').map((d) => field(d).value!);
    expect(v.filter((x) => x > 1.99).length).toBe(14);
    expect(Math.max(...v)).toBeLessThan(2);
  });

  it('6D/70 replies that lost a consecutive frame are reported incomplete, never decoded from partial bytes', () => {
    for (const pidHex of ['6D', '70']) {
      for (const e of exchangesFromAny(text)) {
        if (e.cmd !== '01' + pidHex) continue;
        const lines = e.rx.split(/[\r\n>]+/).map((x) => x.trim()).filter((x) => /^7E8 1/.test(x) || /^7E8 2/.test(x));
        const msgs = reassemble(lines.map((l) => parseFrameLine(l, { family: 'can11', headers: true })!), 'can11');
        for (const m of msgs) {
          const hasCf = lines.some((l) => /^7E8 2/.test(l));
          expect(m.complete, `${pidHex}: ${lines.join(' | ')}`).toBe(hasCf);
        }
      }
    }
  });

  it('full scan + 3 minutes live from the recorded replies: survives the 143 s hang, decodes every recorded PID', async () => {
    const clock = new VirtualClock();
    const replay = new ReplayTransport(exchangesFromAny(text), { clock, id: 'browser-capture' });
    const engine = new OBDCraftEngine({ clock });
    const readings: Reading[] = [];
    engine.on((ev) => {
      if (ev.type === 'readings') readings.push(...ev.readings);
    });
    await runVirtual(clock, engine.connect(replay));
    const scan = await runVirtual(clock, engine.fullScan());
    expect(scan.dtcs.stored!.state).toBe('none');
    expect(scan.dtcs.pending!.state).toBe('none');
    expect(scan.dtcs.permanent!.state).toBe('unavailable');

    await runVirtual(clock, (async () => {
      await engine.startLive();
      await clock.sleep(180_000);
      await engine.stopLive();
    })());

    const cov = engine.coverage();
    const failed = cov.rows.filter((r) => r.decoded === 0).map((r) => `${r.ecu}:${r.pid}:${r.lastStatus}`);
    // 68 (intake air, sensor 2) is advertised but v1 never requested it, so the recording has no reply
    expect(replay.commands()).not.toContain('0168');
    expect(failed).toEqual(['7E8:68:no_data']);
    // the hang on 0170 (recorded timeout) cost one bounded timeout, not 143 s
    expect(engine.session!.stats.timeouts).toBeGreaterThanOrEqual(1);
    expect(engine.session!.stats.recoveryFailures).toBe(0);
    expect(engine.liveRate().valuesPerSecond).toBeGreaterThan(1);
    // 6D and 70 decode on a retry that got every frame
    for (const pid of ['6D', '70']) expect(cov.rows.find((r) => r.ecu === '7E8' && r.pid === pid)!.decoded).toBeGreaterThan(0);
    expect(readings.some((r) => r.pid === '44' && r.value !== null && r.value > 1.99)).toBe(true);
  });
});
