import { describe, expect, it } from 'vitest';
import { verifyVehicleLink } from '../src/adapters/identify.ts';
import { parseFrameLine } from '../src/can/frames.ts';
import { reassemble } from '../src/can/isotp.ts';
import { SafetyPolicy } from '../src/safety/policy.ts';
import { exchangesFromAny } from '../src/transport/captureFormats.ts';
import { runVirtual, VirtualClock } from '../src/util/clock.ts';
import { scriptedRig } from './scripted.ts';

const asm = (lines: string[]) =>
  reassemble(lines.map((l) => parseFrameLine(l, { family: 'can11', headers: true })!), 'can11');

describe('obd-core robustness', () => {
  it('ignores a duplicated consecutive frame instead of shifting later frames (long messages)', () => {
    // 6 bytes in the first frame + 20 consecutive frames of 7 = 146 bytes; sequence numbers wrap after 15.
    const payload = Array.from({ length: 146 }, (_, i) => i & 0xff);
    const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    const lines = [`7E8 10 92 ${hex(payload.slice(0, 6))}`];
    for (let i = 0; i < 20; i++) {
      lines.push(`7E8 ${(0x20 | ((i + 1) & 15)).toString(16).toUpperCase()} ${hex(payload.slice(6 + i * 7, 13 + i * 7))}`);
      if (i === 0) lines.push(lines[lines.length - 1] as string); // the first consecutive frame arrives twice
    }
    const [m] = asm(lines);
    expect(m).toMatchObject({ complete: true });
    expect(m?.bytes).toEqual(payload);
  });

  it('never completes a message from two different copies of one consecutive frame', () => {
    // FF, CF 21 (data A), CF 21 again with DIFFERENT data, CF 22: which 21 belongs to the message is unknown.
    const [m, ...rest] = asm([
      '778 10 14 62 06 00 01 02 03',
      '778 21 04 05 06 07 08 09 0A',
      '778 21 FF FF FF FF FF FF FF',
      '778 22 0B 0C 0D 0E 0F 10 11',
    ]);
    expect(m).toMatchObject({ complete: false, problem: 'conflicting_cf' });
    expect([m, ...rest].some((x) => x?.complete)).toBe(false);
    // The same capture with a byte-identical repeat still completes (the duplicate control above, short form).
    const [ok] = asm([
      '778 10 14 62 06 00 01 02 03',
      '778 21 04 05 06 07 08 09 0A',
      '778 21 04 05 06 07 08 09 0A',
      '778 22 0B 0C 0D 0E 0F 10 11',
    ]);
    expect(ok).toMatchObject({ complete: true });
    expect(ok?.bytes).toEqual([0x62, 6, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("a coding permit's security budget is the writer's own worst case, not a fixed 8/6", () => {
    const policy = new SafetyPolicy(() => 0);
    const state = { family: 'can11' as const, target: '70E' };
    const token = policy.issueCodingPermit('70E', { securityAccess: true, securityBudget: { seed: 30, key: 10 } });
    for (let i = 0; i < 30; i++) policy.check('2703', state, undefined, token);
    for (let i = 0; i < 10; i++) policy.check('270412345678', state, undefined, token);
    expect(() => policy.check('2703', state, undefined, token)).toThrow();
    const fixed = policy.issueCodingPermit('70E', { securityAccess: true });
    for (let i = 0; i < 8; i++) policy.check('2703', state, undefined, fixed);
    expect(() => policy.check('2703', state, undefined, fixed)).toThrow();
  });

  it('stamps refusals on the policy clock and keeps at most 200', () => {
    const policy = new SafetyPolicy(() => 42);
    for (let i = 0; i < 250; i++) expect(() => policy.check('2E0A5E00', { family: 'can11' })).toThrow();
    expect(policy.refused).toHaveLength(200);
    expect(policy.refused[0]?.at).toBe(42);
  });

  it('says a non-capture file is not a capture, rather than throwing a JSON error', () => {
    expect(() => exchangesFromAny('hello\nworld')).toThrow('not a recognised capture file');
  });

  it('treats a rejection with undefined as a failure', async () => {
    await expect(runVirtual(new VirtualClock(), Promise.reject(undefined))).rejects.toBeUndefined();
  });

  it('finds 41 00 only as two reply bytes, not across byte boundaries', async () => {
    const reply = (line: string) => scriptedRig((cmd) => (cmd === '0100' ? line : ''));
    const real = reply('7E8 06 41 00 BE 3E A8 13');
    expect((await real.run(verifyVehicleLink(real.link))).alive).toBe(true);
    const compact = reply('7E8064100BE3EA813');
    expect((await compact.run(verifyVehicleLink(compact.link))).alive).toBe(true);
    const straddle = reply('7E8 06 54 10 0A 00 00 00'); // "...5410 0A..." contains "4100" across bytes
    expect((await straddle.run(verifyVehicleLink(straddle.link))).alive).toBe(false);
  });
});
