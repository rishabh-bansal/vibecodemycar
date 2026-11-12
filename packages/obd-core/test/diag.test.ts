import { describe, expect, it } from 'vitest';
import {
  MAX_WAIT_MS, decodeDtcReply, findNegative, parseScript, parseSession, protoSelToAtsp, recipesFor, replyBytes, runScript, sweepRecipes,
  type UdsRecipe,
} from '../src/index.ts';
import { scriptedRig } from './scripted.ts';

const hex = (s: string) => s.trim().split(/\s+/).map((x) => parseInt(x, 16));

describe('decodeDtcReply', () => {
  it('59 (UDS 19): 4-byte records, failure type appended as -NN', () => {
    const r = decodeDtcReply(hex('59 02 FF 01 33 1C 08 02 44 00 09'))!;
    expect(r).toMatchObject({ sid: 0x59, format: 'uds', layout: 'uds-4' });
    expect(r.codes).toEqual([{ code: 'P0133-1C', status: 0x08 }, { code: 'P0244-00', status: 0x09 }]);
  });

  it('59 with no records is a valid, empty answer; padding records are not codes', () => {
    expect(decodeDtcReply(hex('59 02 FF'))).toMatchObject({ codes: [], layout: 'uds-4' });
    expect(decodeDtcReply(hex('59 02 FF 01 33 1C 08 00 00 00 00 55 55 55 55'))!.codes).toEqual([{ code: 'P0133-1C', status: 8 }]);
  });

  it('59 count replies carry the count, not codes', () => {
    expect(decodeDtcReply(hex('59 01 FF 01 00 03'))).toMatchObject({ codes: [], declaredCount: 3, layout: 'uds-count' });
  });

  it('58 / 57 / 53 (KWP): a count, then 2-byte codes, or 3-byte code + status when the length says so', () => {
    expect(decodeDtcReply(hex('58 02 01 33 02 44'))).toMatchObject({ format: 'kwp', layout: 'count+2', codes: [{ code: 'P0133' }, { code: 'P0244' }] });
    expect(decodeDtcReply(hex('58 02 01 33 20 02 44 28'))).toMatchObject({ layout: 'count+3', codes: [{ code: 'P0133', status: 0x20 }, { code: 'P0244', status: 0x28 }] });
    expect(decodeDtcReply(hex('57 01 C1 23'))!.codes).toEqual([{ code: 'U0123' }]);
    expect(decodeDtcReply(hex('53 01 05 71'))!.codes).toEqual([{ code: 'P0571' }]);
    expect(decodeDtcReply(hex('58 00'))).toMatchObject({ codes: [], declaredCount: 0 });
  });

  it('43 / 47 / 4A: a count byte on CAN, no count byte (and 0000 padding) on legacy buses', () => {
    expect(decodeDtcReply(hex('43 02 01 33 02 44 00 00'))).toMatchObject({ format: 'obd', declaredCount: 2, codes: [{ code: 'P0133' }, { code: 'P0244' }] });
    expect(decodeDtcReply(hex('47 01 C1 00'))!.codes).toEqual([{ code: 'U0100' }]);
    expect(decodeDtcReply(hex('4A 00 00 00'))!.codes).toEqual([]);
    expect(decodeDtcReply(hex('43 01 33 00 00 00 00'), { can: false })).toMatchObject({ layout: 'no-count', codes: [{ code: 'P0133' }] });
  });

  it('finds the service id behind CAN ids, PCI bytes and 29-bit header bytes', () => {
    expect(decodeDtcReply(hex('06 59 02 FF 01 33 1C 08'))!.offset).toBe(1);
    expect(decodeDtcReply(hex('18 DA F1 10 07 59 02 FF 01 33 1C 08'))).toMatchObject({ offset: 5, codes: [{ code: 'P0133-1C', status: 8 }] });
    expect(decodeDtcReply(hex('04 58 01 01 33'))!.codes).toEqual([{ code: 'P0133' }]);
  });

  it('a first-frame length byte that looks like a service id does not fool it', () => {
    // 10 59: ISO-TP first frame of 0x59 = 89 bytes; the real reply starts at the next byte
    const bytes = [0x10, 0x59, 0x59, 0x02, 0xff, 0x01, 0x33, 0x1c, 0x08];
    expect(decodeDtcReply(bytes)).toMatchObject({ sid: 0x59, offset: 2, codes: [{ code: 'P0133-1C' }] });
  });

  it('does not invent codes from replies that are not DTC lists', () => {
    expect(decodeDtcReply(hex('62 F1 90 57 41 55'))).toBeNull();
    expect(decodeDtcReply(hex('7F 19 12'))).toBeNull();
    expect(decodeDtcReply(hex('58 05 01 33'))).toBeNull(); // count says 5, bytes say 1
    expect(decodeDtcReply([])).toBeNull();
  });

  it('reads negative responses', () => {
    expect(findNegative(hex('03 7F 19 12'))).toEqual({ service: 0x19, nrc: 0x12 });
    expect(findNegative(hex('59 02 FF'))).toBeNull();
  });
});

