import { WebBluetoothTransport } from '@obdcraft/obd-core';
import { describe, expect, it } from 'vitest';
import { ADAPTER_NAME_PREFIXES, chooserFor } from './web-chooser.ts';

const UUID = (s: string) => `0000${s}-0000-1000-8000-00805f9b34fb`;

/** Mirrors Chrome's matching: a device is listed when any one filter matches all of its parts. */
function chromeLists(
  options: { filters?: { services?: string[]; namePrefix?: string }[]; acceptAllDevices?: boolean },
  device: { name?: string; services: string[] },
): boolean {
  if (options.acceptAllDevices) return true;
  return (options.filters ?? []).some(
    (f) =>
      (!f.namePrefix || (device.name ?? '').startsWith(f.namePrefix)) &&
      (!f.services || f.services.every((s) => device.services.includes(s))),
  );
}

async function requested(chooser: ReturnType<typeof chooserFor>) {
  let options: unknown;
  const t = new WebBluetoothTransport(
    {
      async requestDevice(o) {
        options = o;
        throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), {
          name: 'NotFoundError',
        });
      },
    },
    chooser,
  );
  await t.open().catch(() => {});
  return options as {
    filters?: { services?: string[]; namePrefix?: string }[];
    acceptAllDevices?: boolean;
    optionalServices: string[];
  };
}

describe('the web chooser', () => {
  it("lists adapters by advertised service or by name — the owner's OBDBLE included", async () => {
    const o = await requested(chooserFor('adapters'));
    expect(o.acceptAllDevices).toBeUndefined();
    expect(o.filters).toEqual(
      expect.arrayContaining([
        { services: [UUID('fff0')] },
        { services: [UUID('ffe0')] },
        { services: [UUID('18f0')] },
      ]),
    );
    for (const name of [
      'OBDBLE',
      'OBDII',
      'OBDLink CX',
      'Vgate iCar Pro',
      'vLinker MC-IOS',
      'IOS-Vlink',
      'VEEPEAK',
      'KONNWEI',
      'ELM327',
    ])
      expect(chromeLists(o, { name, services: [] }), name).toBe(true);
    expect(chromeLists(o, { services: [UUID('ffe0')] })).toBe(true); // unnamed clone advertising FFE0
    expect(chromeLists(o, { name: 'boAt Airdopes', services: [] })).toBe(false);
    // Every adapter layout stays reachable after connecting.
    expect(o.optionalServices).toEqual(
      expect.arrayContaining([UUID('fff0'), UUID('ffe0'), UUID('18f0'), UUID('beef')]),
    );
  });

  it('"Show all Bluetooth devices" falls back to the old unfiltered chooser', async () => {
    const o = await requested(chooserFor('all'));
    expect(o.acceptAllDevices).toBe(true);
    expect(o.filters).toBeUndefined();
    expect(o.optionalServices.length).toBeGreaterThan(3);
  });

  it('name prefixes are plain, non-empty strings (Chrome rejects an empty prefix)', () => {
    expect(ADAPTER_NAME_PREFIXES.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
  });
});

describe('Bluetooth blocked for the site', () => {
  it('is reported as permission-denied, not as "no adapter"', async () => {
    const { mapConnectError } = await import('../link/web-bluetooth.ts');
    const t = new WebBluetoothTransport({
      async requestDevice() {
        throw Object.assign(new Error('Bluetooth permission has been blocked.'), { name: 'SecurityError' });
      },
    });
    const err = await t.open().catch((e) => e);
    expect(err).toMatchObject({ code: 'denied' });
    expect(mapConnectError(err).code).toBe('permission-denied');
  });
});
