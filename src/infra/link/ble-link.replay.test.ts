/**
 * Deterministic replay of the Bluetooth link: the real engine, ELM session, ISO-TP framing,
 * safety policy and coding writer, running against the ELM327 emulator on a virtual clock.
 * Nothing here touches Bluetooth or a vehicle.
 */
import {
  type EcuModel,
  Elm327Emulator,
  kushaqLikeSpecs,
  OBDCraftEngine,
  runVirtual,
  StandardEcu,
  VirtualClock,
} from '@obdcraft/obd-core';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptedRig } from '../../../packages/obd-core/test/scripted.ts';
import type { DidWrite } from '../../domain/coding/types.ts';
import { writeCodingDid } from './ble-writer.ts';
import { WebBluetoothLink } from './web-bluetooth.ts';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PASSWORD = '31347';

/** The Kushaq BCM as the native sessions saw it: 0A5E behind 10 03 + seed/key, VAG coding markers. */
class Bcm implements EcuModel {
  readonly id = '778';
  readonly requestId = '70E';
  readonly pad = 0x55;
  readonly latencyMs = 15;
  block = [0x3a, 0, 0, 0, 0];
  session = 1;
  unlocked = false;
  seed = [0x12, 0x34, 0x56, 0x78];
  /** `null`: the DID is refused (NRC 31); `'silent'`: no answer at all. */
  f199: number[] | null | 'silent' = [0x24, 0x01, 0x15];
  f1a5: number[] | null | 'silent' = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  /** Emulator time at which the data write arrived. */
  mainAt: number | null = null;
  markerNrc: Record<number, number> = {};
  mainNrc: number | null = null;
  silentMain = false;
  /** Payload frames the module never sees at all (CAN-level loss; live-observed disease). */
  dropMain = 0;
  /** Correct key replies that never reach the requester. */
  silentKey = 0;
  /** The 0A5E read itself goes unanswered. */
  silentRead5e = false;
  readonly requests: string[] = [];
  readonly markerWrites: Record<string, string> = {};
  handle(req: number[], t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    this.requests.push(req.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''));
    const [svc, a = 0, b = 0] = req;
    const did = a * 256 + b;
    if (svc === 0x3e) return [0x7e, 0x00];
    if (svc === 0x10 && (a === 1 || a === 3)) {
      this.session = a;
      if (a === 1) this.unlocked = false;
      return [0x50, a, 0x00, 0x32, 0x01, 0xf4];
    }
    if (svc === 0x22) {
      if (did === 0xf187) return [0x62, a, b, ...ascii('2Q0937089D')];
      if (did === 0x0a5e) return this.silentRead5e ? null : [0x62, a, b, ...this.block];
      for (const [id, value] of [
        [0xf199, this.f199],
        [0xf1a5, this.f1a5],
      ] as const) {
        if (did !== id) continue;
        if (value === 'silent') return null;
        return value ? [0x62, a, b, ...value] : [0x7f, 0x22, 0x31];
      }
      return [0x7f, 0x22, 0x31];
    }
    if (svc === 0x27) {
      if (this.session !== 3) return [0x7f, 0x27, 0x7f];
      if (a === 0x03) return [0x67, 0x03, ...this.seed];
      const seed = this.seed.reduce((v, x) => (v * 256 + x) >>> 0, 0);
      const key = req.slice(2).reduce((v, x) => (v * 256 + x) >>> 0, 0);
      if (key !== (seed + Number(PASSWORD)) >>> 0) return [0x7f, 0x27, 0x35];
      if (this.silentKey > 0) {
        this.silentKey -= 1;
        return null; // a correct key whose reply never arrives — the module stays locked
      }
      this.unlocked = true;
      return [0x67, 0x04];
    }
    if (svc === 0x2e) {
      if (this.session !== 3) return [0x7f, 0x2e, 0x7f];
      if (did === 0xf199 || did === 0xf198) {
        const nrc = this.markerNrc[did];
        if (nrc) return [0x7f, 0x2e, nrc];
        this.markerWrites[did.toString(16).toUpperCase()] = req
          .slice(3)
          .map((x) => x.toString(16).toUpperCase().padStart(2, '0'))
          .join('');
        return [0x6e, a, b];
      }
      if (did === 0x0a5e) {
        this.mainAt = t;
        if (!this.unlocked) return [0x7f, 0x2e, 0x33];
        if (this.mainNrc) return [0x7f, 0x2e, this.mainNrc];
        if (this.dropMain > 0) {
          this.dropMain -= 1;
          return null; // the frame was sent but the module never received/stored it
        }
        this.block = req.slice(3);
        return this.silentMain ? null : [0x6e, a, b];
      }
    }
    return [0x7f, svc ?? 0, 0x11];
  }
}

class Gateway implements EcuModel {
  readonly id = '77A';
  readonly requestId = '710';
  readonly pad = 0x55;
  readonly latencyMs = 10;
  handle(req: number[], _t: number, physical: boolean) {
    return physical && req[0] === 0x10 ? [0x50, req[1] ?? 0, 0, 0x32, 0x01, 0xf4] : null;
  }
}

class Cluster implements EcuModel {
  readonly id = '77E';
  readonly requestId = '714';
  readonly pad = 0x55;
  latencyMs = 10;
  handle(req: number[], _t: number, physical: boolean) {
    if (!physical || req[0] !== 0x22) return null;
    return req[1] === 0xf1 && req[2] === 0x90
      ? [0x62, 0xf1, 0x90, ...ascii('MEXTEST0000000001')]
      : [0x7f, 0x22, 0x31];
  }
}

async function rig(
  opts: {
    running?: boolean;
    voltage?: number;
    writeLatencyMs?: number;
    clusterLatencyMs?: number;
    /** No engine ECUs answer (the OBD-II search finds nothing). */
    engineSilent?: boolean;
    /** Nothing on the car acknowledges a frame (bus asleep). */
    asleep?: () => boolean;
    /** Responders the adapter displays as "00 00 07 78". */
    wideHeaders?: string[];
  } = {},
) {
  const clock = new VirtualClock();
  const bcm = new Bcm();
  const engineEcus = kushaqLikeSpecs().map(
    (spec) =>
      new StandardEcu(
        opts.running ? spec : { ...spec, pids: { ...spec.pids, 12: () => [0, 0], 13: () => [0] } },
      ),
  );
  const emulator = new Elm327Emulator({
    clock,
    ecus: [
      ...(opts.engineSilent ? [] : engineEcus),
      bcm,
      new Gateway(),
      Object.assign(new Cluster(), { latencyMs: opts.clusterLatencyMs ?? 10 }),
    ],
    protocol: 6,
    voltage: () => opts.voltage ?? 12.7,
    id: 'replay',
    ...(opts.writeLatencyMs === undefined ? {} : { writeLatencyMs: opts.writeLatencyMs }),
    ...(opts.asleep ? { asleep: opts.asleep } : {}),
    ...(opts.wideHeaders ? { wideHeaders: opts.wideHeaders } : {}),
  });
  // As in production (WebBluetoothLink.open): the native coding tool's startup.
  const engine = new OBDCraftEngine({ clock, startup: 'diagnostic-can' });
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  await run(engine.connect(emulator));
  const link = WebBluetoothLink.adopt(engine);
  const sent = () => emulator.log.map((l) => l.cmd.replace(/\s+/g, '').toUpperCase());
  return { clock, bcm, emulator, engine, link, run, sent };
}

