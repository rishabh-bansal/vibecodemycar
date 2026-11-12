import { describe, expect, it } from 'vitest';
import { OBD, MODE06, DTC, pidDef, pidDefOrRaw, compile, decodeField, decodePid, tidName, classifyDtc, isDtcCode, decodeMode06Records, scalingFor, substitute, beginnerInfo, isSimpleReading, GLOSSARY, monitorInfo } from '../src/index.ts';

const bytes = (s: string) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));
const dec = (pid: number, data: string) => decodePid(OBD, pidDef(pid)!, bytes(data));
const val = (pid: number, data: string, key: string) => dec(pid, data).fields.find((f) => f.key === key)!;

describe('obd.json integrity', () => {
  it('every known reading has beginner context without inventing a healthy range from encoding limits', () => {
    for (const pid of OBD.pids) for (const field of pid.fields) {
      const info = beginnerInfo(field.key)!;
      expect(info, field.key).not.toBeNull();
      expect(info.meaning.length, field.key).toBeGreaterThan(15);
      expect(info.context.length, field.key).toBeGreaterThan(20);
      for (const term of info.terms) expect(GLOSSARY.some(entry => entry.id === term), term).toBe(true);
      if (field.kind === 'raw') expect(isSimpleReading(field.key), field.key).toBe(false);
    }
    expect(isSimpleReading('pid_c1_raw')).toBe(false);
    expect(isSimpleReading('support_00')).toBe(false);
    expect(isSimpleReading('rpm')).toBe(true);
    expect(beginnerInfo('map')!.range).toBeNull();
    expect(beginnerInfo('coolant_temp')!.range!.source).toMatch(/not an OEM/);
    expect(monitorInfo('FF', 'FF').meaning).toMatch(/manufacturer/i);
  });
  it('every PID and field has a name, a key and a formula that compiles', () => {
    const keys = new Set<string>();
    for (const p of OBD.pids) {
      expect(p.name.length).toBeGreaterThan(3);
      expect(p.short.length).toBeGreaterThan(0);
      const rawOnly = p.fields.every((f) => f.kind === 'raw');
      // only raw-bytes PIDs may leave the length open
      if (!rawOnly) expect(p.lengths.length, p.pid).toBeGreaterThan(0);
      for (const f of p.fields) {
        expect(f.name, `${p.pid}.${f.id}`).toBeTruthy();
        expect(f.key).toMatch(/^[a-z0-9_]+$/);
        expect(keys.has(f.key), `duplicate ${f.key}`).toBe(false);
        keys.add(f.key);
        if (f.kind === 'raw') {
          expect(f.formula).toBe('');
          expect(f.unit).toBeNull();
          continue;
        }
        const c = compile(f.formula);
        // a formula never reads past the longest valid reply
        expect(c.maxByte, `${p.pid}.${f.id}`).toBeLessThan(Math.max(...p.lengths));
        if (f.requires_length !== null) expect(p.lengths).toContain(f.requires_length);
      }
    }
  });

  it('names exist for the PIDs v1 showed as pid_xx (bug 7)', () => {
    for (const pid of [0x13, 0x15, 0x2e, 0x30, 0x34, 0x41, 0x45, 0x47, 0x4a, 0x4c]) {
      const p = pidDef(pid)!;
      expect(p.name).not.toMatch(/pid_/i);
      for (const f of p.fields) expect(f.name).not.toMatch(/pid_/i);
    }
  });

  it('covers every PID this Kushaq advertises', () => {
    const advertised = '01 03 04 05 06 07 0B 0C 0D 0E 0F 11 13 15 1C 1F 21 2E 2F 30 31 33 34 3C 41 42 43 44 45 46 47 49 4A 4C 51 56 67 68 6D 70 20 40 60 00';
    for (const h of advertised.split(' ')) expect(pidDef(parseInt(h, 16)), h).toBeDefined();
  });
});