describe('replyBytes', () => {
  it('drops 11-bit ids and "0:" prefixes, keeps 29-bit header bytes, reads compact lines', () => {
    expect(replyBytes(['7E8 06 59 02 FF 01 33 1C'])).toEqual(hex('06 59 02 FF 01 33 1C'));
    expect(replyBytes(['18 DA F1 10 03 7F 19 12'])).toEqual(hex('18 DA F1 10 03 7F 19 12'));
    expect(replyBytes(['0: 59 02 FF 01', '1: 33 1C 08'])).toEqual(hex('59 02 FF 01 33 1C 08'));
    expect(replyBytes(['7E8065902FF01331C'])).toEqual(hex('06 59 02 FF 01 33 1C'));
    expect(replyBytes(['18DAF110065902FF01331C'])).toEqual(hex('06 59 02 FF 01 33 1C'));
    expect(replyBytes(['NO DATA', '00B'])).toEqual([]);
  });
});

describe('profile script grammar', () => {
  it('section tags (attached to a command or alone), markers, AT commands, WAIT / DELAY', () => {
    const s = parseScript('[CAN11]ATSH7E0;ATFCSD300F05;1092;_1800FF00;WAIT250;DELAY 100;[/CAN11];_03;ATSH7DF');
    expect(s.steps.map((x) => [x.kind, 'cmd' in x ? x.cmd : 'ms' in x ? x.ms : '', x.section ?? ''])).toEqual([
      ['at', 'ATSH7E0', 'CAN11'], ['at', 'ATFCSD300F05', 'CAN11'], ['send', '1092', 'CAN11'], ['send', '1800FF00', 'CAN11'],
      ['wait', 250, 'CAN11'], ['wait', 100, 'CAN11'], ['send', '03', ''], ['at', 'ATSH7DF', ''],
    ]);
    expect(s.steps[3]).toMatchObject({ marked: true });
    expect(s.steps[2]).toMatchObject({ marked: false });
    expect(s.sessions).toEqual(['92']);
  });

  it('parses the scripts as the dataset has them', () => {
    const merc = parseScript('_03;03;_03;_03;_ATSH8101F3;A1;_ATSH8101F1');
    expect(merc.steps.map((x) => x.kind)).toEqual(['send', 'send', 'send', 'send', 'at', 'send', 'at']);
    expect(merc.steps[4]).toMatchObject({ cmd: 'ATSH8101F3' });
    const clr = parseScript('[CAN11]ATSH7E0;ATFCSH7E0;ATFCSM1;1092;14;14FF00;1081;ATFCSM0;[/CAN11]');
    expect(clr.steps.filter((x) => x.kind === 'send').map((x) => (x as { cmd: string }).cmd)).toEqual(['1092', '14', '14FF00', '1081']);
    expect(parseScript(['ATZ', 'ATE0', 'STCAF 1,07', '22F400']).steps.map((x) => x.kind)).toEqual(['at', 'at', 'at', 'send']);
    expect(parseScript(null).steps).toEqual([]);
  });

  it('keeps what it cannot read as unknown, and caps a WAIT', () => {
    const s = parseScript('1800FF00;hello world;WAIT999999;==;TS');
    expect(s.steps.map((x) => x.kind)).toEqual(['send', 'unknown', 'wait', 'unknown', 'unknown']);
    expect((s.steps[2] as { ms: number }).ms).toBe(MAX_WAIT_MS);
  });

  it('maps protoSel to ATSP, and marks the vendor K-line protocols unsupported', () => {
    expect(protoSelToAtsp(0)).toEqual({ atsp: '0', supported: true });
    for (const n of [5, 6, 7, 8, 9]) expect(protoSelToAtsp(n)).toEqual({ atsp: String(n), supported: true });
    expect(protoSelToAtsp(10)).toEqual({ atsp: 'A', supported: true });
    for (const n of [11, 43, 44]) expect(protoSelToAtsp(n)).toEqual({ atsp: '0', supported: false });
  });

  it('reads a diagnostic system\'s session field: session command, tester-present, interval', () => {
    expect(parseSession('(10_92, $3E, 3500)')).toEqual({ sessionCmd: '1092', testerPresent: '3E', intervalMs: 3500 });
    expect(parseSession(null)).toBeNull();
    expect(parseSession('(11_92, $3E, 3500)')).toBeNull();
    expect(parseSession('(10_92, $3E, 5)')).toBeNull();
    expect(parseSession('nonsense')).toBeNull();
  });
});