const BCM = { request: '70E', response: '778' };
const write = (
  r: Awaited<ReturnType<typeof rig>>,
  bytes = '3E00000000',
  password: string | null = PASSWORD,
  original = '3A00000000',
) => {
  const pending: number[] = [];
  return r.run(
    r.link.writeDid(BCM, '0A5E', bytes, {
      securityPassword: password,
      originalBytes: original,
      onPending: () => pending.push(1),
      today: () => new Date(2026, 9, 24),
    } as Parameters<WebBluetoothLink['writeDid']>[3]),
  );
};

afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

describe('Bluetooth link — reads and identity', () => {
  it('ends a read group on an unbound reply instead of sending the next read into an uncertain stream', async () => {
    const r = await rig();
    const handle = r.bcm.handle.bind(r.bcm);
    r.bcm.handle = (req, time, physical) =>
      req[0] === 0x22 && req[1] === 0xf1 && req[2] === 0x87
        ? [0x62, 0xf1, 0x99, 0x26, 0x10, 0x23]
        : handle(req, time, physical);
    await r.run(
      r.link.withReads(BCM, async (reader) => {
        expect(await reader.readDid(BCM, 'F187')).toEqual({ kind: 'link-lost' });
        expect(await reader.readDid(BCM, '0A5E')).toEqual({ kind: 'link-lost' });
      }),
    );
    expect(r.link.isClosed).toBe(true);
    expect(r.sent()).not.toContain('03220A5E');
  });

  it('does not return a successful group when its final adapter restoration fails', async () => {
    const r = await rig();
    const write = r.emulator.write.bind(r.emulator);
    r.emulator.write = async (data) => {
      if (new TextDecoder().decode(data).trim() === 'ATCAF1') throw new Error('adapter failed');
      return write(data);
    };
    await expect(r.run(r.link.withReads(BCM, (reader) => reader.readDid(BCM, 'F187')))).rejects.toThrow(
      /configuration could not be restored/,
    );
    expect(r.link.isClosed).toBe(true);
  });

  it('keeps VIN fallback and the following BCM part read in one configuration, with native rebinds', async () => {
    const r = await rig();
    const from = r.sent().length;
    const result = await r.run(
      r.link.withReads(BCM, async (reader) => ({
        vin: await reader.identify(BCM),
        part: await reader.readDid(BCM, 'F187'),
      })),
    );
    expect(result.vin).toMatchObject({ kind: 'ok' });
    expect(result.part).toEqual({ kind: 'ok', bytes: '32513039333730383944' });
    const sent = r.sent().slice(from);
    expect(sent.filter((c) => c === 'ATCAF0')).toHaveLength(1);
    expect(sent.filter((c) => c === 'ATCAF1')).toHaveLength(1);
    const firstVin = sent.indexOf('0322F190');
    const part = sent.indexOf('0322F187');
    expect(sent.slice(firstVin, part + 1)).toEqual([
      '0322F190',
      'ATSH714',
      'ATCRA77E',
      'ATFCSH714',
      'ATSP0',
      '0322F190',
      'ATSH70E',
      'ATCRA778',
      'ATFCSH70E',
      'ATSP0',
      '0322F187',
    ]);
  });

  it('re-binds before every DID read — the clone only waits out slow replies while searching — then restores once', async () => {
    const r = await rig();
    const from = r.sent().length;
    const results = await r.run(
      r.link.withReads(BCM, async (reader) => {
        const values = [];
        for (const did of ['F187', '0A5E', 'F199', 'F1A5']) values.push(await reader.readDid(BCM, did));
        return values;
      }),
    );
    expect(results.every((v) => v.kind === 'ok')).toBe(true);
    const sent = r.sent().slice(from);
    expect(sent.filter((c) => c === 'ATCAF0')).toHaveLength(1);
    expect(sent.filter((c) => c === 'ATCAF1')).toHaveLength(1);
    // No ATST after the search: the clone ignores it, and the search survives later AT commands anyway (BRIEF U1).
    // The first read uses the channel setup's own ATSP0 (BRIEF R8); every later one re-binds.
    const rebind = ['ATSH70E', 'ATCRA778', 'ATFCSH70E', 'ATSP0'];
    const setup = sent.slice(0, sent.indexOf('0322F187'));
    expect(setup.slice(setup.lastIndexOf('ATFCSH70E') + 1, setup.lastIndexOf('ATFCSH70E') + 2)).toEqual([
      'ATSP0',
    ]);
    expect(sent.slice(sent.indexOf('0322F187'), sent.indexOf('0322F1A5') + 1)).toEqual([
      '0322F187',
      ...rebind,
      '03220A5E',
      ...rebind,
      '0322F199',
      ...rebind,
      '0322F1A5',
    ]);
    expect(r.link.isClosed).toBe(false);
  });

  it('a sweep skips a DID whose response-pending never resolves, and keeps the link (live: every BCM sweep died at 0560)', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    r.bcm.handle = (req, t, physical) =>
      req[0] === 0x22 && req[1] === 0x05 && req[2] === 0x60 ? [0x7f, 0x22, 0x78] : inner(req, t, physical);
    const results = await r.run(
      r.link.withReads(BCM, async (reader) => [
        await reader.readDid(BCM, '0560'),
        await reader.readDid(BCM, 'F187'),
      ]),
    );
    expect(results[0]?.kind).toBe('no-reply');
    expect(results[1]).toEqual({ kind: 'ok', bytes: '32513039333730383944' });
    expect(r.link.isClosed).toBe(false);
  });

  it('one silent read of a fitted module does not mark it unreachable for the rest of the group', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let silent = 1;
    r.bcm.handle = (req, t, physical) =>
      physical && req[0] === 0x22 && silent-- > 0 ? null : inner(req, t, physical);
    const results = await r.run(
      r.link.withReads(BCM, async (reader) => [
        await reader.readDid(BCM, 'F189'),
        await reader.readDid(BCM, 'F187'),
      ]),
    );
    // The lost search (UNABLE TO CONNECT) is asked again at once and the module's own answer comes back (live
    // W13#4: an unretried UNABLE on the pre-write read ended a tap "didn't answer").
    expect(results[0]).toEqual({ kind: 'nrc', code: '31' });
    expect(results[1]).toEqual({ kind: 'ok', bytes: '32513039333730383944' });
  });

  it('a module that is not fitted (UNABLE TO CONNECT) costs three searches per sweep, not one per DID', async () => {
    const r = await rig();
    const absent = { request: '74A', response: '7B4' };
    const searchesBefore = r.emulator.log.filter((l) => l.reply.includes('UNABLE TO CONNECT')).length;
    const results = await r.run(
      r.link.withReads(absent, async (reader) => {
        const out = [];
        for (const did of ['F187', 'F189', '0600', '0601']) out.push(await reader.readDid(absent, did));
        out.push(await reader.readDid(BCM, 'F187'));
        return out;
      }),
    );
    expect(results.slice(0, 4).every((x) => x.kind === 'no-reply' && x.adapter === 'UNABLE TO CONNECT')).toBe(
      true,
    );
    expect(results[4]).toEqual({ kind: 'ok', bytes: '32513039333730383944' });
    // With ATSP0 on every read a silent fitted module also answers UNABLE TO CONNECT now and then (~1.5 % of
    // searches, ~9 % again right after one): only a third in a row, with no read of it ever answered, marks it
    // absent for the rest of the group.
    expect(r.emulator.log.filter((l) => l.reply.includes('UNABLE TO CONNECT')).length - searchesBefore).toBe(
      3,
    );
    expect(r.link.isClosed).toBe(false);
  });

  it('reads the VIN from the cluster and the part number from the BCM', async () => {
    const r = await rig();
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
    const part = await r.run(r.link.readDid(BCM, 'F187'));
    expect(part).toEqual({ kind: 'ok', bytes: '3251303933373038394' + '4' });
    expect(await r.run(r.link.readDid(BCM, '0A5E'))).toEqual({ kind: 'ok', bytes: '3A00000000' });
  });
});

