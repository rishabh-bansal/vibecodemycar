import { describe, expect, it } from 'vitest';
import type { ScannedDevice } from './likely.ts';
import {
  buildView,
  displayOrder,
  mergeSighting,
  type Sightings,
  sortDevices,
  topMatch,
} from './scan-list.ts';

const d = (id: string, over: Partial<ScannedDevice> = {}): ScannedDevice => ({
  id,
  serviceUuids: [],
  ...over,
});
const seenAll = (...devices: ScannedDevice[]): Sightings =>
  devices.reduce<Sightings>((m, x) => mergeSighting(m, x), new Map());
const ids = (devices: readonly { id: string }[]) => devices.map((x) => x.id);

describe('merge by device id', () => {
  it('a repeat sighting updates the signal and never adds a second row', () => {
    const seen = seenAll(d('a', { name: 'OBDBLE', rssi: -70 }), d('b', { rssi: -50 }), d('a', { rssi: -55 }));
    expect([...seen.keys()]).toEqual(['a', 'b']);
    expect(seen.get('a')).toMatchObject({ name: 'OBDBLE', rssi: -55 });
  });

  it('keeps a name and services a later advertisement left out, and adds ones it carried', () => {
    const seen = seenAll(
      d('a', { rssi: -70, serviceUuids: ['fff0'] }),
      d('a', { name: 'OBDBLE', serviceUuids: [] }),
      d('a', { rssi: -60, serviceUuids: ['180a'] }),
    );
    expect(seen.get('a')).toEqual({ id: 'a', name: 'OBDBLE', rssi: -60, serviceUuids: ['fff0', '180a'] });
  });

  it('does not change the map it was given', () => {
    const before = seenAll(d('a', { rssi: -70 }));
    mergeSighting(before, d('a', { rssi: -40 }));
    expect(before.get('a')?.rssi).toBe(-70);
  });
});

describe('sorting', () => {
  it('likely adapters first, then by signal; ties keep the order first seen', () => {
    const sorted = sortDevices([
      d('speaker', { name: 'JBL', rssi: -40 }),
      d('weak-obd', { name: 'OBDII', rssi: -85 }),
      d('strong-obd', { name: 'vLinker', rssi: -50 }),
      d('tv', { name: 'TV', rssi: -60 }),
      d('tv2', { name: 'TV 2', rssi: -60 }),
      d('nosignal', { name: 'Thing' }),
    ]);
    expect(ids(sorted)).toEqual(['strong-obd', 'weak-obd', 'speaker', 'tv', 'tv2', 'nosignal']);
  });
});

describe('the pinned last-used adapter', () => {
  const seen = seenAll(
    d('obd', { name: 'OBDBLE', rssi: -50 }),
    d('clone', { rssi: -90 }), // unnamed clone, last used
    d('vl', { name: 'vLinker', rssi: -70 }),
  );

  it('is first, above stronger likely adapters, even when it does not look like one', () => {
    const last = { id: 'clone' };
    const order = displayOrder(seen, last);
    expect(order).toEqual(['clone', 'obd', 'vl']);
    const view = buildView(seen, order, last);
    expect(view.pinned).toMatchObject({ device: { id: 'clone' }, lastUsed: true, likely: false });
    expect(ids(view.likely.map((r) => r.device))).toEqual(['obd', 'vl']);
    expect(view.other).toEqual([]);
    expect(topMatch(view)?.device.id).toBe('clone');
  });

  it('carries LIKELY too when it qualifies', () => {
    const view = buildView(seen, displayOrder(seen, { id: 'vl' }), { id: 'vl' });
    expect(view.pinned).toMatchObject({ device: { id: 'vl' }, lastUsed: true, likely: true });
    expect(ids(view.likely.map((r) => r.device))).toEqual(['obd']);
  });

  it('is not shown before the scan has seen it', () => {
    const view = buildView(seen, displayOrder(seen, { id: 'gone' }), { id: 'gone' });
    expect(view.pinned).toBeUndefined();
    expect(topMatch(view)?.device.id).toBe('obd');
    expect(view.count).toBe(3);
  });
});

describe('order held while a finger is on the list', () => {
  it('rows keep their places as signals change; new devices are added after them', () => {
    let seen = seenAll(d('a', { name: 'OBD A', rssi: -70 }), d('b', { name: 'OBD B', rssi: -60 }));
    const shown = displayOrder(seen);
    expect(shown).toEqual(['b', 'a']);

    seen = mergeSighting(seen, d('a', { rssi: -40 })); // a is now the stronger one
    seen = mergeSighting(seen, d('c', { name: 'OBD C', rssi: -30 }));
    const held = displayOrder(seen, undefined, shown);
    expect(held).toEqual(['b', 'a', 'c']);
    expect(buildView(seen, held).likely.map((r) => r.device.rssi)).toEqual([-60, -40, -30]); // signal still live

    expect(displayOrder(seen)).toEqual(['c', 'a', 'b']); // finger lifted: sorted again
  });

  it('a last-used adapter found while held waits in its group instead of jumping to the top', () => {
    let seen = seenAll(d('a', { name: 'OBD A', rssi: -70 }));
    const shown = displayOrder(seen, { id: 'z' });
    seen = mergeSighting(seen, d('z', { name: 'OBD Z', rssi: -50 }));
    const view = buildView(seen, displayOrder(seen, { id: 'z' }, shown), { id: 'z' });
    expect(view.pinned).toBeUndefined();
    expect(view.likely.map((r) => [r.device.id, r.lastUsed])).toEqual([
      ['a', false],
      ['z', true],
    ]);
  });
});
