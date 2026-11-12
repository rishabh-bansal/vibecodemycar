import { describe, expect, it } from 'vitest';
import { VirtualClock, runVirtual } from '../src/util/clock.ts';
import { Elm327Emulator, type EmulatorOptions } from '../src/emulator/elm327.ts';
import { kushaqLikeEcus } from '../src/emulator/presets.ts';
import { ElmSession } from '../src/elm/session.ts';
import { ElmLink } from '../src/elm/link.ts';
import { OBDCraftEngine } from '../src/engine/engine.ts';
import { PolicyError, SafetyPolicy } from '../src/safety/policy.ts';
import { WebBluetoothTransport, type BleDevice, type BleObservation } from '../src/transport/webBluetooth.ts';
import {
  BLE_LAYOUTS, BLE_SERVICES, SERIAL_BAUDS, WIFI_DEFAULTS, classifyBleName, describeUsbChip, identifyAdapter, pickCharacteristics, shareableProfile,
  tunerSeedFor, verifyVehicleLink, FIRST_QUERY_TIMEOUT_MS, type GattCharInfo,
} from '../src/index.ts';
import { seeded } from './helpers.ts';
import { scriptedRig } from './scripted.ts';

function identify(opts: Partial<EmulatorOptions> = {}) {
  const clock = new VirtualClock();
  const emu = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(3), ...opts });
  const session = new ElmSession(emu, { clock });
  const link = new ElmLink(session);
  return runVirtual(clock, (async () => {
    await emu.open();
    await link.at('ATZ', 5000);
    for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH1']) await link.at(c);
    return identifyAdapter(link);
  })());
}

describe('identifyAdapter', () => {
  it('your OBDBLE clone (ATI "ELM327 v2.1", AT@1 the stock string) is a plain ELM, not "branded"', async () => {
    const p = await identify();
    expect(p).toMatchObject({ cls: 'elm', confidence: 'likely', claimedVersion: '2.1', firmware: 'ELM327 v2.1' });
    expect(p.label).toBe('ELM327-compatible (reports v2.1)');
    expect(p.description).toBeUndefined();
    expect(p.caps.stCommands).toBe(false);
    expect(p.evidence.join(' ')).toMatch(/stock ELM string/);
    expect(p.raw).toMatchObject({ identity: 'ELM327 v2.1', device: 'OBDII to RS232 Interpreter' });
    expect(p.voltage).toBeGreaterThan(10);
  });

  it('a confirmed STN chip is recognised from STI, with its device name from STDI', async () => {
    const p = await identify({ identity: 'ELM327 v1.4b', stnChip: 'STN2120 v5.10.3', stnDevice: 'OBDLink MX+' });
    expect(p).toMatchObject({ cls: 'stn', confidence: 'confirmed', stn: { chip: 'STN2120', model: 2120, device: 'OBDLink MX+' }, caps: { stCommands: true } });
    expect(p.label).toBe('OBDLink MX+ (STN2120)');
    expect(tunerSeedFor(p)).toMatchObject({ maxPids: 6, responseCount: true, spaces: false });
  });

  it('STN chips the kit\'s JSON regex would miss (STN1130, STN1170) are still STN', async () => {
    for (const chip of ['STN1130 v4.0', 'STN1170 v5.1']) {
      expect((await identify({ stnChip: chip })).cls).toBe('stn');
    }
  });

  it('a name that says OBDLink without an STI answer is "likely" STN, and gets no seed', async () => {
    const p = await identify({ identity: 'OBDLink MX v4', device: 'OBDLink MX' });
    expect(p).toMatchObject({ cls: 'stn', confidence: 'likely', caps: { stCommands: false } });
    expect(tunerSeedFor(p)).toBeNull();
  });

  it('a non-stock AT@1 text, or a programmed AT@2 identifier, marks a branded adapter', async () => {
    const a = await identify({ device: 'Veepeak OBDCheck BLE' });
    expect(a).toMatchObject({ cls: 'branded', description: 'Veepeak OBDCheck BLE', label: 'Veepeak OBDCheck BLE' });
    const b = await identify({ identifier: 'VP-0042-AB12' });
    expect(b).toMatchObject({ cls: 'branded', serial: 'VP-0042-AB12' });
    expect(tunerSeedFor(a)).toBeNull();
  });

  it('the unit\'s own identifier is shortened in anything shared', async () => {
    const b = await identify({ identifier: 'VP-0042-AB12' });
    expect(shareableProfile(b).serial).toBe('…AB12');
    expect(JSON.stringify(shareableProfile(b))).not.toContain('VP-0042');
  });

  it('a banner that is not ELM327 is reported as it is, not forced into a class', async () => {
    const p = await identify({ identity: 'SuperScan 9000', device: '' });
    expect(p).toMatchObject({ cls: 'unknown', firmware: 'SuperScan 9000', label: 'SuperScan 9000' });
  });
});

