import { PolicyError, SafetyPolicy } from '@obdcraft/obd-core';
import { describe, expect, it } from 'vitest';
import { HealthReadOnlyViolation } from './readonly.ts';
import {
  assertVwRequest,
  decodeMeasure,
  defaultLogMeasures,
  didExists,
  expectedLength,
  parseDidSpec,
  parseSweepRange,
  selectMeasures,
  VW_CANDIDATES,
  vwColumns,
  vwValues,
} from './vwmeasure.ts';

const can = { family: 'can11' as const, target: '7E0' };

describe('vwread / vwlog read-only guard', () => {
  it('lets only 22 of one DID, 3E 00/80 and 10 01/03 through', () => {
    for (const pdu of [
      [0x22, 0xf4, 0x0c],
      [0x22, 0x20, 0x00],
      [0x3e, 0x00],
      [0x3e, 0x80],
      [0x10, 0x01],
      [0x10, 0x03],
    ])
      expect(() => assertVwRequest(pdu)).not.toThrow();
  });

  it('refuses 2E, 2F, 31, 14, 27 and every other service', () => {
    for (const pdu of [
      [0x2e, 0xf1, 0x98, 0x01],
      [0x2f, 0x05, 0x03, 0x03, 0x00],
      [0x31, 0x01, 0x02, 0x03],
      [0x14, 0xff, 0xff, 0xff],
      [0x27, 0x03],
      [0x27, 0x04, 1, 2, 3, 4],
      [0x11, 0x01],
      [0x10, 0x02],
      [0x28, 0x00, 0x01],
      [0x85, 0x02],
      [0x04],
      [0x19, 0x02, 0xff], // allowed for health, not here
      [0x01, 0x0c], // OBD-II, not here
      [0x22, 0xf4, 0x0c, 0xf4, 0x0d], // two DIDs at once
      [0x22, 0xf4],
      [],
    ])
      expect(() => assertVwRequest(pdu), pdu.join(' ')).toThrow(HealthReadOnlyViolation);
  });

  it('the adapter policy with both locks (health + scan read-only) refuses 2E/2F/31/14/27 and passes 22', () => {
    const policy = new SafetyPolicy(() => 0);
    const health = policy.enterHealthReadOnly();
    const scan = policy.enterReadOnly();
    for (const c of [
      '2EF198010203040506',
      '2F05030300',
      '31010203',
      '14FFFFFF',
      '2703',
      '2704AABBCCDD',
      '1101',
      '1002',
      '04',
      '0100',
    ])
      expect(() => policy.check(c, can), c).toThrow(PolicyError);
    for (const c of ['22F40C', '222000', '3E00', '3E80', '1003', '1001'])
      expect(() => policy.check(c, can), c).not.toThrow();
    expect(() => policy.issueCodingPermit('7E0', { writes: ['2E200001'] })).toThrow(PolicyError);
    scan();
    health();
  });
});

describe('DID lists and ranges', () => {
  it('parses bare and unit-prefixed DIDs, dropping duplicates', () => {
    expect(parseDidSpec('f40c, 02:1234 39C0,F40C', '01')).toEqual([
      { unit: '01', did: 0xf40c },
      { unit: '02', did: 0x1234 },
      { unit: '01', did: 0x39c0 },
    ]);
    expect(() => parseDidSpec('12345', '01')).toThrow(/not a DID/);
    expect(() => parseDidSpec('03:1234', '01')).toThrow(/not a DID/);
  });

  it('parses a sweep range and refuses reversed or oversized ones', () => {
    expect(parseSweepRange('2000-200F')).toHaveLength(16);
    expect(parseSweepRange('F40C')).toEqual([0xf40c]);
    expect(() => parseSweepRange('20FF-2000')).toThrow(/backwards/);
    expect(() => parseSweepRange('0000-FFFF')).toThrow(/at most/);
    expect(() => parseSweepRange('20-30')).toThrow(/range/);
  });

  it('selects the table for the units, then extra DIDs (raw only unless known)', () => {
    const sel = selectMeasures(
      ['01'],
      [
        { unit: '01', did: 0xabcd },
        { unit: '01', did: 0xf40c },
      ],
    );
    expect(sel.every((m) => m.unit === '01')).toBe(true);
    expect(sel.filter((m) => m.did === 0xf40c)).toHaveLength(1);
    expect(sel.at(-1)).toMatchObject({ did: 0xabcd, fields: [] });
    const only = selectMeasures(['01'], [{ unit: '01', did: 0xf40c }], true);
    expect(only).toHaveLength(1);
    expect(only[0]!.fields.length).toBeGreaterThan(0);
    expect(defaultLogMeasures(['01']).length).toBeGreaterThan(0);
  });
});

describe('decoding', () => {
  it('decodes the OBD mirror DIDs like their PIDs', () => {
    const rpm = VW_CANDIDATES.find((m) => m.did === 0xf40c)!;
    expect(decodeMeasure(rpm, [0x0c, 0x80]).values).toEqual({ rpm: 800 });
    const timing = VW_CANDIDATES.find((m) => m.did === 0xf40e)!;
    expect(decodeMeasure(timing, [0x94]).values).toEqual({ timing: 10 });
  });

  it('decodes signed and unsigned numbers big-endian with scale and offset', () => {
    const m = {
      fields: [
        { key: 'a', type: 's16' as const, scale: 0.5, unit: '°' },
        { key: 'b', type: 'u8' as const, scale: 1, unit: '', add: -40 },
        { key: 'c', type: 'u32' as const, scale: 1, unit: '' },
      ],
    };
    expect(expectedLength(m.fields)).toBe(7);
    const d = decodeMeasure(m, [0xff, 0xfe, 0x50, 0, 0, 1, 0]);
    expect(d.values).toEqual({ a: -1, b: 40, c: 256 });
    expect(d.lengthMismatch).toBe(false);
  });

  it('flags a short or long answer and leaves missing fields null', () => {
    const m = {
      fields: [
        { key: 'a', type: 'u16' as const, scale: 1, unit: '' },
        { key: 'b', type: 'u16' as const, scale: 1, unit: '' },
      ],
    };
    const d = decodeMeasure(m, [0, 5, 1]);
    expect(d.values).toEqual({ a: 5, b: null });
    expect(d.lengthMismatch).toBe(true);
    expect(d.text).toMatch(/formula expects 4/);
  });

  it('classifies NRC 31 as missing and other refusals as present', () => {
    expect(didExists({ kind: 'nrc', code: 0x31 })).toBe(false);
    expect(didExists({ kind: 'nrc', code: 0x33 })).toBe(true);
    expect(didExists({ kind: 'nrc', code: 0x22 })).toBe(true);
    expect(didExists({ kind: 'ok' })).toBe(true);
    expect(didExists({ kind: 'no-reply' })).toBe(false);
  });

  it('builds one CSV column per field, keyed by DID', () => {
    const rpm = VW_CANDIDATES.find((m) => m.did === 0xf40c)!;
    expect(vwColumns([rpm])).toEqual([{ pid: '01', key: 'F40C_rpm', unit: 'rpm' }]);
    expect(vwValues(rpm, decodeMeasure(rpm, [0x0c, 0x80]))).toEqual({ F40C_rpm: 800 });
  });

  it('every table entry is well formed: unique (unit, DID), a source, field keys unique', () => {
    const seen = new Set<string>();
    for (const m of VW_CANDIDATES) {
      const id = `${m.unit}:${m.did}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      expect(m.source.length).toBeGreaterThan(3);
      const keys = m.fields.map((x) => x.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