describe('formula language', () => {
  it('handles unsigned shifts above 2^31', () => {
    expect(compile('(A<<24)|(B<<16)|(C<<8)|D').run([0xbe, 0x3e, 0xa8, 0x13])).toBe(0xbe3ea813);
  });
  it('supports signed helpers and ternaries', () => {
    expect(compile('s16(256*A+B)/4').run([0xff, 0xfc])).toBe(-1);
    expect(compile('A>127 ? A-256 : A').run([0xff])).toBe(-1);
  });
  it('rejects unknown names instead of evaluating them', () => {
    expect(() => compile('process.exit(1)')).toThrow();
    expect(() => compile('foo(A)')).toThrow();
  });
  it('prints a substituted breakdown', () => {
    expect(substitute(compile('(256*A+B)/4').ast, [0x1c, 0x56])).toBe('(256*28 + 86)/4');
  });
});

describe('decoders', () => {
  it('RPM 1813.5 from 41 0C 1C 56 and speed 73 from 41 0D 49 (brief fixtures)', () => {
    const rpm = val(0x0c, '1C 56', 'rpm');
    expect(rpm.value).toBe(1813.5);
    expect(rpm.breakdown.substituted).toBe('(256*28 + 86)/4');
    expect(rpm.breakdown.bytes.map((b) => b.hex)).toEqual(['1C', '56']);
    expect(val(0x0d, '49', 'speed').value).toBe(73);
  });

  it('PID 56 accepts the one-byte reply 41 56 7F (bug 4) and the two-byte variant', () => {
    const one = dec(0x56, '7F');
    expect(one.status).toBe('decoded');
    expect(one.fields[0]!.value).toBeCloseTo(-0.78125, 5);
    expect(one.fields[1]!.state).toBe('absent');
    const two = dec(0x56, '80 80');
    expect(two.fields[1]!.value).toBe(0);
    expect(dec(0x56, '80 80 80').status).toBe('length_mismatch');
  });

  it('PID 06 optional bank 3 byte', () => {
    expect(dec(0x06, '80').fields[0]!.value).toBe(0);
    expect(dec(0x06, '80 90').fields[1]!.value).toBe(12.5);
  });

  it('PID 01 readiness from the capture (41 01 00 07 E1 00)', () => {
    const d = dec(0x01, '00 07 E1 00');
    const f = (k: string) => d.fields.find((x) => x.key === k)!;
    expect(f('monitor_status_mil').value).toBe(0);
    expect(f('monitor_status_dtc_count').value).toBe(0);
    expect(f('monitor_status_noncontinuous_available').setBits).toEqual(['catalyst', 'oxygen sensor', 'oxygen sensor heater', 'EGR/VVT system']);
    expect(f('monitor_status_noncontinuous_incomplete').setBits).toEqual([]);
  });

  it('PID 41 drive-cycle monitors (41 41 00 07 A1 21)', () => {
    const d = dec(0x41, '00 07 A1 21');
    const f = (k: string) => d.fields.find((x) => x.key === k)!;
    expect(f('monitor_drive_cycle_enabled').setBits).toEqual(['catalyst', 'oxygen sensor', 'EGR/VVT system']);
    expect(f('monitor_drive_cycle_incomplete').setBits).toEqual(['catalyst', 'oxygen sensor']);
  });

  it('PID 6D masked fields (capture: 02 00 00 0D D5 28 00 00 00 00 28)', () => {
    const d = dec(0x6d, '02 00 00 0D D5 28 00 00 00 00 28');
    const f = (k: string) => d.fields.find((x) => x.key === k)!;
    expect(f('fuel_pressure_ctrl_cmd_a').state).toBe('absent');
    expect(f('fuel_pressure_ctrl_act_a').value).toBe(0x0dd5 * 10);
    expect(f('fuel_pressure_ctrl_temp_a').state).toBe('absent');
  });

  it('PID 70 boost (capture: 02 00 00 0C CC ...)', () => {
    const d = dec(0x70, '02 00 00 0C CC 00 00 00 00 00');
    expect(d.fields.find((x) => x.key === 'boost_act_a')!.value).toBeCloseTo(0x0ccc * 0.03125, 6);
  });

  it('PID 68 intake air sensors (capture first frame: 03 6E 5C ...)', () => {
    const d = dec(0x68, '03 6E 5C 00 00 00 00');
    expect(d.fields.find((x) => x.key === 'iat_sensors_b1s1')!.value).toBe(70);
    expect(d.fields.find((x) => x.key === 'iat_sensors_b1s2')!.value).toBe(52);
    expect(d.fields.find((x) => x.key === 'iat_sensors_b2s1')!.state).toBe('absent');
  });

  it('PID 67 coolant sensors and PID 51 fuel type', () => {
    const d = dec(0x67, '03 86 56');
    expect(d.fields.map((f) => f.value)).toEqual([94, 46]);
    expect(dec(0x51, '01').fields[0]!.text).toBe('Gasoline');
  });

  it('O2 trim 0xFF is "not used", support bitmaps list PIDs', () => {
    expect(dec(0x15, '5A FF').fields[1]!.state).toBe('not_available');
    expect(dec(0x00, 'BE 3E A8 13').fields[0]!.setBits!.slice(0, 5)).toEqual(['01', '03', '04', '05', '06']);
  });
});