describe('writer parity with the two original 23 October captures', () => {
  // Seeds, keys, marker values and before/after values come from the original captures/journals.
  // A final ACK at 12 s is synthetic: the historical logs themselves lost that ACK — and the live clone
  // never forwards a frame after its prompt, so the writer no longer listens for it: it reads the DID.
  for (const fixture of [
    {
      name: 'BCM comfort indicators',
      request: '70E',
      response: '778',
      did: '0A5E',
      after: '3E00000000',
      password: '31347',
      seed: '1B1FDDE2',
      key: '1B205855',
      probe: '00 00 00 00 00 00',
      marker: ['10092EF1980181C8', '21F63039AAAAAAAA'],
      main: ['10082E0A5E3E0000', '210000AAAAAAAAAA'],
      proof: '778 10 08 62 0A 5E 3E 00 00\r778 21 00 00 AA AA AA AA AA',
    },
    {
      name: 'cluster speed-warning setting',
      request: '714',
      response: '77E',
      did: '0E46',
      after: '00',
      password: '47115',
      seed: '0C251DFF',
      key: '0C25D60A',
      probe: '00 06 45 10 03 19',
      marker: ['10092EF198000645', '21100319AAAAAAAA'],
      main: ['042E0E4600'],
      proof: '77E 04 62 0E 46 00 AA AA AA',
    },
  ]) {
    it(`${fixture.name}: sends the captured ritual and exact payload once, then proves it by reading the DID`, async () => {
      const id = fixture.response;
      let frame: 'marker' | 'main' | undefined;
      const r = scriptedRig((cmd, state) => {
        if (cmd === '021003' && state.header === '710') return 'NO DATA'; // optional gateway reply
        if (cmd === '021003') return `${id} 06 50 03 00 32 01 F4 AA`;
        if (cmd === '0322F199') return `${id} 03 7F 22 31 AA AA AA AA`;
        if (cmd === '023E00') return `${id} 02 7E 00 AA AA AA AA AA`;
        if (cmd === '0322F1A5') {
          const bytes = fixture.probe.split(' ');
          return `${id} 10 09 62 F1 A5 ${bytes.slice(0, 3).join(' ')}\r${id} 21 ${bytes.slice(3).join(' ')} AA AA AA AA`;
        }
        if (cmd === '022703') return `${id} 06 67 03 ${(fixture.seed.match(/../g) ?? []).join(' ')} AA`;
        if (cmd === `062704${fixture.key}`) return `${id} 02 67 04 AA AA AA AA AA`;
        if (cmd === '062EF199261023') return `${id} 03 6E F1 99 AA AA AA AA`;
        if (cmd === fixture.marker[0]) {
          frame = 'marker';
          return `${id} 30 0F 05 AA AA AA AA AA`;
        }
        if (cmd === fixture.marker[1] && frame === 'marker') {
          frame = undefined;
          return `${id} 03 6E F1 98 AA AA AA AA`;
        }
        if (fixture.main.length > 1 && cmd === fixture.main[0]) {
          frame = 'main';
          return `${id} 30 0F 05 AA AA AA AA AA`;
        }
        if (cmd === fixture.main.at(-1) && (fixture.main.length === 1 || frame === 'main')) {
          frame = undefined;
          r.elm.emitLater(`${id} 03 6E ${(fixture.did.match(/../g) ?? []).join(' ')} AA AA AA AA`, 12_000);
          return `${id} 03 7F 2E 78 AA AA AA AA`;
        }
        if (cmd === `0322${fixture.did}`) return fixture.proof;
        if (cmd === '021001') return `${id} 06 50 01 00 32 01 F4 AA`;
        if (cmd.startsWith('AT')) return cmd === 'ATMA' ? '?' : 'OK';
        throw new Error(`Unexpected diagnostic command ${cmd}`);
      });
      r.link.nativeBind = true;
      let pending = 0;
      const result = await r.run(
        writeCodingDid(
          r.link,
          { request: fixture.request, response: fixture.response },
          fixture.did,
          fixture.after,
          {
            securityPassword: fixture.password,
            today: () => new Date(2026, 9, 23, 12),
            onPending: () => pending++,
          },
        ),
      );
      // 78, then the module's own memory shows the intended bytes: landed, final answer unheard.
      expect(result).toMatchObject({
        kind: 'pending-no-final',
        markers: [
          { did: 'F199', outcome: 'acked' },
          { did: 'F198', outcome: 'acked' },
        ],
      });
      expect(pending).toBe(1);
      expect(r.elm.sentTo('710')).toEqual(['021003']);
      expect(r.elm.sentTo(fixture.request)).toEqual([
        '021003',
        '0322F199',
        '0322F1A5',
        '022703',
        `062704${fixture.key}`,
        '062EF199261023',
        ...fixture.marker,
        ...fixture.main,
        `0322${fixture.did}`,
        '021001',
      ]);
      expect(r.elm.log.map((e) => e.cmd)).not.toContain('ATMA');
      // Bounded: no 30 s listen after the 78 — the proof read ran ~2 s later, inside S3.
      expect(r.clock.now()).toBeLessThan(12_000);
    });
  }
});