describe('identifyAdapter: echo and no-answer', () => {
  /** A pretend adapter whose echo is still on: unknown commands come back as the echo alone, or as "?". */
  async function withReplies(replies: Record<string, string>) {
    const { link, run } = scriptedRig((cmd) => (cmd in replies ? replies[cmd]! : '?'));
    return run(identifyAdapter(link));
  }

  it('a command that only comes back as its own echo is not an answer', async () => {
    const p = await withReplies({ ATI: 'ATI\rELM327 v1.5', 'AT@1': 'AT@1', 'AT@2': 'AT@2\r?', ATRV: 'ATRV\r12.4V', STI: 'STI\r?' });
    expect(p).toMatchObject({ cls: 'elm', firmware: 'ELM327 v1.5', claimedVersion: '1.5' });
    expect(p.description).toBeUndefined(); // the kit would have called the echoed "AT@1" a description and the adapter "branded"
    expect(p.serial).toBeUndefined();
    expect(p.voltage).toBe(12.4);
    expect(p.caps.stCommands).toBe(false);
  });

  it('"?" and NO DATA to AT@1 / AT@2 are no answer; the stock string is an answer that says nothing about the maker', async () => {
    const unknown = await withReplies({ ATI: 'ELM327 v2.1' });
    expect(unknown.cls).toBe('elm');
    expect(unknown.description).toBeUndefined();
    expect(unknown.serial).toBeUndefined();
    const stock = await withReplies({ ATI: 'ELM327 v2.1', 'AT@1': 'OBDII to RS232 Interpreter' });
    expect(stock.cls).toBe('elm');
    expect(stock.raw.device).toBe('OBDII to RS232 Interpreter'); // kept for display, not for classification
    const nodata = await withReplies({ ATI: 'ELM327 v1.5', 'AT@1': 'NO DATA', 'AT@2': 'NO DATA' });
    expect(nodata).toMatchObject({ cls: 'elm' });
  });

  it('asks a plain ELM for its programmable-parameter summary (ATPPS) and keeps it as evidence; an STN chip is not asked', async () => {
    const pic = await withReplies({ ATI: 'ELM327 v1.5', ATPPS: '00:FF F  01:FF F  02:FF F  03:32 F\r26:00 F  2C:E0 F\rOK' });
    expect(pic.ppSummary).toBe('00:FF F  01:FF F  02:FF F  03:32 F 26:00 F  2C:E0 F');
    expect(pic.evidence).toContain('ATPPS answered (programmable parameters listed)');
    const clone = await withReplies({ ATI: 'ELM327 v2.1' });
    expect(clone.ppSummary).toBeUndefined();
    expect(clone.evidence).toContain('ATPPS not answered');
    const { link, run, elm } = scriptedRig((cmd) => (cmd === 'ATI' ? 'ELM327 v1.4b' : cmd === 'STI' ? 'STN2120 v5.6.5' : '?'));
    expect((await run(identifyAdapter(link))).cls).toBe('stn');
    expect(elm.log.some((e) => e.cmd === 'ATPPS')).toBe(false);
  });

  it('a silent adapter is "unknown", not misfiled', async () => {
    const p = await withReplies({});
    expect(p).toMatchObject({ cls: 'unknown', confidence: 'unknown', firmware: '(no banner)' });
  });
});