describe('DTC classification', () => {
  it('generic, manufacturer and network codes', () => {
    expect(classifyDtc(DTC, 'P0301')).toMatchObject({ type: 'generic', known: true, system: 'P' });
    const m = classifyDtc(DTC, 'P1234');
    expect(m.type).toBe('manufacturer');
    expect(m.title).toMatch(/meaning unknown/);
    expect(classifyDtc(DTC, 'P3401').type).toBe('generic');
    expect(classifyDtc(DTC, 'P3001').type).toBe('manufacturer');
    expect(classifyDtc(DTC, 'U0100').subsystem).toMatch(/communication/);
    expect(classifyDtc(DTC, 'P0999').title).toBe(DTC.unknown_generic);
  });
  it('states its licence', () => {
    expect(DTC.licence).toMatch(/CC0/);
  });
});

describe('service 06', () => {
  it('scales signed mirrors and table entries', () => {
    expect(scalingFor(MODE06, 0x10)).toMatchObject({ unit: 'ms', basis: 'table' });
    expect(scalingFor(MODE06, 0x85)).toMatchObject({ signed: true, basis: 'signed_mirror' });
    expect(scalingFor(MODE06, 0x16).offset).toBe(-40);
  });
  it('decodes misfire records from the capture (06A2)', () => {
    const { tests, leftover } = decodeMode06Records(MODE06, bytes('A2 0B 24 00 0F 00 00 FF FF A2 0C 24 00 0B 00 00 FF FF'));
    expect(leftover).toBe(0);
    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({ midName: 'Misfire, cylinder 1', standardTid: true, value: 15, passed: true });
    expect(tests[0]!.tidName).toMatch(/last 10/);
    expect(tests[1]!.value).toBe(11);
  });
  it('manufacturer TIDs are shown raw with scaling', () => {
    const { tests } = decodeMode06Records(MODE06, bytes('01 8A 85 FF 69 80 00 0A 3F'));
    expect(tests[0]!.standardTid).toBe(false);
    expect(tests[0]!.raw.value).toBe(0xff69);
    expect(tests[0]!.value).toBeCloseTo(-151 * 0.0000305, 9);
    expect(tests[0]!.passed).toBe(true);
  });
});

