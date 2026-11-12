import { ConnectError, TransportError, UdsExchangeError } from '@obdcraft/obd-core';
import { describe, expect, it } from 'vitest';
import {
  LinkConnectError,
  type LinkIo,
  mapConnectError,
  mapReadError,
  WebBluetoothLink,
} from './web-bluetooth.ts';

const link = (read: (t: string, r: string, d: number) => Promise<number[]>) =>
  new WebBluetoothLink({ read, close: async () => {} });
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const module = { request: '714', response: '77E' };

describe('mapReadError', () => {
  it('maps a negative response to its code', () => {
    expect(mapReadError(new UdsExchangeError('no', true, [], 0x31), false)).toEqual({
      kind: 'nrc',
      code: '31',
    });
    expect(mapReadError(new UdsExchangeError('no', true, [], 0x7), false)).toEqual({
      kind: 'nrc',
      code: '07',
    });
  });
  it('maps silence to no-reply', () => {
    expect(mapReadError(new UdsExchangeError('timeout', true, []), false)).toEqual({ kind: 'no-reply' });
    expect(mapReadError(new Error('whatever'), false)).toEqual({ kind: 'no-reply' });
  });
  it('maps a closed link to link-lost, whatever the error looked like', () => {
    expect(mapReadError(new Error('x'), true)).toEqual({ kind: 'link-lost' });
    expect(mapReadError(new TransportError('closed', 'closed'), false)).toEqual({ kind: 'link-lost' });
  });
});

describe('mapConnectError', () => {
  it('explains the browser having no Bluetooth', () => {
    expect(mapConnectError(new TransportError('nope', 'not_supported')).code).toBe('not-supported');
  });
  it('treats a dismissed chooser as "no adapter"', () => {
    expect(mapConnectError(new TransportError('cancelled', 'cancelled')).code).toBe('no-adapter');
  });
  it('recognises Bluetooth being switched off', () => {
    expect(mapConnectError(new TransportError('Bluetooth adapter not available.', 'not_found')).code).toBe(
      'bluetooth-off',
    );
  });
  it('tells a silent car apart from a broken adapter', () => {
    expect(mapConnectError(new ConnectError('quiet', 'car_silent')).code).toBe('car-silent');
    expect(mapConnectError(new ConnectError('dead', 'adapter_silent')).code).toBe('adapter-failed');
  });
  it('never leaks an unknown error type', () => {
    expect(mapConnectError('weird')).toBeInstanceOf(LinkConnectError);
  });
});