describe('verifyVehicleLink', () => {
  async function verify(opts: Partial<EmulatorOptions> = {}) {
    const clock = new VirtualClock();
    const emu = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(3), ...opts });
    const link = new ElmLink(new ElmSession(emu, { clock }));
    return runVirtual(clock, (async () => {
      await emu.open();
      await link.at('ATZ', 5000);
      for (const c of ['ATE0', 'ATL0', 'ATS1', 'ATH1']) await link.at(c);
      return verifyVehicleLink(link);
    })());
  }

  it('waits long enough for the protocol search, and says the car answered', async () => {
    expect(FIRST_QUERY_TIMEOUT_MS).toBeGreaterThanOrEqual(12_000);
    expect(FIRST_QUERY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    const v = await verify();
    expect(v).toMatchObject({ alive: true, failure: null });
    expect(v.protocol).toMatch(/CAN/);
  });
});

describe('policy', () => {
  it('lets the two STN identity queries through and nothing else in the ST family', () => {
    const p = new SafetyPolicy();
    expect(() => p.check('STI', { family: 'can11' })).not.toThrow();
    expect(() => p.check('stdi', { family: 'can11' })).not.toThrow();
    for (const c of ['STPX', 'STSLCS', 'STFAP', 'STPRS']) expect(() => p.check(c, { family: 'can11' }), c).toThrow(PolicyError);
  });

  it('frame modes: the PP 26 filler only at 00, ATPPS, STN segmentation, and STPX only as a carrier of one allowed request', () => {
    const p = new SafetyPolicy();
    for (const c of ['ATPPS', 'ATPP26SV00', 'ATPP26ON', 'ATPP26OFF', 'STCSEGT1', 'STCSEGT0', 'STCSEGR1']) {
      expect(() => p.check(c, { family: 'can11' }), c).not.toThrow();
    }
    // Any other programmable parameter (or another filler) is an EEPROM write the tool never makes.
    for (const c of ['ATPP26SV55', 'ATPP0CSV08', 'ATPP2CON', 'ATPPFFOFF', 'ATPP0EON', 'STCSEGT2']) {
      expect(() => p.check(c, { family: 'can11' }), c).toThrow(PolicyError);
    }
    const state = { family: 'can11' as const, target: '70E' };
    expect(() => p.check('STPX h:70E,d:22F198,r:1', state)).not.toThrow();
    expect(() => p.check('STPX h:714,d:22F198,r:1', state)).toThrow(/differs from the addressed module/);
    expect(() => p.check('STPX h:70E,d:1101,r:1', state)).toThrow(PolicyError); // ECU reset: refused as on its own
    expect(() => p.check('STPX h:70E,d:22F198', state)).toThrow(/one physical request/);
    expect(() => p.check('STPX h:70E,d:2EF198014100F63039,r:1', state)).toThrow(PolicyError); // no permit
    const token = p.issueCodingToken('2EF198014100F63039', '70E');
    expect(() => p.check('STPX h:70E,d:2EF198014100F63039,r:1', state, undefined, token)).not.toThrow();
  });
});