describe('PIDs without a published formula (diesel, WWH-OBD, newer)', () => {
  it('every PID 01-C8 the public table lists has a name; formula-less ones are raw, never guessed', () => {
    for (const h of '5F 7A 7B 7D 7E 81 82 83 85 86 88 89 8A 8B 8C 8F 90 91 92 93 94 98 99 9A 9B 9C 9F A1 A3 A5 A7 A8 A9 C3 C4 C5 C6 C7 C8'.split(' ')) {
      const p = pidDef(parseInt(h, 16));
      expect(p, h).toBeDefined();
      expect(p!.name).not.toMatch(/^PID /);
    }
    expect(pidDef(0x7a)!.fields.map((f) => f.kind)).toEqual(['raw']);
  });

  it('raw PIDs decode to the bytes the car sent, at any length', () => {
    for (const data of ['01 00 64 01 F4 01 90', '01 00 64']) {
      const d = dec(0x7a, data);
      expect(d.status).toBe('decoded');
      expect(d.fields[0]!.state).toBe('ok');
      expect(d.fields[0]!.value).toBeNull();
      expect(d.fields[0]!.text).toBe(data);
    }
  });

  it('decodes the four published formulas: DEF tank level, DEF sensor D, DEF dosing, ABS switch', () => {
    expect(val(0x85, '01 00 10 00 20 FF 00 00 00 00', 'def_tank_level').value).toBe(100);
    expect(val(0x85, '01 00 10 00 20 80 00 00 00 00', 'pid_85_raw').text).toBe('01 00 10 00 20 80 00 00 00 00');
    expect(val(0x9b, '00 00 00 66', 'def_sensor_d').value).toBeCloseTo(40, 1);
    expect(val(0xa5, '01 51 00 00', 'def_dosing_commanded').value).toBe(40.5);
    expect(val(0xa5, '00 51 00 00', 'def_dosing_commanded').state).toBe('absent');
  });

  it('a PID in no table at all becomes a raw stand-in instead of being skipped', () => {
    expect(pidDef(0xc1)).toBeUndefined();
    const p = pidDefOrRaw(0xc1)!;
    expect(p.confidence).toBe('unlisted');
    expect(p.name).toBe("PID C1 (not in Vibecode my car's tables)");
    expect(decodePid(OBD, p, bytes('12 34 56')).fields[0]!.text).toBe('12 34 56');
    // support pages are never synthesized
    expect(pidDefOrRaw(0x100)).toBeUndefined();
  });
});

describe('formula language: only real functions, with the right arguments', () => {
  it.each(['constructor(A)', 'toString()', 'valueOf()', 'hasOwnProperty(A)'])('refuses %s', (formula) => {
    expect(() => compile(formula)).toThrow(/unknown function/);
  });
  it.each([
    ['s8()', /s8 takes 1 argument, got 0/],
    ['abs(A,B)', /abs takes 1 argument, got 2/],
    ['bit(A)', /bit takes 2 arguments, got 1/],
    ['min()', /min takes 1–8 arguments, got 0/],
  ])('refuses %s', (formula, message) => {
    expect(() => compile(formula)).toThrow(message);
  });
  it('still evaluates valid calls', () => {
    expect(compile('max(A,B,1)').run([0, 5])).toBe(5);
  });
});

describe('DTC codes', () => {
  it('recognises a code in either case, as classifyDtc does', () => {
    expect(isDtcCode('p0301')).toBe(true);
    expect(isDtcCode('P0301')).toBe(true);
    expect(isDtcCode('X0301')).toBe(false);
  });
});

describe('decode edge cases', () => {
  it('a full-scale reading is in range although the published bound is rounded (PID 34 current)', () => {
    const current = dec(0x34, '00 00 FF FF').fields.find((f) => f.key.includes('current'));
    expect(current?.value).toBeCloseTo(127.99609375, 8);
    expect(current?.state).toBe('ok');
  });
  it('a value beyond the rounded bound is still out of range', () => {
    const pid = pidDef(0x34);
    const field = pid?.fields.find((f) => f.key.includes('current'));
    if (!pid || !field) throw new Error('fixture');
    expect(decodeField(OBD, pid, { ...field, max: 100 }, bytes('00 00 FF FF')).state).toBe('out_of_range');
  });
  it('a formula that cannot be computed (division by a zero byte) is not available, never an ok value', () => {
    const pid = pidDef(0x34);
    const field = pid?.fields.find((f) => f.key.includes('current'));
    if (!pid || !field) throw new Error('fixture');
    expect(decodeField(OBD, pid, { ...field, formula: 'A/B', min: null, max: null }, bytes('01 00 00 00'))).toMatchObject({
      value: null,
      state: 'not_available',
    });
  });
  it('a formula nested absurdly deep fails with a message, not a stack overflow', () => {
    expect(() => compile(`${'('.repeat(300)}1${')'.repeat(300)}`)).toThrow(/nested too deeply/);
  });
});

describe('Mode 06 explanations agree with the test-name rules', () => {
  it('names a standard test only for the monitors it applies to', () => {
    expect(monitorInfo('01', '01').meaning).toBe(tidNameFor(0x01, 0x01));
    // Catalyst monitor: TID 01 is not the O2-sensor test of that number.
    expect(monitorInfo('21', '01').meaning).toMatch(/manufacturer defines/i);
  });
});
const tidNameFor = (mid: number, tid: number) => tidName(MODE06, mid, tid).name;
