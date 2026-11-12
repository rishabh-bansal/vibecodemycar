import { describe, expect, it } from 'vitest';
import { LinkConnectError, WebBluetoothLink } from '../link/web-bluetooth.ts';
import { FAKE_DEVICES, fakeScanner } from './fake-scanner.ts';

const device = (id: string) => {
  const d = FAKE_DEVICES.find((x) => x.id === id);
  if (!d) throw new Error(id);
  return d;
};

/** The picker's tap runs the app's real connect path: the ELM327 start (ATZ, ATI, …) over the scanned device. */
describe('connecting a scanned device (fake scanner, real ELM327 handshake)', () => {
  it('an adapter answers the handshake and identifies the car', async () => {
    const wire: string[] = [];
    const scanner = fakeScanner();
    const link = await WebBluetoothLink.connectTransport(scanner.transport(device('fake-obdble')), {
      onWire: (e) => wire.push(e.text),
    });
    try {
      expect(wire.some((t) => /^ATZ/.test(t))).toBe(true);
      expect(wire.some((t) => /^ATI/.test(t))).toBe(true);
      expect(link.adapter?.firmware).toBeTruthy();
      expect(await link.identify()).toEqual({ kind: 'ok', vin: 'MEXTEST0FAKE00001' });
    } finally {
      await link.close();
    }
  }, 20_000);

  it('a device that never answers, then drops the link, fails as an adapter failure', async () => {
    const scanner = fakeScanner({ dropMs: 300 });
    const err = await WebBluetoothLink.connectTransport(scanner.transport(device('fake-unnamed'))).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(LinkConnectError);
    expect(err.code).toBe('adapter-failed');
  });

  it('a device with no serial service is refused before any command', async () => {
    const scanner = fakeScanner({ refuseMs: 5 });
    const wire: string[] = [];
    const err = await WebBluetoothLink.connectTransport(scanner.transport(device('fake-earbuds')), {
      onWire: (e) => wire.push(e.text),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(LinkConnectError);
    expect(err.code).toBe('adapter-failed');
    expect(wire).toEqual([]);
  });
});
