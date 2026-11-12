import { describe, expect, it } from 'vitest';
import { readMode01, splitMode01 } from '../src/obd/services/service01.ts';
import { makeContext, newEcu } from '../src/obd/context.ts';
import type { ElmLink } from '../src/elm/link.ts';
import { RequestRunner } from '../src/obd/request.ts';
import { LiveScheduler } from '../src/engine/scheduler.ts';
import { SafetyPolicy } from '../src/safety/policy.ts';
import { buildCommand } from '../src/obd/request.ts';

const b = (s: string) => s.split(' ').map((x) => parseInt(x, 16));

describe('multi-PID replies', () => {
  it('splits a combined reply by definition lengths', () => {
    const parts = splitMode01(b('41 0C 1C 56 0D 49 05 86'), [0x0c, 0x0d, 0x05], undefined)!;
    expect(parts.map((p) => [p.pid, p.data.length])).toEqual([[0x0c, 2], [0x0d, 1], [0x05, 1]]);
  });
  it('accepts a subset and any order, rejects PIDs we did not ask for', () => {
    expect(splitMode01(b('41 0D 49 0C 1C 56'), [0x0c, 0x0d, 0x11], undefined)!.length).toBe(2);
    expect(splitMode01(b('41 0C 1C 56 0F 4C'), [0x0c, 0x0d], undefined)).toBeNull();
  });
  it('uses the learned length of a variable PID (56 is one byte on this ECU)', () => {
    const ecu = newEcu('7E8', '7E0');
    ecu.learnedLengths.set(0x56, 1);
    const parts = splitMode01(b('41 56 7F 0D 49'), [0x56, 0x0d], ecu)!;
    expect(parts[0]).toEqual({ pid: 0x56, data: [0x7f] });
  });
  it('a truncated combined reply is rejected, not mis-decoded', () => {
    expect(splitMode01(b('41 0C 1C 56 0D'), [0x0c, 0x0d], undefined)).toBeNull();
  });
  it('builds commands with the response-count digit', () => {
    expect(buildCommand(1, [0x0c, 0x0d], 2)).toBe('010C0D2');
    expect(buildCommand(9, [0x02])).toBe('0902');
  });
});

describe('live scheduler', () => {
  it('gives fast items most requests without starving slow ones, and groups within limits', () => {
    let t = 0;
    const ecus = new Map([['7E8', Object.assign(newEcu('7E8', '7E0'), { role: 'engine' as const })]]);
    for (const p of [0x0c, 0x0d, 0x04, 0x05, 0x2f, 0x31]) ecus.get('7E8')!.pids.add(p);
    const s = new LiveScheduler(ecus, () => t);
    s.setPids([0x0c, 0x0d, 0x04, 0x05, 0x2f, 0x31]);
    const counts = new Map<number, number>();
    for (let i = 0; i < 2000; i++) {
      t += 50;
      const batch = s.next({ maxPids: 3, maxReplyBytes: 7 })!;
      expect(batch.pids.length).toBeLessThanOrEqual(3);
      for (const p of batch.pids) {
        counts.set(p, (counts.get(p) ?? 0) + 1);
        s.report('7E8', p, true);
      }
    }
    expect(counts.get(0x0c)!).toBeGreaterThan(counts.get(0x05)! * 3);
    expect(counts.get(0x31)!).toBeGreaterThan(0);
  });
});