describe('WebBluetoothLink', () => {
  it('keeps a proven VIN for the life of the link — a second identify never touches the wire', async () => {
    const vin = 'MEXKAA050MB000001';
    const calls: string[] = [];
    const read: LinkIo['read'] = async (target, _response, did) => {
      calls.push(`${target}:${did.toString(16).toUpperCase()}`);
      return target === '714' ? ascii(vin) : [0x03, 0x7f, 0x22, 0x31];
    };
    const io: LinkIo = { read, withReads: (_m, work) => work(read), close: async () => {} };
    const l = new WebBluetoothLink(io);
    const first = await l.identify();
    const callsAfterFirst = calls.length;
    const second = await l.identify({ request: '714', response: '77E' });
    expect(first).toEqual({ kind: 'ok', vin });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(callsAfterFirst);
    expect(calls.filter((c) => c.endsWith('F190'))).toHaveLength(2);
  });

  it('lets a scoped reader serve the cached identity too — verify never repeats the VIN reads', async () => {
    const vin = 'MEXKAA050MB000001';
    const calls: string[] = [];
    const read: LinkIo['read'] = async (target, _response, did) => {
      calls.push(`${target}:${did.toString(16).toUpperCase()}`);
      return target === '714' ? ascii(vin) : [0x03, 0x7f, 0x22, 0x31];
    };
    const io: LinkIo = { read, withReads: (_m, work) => work(read), close: async () => {} };
    const l = new WebBluetoothLink(io);
    await l.identify();
    const callsAfterFirst = calls.length;
    const scoped = await l.withReads({ request: '70E', response: '778' }, (reader) => reader.identify());
    expect(scoped).toEqual({ kind: 'ok', vin });
    expect(calls).toHaveLength(callsAfterFirst);
  });

  it('lets a scoped reader fill the cache when the first identify happened inside a group', async () => {
    const vin = 'MEXKAA050MB000001';
    const calls: string[] = [];
    const read: LinkIo['read'] = async (target, _response, did) => {
      calls.push(`${target}:${did.toString(16).toUpperCase()}`);
      return target === '714' ? ascii(vin) : [0x03, 0x7f, 0x22, 0x31];
    };
    const io: LinkIo = { read, withReads: (_m, work) => work(read), close: async () => {} };
    const l = new WebBluetoothLink(io);
    const scoped = await l.withReads({ request: '70E', response: '778' }, (reader) => reader.identify());
    const callsAfterScoped = calls.length;
    const second = await l.identify();
    expect(scoped).toEqual({ kind: 'ok', vin });
    expect(second).toEqual(scoped);
    expect(calls).toHaveLength(callsAfterScoped);
  });

  it('retries a failed identify — a sleeping bus is not the final answer', async () => {
    const vin = 'MEXKAA050MB000001';
    let silent = true;
    const read: LinkIo['read'] = async () => {
      if (silent) throw new UdsExchangeError('timeout', true, []);
      return ascii(vin);
    };
    const io: LinkIo = { read, withReads: (_m, work) => work(read), close: async () => {} };
    const l = new WebBluetoothLink(io);
    const missed = await l.identify({ request: '714', response: '77E' });
    silent = false;
    const found = await l.identify();
    expect(missed.kind).toBe('no-vin');
    expect(found).toEqual({ kind: 'ok', vin });
  });

  it('gives a slow ECU further chances: a completed NO DATA read is asked again at once, four sends in all, then reports', async () => {
    const empty = () =>
      new UdsExchangeError(
        'timeout',
        true,
        [{ status: 'ok', statuses: ['NO DATA'], lines: ['NO DATA'] } as never],
        undefined,
        'timeout',
      );
    const calls: string[] = [];
    let emptyStreak = 1;
    const read: LinkIo['read'] = async (t, _r, d) => {
      calls.push(`${t}:${d.toString(16).toUpperCase()}`);
      if (emptyStreak > 0) {
        emptyStreak--;
        throw empty();
      }
      return [0x3a];
    };
    const io: LinkIo = { read, close: async () => {} };
    const l = new WebBluetoothLink(io);
    const found = await l.readDid(module, '0A5E');
    expect(found).toEqual({ kind: 'ok', bytes: '3A' });
    expect(calls).toHaveLength(2);

    // Still silent on the retry: reported as no-reply, not pummelled further.
    emptyStreak = Infinity;
    calls.length = 0;
    const missed = await l.readDid(module, '0A5E');
    expect(missed.kind).toBe('no-reply');
    expect(calls).toHaveLength(4);

    // A definite refusal is never retried.
    calls.length = 0;
    const refused: LinkIo['read'] = async () => {
      calls.push('x');
      throw new UdsExchangeError('no', true, [], 0x31);
    };
    const l2 = new WebBluetoothLink({ read: refused, close: async () => {} });
    expect(await l2.readDid(module, '0A5E')).toEqual({ kind: 'nrc', code: '31' });
    expect(calls).toHaveLength(1);
  });

  it('preserves the I/O receiver for standalone reads and the ungrouped fallback', async () => {
    const io = {
      calls: 0,
      async read() {
        this.calls++;
        return [0x3a];
      },
      close: async () => {},
    };
    const l = new WebBluetoothLink(io);
    expect(await l.readDid(module, '0A5E')).toEqual({ kind: 'ok', bytes: '3A' });
    expect(await l.withReads(module, (reader) => reader.readDid(module, '0A5E'))).toEqual({
      kind: 'ok',
      bytes: '3A',
    });
    expect(io.calls).toBe(2);
  });

  it('an I/O without a writer is read-only and says so', () => {
    const l = link(async () => []);
    expect(l.canWrite).toBe(false);
    expect(l.mode).toBe('live');
    expect(l.banner).toMatch(/only read/);
  });

  it('a live link with a writer always writes — no qualification switch', async () => {
    const writes: string[] = [];
    const l = new WebBluetoothLink(
      {
        read: async () => [],
        write: async (m, did, bytes) => {
          writes.push(`${m.request}:${did}:${bytes}`);
          return { kind: 'acked' };
        },
        close: async () => {},
      },
      {},
    );
    expect(l.canWrite).toBe(true);
    expect(l.banner).toBe('LIVE · connected to your car');
    // Each call carries its own module: group steps on different units go through one link.
    await l.writeDid(module, '0A5E', '00', { securityPassword: null, onPending: () => {} });
    await l.writeDid({ request: '70E', response: '778' }, '0600', '01', {
      securityPassword: null,
      onPending: () => {},
    });
    expect(writes).toEqual(['714:0A5E:00', '70E:0600:01']);
  });

  it('reads the VIN as the native tool did: the BCM first, then the cluster, where this platform serves it', async () => {
    const calls: string[] = [];
    const l = link(async (t, r, d) => {
      calls.push(`${t}/${r}/${d.toString(16)}`);
      if (t === '70E') throw new UdsExchangeError('refused', true, [], 0x31);
      return ascii('MEXTEST0SAMPLE042');
    });
    expect(await l.identify()).toEqual({ kind: 'ok', vin: 'MEXTEST0SAMPLE042' });
    expect(calls).toEqual(['70E/778/f190', '714/77E/f190']);
  });

  it('asks the bound module first, and the cluster only once', async () => {
    const calls: string[] = [];
    const l = link(async (t) => {
      calls.push(t);
      return ascii('MEXTEST0SAMPLE042');
    });
    expect(await l.identify({ request: '714', response: '77E' })).toEqual({
      kind: 'ok',
      vin: 'MEXTEST0SAMPLE042',
    });
    expect(calls).toEqual(['714']);
  });

  it('drops padding bytes around the VIN, as the native tool did', async () => {
    const l = link(async () => [...ascii('MEXTEST0SAMPLE042'), 0x00, 0xaa]);
    expect(await l.identify()).toEqual({ kind: 'ok', vin: 'MEXTEST0SAMPLE042' });
  });

  it('rejects a malformed VIN rather than trust it', async () => {
    expect(await link(async () => ascii('NOT A VIN')).identify()).toEqual({ kind: 'no-vin', why: 'no-vin' });
    expect(await link(async () => ascii('MEXTEST0SAMPLE04I')).identify()).toEqual({
      kind: 'no-vin',
      why: 'no-vin',
    }); // 'I' is illegal in a VIN
  });

  it('says when nothing on the car answered at all (the adapter could not reach the bus)', async () => {
    const unable = { statuses: ['UNABLE TO CONNECT'] } as unknown as ConstructorParameters<
      typeof UdsExchangeError
    >[2][number];
    const l = link(async () => {
      throw new UdsExchangeError('Adapter reported UNABLE TO CONNECT.', true, [unable], undefined, 'adapter');
    });
    expect(await l.identify()).toEqual({ kind: 'no-vin', why: 'bus-silent', adapter: 'UNABLE TO CONNECT' });
  });

  it('tells silent modules apart from an unreachable bus', async () => {
    const l = link(async () => {
      throw new UdsExchangeError('timeout', true, [], undefined, 'timeout');
    });
    expect(await l.identify()).toEqual({ kind: 'no-vin', why: 'no-answer' });
  });

  it('returns upper-case hex payloads', async () => {
    expect(await link(async () => [0x3e, 0x00, 0xa0]).readDid(module, '0A5E')).toEqual({
      kind: 'ok',
      bytes: '3E00A0',
    });
  });

  it('reports link-lost once closed, and never calls the transport again', async () => {
    let calls = 0;
    const l = link(async () => {
      calls++;
      return [1];
    });
    await l.close();
    expect(await l.readDid(module, '0A5E')).toEqual({ kind: 'link-lost' });
    expect(await l.identify()).toEqual({ kind: 'link-lost' });
    expect(calls).toBe(0);
  });

  it('an I/O without a writer reports not-sent instead of pretending', async () => {
    expect(
      await link(async () => []).writeDid(module, '0A5E', '00', {
        securityPassword: null,
        onPending: () => {},
      }),
    ).toMatchObject({ kind: 'not-sent' });
  });
});

describe('WebBluetoothLink.connect — one at a time', () => {
  it('a second connect waits for the first to finish before it asks for a device', async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const nav = {
      bluetooth: {
        async requestDevice() {
          calls++;
          if (calls === 1) await gate;
          throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), {
            name: 'NotFoundError',
          });
        },
      },
    };
    const first = WebBluetoothLink.connect(nav).catch(() => 'first-failed');
    const second = WebBluetoothLink.connect(nav).catch(() => 'second-failed');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    release();
    expect(await first).toBe('first-failed');
    expect(await second).toBe('second-failed');
    expect(calls).toBe(2);
  });
});

describe('connection log hook', () => {
  it('tells its owner once when the link closes, whoever closed it', async () => {
    let closed = 0;
    const l = new WebBluetoothLink(
      { read: async () => [], close: async () => {} },
      { onClosed: () => closed++ },
    );
    await l.close();
    await l.close();
    expect(closed).toBe(1);
  });
});
