import { describe, expect, it } from 'vitest';
import { parseFrameLine } from '../src/can/frames.ts';
import { reassemble, mergeVerified } from '../src/can/isotp.ts';
import { toHex } from '../src/util/hex.ts';

const frames = (lines: string[]) => lines.map((l) => parseFrameLine(l, { family: 'can11', headers: true })!);
const asm = (lines: string[]) => reassemble(frames(lines), 'can11');

describe('frame parsing', () => {
  it('reads spaced and compact (ATS0) lines identically', () => {
    const a = parseFrameLine('7E8 06 41 00 BE 3E A8 13 00', { family: 'can11', headers: true })!;
    const b = parseFrameLine('7E8064100BE3EA81300', { family: 'can11', headers: true })!;
    expect(a.ecu).toBe('7E8');
    expect(b).toMatchObject({ ecu: '7E8', bytes: a.bytes });
  });
  it('reads 29-bit and legacy headers', () => {
    expect(parseFrameLine('18 DA F1 10 03 41 0D 49 00 00 00 00', { family: 'can29', headers: true })!.ecu).toBe('18DAF110');
    const l = parseFrameLine('48 6B 10 41 0D 49 C5', { family: 'legacy', headers: true })!;
    expect(l).toMatchObject({ ecu: '10', bytes: [0x41, 0x0d, 0x49] });
  });
});

describe('ISO-TP reassembly', () => {
  it('assembles 6D from the capture (FF + 1 CF)', () => {
    const [m] = asm(['7E8 10 0D 41 6D 02 00 00 0D', '7E8 21 D5 28 00 00 00 00 28']);
    expect(m!.complete).toBe(true);
    expect(toHex(m!.bytes)).toBe('41 6D 02 00 00 0D D5 28 00 00 00 00 28');
  });

  it('a foreign single frame from the same ECU does not abort an open message (bug 3)', () => {
    const msgs = asm(['7E8 10 0D 41 6D 02 00 00 0D', '7E8 04 41 0C 0F 82 00 00 00', '7E8 21 D5 28 00 00 00 00 28']);
    const big = msgs.find((m) => m.multiFrame)!;
    expect(big.complete).toBe(true);
    expect(msgs.find((m) => !m.multiFrame)!.bytes).toEqual([0x41, 0x0c, 0x0f, 0x82]);
  });

  it('two ECUs interleaving their consecutive frames (090A from the capture)', () => {
    const msgs = asm([
      '7E9 10 17 49 0A 01 54 43 4D', '7E9 21 00 2D 54 72 61 6E 73', '7E8 10 17 49 0A 01 45 43 4D', '7E9 22 6D 69 73 43 74 72 6C',
      '7E8 21 00 2D 45 6E 67 69 6E', '7E8 22 65 43 6F 6E 74 72 6F', '7E9 23 00 00 00 AA AA AA AA', '7E8 23 6C 00 00 00 00 00 00',
    ]);
    expect(msgs.every((m) => m.complete)).toBe(true);
    const name = (ecu: string) => String.fromCharCode(...msgs.find((m) => m.ecu === ecu)!.bytes.slice(3)).replace(/\0/g, '');
    expect(name('7E8')).toBe('ECM-EngineControl');
    expect(name('7E9')).toBe('TCM-TransmisCtrl');
  });

  it('a lost consecutive frame leaves a hole at the right place (0902 missing CF 21)', () => {
    const [m] = asm(['7E8 10 14 49 02 01 41 42 43', '7E8 22 52 50 55 4C 53 45 31']);
    expect(m!.complete).toBe(false);
    expect(m!.missingCf).toEqual([1]);
    expect(m!.problem).toBe('missing_cf');
    expect(m!.bytes).toEqual([0x49, 0x02, 0x01, 0x41, 0x42, 0x43]);
  });

  it('a missing tail is "truncated" (0168 FF only)', () => {
    const [m] = asm(['7E8 10 09 41 68 03 6E 5C FF']);
    expect(m).toMatchObject({ complete: false, problem: 'truncated', missingCf: [1] });
  });

  it('merges two attempts of static data only when every overlap agrees', () => {
    const a = asm(['7E8 10 14 49 02 01 41 42 43', '7E8 22 52 50 55 4C 53 45 31'])[0]!;
    const b = asm(['7E8 10 14 49 02 01 41 42 43', '7E8 21 44 45 4D 4F 30 43 41'])[0]!;
    const m = mergeVerified([a, b])!;
    expect(m.complete).toBe(true);
    expect(m.bytes.length).toBe(0x14);
    const bad = asm(['7E8 10 14 49 02 01 41 42 43', '7E8 21 44 45 4D 4F 30 43 42', '7E8 22 52 50 55 4C 53 45 31'])[0]!;
    const c = asm(['7E8 10 14 49 02 01 41 42 43', '7E8 21 44 45 4D 4F 30 43 41'])[0]!;
    // bad is complete on its own; conflicting slot 1 between bad and c -> refuse
    expect(mergeVerified([bad, c])).toBeNull();
  });

  it('flags a single frame whose length byte exceeds the frame', () => {
    const [m] = asm(['7E8 09 41 0C 1C 56 00 00 00']);
    expect(m).toMatchObject({ complete: false, problem: 'bad_length' });
  });
});

describe('first-frame validity', () => {
  it.each([
    ['a declared length that fits a single frame', '7E8 10 05 49 02 01 57 30 4C'],
    ['the >4095-byte escape (length 0)', '7E8 10 00 49 02 01 57 30 4C'],
    ['a short CAN frame', '7E8 10 14 49 02 01'],
  ])('reports %s as bad_length, never as a complete message', (_why, line) => {
    const [m] = asm([line]);
    expect(m).toMatchObject({ complete: false, multiFrame: true, problem: 'bad_length' });
  });
  it('still accepts a valid first frame', () => {
    const [m] = asm(['7E8 10 08 62 0A 5E 3A 00 00', '7E8 21 00 00 55 55 55 55 55']);
    expect(m).toMatchObject({ complete: true, bytes: [0x62, 0x0a, 0x5e, 0x3a, 0, 0, 0, 0] });
  });
});
