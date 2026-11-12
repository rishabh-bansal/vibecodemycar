/**
 * The live kit's frame test (frame-test.ts) end to end: the production engine, ELM session, Bluetooth link and
 * writer, on the clone simulator (with and without the owner's clone's 8th-byte fault) and on the ELM327 emulator
 * as an STN chip, all on one virtual clock.
 */
import { Elm327Emulator, OBDCraftEngine, VirtualClock } from '@obdcraft/obd-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeCarEcus, loadProfile } from '../../../scripts/live/fake-car.ts';
import { FRAME_TEST_MODES, type FrameTestReport, runFrameTest, trialBytes } from './frame-test.ts';
import { type FaultModel, kushaqEcus } from './testing/clone-sim.ts';
import { drive, installDeterministicDigest, simRig } from './testing/harness.ts';
import { WebBluetoothLink } from './web-bluetooth.ts';

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());
afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

/** Every drop chance off: the frame handling is what is measured, not the clone's losses. */
const CALM: Partial<FaultModel> = {
  pStale: 0,
  pLocked: 0,
  transitions: [],
  pSearchOk: 0,
  pSearchAfterSilent: 0,
  pSearchUnable: 0,
  pFirstCf: 0,
  pRxFc: 0,
  pLastRxCfLoss: 0,
};

async function onSim(f198: string, model: Partial<FaultModel>): Promise<FrameTestReport> {
  const rig = await simRig({
    seed: 7,
    ecus: kushaqEcus({ values: { '70E:F198': f198 } }),
    model: { ...CALM, ...model },
  });
  return drive(rig.clock, () => runFrameTest(rig.link));
}

const row = (r: FrameTestReport, mode: string, value: string) =>
  r.trials.find((t) => t.mode === mode && t.value === value);

describe('frame test: trial bytes', () => {
  it("sets F198 byte 2 (the first frame's 8th byte) to the value and byte 1 to a per-trial tag", () => {
    expect(trialBytes('0181C8F63039', 0, 0x00)).toBe('014100F63039');
    expect(trialBytes('0181C8F63039', 1, 0x5a)).toBe('01445AF63039');
    // A tag equal to the original's own 7th byte would not prove the write landed: it moves.
    expect(trialBytes('0141C8F63039', 0, 0x00)).toBe('015100F63039');
  });
});

describe('frame test on the clone simulator', () => {
  it('with the 8th-byte fault: full stores 0x30, trim-zero stores 0x00 right, fc-alt moves it to 0x31', async () => {
    const r = await onSim('018100F63039', { corruptFullFrames: true });
    expect(r.modes).toEqual(['full', 'trim-zero', 'fc-alt']); // no STN chip: no stpx
    expect(r.trials).toHaveLength(6);
    expect(r.trials.every((t) => t.write === 'acked' && t.landed)).toBe(true);
    expect(row(r, 'full', '00')).toMatchObject({ match: false, byte8: '30' });
    expect(row(r, 'full', '5A')).toMatchObject({ match: false, byte8: '30' });
    expect(row(r, 'trim-zero', '00')).toMatchObject({ match: true, byte8: '00' });
    expect(row(r, 'trim-zero', '5A')).toMatchObject({ match: false, byte8: '30' });
    expect(row(r, 'fc-alt', '00')).toMatchObject({ match: false, byte8: '31' });
    // The tx log keeps the intended first frame and what the adapter was actually given.
    expect(row(r, 'trim-zero', '00')?.frames[0]).toMatchObject({
      data: '10092EF198014700',
      sent: '10092EF1980147',
    });
    expect(row(r, 'full', '00')?.frames).toHaveLength(2);
    expect(row(r, 'full', '00')?.frames[0]?.sent).toBeUndefined();
    expect(row(r, 'trim-zero', '5A')?.frames[0]?.sent).toBeUndefined();
    expect(r.best).toEqual({ zero: 'trim-zero' });
    // The original's 8th byte is 00: trim-zero puts it back exactly.
    expect(r.restore).toMatchObject({
      mode: 'trim-zero',
      write: 'acked',
      stored: '018100F63039',
      exact: true,
    });
    expect(r.findings).toContain(
      'fc-alt stored 0x31: the 8th byte comes from the adapter flow-control buffer',
    );
  });

  it('with the fault, an original whose 8th byte is not 00 cannot be put back exactly, and the report says so', async () => {
    const r = await onSim('0181C8F63039', { corruptFullFrames: true });
    expect(r.restore).toMatchObject({ mode: 'full', exact: false, stored: '018130F63039' });
    expect(r.findings.join('\n')).toMatch(/F198 NOT restored: holds 018130F63039, original 0181C8F63039/);
    expect(r.findings.join('\n')).toMatch(/no mode stored a non-zero 8th byte/);
  });

  it('without the fault every mode stores what was sent and full stays the choice', async () => {
    const r = await onSim('0181C8F63039', {});
    expect(r.trials.every((t) => t.match)).toBe(true);
    expect(r.best).toEqual({ zero: 'full', nonZero: 'full' });
    expect(r.restore).toMatchObject({ mode: 'full', exact: true, stored: '0181C8F63039' });
  });

  it('writes nothing when F198 cannot be read first, and says so plainly when it is write-only (7F 22 31)', async () => {
    const rig = await simRig({ seed: 7, ecus: kushaqEcus(), model: CALM });
    const r = await drive(rig.clock, () => runFrameTest(rig.link));
    expect(r.trials).toEqual([]);
    expect(r.stopped).toMatch(/nothing was written/i);
    expect(r.stopped).toMatch(/F198 is not readable on this module .*frame test not possible; use `repair`/);
    expect(rig.sim.truth.some((e) => e.type === 'stored')).toBe(false);
  });
});

describe('frame test on the emulator as an STN chip (fake bridge --stn)', () => {
  it('adds stpx: the whole PDU goes in one STPX command, recorded against the frames it stands for', async () => {
    const clock = new VirtualClock();
    const emu = new Elm327Emulator({
      clock,
      ecus: fakeCarEcus(loadProfile()).ecus,
      stnChip: 'STN2255 v5.10.3',
      stnDevice: 'OBDLink MX+ (fake)',
      random: () => 0.5,
    });
    const engine = new OBDCraftEngine({ clock, startup: 'diagnostic-can' });
    await drive(clock, () => engine.connect(emu));
    const link = WebBluetoothLink.adopt(engine);
    expect(link.adapter).toMatchObject({ cls: 'stn', stpx: true, stn: 'STN2255 OBDLink MX+ (fake)' });
    const r = await drive(clock, () => runFrameTest(link));
    expect(r.modes).toEqual([...FRAME_TEST_MODES]);
    expect(r.trials).toHaveLength(8);
    expect(r.trials.every((t) => t.match)).toBe(true);
    const stpx = row(r, 'stpx', '00');
    expect(stpx?.frames.map((f) => f.sent)).toEqual([`STPX h:70E,d:2EF198${stpx?.sent},r:1`, 'STPX']);
    expect(r.restore).toMatchObject({ mode: 'full', exact: true, stored: '0181C8F63039' });
  });
});