describe('tuner seed', () => {
  async function connect(opts: Partial<EmulatorOptions>) {
    const clock = new VirtualClock();
    const emu = new Elm327Emulator({ clock, ecus: kushaqLikeEcus(), random: seeded(11), writeLatencyMs: 40, bytesPerMs: 1.3, ...opts });
    const engine = new OBDCraftEngine({ clock });
    const run = <T>(p: Promise<T>) => runVirtual(clock, p);
    const r = await run(engine.connect(emu));
    return { engine, run, clock, r };
  }

  it('the engine records the profile, and an STN adapter starts from the fast configuration', async () => {
    const { engine, run, clock } = await connect({ stnChip: 'STN2120 v5.10.3', stnDevice: 'OBDLink MX+' });
    expect(engine.adapter.profile).toMatchObject({ cls: 'stn', confidence: 'confirmed' });
    expect(engine.adapter.identity).toBe('ELM327 v2.1');
    engine.startLive();
    await run(clock.sleep(3000));
    const first = engine.tuner!.events.find((e) => e.kind === 'restore');
    expect(first?.note).toMatch(/adapter class/);
    expect(engine.tuner!.config).toMatchObject({ maxPids: 6, spaces: false });
    await run(engine.disconnect());
  });

  it('a plain ELM starts from the baseline and climbs by measurement', async () => {
    const { engine, run, clock } = await connect({});
    expect(engine.adapter.profile?.cls).toBe('elm');
    engine.startLive();
    await run(clock.sleep(3000));
    expect(engine.tuner!.events[0]?.kind).toBe('start');
    expect(engine.tuner!.config.maxPids).toBe(1);
    await run(engine.disconnect());
  });

  it('the session export carries the profile without the unit identifier', async () => {
    const { engine } = await connect({ identifier: 'VP-0042-AB12' });
    const out = engine.exportSession();
    expect(JSON.stringify(out.adapter)).toContain('…AB12');
    expect(JSON.stringify(out.adapter)).not.toContain('VP-0042');
  });
});

