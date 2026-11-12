import { isLikelyObdAdapter, type ScannedDevice } from './likely.ts';

/**
 * The adapter picker's list as data: sightings merged by device id, sorted (likely adapters first, then by
 * signal), the last adapter that connected pinned on top, and the order held still while a finger is on the
 * list. Pure: every function returns a new value.
 */

/** The adapter that last connected successfully (its handshake answered), remembered across visits. */
export interface LastAdapter {
  id: string;
  name?: string;
}

export interface ScanRow {
  device: ScannedDevice;
  likely: boolean;
  lastUsed: boolean;
}

export interface ScanView {
  /** The last adapter that connected, when this scan has seen it. Always first. */
  pinned?: ScanRow;
  /** LOOKS LIKE AN OBD ADAPTER (the pinned row excluded). */
  likely: ScanRow[];
  /** OTHER DEVICES. */
  other: ScanRow[];
  /** Every device seen, in display order. */
  count: number;
}

/** Sightings by device id, in the order first seen. */
export type Sightings = ReadonlyMap<string, ScannedDevice>;

/**
 * Adds one sighting. A repeat of a known id updates its signal (and fills in a name or services a later
 * advertisement carried); it never adds a second row.
 */
export function mergeSighting(seen: Sightings, next: ScannedDevice): Sightings {
  const prev = seen.get(next.id);
  const merged: ScannedDevice = prev
    ? {
        ...prev,
        ...(next.name ? { name: next.name } : {}),
        ...(next.rssi !== undefined ? { rssi: next.rssi } : {}),
        ...(next.deviceClass ? { deviceClass: next.deviceClass } : {}),
        serviceUuids: [...new Set([...prev.serviceUuids, ...next.serviceUuids])],
      }
    : { ...next, serviceUuids: [...next.serviceUuids] };
  const out = new Map(seen);
  out.set(next.id, merged);
  return out;
}

const NO_SIGNAL = Number.NEGATIVE_INFINITY;

/** Likely adapters first, then the stronger signal; ties keep the order first seen (a stable sort). */
export function sortDevices(devices: readonly ScannedDevice[]): ScannedDevice[] {
  return devices
    .map((device, seenAt) => ({ device, seenAt, likely: isLikelyObdAdapter(device) }))
    .sort(
      (a, b) =>
        Number(b.likely) - Number(a.likely) ||
        (b.device.rssi ?? NO_SIGNAL) - (a.device.rssi ?? NO_SIGNAL) ||
        a.seenAt - b.seenAt,
    )
    .map((x) => x.device);
}

/**
 * The display order, as device ids. With `frozen` (the order shown when a finger went down) the rows already
 * shown keep their places and devices found since are added after them, so nothing moves under the finger.
 */
export function displayOrder(seen: Sightings, lastUsed?: LastAdapter, frozen?: readonly string[]): string[] {
  const sorted = sortDevices([...seen.values()]).map((d) => d.id);
  const pinnedId = lastUsed && seen.has(lastUsed.id) ? lastUsed.id : undefined;
  const fresh = (pinnedId ? [pinnedId] : []).concat(sorted.filter((id) => id !== pinnedId));
  if (!frozen) return fresh;
  const kept = frozen.filter((id) => seen.has(id));
  return kept.concat(fresh.filter((id) => !kept.includes(id)));
}

/** Splits an order into the picker's groups. */
export function buildView(seen: Sightings, order: readonly string[], lastUsed?: LastAdapter): ScanView {
  const view: ScanView = { likely: [], other: [], count: 0 };
  for (const id of order) {
    const device = seen.get(id);
    if (!device) continue;
    view.count += 1;
    const row: ScanRow = { device, likely: isLikelyObdAdapter(device), lastUsed: lastUsed?.id === id };
    // Pinned only when the order put it first: one found while the order is held waits in its group.
    if (row.lastUsed && view.count === 1) view.pinned = row;
    else (row.likely ? view.likely : view.other).push(row);
  }
  return view;
}

/** The single row drawn as the white "top match" card: the pinned adapter, else the first likely one. */
export function topMatch(view: ScanView): ScanRow | undefined {
  return view.pinned ?? view.likely[0];
}
