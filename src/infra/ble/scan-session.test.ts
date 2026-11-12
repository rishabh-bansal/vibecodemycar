import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import { type FakeDevice, fakeScanner } from './fake-scanner.ts';
import { SCAN_MS, ScanSession } from './scan-session.ts';
import { type BleScanner, ScanError } from './scanner.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const DEVICES: FakeDevice[] = [
  {
    id: 'speaker',
    name: 'JBL Flip',
    rssi: -45,
    serviceUuids: [],
    deviceClass: 'audio',
    at: 100,
    behaviour: 'no-serial',
  },
  { id: 'obd', name: 'OBDBLE', rssi: -70, serviceUuids: ['fff0'], at: 200, behaviour: 'adapter' },
  { id: 'vl', name: 'vLinker', rssi: -65, serviceUuids: ['18f0'], at: 300, behaviour: 'adapter' },
];

/** A scanner whose sightings the test pushes by hand. */
function manualScanner() {
  let seen: ((d: ScannedDevice) => void) | undefined;
  let fail: ((e: ScanError) => void) | undefined;
  let stops = 0;
  const scanner: BleScanner = {
    ui: 'in-app',
    scan(onSeen, onError) {
      seen = onSeen;
      fail = onError;
      return { stop: () => void stops++ };
    },
    transport() {
      throw new Error('unused');
    },
  };
  return {
    scanner,
    see: (d: Partial<ScannedDevice> & { id: string }) => seen?.({ serviceUuids: [], ...d }),
    fail: (e: ScanError) => fail?.(e),
    get stops() {
      return stops;
    },
  };
}

const order = (s: ScanSession) => {
  const v = s.getState().view;
  return [v.pinned, ...v.likely, ...v.other].filter(Boolean).map((r) => r?.device.id);
};

describe('ScanSession', () => {
  it('scans for 10 s, then stops the scanner and keeps the list', () => {
    const m = manualScanner();
    const s = new ScanSession(m.scanner);
    s.start();
    m.see({ id: 'obd', name: 'OBDBLE', rssi: -60 });
    expect(s.getState()).toMatchObject({ phase: 'scanning', view: { count: 1 } });
    vi.advanceTimersByTime(SCAN_MS - 1);
    expect(s.getState().phase).toBe('scanning');
    vi.advanceTimersByTime(1);
    expect(s.getState()).toMatchObject({ phase: 'done', view: { count: 1 } });
    expect(m.stops).toBe(1);
    m.see({ id: 'late', rssi: -50 }); // a sighting after the stop is ignored
    expect(s.getState().view.count).toBe(1);
  });

  it('merges repeat sightings by id and re-sorts: likely first, then signal', () => {
    const s = new ScanSession(fakeScanner({ devices: DEVICES, repeatMs: 0 }));
    s.start();
    vi.advanceTimersByTime(400);
    expect(order(s)).toEqual(['vl', 'obd', 'speaker']);
    expect(s.getState().view.count).toBe(3);
  });

  it('RESCAN clears the list and starts a new 10 s scan', () => {
    const scanner = fakeScanner({ devices: DEVICES, repeatMs: 0 });
    const s = new ScanSession(scanner);
    s.start();
    vi.advanceTimersByTime(SCAN_MS);
    expect(s.getState()).toMatchObject({ phase: 'done', view: { count: 3 } });
    s.rescan();
    expect(scanner.scans).toBe(2);
    expect(s.getState()).toMatchObject({ phase: 'scanning', view: { count: 0 } });
    vi.advanceTimersByTime(250);
    expect(s.getState().view.count).toBe(2);
    vi.advanceTimersByTime(SCAN_MS);
    expect(s.getState().phase).toBe('done');
  });

  it('a rescan in the middle of a scan cancels the first scan’s timer', () => {
    const m = manualScanner();
    const s = new ScanSession(m.scanner);
    s.start();
    vi.advanceTimersByTime(6000);
    s.rescan();
    vi.advanceTimersByTime(6000); // 12 s after the first start, 6 s into the second
    expect(s.getState().phase).toBe('scanning');
    vi.advanceTimersByTime(4000);
    expect(s.getState().phase).toBe('done');
  });

  it('holds the order while a finger is down; signals keep updating; lifting re-sorts', () => {
    const m = manualScanner();
    const s = new ScanSession(m.scanner);
    s.start();
    m.see({ id: 'a', name: 'OBD A', rssi: -60 });
    m.see({ id: 'b', name: 'OBD B', rssi: -70 });
    expect(order(s)).toEqual(['a', 'b']);
    s.hold();
    m.see({ id: 'b', rssi: -40 });
    m.see({ id: 'c', name: 'OBD C', rssi: -30 });
    expect(order(s)).toEqual(['a', 'b', 'c']);
    expect(s.getState().view.likely[1]?.device.rssi).toBe(-40);
    s.release();
    expect(order(s)).toEqual(['c', 'b', 'a']);
  });

  it('pins the last adapter that connected', () => {
    const s = new ScanSession(fakeScanner({ devices: DEVICES, repeatMs: 0 }), {
      lastUsed: { id: 'speaker' },
    });
    s.start();
    vi.advanceTimersByTime(400);
    expect(s.getState().view.pinned?.device.id).toBe('speaker');
    expect(order(s)).toEqual(['speaker', 'vl', 'obd']);
  });

  it('reports Bluetooth off and permission refusals as error states', () => {
    for (const [scenario, code] of [
      ['off', 'bluetooth-off'],
      ['denied', 'permission-denied'],
    ] as const) {
      const s = new ScanSession(fakeScanner({ scenario }));
      s.start();
      vi.advanceTimersByTime(200);
      expect(s.getState()).toMatchObject({ phase: 'error', error: code });
      vi.advanceTimersByTime(SCAN_MS); // the 10 s timer no longer changes anything
      expect(s.getState().phase).toBe('error');
    }
  });

  it('nothing found: done with an empty list after 10 s', () => {
    const s = new ScanSession(fakeScanner({ scenario: 'empty' }));
    s.start();
    vi.advanceTimersByTime(SCAN_MS);
    expect(s.getState()).toMatchObject({ phase: 'done', view: { count: 0 } });
  });

  it('stop() ends the scan early and keeps what was found', () => {
    const m = manualScanner();
    const s = new ScanSession(m.scanner);
    s.start();
    m.see({ id: 'a', name: 'OBD', rssi: -60 });
    s.stop();
    expect(s.getState()).toMatchObject({ phase: 'done', view: { count: 1 } });
    m.fail(new ScanError('bluetooth-off')); // a late error from the stopped scan is ignored
    expect(s.getState().phase).toBe('done');
  });
});