describe('safety policy', () => {
  const p = new SafetyPolicy();
  const can = { family: 'can11' as const };
  it('allows read-only generic OBD and the tuning AT commands', () => {
    for (const c of ['010C', '010C0D2', '0902', '03', '07', '0A', '0600', '0800', '020200', 'ATSH7E0', 'ATCRA7E8', 'ATS0', 'ATAT2', 'ATST19']) {
      expect(() => p.check(c, can), c).not.toThrow();
    }
  });
  it('refuses writes, state changes, 08 tests, 05 on CAN and adapter EEPROM commands', () => {
    for (const c of ['04', '0801', '2701', '11', '14FFFFFF', '2E010203', '3101FF00', '34', '3600', '37', '2F0101', '3B01', '3D', '83030002001400', '0501', 'ATPP0CSV01', 'AT@3TEST', 'ATBRD45', 'ATMA']) {
      expect(() => p.check(c, can), c).toThrow();
    }
  });
  it('allows the manufacturer read services', () => {
    for (const c of ['190208', '1902AF', '1A87', '21F0', '2101', '22F190', '22F4000', '23140000FF', 'A8000008', '1800FF00', '17FF00', '13FF00', '1081', '1003', '3E00', '3E', '81', '82']) {
      expect(() => p.check(c, can), c).not.toThrow();
    }
  });
  it('never allows a programming or adjustment session; other sessions only when the dataset declares them', () => {
    for (const c of ['1002', '1085', '1086', '1087', '1082', '10']) expect(() => p.check(c, can), c).toThrow();
    const q = new SafetyPolicy();
    expect(() => q.check('1092', can)).toThrow();
    q.declareSessions(['92', '02', '85']);
    expect(() => q.check('1092', can)).not.toThrow();
    expect(() => q.check('1002', can)).toThrow(); // declaring a banned session changes nothing
  });
  it('says why a write is refused', () => {
    expect(() => p.check('2E010203', can)).toThrow(/writes data to the ECU/);
    expect(() => p.check('7F', can)).toThrow(/not on the read list/);
  });
  it('a clear token works once', () => {
    const t = p.issueClearToken();
    expect(() => p.check('04', can, t)).not.toThrow();
    expect(() => p.check('04', can, t)).toThrow();
  });
});

describe('readMode01 — expected ECUs', () => {
  it('keeps the computed list when a caller passes expectEcus: undefined (clearPrecheck without an engine ECU)', async () => {
    const seen: unknown[] = [];
    const runner = {
      async execute(req: { expectEcus?: string[] }) {
        seen.push(req.expectEcus);
        return { ecus: {}, endedAt: 0, expectEcus: req.expectEcus ?? [] };
      },
    } as unknown as RequestRunner;
    const ctx = makeContext({} as ElmLink, runner);
    const ecu = newEcu('7E8', '7E0');
    ecu.pids.add(0x0c);
    ctx.ecus.set(ecu.id, ecu);
    await readMode01(ctx, [0x0c], { expectEcus: undefined });
    expect(seen).toEqual([['7E8']]);
  });
});

describe('RequestRunner — late answers go to the request they answer', () => {
  it('bytes arriving before a retry belong to that same request, not the previous one', async () => {
    const replies: { lines: string[]; staleBefore: string }[] = [
      { lines: [], staleBefore: '' }, // A: 7E8 silent
      { lines: ['7E9 04 41 0C 00 00'], staleBefore: '' }, // B attempt 1: only 7E9
      { lines: [], staleBefore: '7E8 04 41 0C 1A F8\r>' }, // B attempt 2: 7E8's late answer to attempt 1
    ];
    const link = {
      clock: { now: () => 0, sleep: async () => {} },
      protocol: { family: 'can11', number: 6 },
      config: { spaces: true, headers: true, adaptiveTiming: 1, st: null, target: 'functional' },
      policy: { check() {} },
      session: {
        async send(cmd: string) {
          const r = replies.shift() ?? { lines: [], staleBefore: '' };
          return { cmd, txHex: '', rxRaw: r.lines.join('\r'), lines: r.lines, statuses: r.lines.length ? [] : ['NO DATA'], status: 'ok', startedAt: 0, durationMs: 1, timeoutMs: 100, staleBefore: r.staleBefore };
        },
      },
    } as unknown as ElmLink;
    const runner = new RequestRunner(link, { defaultAttempts: 1 });
    const a = await runner.execute({ service: 1, params: [0x0c], purpose: 'live', expectEcus: ['7E8'] });
    const b = await runner.execute({ service: 1, params: [0x0c], purpose: 'live', expectEcus: ['7E8', '7E9'], maxAttempts: 2 });
    expect(a.ecus['7E8']?.status).not.toBe('ok');
    expect(b.ecus['7E8']).toMatchObject({ status: 'ok', late: true });
  });
});