describe('Bluetooth link — a slow cluster (live 2026-10-25: "VIN not found")', () => {
  it('reads the VIN from a cluster that takes 260 ms to answer', async () => {
    // At the former read timing (ATAT0/ATST32: 200 ms) the adapter answered NO DATA before the reply came.
    const r = await rig({ clusterLatencyMs: 260 });
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
  });
});

describe('Bluetooth link — engine silent at connect (live 2026-10-25: "doesn\'t stay connected")', () => {
  it('starts like the native tool — automatic protocol, no OBD-II request — and still reads the car', async () => {
    const r = await rig({ engineSilent: true });
    expect(r.sent().at(-1)).toBe('ATSP0');
    expect(r.sent()).not.toContain('ATSP6');
    expect(r.sent()).not.toContain('0100');
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
    expect(await r.run(r.link.readDid(BCM, '0A5E'))).toEqual({ kind: 'ok', bytes: '3A00000000' });
  });

  it('still cannot claim the car is ready to code: the engine speed is unknown, so a write is refused', async () => {
    const r = await rig({ engineSilent: true });
    const ready = await r.run(r.link.readiness());
    expect(ready).toMatchObject({ kind: 'ok', rpm: null });
  });

  it('without the option the engine refuses a silent car, as before', async () => {
    const clock = new VirtualClock();
    const emulator = new Elm327Emulator({
      clock,
      ecus: [new Bcm(), new Cluster()],
      protocol: 6,
      voltage: () => 12.7,
      id: 'silent',
    });
    const engine = new OBDCraftEngine({ clock });
    await expect(runVirtual(clock, engine.connect(emulator))).rejects.toThrow(/does not answer|protocol/);
  });
});

describe("Bluetooth link — the native Mac tool's connection, replicated (live 2026-10-25)", () => {
  /** What reached the car: hex requests only (not AT/ST adapter commands). */
  const bus = (r: Awaited<ReturnType<typeof rig>>) =>
    r.emulator.log.filter((l) => /^[0-9A-F]+$/i.test(l.cmd.trim()));

  it("the first frame on the car is the BCM's VIN request, unpadded, and it runs the protocol search", async () => {
    const r = await rig({ engineSilent: true });
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
    // ble-write-coding readVinEvidence: the bound module (BCM: NRC 31 here), then the cluster.
    expect(bus(r).map((l) => l.cmd)).toEqual(['0322F190', '0322F190']);
    expect(bus(r)[0]?.reply).toMatch(/^SEARCHING\.\.\.\s+778 03 7F 22 31/);
    // The switch to the cluster re-runs the search: ATSP0 after the addresses, as the native rebind.
    const sent = r.sent();
    const cluster = sent.indexOf('ATFCSH714');
    expect(sent[cluster + 1]).toBe('ATSP0');
    expect(bus(r)[1]?.reply).toMatch(/^SEARCHING\.\.\.\s+77E 10 14 62 F1 90/);
  });

  it('module setup is the native one, except block size 4 flow control (the clone forwards 4 CFs per command), no ATR0', async () => {
    const r = await rig();
    await r.run(r.link.readDid(BCM, 'F187'));
    const sent = r.sent();
    const setup = sent.slice(sent.lastIndexOf('ATCAF0') - 1, sent.indexOf('0322F187'));
    // ATH1/ATS1 always open the setup, though the link already holds them: an adapter that reset without the link
    // closing is back at its defaults, and every frame parse needs them.
    expect(sent.slice(sent.lastIndexOf('ATCAF0') - 3, sent.lastIndexOf('ATCAF0') - 1)).toEqual([
      'ATH1',
      'ATS1',
    ]);
    expect(setup).toEqual([
      'ATD0',
      'ATCAF0',
      // Allow 8-byte sends: without it the clone drops the last byte of every full ISO-TP frame (live 2026-11-02).
      'ATAL',
      'ATCFC1',
      'ATSH70E',
      'ATCRA778',
      'ATFCSH70E',
      // Always a search after the addresses, even for the module the adapter last searched for: after the
      // setup a locked first request was dropped 94 % of the time live (BRIEF R8). The later setup commands
      // keep it pending (21/21), so the read itself needs no re-bind.
      'ATSP0',
      'ATFCSD300405',
      'ATFCSM1',
      'ATAT0',
      'ATSTFF',
      'ATR1',
    ]);
  });

  it('re-searches before every module read, including back-to-back reads on one module', async () => {
    const r = await rig();
    await r.run(r.link.identify()); // BCM, then the cluster
    const from = r.sent().length;
    await r.run(r.link.readDid(BCM, 'F187'));
    await r.run(r.link.readDid(BCM, '0A5E')); // same module: still a re-search — see 2026-10-28 logs
    const after = r.sent().slice(from);
    // Live 2026-10-28: reads without a re-search got NO DATA at ~250 ms (ATST is ignored on this
    // clone) while the BCM needed ~270-430 ms — the search window is the only thing that lets
    // slow replies land, so every read re-binds.
    expect(after.indexOf('ATSP0')).toBeLessThan(after.indexOf('0322F187'));
    expect(after.indexOf('ATSP0', after.indexOf('0322F187'))).toBeLessThan(after.indexOf('03220A5E'));
    expect(after.indexOf('ATSP0', after.indexOf('03220A5E'))).toBe(-1);
  });

  it('reads a BCM the adapter displays as "00 00 07 78" after its search', async () => {
    const r = await rig({ wideHeaders: ['778'] });
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
    expect(await r.run(r.link.readDid(BCM, 'F187'))).toEqual({ kind: 'ok', bytes: '32513039333730383944' });
    expect(bus(r).some((l) => l.reply.includes('00 00 07 78'))).toBe(true);
  });

  it('a car whose bus is asleep: UNABLE TO CONNECT is reported as such, the adapter stays connected, and the same connection reads the car once it wakes', async () => {
    let asleep = true;
    const r = await rig({ asleep: () => asleep });
    const t0 = r.clock.now();
    expect(await r.run(r.link.identify())).toEqual({
      kind: 'no-vin',
      why: 'bus-silent',
      adapter: 'UNABLE TO CONNECT',
    });
    // The whole ~4.2 s search was waited out for each module (never cut short and turned into a timeout).
    expect(r.clock.now() - t0).toBeGreaterThan(2 * 4200);
    expect(r.link.isClosed).toBe(false);
    expect(r.emulator.isOpen).toBe(true);
    asleep = false;
    expect(await r.run(r.link.identify())).toEqual({ kind: 'ok', vin: 'MEXTEST0000000001' });
  });
});