describe('runScript', () => {
  const handler = (cmd: string): string => {
    if (cmd.startsWith('AT')) return 'OK';
    if (cmd === '03') return '7E8 06 43 01 01 33 00 00';
    if (cmd === '3E00' || cmd === '3E') return '7E8 02 7E 00';
    return 'NO DATA';
  };

  it('runs the steps in order through the policy, collects marked replies, and records refusals without stopping', async () => {
    const { elm, link, run } = scriptedRig(handler);
    const script = parseScript('ATSH7E0;_03;2E010203;14FFFFFF;_07;ATSH7DF');
    const r = await run(runScript(link, script));
    expect(elm.log.map((l) => l.cmd)).toEqual(['ATSH7E0', '03', '07', 'ATSH7DF']);
    expect(r.marked.map((x) => x.cmd)).toEqual(['03', '07']);
    expect(r.refused.map((x) => x.step)).toEqual([script.steps[2], script.steps[3]]);
    expect(r.refused[0]!.reason).toMatch(/writes data/);
    expect(r.refused[1]!.reason).toMatch(/clears fault memory/);
    expect(r.steps.at(-1)!.outcome).toBe('done');
  });

  it('skips a section for another protocol family, and runs the matching one', async () => {
    const { elm, link, run } = scriptedRig(handler, '6'); // CAN 11-bit
    await run(runScript(link, parseScript('[CAN29]ATSH18DA10F1;_03;[/CAN29];[CAN11]ATSH7E0;_03;[/CAN11]')));
    expect(elm.log.map((l) => l.cmd)).toEqual(['ATSH7E0', '03']);
  });

  it('on a car whose protocol is not set yet, the tag selects it', async () => {
    const { elm, link, run } = scriptedRig(handler, '0');
    await run(runScript(link, parseScript('[CAN11]ATSH7E0;_03;[/CAN11]')));
    expect(elm.log.map((l) => l.cmd)).toEqual(['ATSP6', 'ATSH7E0', '03']);
  });

  it('WAIT sleeps on the clock, and tester-present goes out during the wait', async () => {
    const { elm, link, clock, run } = scriptedRig(handler);
    const t0 = clock.now();
    await run(runScript(link, parseScript('_03;WAIT3000;_03'), { keepAlive: { sessionCmd: '1092', testerPresent: '3E', intervalMs: 1000 } }));
    expect(clock.now() - t0).toBeGreaterThanOrEqual(3000);
    expect(elm.log.filter((l) => l.cmd === '3E').length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a programming session in a script even though the script contains it', async () => {
    const { elm, link, run } = scriptedRig(handler);
    const script = parseScript('1002;1003;1092');
    link.policy.declareSessions(script.sessions);
    const r = await run(runScript(link, script));
    expect(elm.log.map((l) => l.cmd)).toEqual(['1003', '1092']);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.reason).toMatch(/programming or adjustment/);
  });

  it('never sends an unknown token and stops at maxSteps', async () => {
    const { elm, link, run } = scriptedRig(handler);
    const r = await run(runScript(link, parseScript('==;hello;_03;_03;_03'), { maxSteps: 4 }));
    expect(elm.log.map((l) => l.cmd)).toEqual(['03', '03']);
    expect(r.steps).toHaveLength(4);
  });
});

