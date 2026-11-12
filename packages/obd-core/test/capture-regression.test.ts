/**
 * Regression against the real Kushaq captures (private, never committed).
 * Skipped automatically when the capture folder is absent. Folder: $OBDCRAFT_CAPTURES, else the
 * git-ignored fixtures/private/hardware-captures (one sub-folder per segment, each with raw.jsonl).
 *
 * 1. Golden values: every sample the Python benchmark decoded from a real reply
 *    is re-decoded by OBDCraft from the same raw lines and must agree.
 * 2. Full replay: the OBDCraft engine connects and runs a full scan against the
 *    recorded adapter replies (truncated ones included, in recorded order).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBD, pidDef, decodePid } from '@obdcraft/definitions';
import { parseFrameLine } from '../src/can/frames.ts';
import { reassemble } from '../src/can/isotp.ts';
import { classify } from '../src/obd/matching.ts';
import { splitMode01 } from '../src/obd/services/service01.ts';
import { ReplayTransport, type RecordedExchange } from '../src/transport/replay.ts';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';

const ROOT =
  process.env.OBDCRAFT_CAPTURES ?? new URL('../../../fixtures/private/hardware-captures', import.meta.url).pathname;
const segments = existsSync(ROOT) ? readdirSync(ROOT).filter((d) => /obdble/.test(d) && existsSync(join(ROOT, d, 'raw.jsonl'))).sort() : [];
const have = segments.length > 0;

function loadExchanges(): RecordedExchange[] {
  const out: RecordedExchange[] = [];
  for (const s of segments) {
    for (const line of readFileSync(join(ROOT, s, 'raw.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const ex = JSON.parse(line).exchange;
      if (!ex) continue;
      const dur = ex.t_end && ex.t_start ? (ex.t_end - ex.t_start) * 1000 : undefined;
      out.push({ cmd: ex.cmd, rx: ex.rx_text ?? '', ...(dur !== undefined ? { durationMs: dur } : {}) });
    }
  }
  return out;
}

describe.skipIf(!have)('real capture regression (private data)', () => {
  it('re-decodes every Python-decoded sample identically', () => {
    let compared = 0;
    let fields = 0;
    let notUsed = 0;
    const mismatches: string[] = [];
    for (const s of segments) {
      const f = join(ROOT, s, 'samples.jsonl');
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.service !== 1 || r.status !== 'decoded' || !r.raw_lines || !r.decoded) continue;
        const pid = parseInt(r.pid, 16);
        const def = pidDef(pid);
        if (!def) continue;
        const frames = r.raw_lines.map((l: string) => parseFrameLine(l, { family: 'can11', headers: true })).filter(Boolean);
        const msgs = reassemble(frames, 'can11').filter((m) => m.ecu === r.ecu && m.complete && classify({ service: 1, params: [pid] }, m).kind === 'ours');
        expect(msgs.length, `${s} ${r.pid} ${r.ecu}`).toBeGreaterThan(0);
        const parts = splitMode01(msgs[0]!.bytes, [pid], undefined)!;
        const d = decodePid(OBD, def, parts[0]!.data);
        expect(d.status, `${r.pid} ${msgs[0]!.bytes}`).toBe('decoded');
        compared++;
        for (const [id, want] of Object.entries(r.decoded as Record<string, number>)) {
          if (typeof want !== 'number') continue;
          // v1/Python packed fields that OBDCraft splits differently (PID 01 monitors_supported, PID 41 monitors)
          const f = d.fields.find((x) => x.id === id);
          if (!f) continue;
          fields++;
          // intentional difference: B = 0xFF on PIDs 14-1B means "sensor not used for trim";
          // Python reported the raw +99.2 %, OBDCraft reports "not used"
          if (f.state === 'not_available' && pid >= 0x14 && pid <= 0x1b && id === 'short_term_trim') {
            notUsed++;
            continue;
          }
          if (f.value === null || Math.abs(f.value - want) > 1e-6) mismatches.push(`${s} ${r.ecu} ${r.pid}.${id}: python ${want} obdcraft ${f.value}`);
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(5000);
    expect(fields).toBeGreaterThan(5000);
    expect(notUsed).toBeGreaterThan(0);
    console.info(`golden regression: ${compared} replies, ${fields} fields compared, 0 mismatches, ${notUsed} O2 trims reported as "not used"`);
  });

  it('every reply in the capture is either ours, foreign or an ELM status; nothing is misattributed', () => {
    const ex = loadExchanges();
    let foreign = 0;
    let wrongPid = 0;
    for (const e of ex) {
      const cmd = e.cmd.replace(/\s/g, '');
      if (!/^01[0-9A-F]{2}$/.test(cmd)) continue;
      const pid = parseInt(cmd.slice(2), 16);
      const lines = e.rx.split(/[\r\n>]+/).map((x) => x.trim()).filter((x) => /^[0-9A-F]{3} /.test(x));
      const msgs = reassemble(lines.map((l) => parseFrameLine(l, { family: 'can11', headers: true })!), 'can11');
      for (const m of msgs) {
        const c = classify({ service: 1, params: [pid] }, m);
        if (c.kind === 'foreign') foreign++;
        if (c.kind === 'ours' && m.bytes[1] !== pid) wrongPid++;
      }
    }
    expect(wrongPid).toBe(0);
    // about 15% of messages answer someone else's requests (another device on the bus)
    expect(foreign).toBeGreaterThan(100);
  });

  it('full scan replayed from the real adapter replies: every advertised PID decoded, VIN read, mode 06 decoded', async () => {
    const clock = new VirtualClock();
    const replay = new ReplayTransport(loadExchanges(), { clock, id: 'capture' });
    const engine = new OBDCraftEngine({ clock });
    await runVirtual(clock, engine.connect(replay));
    const scan = await runVirtual(clock, engine.fullScan());
    const cov = engine.coverage();
    const failed = cov.rows.filter((r) => r.decoded === 0).map((r) => `${r.ecu}:${r.pid}:${r.lastStatus}`);
    // 0168 was recorded once, truncated (one CF lost); it cannot decode from that recording
    expect(failed.filter((f) => !f.startsWith('7E8:68:'))).toEqual([]);
    expect(cov.rows.find((r) => r.ecu === '7E8' && r.pid === '56')!.decoded).toBeGreaterThan(0);
    expect(scan.identity?.vin).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
    expect(scan.monitors!.perEcu.flatMap((e) => e.tests).length).toBeGreaterThanOrEqual(13);
    expect(scan.dtcs.stored!.state).toBe('none');
    expect(scan.dtcs.permanent!.state).toBe('unavailable');
    expect(scan.freeze!.perEcu.every((p) => p.state === 'none')).toBe(true);
  });
});
