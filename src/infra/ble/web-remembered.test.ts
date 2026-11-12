import { WebBluetoothTransport } from '@obdcraft/obd-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import { forgetGrants, rememberedAdapters, rememberGrant, webRememberedScanner } from './web-remembered.ts';

/** A granted device that can be told to "hear" an advertisement. */
function granted(id: string, name?: string, watch = true) {
  const listeners = new Set<(e: { rssi?: number; uuids?: string[] }) => void>();
  return {
    id,
    ...(name ? { name } : {}),
    addEventListener: (_t: string, cb: (e: { rssi?: number }) => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: (e: { rssi?: number }) => void) => listeners.delete(cb),
    ...(watch ? { watchAdvertisements: vi.fn(async () => {}) } : {}),
    hear: (rssi: number) => {
      for (const l of listeners) l({ rssi, uuids: ['0000fff0-0000-1000-8000-00805f9b34fb'] });
    },
    listening: () => listeners.size,
  };
}
const navWith = (devices: unknown[]) => ({
  bluetooth: { requestDevice: vi.fn(), getDevices: async () => devices },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the adapters the browser remembers', () => {
  afterEach(forgetGrants);

  it("without the browser's memory (Chrome on Android by default), lists what was granted on this page", async () => {
    const nav = { bluetooth: { requestDevice: vi.fn() } };
    expect(await rememberedAdapters(nav)).toEqual([]);
    const obd = granted('g1', 'OBDBLE', false);
    rememberGrant(obd);
    expect((await rememberedAdapters(nav)).map((d) => d.id)).toEqual(['g1']);
  });

  it('merges this page’s grants with what the browser keeps, once each', async () => {
    rememberGrant(granted('g1', 'OBDBLE'));
    const kept = await rememberedAdapters(navWith([granted('g1', 'OBDBLE'), granted('g2', 'OBDII')]));
    expect(kept.map((d) => d.id)).toEqual(['g1', 'g2']);
  });

  it('lists none where the browser cannot remember devices', async () => {
    expect(await rememberedAdapters({ bluetooth: { requestDevice: vi.fn() } })).toEqual([]);
    expect(await rememberedAdapters(undefined)).toEqual([]);
    expect(
      await rememberedAdapters({
        bluetooth: { requestDevice: vi.fn(), getDevices: async () => Promise.reject(new Error('x')) },
      }),
    ).toEqual([]);
  });

  it('reports each remembered adapter, then its signal once it is heard; stop stops listening', async () => {
    const obd = granted('g1', 'OBDBLE');
    const seen: ScannedDevice[] = [];
    const scanner = webRememberedScanner(navWith([obd]));
    const handle = scanner.scan((d) => seen.push(d), vi.fn());
    await flush();
    expect(seen).toEqual([{ id: 'g1', name: 'OBDBLE', serviceUuids: [] }]);
    obd.hear(-61);
    expect(seen.at(-1)).toMatchObject({ id: 'g1', rssi: -61 });
    handle.stop();
    expect(obd.listening()).toBe(0);
  });

  it('a browser without watchAdvertisements still lists the adapter, with no signal', async () => {
    const seen: ScannedDevice[] = [];
    webRememberedScanner(navWith([granted('g2', 'OBDII', false)])).scan((d) => seen.push(d), vi.fn());
    await flush();
    expect(seen).toEqual([{ id: 'g2', name: 'OBDII', serviceUuids: [] }]);
  });

  it('opens a listed adapter directly, never through the chooser', async () => {
    const nav = navWith([granted('g1', 'OBDBLE')]);
    const scanner = webRememberedScanner(nav);
    scanner.scan(vi.fn(), vi.fn());
    await flush();
    const transport = scanner.transport({ id: 'g1', serviceUuids: [] });
    expect(transport).toBeInstanceOf(WebBluetoothTransport);
    expect((transport as WebBluetoothTransport).reusableDevice?.id).toBe('g1');
    expect(() => scanner.transport({ id: 'unknown', serviceUuids: [] })).toThrow(/no longer remembered/);
    expect(nav.bluetooth.requestDevice).not.toHaveBeenCalled();
  });

  it('says it cannot list where the browser has no Bluetooth', () => {
    const onError = vi.fn();
    webRememberedScanner({}).scan(vi.fn(), onError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: 'not-supported' });
  });
});