describe('per-module UDS recipe sweep', () => {
  // module 760 answers 19 02 08 positively after a negative 19 02 AF; module 720 answers the KWP 18 request
  const handler = (cmd: string, st: { header: string }): string => {
    if (cmd.startsWith('AT')) return 'OK';
    if (st.header === '760') {
      if (cmd === '1902AF') return '768 03 7F 19 12';
      if (cmd === '190208') return '768 07 59 02 FF 01 33 1C 08';
      return 'NO DATA';
    }
    if (st.header === '720') {
      if (cmd === '1800FF00') return '728 04 58 01 01 33';
      return 'NO DATA';
    }
    return 'NO DATA';
  };
  const recipes: UdsRecipe[] = [
    { mk: 'acr00', hdr: '760', read: ['1800FF00', '1902AF', '190208', '190223'], clr: ['14FFFFFF'] },
    { mk: 'acr00', hdr: '720', read: ['==', '1800FF00', '1902AF'], clr: ['14'] },
    { mk: 'acr00', hdr: '7E3', read: ['2E010203', '1902FF'], clr: [] },
    { mk: 'zzz99', hdr: '740', read: ['1902FF'], clr: [] },
  ];

  it('gives each module its own header and its own list, first working command wins', async () => {
    const { elm, link, run } = scriptedRig(handler);
    const res = await run(sweepRecipes(link, recipesFor(recipes, 'acr00')));
    expect(res.map((m) => [m.hdr, m.status, m.command])).toEqual([['760', 'codes', '190208'], ['720', 'codes', '1800FF00'], ['7E3', 'no-answer', null]]);
    expect(res[0]!.reply!.codes).toEqual([{ code: 'P0133-1C', status: 8 }]);
    expect(res[1]!.reply).toMatchObject({ format: 'kwp', codes: [{ code: 'P0133' }] });
    expect(res[0]!.tried.map((t) => [t.cmd, t.outcome])).toEqual([['1800FF00', 'no-data'], ['1902AF', 'negative'], ['190208', 'positive']]);
    expect(res[0]!.tried[1]).toMatchObject({ nrc: 0x12 });
    // 190223 was never needed; 720's list never contained 1902AF before its answer; the lists did not leak across headers
    expect(elm.sentTo('760')).toEqual(['1800FF00', '1902AF', '190208']);
    expect(elm.sentTo('720')).toEqual(['1800FF00']);
    expect(elm.log.some((l) => l.cmd === '190223')).toBe(false);
  });

  it('puts the addressing back after every module', async () => {
    const { elm, link, run } = scriptedRig(handler);
    await run(sweepRecipes(link, recipesFor(recipes, 'acr00')));
    const addressing = elm.log.map((l) => l.cmd).filter((c) => c.startsWith('ATSH'));
    expect(addressing).toEqual(['ATSH760', 'ATSH7DF', 'ATSH720', 'ATSH7DF', 'ATSH7E3', 'ATSH7DF']);
    expect(link.config.target).toBe('functional');
    // a module with no known reply id does not inherit the last module's receive filter
    expect(elm.log.map((l) => l.cmd).filter((c) => c.startsWith('ATCRA'))).toContain('ATCRA');
  });

  it('flags unusable commands, refuses writes inside a recipe, and never sends a clear list', async () => {
    const { elm, link, run } = scriptedRig(handler);
    const res = await run(sweepRecipes(link, recipesFor(recipes, 'acr00')));
    expect(res[1]!.tried[0]).toEqual({ cmd: '==', outcome: 'invalid' });
    expect(res[2]!.tried.map((t) => [t.cmd, t.outcome])).toEqual([['2E010203', 'refused'], ['1902FF', 'no-data']]);
    expect(elm.log.some((l) => l.cmd.startsWith('14') || l.cmd.startsWith('2E'))).toBe(false);
  });

  it('selects rows by vehicle profile, and skips modules on a car that is not on CAN', async () => {
    expect(recipesFor(recipes, 'acr00')).toHaveLength(3);
    expect(recipesFor(recipes, 'nope')).toEqual([]);
    expect(recipesFor([{ mk: 'a', hdr: 'ZZZ', read: [], clr: [] }], 'a')).toEqual([]);
    const { link, run } = scriptedRig(handler, '5'); // ISO 14230-4 KWP
    const res = await run(sweepRecipes(link, recipesFor(recipes, 'acr00')));
    expect(res.every((m) => m.status === 'skipped')).toBe(true);
  });
});