describe('Bluetooth link — readiness evidence', () => {
  it('reports engine off, stationary and the supply voltage', async () => {
    const r = await rig({ voltage: 12.7 });
    expect(await r.run(r.link.readiness())).toMatchObject({ kind: 'ok', rpm: 0, speedKmh: 0, voltage: 12.7 });
  });

  it('reports a running, moving car as such (the domain then refuses)', async () => {
    const r = await rig({ running: true });
    const ready = await r.run(r.link.readiness());
    expect(ready.kind === 'ok' && (ready.rpm ?? 0) > 0 && (ready.speedKmh ?? 0) > 0).toBe(true);
  });
});

describe('Bluetooth link — the coding sequence (ported native order)', () => {
  it('runs gateway → session → probes → seed/key → markers → one 2E → 10 01, in that order', async () => {
    const r = await rig();
    expect(await write(r)).toEqual({
      kind: 'acked',
      markers: [
        { did: 'F199', outcome: 'acked' },
        { did: 'F198', outcome: 'acked' },
      ],
      txFrames: expect.any(Array),
      rxFrames: expect.any(Array),
    });
    // No tester-present between the probes and no re-open before the seed: each answered probe proves the
    // session, which is re-opened only when it could lapse before the key lands (BRIEF B10).
    expect(r.bcm.requests).toEqual([
      '1003',
      '22F199',
      '22F1A5',
      '2703',
      `2704${((0x12345678 + 31347) >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
      '2EF199261024',
      '2EF198AABBCCDDEEFF',
      '2E0A5E3E00000000',
      // No re-send and no proof read after an ACK: the domain reads back.
      // Back to the default session deterministically (native `02 10 01`), not left to S3.
      '1001',
    ]);
    expect(r.bcm.block).toEqual([0x3e, 0, 0, 0, 0]);
    // F199 is today's date in BCD (YY MM DD); F198 echoes F1A5's six raw bytes.
    expect(r.bcm.markerWrites).toEqual({ F199: '261024', F198: 'AABBCCDDEEFF' });
    // T-1: the journaled frames are the frames handed to the adapter, addressed — the 8-byte data write
    // segments into FF 1008 2E0A5E3E00 + CF 21 0000, sent once to the BCM (70E); the gateway step went to 710.
    const w = await write(r);
    expect(w.txFrames?.filter((f) => f.data.startsWith('10082E0A5E'))).toEqual([
      { can: '70E', data: '10082E0A5E3E0000', stage: 'submitted' },
    ]);
    expect(w.txFrames?.filter((f) => f.data.startsWith('210000'))).toHaveLength(1);
    expect(w.txFrames?.at(-2)).toMatchObject({ can: '70E', data: '210000AAAAAAAAAA' });
    expect(w.txFrames?.at(-1)).toMatchObject({ can: '70E', data: '021001' });
    expect(w.txFrames?.[0]).toMatchObject({ can: '710', data: '021003' });
  });

  it('sends the data write exactly once', async () => {
    const r = await rig();
    await write(r);
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
  });

  it('rides out a silent session open — asks again at once, and still completes the change', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let opens = 0,
      dropped = 0;
    r.bcm.handle = (req, t, physical) => {
      // Live 2026-10-28: the BCM's 10 03 went unanswered at ~277 ms.
      if (physical && req[0] === 0x10 && req[1] === 0x03 && ++opens === 1) {
        dropped += 1;
        return null;
      }
      return inner(req, t, physical);
    };
    expect(await write(r)).toMatchObject({ kind: 'acked' });
    expect(dropped).toBe(1); // the open was attempted, lost, and asked again
    // The retry follows the lost search's prompt at once, with no re-bind: a search right after a silent one
    // was lost 36 % of the time live, an immediate send ~20 % (BRIEF R2).
    const sent = r.sent();
    const first = sent.indexOf('021003', sent.indexOf('ATFCSH70E'));
    expect(sent[first + 1]).toBe('021003');
    expect(r.bcm.block).toEqual([0x3e, 0, 0, 0, 0]);
  });

  it('a step silent through its whole ladder stops before the change — four sends, never hammered', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let opens = 0;
    r.bcm.handle = (req, t, physical) => {
      // The module's session open never answers.
      if (physical && req[0] === 0x10 && req[1] === 0x03 && ++opens >= 1) return null;
      return inner(req, t, physical);
    };
    expect(await write(r)).toMatchObject({ kind: 'not-sent' });
    expect(opens).toBe(4); // one ladder: four sends (BRIEF R2)
    expect(r.bcm.requests.some((q) => q.startsWith('2E0A5E'))).toBe(false);
  });

  it('uses the vendor F198 fallback when F1A5 is all zero', async () => {
    const r = await rig();
    r.bcm.f1a5 = [0, 0, 0, 0, 0, 0];
    expect(await write(r)).toEqual({
      kind: 'acked',
      markers: [
        { did: 'F199', outcome: 'acked' },
        { did: 'F198', outcome: 'acked' },
      ],
      txFrames: expect.any(Array),
      rxFrames: expect.any(Array),
    });
    expect(r.bcm.markerWrites).toMatchObject({ F198: '0181C8F63039' });
  });

  it('writes F199 when its read is refused — modules refuse the READ yet accept the write (native rule)', async () => {
    const r = await rig();
    r.bcm.f199 = null;
    expect(await write(r)).toEqual({
      kind: 'acked',
      markers: [
        { did: 'F199', outcome: 'acked' },
        { did: 'F198', outcome: 'acked' },
      ],
      txFrames: expect.any(Array),
      rxFrames: expect.any(Array),
    });
    expect(r.bcm.markerWrites).toMatchObject({ F199: '261024' });
  });

  it('skips F199 when its probe got no answer, and F198 when F1A5 is refused or empty', async () => {
    for (const f1a5 of [null, [] as number[]]) {
      const r = await rig();
      r.bcm.f199 = 'silent';
      r.bcm.f1a5 = f1a5;
      expect(await write(r)).toEqual({
        kind: 'acked',
        txFrames: expect.any(Array),
        rxFrames: expect.any(Array),
      });
      expect(r.bcm.markerWrites).toEqual({});
    }
  });

  it('markers never block the payload: NRC 31 is "not hosted", any other refusal is recorded and the change still goes', async () => {
    const advisory = await rig();
    advisory.bcm.markerNrc = { 61849: 0x31 };
    expect(await write(advisory)).toEqual({
      kind: 'acked',
      markers: [
        { did: 'F199', outcome: 'not-hosted' },
        { did: 'F198', outcome: 'acked' },
      ],
      txFrames: expect.any(Array),
      rxFrames: expect.any(Array),
    });

    const hard = await rig();
    hard.bcm.markerNrc = { 61848: 0x13 };
    const result = await write(hard);
    // F199 was stored, F198 was refused — both recorded — and the payload still landed.
    expect(result).toMatchObject({
      kind: 'acked',
      markers: [
        { did: 'F199', outcome: 'acked' },
        { did: 'F198', outcome: 'refused' },
      ],
    });
    // A refusal is an answer: never re-sent.
    expect(hard.bcm.requests.filter((q) => q.startsWith('2EF198'))).toHaveLength(1);
    expect(hard.bcm.block).toEqual([0x3e, 0, 0, 0, 0]);
  });

  it('a refused security key stops the sequence before any write', async () => {
    const r = await rig();
    const result = await write(r, '3E00000000', '11111');
    expect(result).toMatchObject({ kind: 'not-sent' });
    expect(r.bcm.requests.some((q) => q.startsWith('2E'))).toBe(false);
  });

  it('maps a negative answer to the data write itself to its code', async () => {
    const r = await rig();
    r.bcm.mainNrc = 0x22;
    expect(await write(r)).toMatchObject({ kind: 'nrc', code: '22' });
  });

  it('a silent data write that DID land is "pending-no-final" — proof read confirms, never re-sent', async () => {
    // Live 2026-10-28 try 3's sibling: the reply was lost but the module stored the value.
    const r = await rig();
    r.bcm.silentMain = true;
    const start = r.clock.now();
    const result = await write(r);
    expect(['no-reply', 'pending-no-final']).toContain(result.kind);
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
    expect(result.kind).toBe('pending-no-final');
    // No passive listen (the live clone never forwards a frame after its prompt): a bounded wait, a
    // re-bind and the proof read, all inside S3 — not the old 30 s dead window.
    expect(r.bcm.requests.slice(r.bcm.requests.indexOf('2E0A5E3E00000000') + 1)).toEqual(['220A5E', '1001']);
    // The whole write (setup, emulator protocol searches on every re-bind, proof, restore) is shorter
    // than the old payload wait alone.
    expect(r.clock.now() - start).toBeLessThan(30_000);
  });

  it('a payload that never landed is re-sent once — proof read showed the pre-write bytes', async () => {
    // Live 2026-10-28 try 2: FC arrived, the CF went out, silence — and the old value survived.
    const r = await rig();
    r.bcm.dropMain = 1;
    const result = await write(r);
    expect(result).toMatchObject({ kind: 'acked' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(2);
    // The proof read ran in-session between the sends, and the value did land eventually.
    expect(r.bcm.block).toEqual([0x3e, 0, 0, 0, 0]);
  });

  it('a silent write with a silent proof read is never re-sent — non-delivery cannot be proven', async () => {
    const r = await rig();
    r.bcm.dropMain = 1;
    r.bcm.silentRead5e = true;
    const result = await write(r);
    expect(result).toMatchObject({ kind: 'no-reply' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
  });

  it('a silent write whose proof read shows unexpected bytes is never re-sent', async () => {
    const r = await rig();
    r.bcm.dropMain = 1;
    r.bcm.block = [0xff, 0xff, 0xff, 0xff, 0xff]; // neither the original nor the intended value
    const result = await write(r);
    expect(result).toMatchObject({ kind: 'no-reply' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
  });

  it('a multi-frame payload that stays silent while its memory shows the old bytes is re-sent up to the permit', async () => {
    // A lost CF makes the module discard the transfer: old bytes past the silent window prove it never completed
    // reception, so each re-send is safe. (A single frame keeps two complete sends: B7 0574.)
    const r = await rig();
    r.bcm.dropMain = 4;
    expect(await write(r)).toMatchObject({ kind: 'no-reply' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(4);
    // The re-send follows proof reads of the pre-write bytes, in the same session while it is still fresh: the grant
    // holds, so no re-arm (BRIEF R5/B8). The reads run until one left after the silent send's commit window, so a
    // write whose 78 was lost could not be delivered twice.
    const sends = r.bcm.requests.flatMap((q, i) => (q.startsWith('2E0A5E') ? [i] : []));
    const between = r.bcm.requests.slice((sends[0] ?? 0) + 1, sends[1]);
    expect(between.length).toBeGreaterThan(1);
    expect(between.every((q) => q === '220A5E')).toBe(true);
  });

  it('a silent key: the seed is asked again at once in the same session, and an unchanged challenge gets its key again', async () => {
    // Live 2026-10-28 try 1: the correct key went out, its reply never came back.
    const r = await rig();
    r.bcm.silentKey = 1;
    const result = await write(r);
    expect(result).toMatchObject({ kind: 'acked' });
    // Two handshakes in one session: no 10 03 re-open while it is fresh (BRIEF R4).
    expect(r.bcm.requests.filter((q) => q === '2703')).toHaveLength(2);
    const keys = r.bcm.requests.filter((q) => q.startsWith('2704'));
    expect(keys).toHaveLength(2);
    // The module kept its challenge: that key was never consumed, so the same key is its first delivery.
    expect(keys[1]).toBe(keys[0]);
    expect(r.bcm.requests.filter((q) => q === '1003')).toHaveLength(1);
  });

  it('a key that stays silent stops before any write — the handshake budget is exhausted', async () => {
    const r = await rig();
    r.bcm.silentKey = Number.POSITIVE_INFINITY;
    const result = await write(r);
    expect(result).toMatchObject({ kind: 'not-sent' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2704'))).toHaveLength(4);
    expect(r.bcm.requests.some((q) => q.startsWith('2E0A5E'))).toBe(false);
  });

  it('a payload refused for the session (7F) is retried once in a re-armed session, then lands', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let mains = 0;
    r.bcm.handle = (req, t, physical) => {
      if (physical && req[0] === 0x2e && req[1] === 0x0a && ++mains === 1) r.bcm.session = 1; // S3 lapsed
      return inner(req, t, physical);
    };
    expect(await write(r)).toMatchObject({ kind: 'acked' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(2);
    const sends = r.bcm.requests.flatMap((q, i) => (q.startsWith('2E0A5E') ? [i] : []));
    expect(r.bcm.requests.slice(sends[0], sends[1])).toContain('1003');
    expect(r.bcm.block).toEqual([0x3e, 0, 0, 0, 0]);
  });

  it('NRC 31 on the payload after a 31 marker is a lapsed-session signature: re-armed and retried before it is believed', async () => {
    // Live 10-30 / 10-31: both markers and the payload came back 31 in a lapsed session — shown as
    // "this car does not have the setting", which was false.
    const r = await rig();
    r.bcm.markerNrc = { 61849: 0x31 };
    const inner = r.bcm.handle.bind(r.bcm);
    let mains = 0;
    r.bcm.handle = (req, t, physical) =>
      physical && req[0] === 0x2e && req[1] === 0x0a && ++mains === 1
        ? [0x7f, 0x2e, 0x31]
        : inner(req, t, physical);
    expect(await write(r)).toMatchObject({ kind: 'acked' });
    expect(mains).toBe(2);
  });

  it('a genuine refusal is still reported after its one retry', async () => {
    const r = await rig();
    r.bcm.mainNrc = 0x22;
    expect(await write(r)).toMatchObject({ kind: 'nrc', code: '22' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(2);
  });

  it("a recipe without a password is attempted without 27, and the unit's NRC 33 is reported (never a key loop)", async () => {
    const r = await rig();
    expect(await write(r, '3E00000000', null)).toMatchObject({ kind: 'nrc', code: '33' });
    expect(r.bcm.requests.some((q) => q.startsWith('27'))).toBe(false);
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(2);
  });

  it('a refused unit-default code carries on without security; a 33 to the change then says so', async () => {
    const r = await rig();
    const result = await r.run(
      r.link.writeDid(BCM, '0A5E', '3E00000000', {
        securityPassword: '11111',
        passwordSource: 'unit-default',
        onPending: () => {},
      } as Parameters<WebBluetoothLink['writeDid']>[3]),
    );
    expect(result).toMatchObject({
      kind: 'nrc',
      code: '33',
      detail: expect.stringMatching(/didn't accept the usual access code.*needs its own access code/),
    });
    // Plain words only: never the code it answered, never the access code itself.
    expect((result as { detail?: string }).detail).not.toMatch(/35|11111/);
    // The key is never sent again once the default code was refused.
    expect(r.bcm.requests.filter((q) => q.startsWith('2704'))).toHaveLength(1);
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
  });

  it('a refused unit-default code does not stop a module that accepts the change without one', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    r.bcm.handle = (req, t, physical) =>
      physical && req[0] === 0x2e && req[1] === 0x0a ? [0x6e, 0x0a, 0x5e] : inner(req, t, physical);
    const result = await r.run(
      r.link.writeDid(BCM, '0A5E', '3E00000000', {
        securityPassword: '11111',
        passwordSource: 'unit-default',
        onPending: () => {},
      } as Parameters<WebBluetoothLink['writeDid']>[3]),
    );
    expect(result).toMatchObject({ kind: 'acked' });
    expect(r.bcm.requests.filter((q) => q.startsWith('2704'))).toHaveLength(1);
  });

  it('a silent seed returns at the prompt and is asked again inside S3 (no 8 s dead listen)', async () => {
    const clean = await rig();
    const cleanStart = clean.clock.now();
    expect(await write(clean)).toMatchObject({ kind: 'acked' });
    const cleanMs = clean.clock.now() - cleanStart;
    await WebBluetoothLink.retireCurrent();
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let seeds = 0;
    r.bcm.handle = (req, t, physical) =>
      physical && req[0] === 0x27 && req[1] === 0x03 && ++seeds === 1 ? null : inner(req, t, physical);
    const started = r.clock.now();
    expect(await write(r)).toMatchObject({ kind: 'acked' });
    expect(seeds).toBe(2);
    expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(1);
    // One retry costs a re-bind and a short wait, not the 8 s security timeout.
    expect(r.clock.now() - started - cleanMs).toBeLessThan(4000);
  });

  it('an acknowledged payload is never re-sent, even when an immediate read still shows the old bytes', async () => {
    const r = await rig();
    const inner = r.bcm.handle.bind(r.bcm);
    let mains = 0;
    r.bcm.handle = (req, t, physical) => {
      if (physical && req[0] === 0x2e && req[1] === 0x0a) {
        mains += 1;
        if (mains === 1) return [0x6e, 0x0a, 0x5e]; // answered, not stored (live 0E46)
        return [0x7f, 0x2e, 0x22];
      }
      return inner(req, t, physical);
    };
    expect(await write(r)).toMatchObject({ kind: 'acked' });
    expect(mains).toBe(1);
  });

  it('sends 10 01 at the end even when the sequence stopped early', async () => {
    const r = await rig();
    await write(r, '3E00000000', '11111');
    expect(r.bcm.requests.at(-1)).toBe('1001');
  });

  it('configures the adapter once for the sequence: coding timing, ATSP0 on each module switch', async () => {
    const r = await rig();
    const from = r.sent().length;
    await write(r);
    const cmds = r.sent().slice(from);
    const at = (c: string) => cmds.filter((x) => x === c).length;
    // Coding timing once at setup — never re-asserted after a re-bind (the clone ignores ATST; BRIEF U1) — and
    // the read timing once at the end.
    expect(at('ATST96')).toBe(1);
    expect(at('ATST32')).toBe(1);
    // Adaptive timing 1 is already in effect from the connection: neither set up nor restored.
    expect(at('ATAT1')).toBe(0);
    expect(at('ATCAF0')).toBe(1); // set up once…
    expect(at('ATCAF1')).toBe(1); // …and restored once, at the end
    // The channel opens on the gateway and its setup ends the addresses with ATSP0 (BRIEF R8): the gateway's
    // 10 03 runs that search. Then the module, re-bound with ATSP0 — and again before the payload, which
    // follows an ISO-TP transfer (the markers) rather than a prompt it could be sent at.
    const switches = cmds.flatMap((c, i) => (c.startsWith('ATSH') ? [[c, cmds[i + 3]]] : []));
    expect(switches[0]).toEqual(['ATSH710', 'ATSP0']);
    expect(cmds[cmds.indexOf('ATSP0') + 5]).toBe('021003');
    expect(switches.slice(1, -1).every(([sh, next]) => sh === 'ATSH70E' && next === 'ATSP0')).toBe(true);
    expect(switches.at(-1)?.[0]).toBe('ATSH7DF'); // the restore
    expect(switches.length).toBeGreaterThanOrEqual(3);
  });

  it('sends single frames unpadded and pads the others with AA, as the native writer did', async () => {
    const r = await rig();
    const from = r.sent().length;
    await write(r);
    const frames = r
      .sent()
      .slice(from)
      .filter((c) => /^[0-9A-F]+$/.test(c));
    expect(frames).toContain('0322F199');
    expect(frames.some((f) => /^10[0-9A-F]{14}$/.test(f))).toBe(true); // 8-byte first frame of the 2E write
    // F198 (9 bytes) and the data write (8 bytes) each need one consecutive frame, padded with AA.
    expect(frames.filter((f) => f.startsWith('21'))).toEqual(['21DDEEFFAAAAAAAA', '210000AAAAAAAAAA']);
  });

  it('declares a write bound that covers its own worst case, so the domain never cuts it short', async () => {
    const r = await rig();
    // Silent data write: the slowest path that still runs to the data-write deadline.
    r.bcm.silentMain = true;
    const start = r.clock.now();
    await write(r);
    expect(r.clock.now() - start).toBeLessThan(r.link.maxWriteMs);
    expect(r.link.maxWriteMs).toBeGreaterThan(60_000);
  });

  it('reports each marker as it goes on the wire and again when the module answers', async () => {
    const r = await rig();
    const seen: string[] = [];
    await r.run(
      r.link.writeDid(BCM, '0A5E', '3E00000000', {
        securityPassword: PASSWORD,
        onPending: () => {},
        onMarker: (m) => seen.push(`${m.did}:${m.outcome}`),
        today: () => new Date(2026, 9, 24),
      } as Parameters<WebBluetoothLink['writeDid']>[3]),
    );
    expect(seen).toEqual(['F199:no-answer', 'F199:acked', 'F198:no-answer', 'F198:acked']);
  });

  it('records no marker that never left: readiness expiring just before it stops the sequence first', async () => {
    const r = await rig();
    const result = await r.run(
      r.link.writeDid(BCM, '0A5E', '3E00000000', {
        securityPassword: PASSWORD,
        onPending: () => {},
        assertReady: () => {
          if (r.bcm.requests.some((q) => q.startsWith('2704'))) throw Error('Readiness expired');
        },
      }),
    );
    expect(result).toMatchObject({ kind: 'not-sent', reason: 'not-ready' });
    expect(result.markers).toBeUndefined();
    expect(r.bcm.requests.some((q) => q.startsWith('2EF1'))).toBe(false);
  });

  it('writes over any live link — there is no qualification switch', async () => {
    const r = await rig();
    expect(r.link.canWrite).toBe(true);
    expect(await write(r)).toMatchObject({ kind: 'acked' });
  });
});

describe('Bluetooth link — invalidation and exclusive ownership', () => {
  it('close() drops queued commands: nothing more reaches the adapter, and every call is link-lost', async () => {
    const r = await rig();
    const before = r.sent().length;
    const queued = r.link.readDid(BCM, '0A5E');
    await r.link.close();
    const result: unknown = await r.run(queued).catch(() => ({ kind: 'link-lost' }));
    expect(result).toEqual({ kind: 'link-lost' });
    expect(r.sent().length).toBe(before);
    expect(await r.link.readDid(BCM, '0A5E')).toEqual({ kind: 'link-lost' });
    expect(await r.link.readiness()).toEqual({ kind: 'link-lost' });
    expect(await r.link.identify()).toEqual({ kind: 'link-lost' });
  });

  it('a write cut off by close() reports link-lost, and its late replies change nothing', async () => {
    const r = await rig();
    const pending = write(r);
    // Let the sequence get under way, then retire the link mid-exchange.
    for (let i = 0; i < 40 && r.bcm.requests.length < 3; i++) r.clock.step();
    await r.link.close();
    const result = (await pending.catch(() => ({ kind: 'link-lost' }))) as DidWrite;
    expect(['link-lost', 'not-sent']).toContain(result.kind);
    expect(r.bcm.requests.some((q) => q.startsWith('2E0A5E'))).toBe(false);
  });

  it('connecting again retires the previous link first (one physical owner)', async () => {
    const first = await rig();
    const second = await rig();
    // adopt() makes the newest link current; retiring it must not touch the first's state…
    await WebBluetoothLink.retireCurrent();
    expect(second.link.isClosed).toBe(true);
    // …and a fresh adopt over the first engine would retire nothing else. The first link stays usable
    // only until a new connect() runs, which calls retireCurrent() before opening the adapter.
    expect(first.link.isClosed).toBe(false);
  });
});

// Regression cases from the independent BLE acceptance review.
it('preparation tolerates 100ms host-write latency', async () => {
  const r = await rig({ writeLatencyMs: 100 });
  expect(await write(r)).toMatchObject({ kind: 'acked' });
});
it('cancelling during preparation prevents the main write and onSend callback', async () => {
  const r = await rig();
  const abort = new AbortController();
  let sent = 0;
  r.clock.schedule(30, () => abort.abort());
  const result = await r.run(
    r.link.writeDid(BCM, '0A5E', '3E00000000', {
      securityPassword: PASSWORD,
      signal: abort.signal,
      onPending: () => {},
      onSend: () => {
        sent++;
      },
    }),
  );
  expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(0);
  expect(sent).toBe(0);
  expect(result).toEqual({ kind: 'cancelled' });
});
it('expired readiness at the main transmit boundary prevents the main frame', async () => {
  const r = await rig();
  const result = await r.run(
    r.link.writeDid(BCM, '0A5E', '3E00000000', {
      securityPassword: PASSWORD,
      onPending: () => {},
      assertReady: () => {
        if (r.bcm.markerWrites.F198) throw Error('Readiness expired');
      },
    }),
  );
  expect(r.bcm.requests.filter((q) => q.startsWith('2E0A5E'))).toHaveLength(0);
  expect(result.kind).toBe('not-sent');
});