describe('BLE catalog', () => {
  it('lists each service once, in lower case, and declares them all up front', () => {
    expect(new Set(BLE_SERVICES).size).toBe(BLE_LAYOUTS.length);
    for (const l of BLE_LAYOUTS) {
      for (const u of [l.service, ...l.write, ...l.notify]) expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('carries the layouts of both sources: the kit\'s FFE5 and ISSC, and OBDCraft\'s 18F0 and BEEF', () => {
    const names = BLE_LAYOUTS.map((l) => l.name).join(' | ');
    for (const n of ['FFF0', 'FFE0', 'FFE5', '18F0', 'E781', 'ISSC', 'BEEF']) expect(names).toContain(n);
  });

  const ch = (uuid: string, ...props: ('write' | 'writeWithoutResponse' | 'notify' | 'indicate')[]): GattCharInfo => ({
    uuid, properties: { write: props.includes('write'), writeWithoutResponse: props.includes('writeWithoutResponse'), notify: props.includes('notify'), indicate: props.includes('indicate') },
  });
  const fff0 = BLE_LAYOUTS.find((l) => l.name.startsWith('FFF0'))!;
  const e781 = BLE_LAYOUTS.find((l) => l.name.startsWith('E781'))!;

  it('picks FFF2 to write and FFF1 to notify, and swaps when the device has them the other way round', () => {
    const normal = [ch('0000FFF1-0000-1000-8000-00805F9B34FB', 'notify'), ch('0000fff2-0000-1000-8000-00805f9b34fb', 'writeWithoutResponse')];
    const p = pickCharacteristics(fff0, normal)!;
    expect([p.write.uuid.slice(4, 8).toLowerCase(), p.notify.uuid.slice(4, 8).toLowerCase(), p.via]).toEqual(['fff2', 'fff1', 'known']);
    const swapped = [ch('0000fff1-0000-1000-8000-00805f9b34fb', 'write'), ch('0000fff2-0000-1000-8000-00805f9b34fb', 'notify')];
    const s = pickCharacteristics(fff0, swapped)!;
    expect([s.write.uuid.slice(4, 8), s.notify.uuid.slice(4, 8), s.via]).toEqual(['fff1', 'fff2', 'known']);
  });

  it('handles both E781 shapes: one read/write/notify characteristic, or a write/notify pair', () => {
    const single = [ch('bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', 'write', 'notify')];
    expect(pickCharacteristics(e781, single)).toMatchObject({ via: 'known' });
    const pair = [ch('e7810a72-73ae-499d-8c15-faa9aef0c3f2', 'write'), ch('e7810a73-73ae-499d-8c15-faa9aef0c3f2', 'notify')];
    const p = pickCharacteristics(e781, pair)!;
    expect([p.write.uuid.slice(0, 8), p.notify.uuid.slice(0, 8), p.via]).toEqual(['e7810a72', 'e7810a73', 'known']);
  });

  it('falls back to the characteristics\' abilities for an unfamiliar layout inside a known service, and gives up when none can do the job', () => {
    const odd = [ch('11111111-0000-1000-8000-00805f9b34fb', 'notify'), ch('22222222-0000-1000-8000-00805f9b34fb', 'writeWithoutResponse')];
    expect(pickCharacteristics(fff0, odd)).toMatchObject({ via: 'by-properties' });
    expect(pickCharacteristics(fff0, [ch('11111111-0000-1000-8000-00805f9b34fb', 'notify')])).toBeNull();
    // a characteristic with the right UUID but without the ability does not count as known
    expect(pickCharacteristics(fff0, [ch(fff0.write[0]!), ch(fff0.notify[0]!)])).toBeNull();
  });

  it('recognises how adapters name themselves, including the ones that only work with their own app', () => {
    expect(classifyBleName('vLinker MC+')).toMatchObject({ vendor: 'vlinker', hint: 'stn-likely', elmCompatible: true });
    expect(classifyBleName('OBDLink CX')).toMatchObject({ vendor: 'obdlink', hint: 'stn-likely' });
    expect(classifyBleName('VEEPEAK')).toMatchObject({ vendor: 'veepeak' });
    expect(classifyBleName('OBDII')).toMatchObject({ vendor: 'generic', hint: 'elm' });
    expect(classifyBleName('Android-Vlink')).toMatchObject({ vendor: 'vlinker' });
    expect(classifyBleName('ThinkDiag-1234')).toMatchObject({ elmCompatible: false, hint: 'app-gated' });
    expect(classifyBleName('V011')).toMatchObject({ vendor: 'generic' });
    expect(classifyBleName('Some Speaker')).toBeUndefined();
    expect(classifyBleName('Portable Mobile Speaker')).toBeUndefined();
    expect(classifyBleName(undefined)).toBeUndefined();
  });

  it('knows the WiFi dongle addresses, the serial speeds, and the USB chips', () => {
    expect(WIFI_DEFAULTS[0]).toMatchObject({ host: '192.168.0.10', port: 35000 });
    expect(SERIAL_BAUDS[0]).toBe(38400);
    expect(describeUsbChip(0x1a86)).toBe('CH340');
    expect(describeUsbChip(0x10c4)).toBe('CP210x');
    expect(describeUsbChip(0x0403)).toBe('FTDI');
    expect(describeUsbChip(0x1234)).toBeUndefined();
  });
});

/* --------------------------------------------------------------- fake devices */

function fakeBle(opts: { name?: string; layouts: { service: string; chars: { uuid: string; props: GattCharInfo['properties'] }[] }[] }) {
  const written: Uint8Array[] = [];
  let valueCb: ((e: { target: unknown }) => void) | null = null;
  const chars = new Map<string, { uuid: string; properties: GattCharInfo['properties']; value: DataView | null }>();
  const services = opts.layouts.map((l) => ({
    uuid: l.service,
    async getCharacteristics() {
      return l.chars.map((c) => {
        const ch = {
          uuid: c.uuid, properties: c.props, value: null as DataView | null,
          async writeValueWithoutResponse(v: ArrayBufferView | ArrayBuffer) { written.push(new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer)); },
          async writeValueWithResponse(v: ArrayBufferView | ArrayBuffer) { written.push(new Uint8Array(v instanceof ArrayBuffer ? v : v.buffer)); },
          async startNotifications() { return ch; },
          async stopNotifications() { return ch; },
          addEventListener(_t: string, cb: (e: { target: unknown }) => void) { valueCb = cb; },
          removeEventListener() { valueCb = null; },
        };
        chars.set(c.uuid, ch);
        return ch;
      });
    },
  }));
  let requested: unknown;
  const device: BleDevice = {
    id: 'dev-1', name: opts.name,
    gatt: { connected: false, async connect() { return this; }, disconnect() {}, async getPrimaryServices() { return services; } },
    addEventListener() {}, removeEventListener() {},
  };
  return {
    bluetooth: { async requestDevice(o: unknown) { requested = o; return device; } },
    written,
    get requested() { return requested as { optionalServices: string[] }; },
    notify(uuid: string, bytes: number[]) {
      const ch = chars.get(uuid)!;
      ch.value = new DataView(new Uint8Array(bytes).buffer);
      valueCb?.({ target: ch });
    },
  };
}

const props = (p: Partial<GattCharInfo['properties']>): GattCharInfo['properties'] => ({ write: false, writeWithoutResponse: false, notify: false, indicate: false, ...p });

describe('WebBluetoothTransport with the merged catalog', () => {
  it('observes actual GATT submissions and notifications without exposing bytes or changing delivery', async () => {
    const uuid = '0000ffe9-0000-1000-8000-00805f9b34fb';
    const dev = fakeBle({ layouts: [{ service: '0000ffe5-0000-1000-8000-00805f9b34fb', chars: [
      { uuid, props: props({ writeWithoutResponse: true, notify: true }) },
    ] }] });
    const events: BleObservation[] = [];
    const t = new WebBluetoothTransport(dev.bluetooth, undefined, e => {
      events.push(e);
      if (e.kind === 'write-submit') throw new Error('recorder unavailable');
    });
    await t.open();
    const got: number[] = [];
    t.onData(bytes => got.push(...bytes));
    dev.notify(uuid, [0x4f, 0x4b, 0x3e]);
    await t.write(new Uint8Array([0x41, 0x54, 0x0d]));
    await t.close();
    expect(got).toEqual([0x4f, 0x4b, 0x3e]);
    expect(dev.written.map(bytes => [...bytes])).toEqual([[0x41, 0x54, 0x0d]]);
    expect(events.map(e => e.kind)).toEqual([
      'connect-start', 'connected', 'profile', 'notifications-ready', 'notification',
      'write-submit', 'write-resolved', 'disconnected',
    ]);
    expect(events.find(e => e.kind === 'write-resolved')?.details).toMatchObject({
      id: 1, bytes: 3, mode: 'without-response', durationMs: expect.any(Number),
    });
    expect(events.every((e, i) => i === 0 || e.monoMs >= events[i - 1]!.monoMs)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('dev-1');
  });

  it('declares every known service, then connects to an FFE5/FFE9 clone the old list did not know', async () => {
    const ffe9 = '0000ffe9-0000-1000-8000-00805f9b34fb';
    const dev = fakeBle({ name: 'V011', layouts: [{ service: '0000ffe5-0000-1000-8000-00805f9b34fb', chars: [{ uuid: ffe9, props: props({ write: true, notify: true }) }] }] });
    const t = new WebBluetoothTransport(dev.bluetooth);
    await t.open();
    expect(dev.requested.optionalServices).toEqual(BLE_SERVICES);
    expect(t.profile?.name).toMatch(/FFE5/);
    expect(t.profileVia).toBe('known');
    expect(t.nameInfo).toMatchObject({ vendor: 'generic' });
    const got: number[] = [];
    t.onData((c) => got.push(...c));
    dev.notify(ffe9, [0x4f, 0x4b, 0x3e]);
    expect(got).toEqual([0x4f, 0x4b, 0x3e]);
    await t.write(new Uint8Array([0x41, 0x54, 0x0d]));
    expect(dev.written).toHaveLength(1);
  });

  it('connects to an ISSC adapter and to an E781 adapter exposing the kit\'s pair', async () => {
    const issc = fakeBle({ layouts: [{ service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', chars: [
      { uuid: '49535343-1e4d-4bd9-ba61-23c647249616', props: props({ notify: true }) },
      { uuid: '49535343-8841-43f4-a8d4-ecbe34729bb3', props: props({ writeWithoutResponse: true }) },
    ] }] });
    const t1 = new WebBluetoothTransport(issc.bluetooth);
    await t1.open();
    expect(t1.profile?.name).toMatch(/ISSC/);
    const e781 = fakeBle({ layouts: [{ service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', chars: [
      { uuid: 'e7810a72-73ae-499d-8c15-faa9aef0c3f2', props: props({ write: true }) },
      { uuid: 'e7810a73-73ae-499d-8c15-faa9aef0c3f2', props: props({ notify: true }) },
    ] }] });
    const t2 = new WebBluetoothTransport(e781.bluetooth);
    await t2.open();
    expect(t2.profile?.name).toMatch(/E781/);
  });

  it('tells "Bluetooth is off" apart from a dismissed picker (both are NotFoundError in Chrome)', async () => {
    const failing = (message: string) => ({
      async requestDevice(): Promise<BleDevice> { throw Object.assign(new Error(message), { name: 'NotFoundError' }); },
    });
    await expect(new WebBluetoothTransport(failing('Bluetooth adapter not available.')).open()).rejects.toMatchObject({ code: 'not_found' });
    await expect(new WebBluetoothTransport(failing('User cancelled the requestDevice() chooser.')).open()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reopens on the granted device without the chooser, and an injected device never asks', async () => {
    const ffe9 = '0000ffe9-0000-1000-8000-00805f9b34fb';
    const dev = fakeBle({ layouts: [{ service: '0000ffe5-0000-1000-8000-00805f9b34fb', chars: [
      { uuid: ffe9, props: props({ write: true, notify: true }) },
    ] }] });
    let asks = 0;
    const counting = { async requestDevice(o: unknown) { asks++; return dev.bluetooth.requestDevice(o); } };
    const t = new WebBluetoothTransport(counting);
    await t.open();
    await t.close();
    expect(asks).toBe(1);
    // Reopen on the same transport: the device the chooser granted is reused — no picker.
    await t.open();
    expect(asks).toBe(1);
    expect(t.reusableDevice?.id).toBe('dev-1');
    // A fresh transport built for a relink takes the granted device directly.
    const mustNotAsk = { async requestDevice(): Promise<BleDevice> { throw new Error('chooser opened'); } };
    const relinked = new WebBluetoothTransport(mustNotAsk, undefined, undefined, t.reusableDevice);
    await relinked.open();
    expect(relinked.isOpen).toBe(true);
    await relinked.close();
  });

  it('disconnects GATT when setup fails after connecting', async () => {
    let disconnected = 0;
    const device: BleDevice = {
      id: 'dev-2', name: 'OBDBLE',
      gatt: { connected: false, async connect() { return this; }, disconnect() { disconnected++; }, async getPrimaryServices() { throw new Error('GATT operation failed'); } },
      addEventListener() {}, removeEventListener() {},
    };
    const t = new WebBluetoothTransport({ async requestDevice() { return device; } });
    await expect(t.open()).rejects.toMatchObject({ code: 'gatt' });
    expect(disconnected).toBe(1);
    expect(t.isOpen).toBe(false);
  });

  it('explains an app-only adapter instead of just failing', async () => {
    const dev = fakeBle({ name: 'ThinkDiag-77', layouts: [{ service: '0000abcd-0000-1000-8000-00805f9b34fb', chars: [] }] });
    const t = new WebBluetoothTransport(dev.bluetooth);
    await expect(t.open()).rejects.toThrow(/only works with its own app/);
    const plain = fakeBle({ name: 'Headphones', layouts: [] });
    await expect(new WebBluetoothTransport(plain.bluetooth).open()).rejects.toThrow('does not offer a known ELM327 serial service');
  });
});
