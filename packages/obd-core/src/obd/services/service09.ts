import { OBD } from '@obdcraft/definitions';
import { bitmapPids, type ObdContext } from '../context.ts';
import type { RequestRecord } from '../records.ts';
import { okResults } from '../request.ts';
import { toHex } from '../../util/hex.ts';

export interface InfoItem {
  pid: number;
  name: string;
  ecu: string;
  status: 'ok' | 'incomplete' | 'unavailable';
  /** Text for VIN / calibration IDs / ECU name; hex for CVN; counters for in-use tracking. */
  text?: string;
  list?: string[];
  counters?: { id: string; name: string; value: number }[];
  /** Filled from several attempts with verified agreement. */
  merged?: boolean;
  raw: string;
}

export interface VehicleIdentity {
  vin: string | null;
  vinSource: string | null;
  items: InfoItem[];
  supported: Record<string, number[]>;
  records: RequestRecord[];
}

const printable = (bytes: number[]) =>
  String.fromCharCode(...bytes.filter((b) => b !== 0)).replace(/[^\x20-\x7e]/g, '').trim();

/**
 * CAN format: 49 PID NODI data. NODI = number of data items.
 * Legacy format: each message carries a sequence byte; caller passes the concatenated data.
 */
export function decodeInfoItem(pid: number, data: number[], can: boolean): Omit<InfoItem, 'ecu' | 'status' | 'raw' | 'name' | 'pid'> {
  const def = OBD.mode09.find((m) => parseInt(m.pid, 16) === pid);
  const body = can ? data.slice(1) : data;
  const count = can ? (data[0] ?? 1) : 1;
  switch (def?.kind) {
    case 'ascii':
      return { text: printable(body) };
    case 'ascii_list': {
      const n = def.item_bytes ?? 16;
      const list: string[] = [];
      for (let i = 0; i < Math.max(count, 1) && i * n < body.length; i++) list.push(printable(body.slice(i * n, (i + 1) * n)));
      return { list, text: list.join(', ') };
    }
    case 'hex_list': {
      const n = def.item_bytes ?? 4;
      const list: string[] = [];
      for (let i = 0; i * n < body.length && i < Math.max(count, 1); i++) list.push(toHex(body.slice(i * n, (i + 1) * n), ''));
      return { list, text: list.join(', ') };
    }
    case 'uint16_list': {
      const items = def.items ?? [];
      const counters: { id: string; name: string; value: number }[] = [];
      for (let i = 0; i * 2 + 1 < body.length && i < (can ? count : items.length); i++) {
        const id = items[i] ?? `item${i + 1}`;
        counters.push({ id, name: OBD.ipt_names[id] ?? id, value: body[i * 2]! * 256 + body[i * 2 + 1]! });
      }
      return { counters, text: counters.map((c) => `${c.id}=${c.value}`).join(' ') };
    }
    default:
      return { text: toHex(body) };
  }
}

/**
 * Service 09: support (0900) per ECU, then VIN, calibration IDs, CVNs, ECU
 * names and in-use performance tracking. All are multi-frame on CAN; static
 * data, so holes may be filled across attempts when every overlap agrees.
 */
export async function readIdentity(ctx: ObdContext): Promise<VehicleIdentity> {
  const records: RequestRecord[] = [];
  const can = ctx.link.protocol.family !== 'legacy';
  const expectAll = [...ctx.ecus.keys()];
  const sup = await ctx.runner.execute({ service: 0x09, params: [0x00], purpose: 'identity', expectEcus: expectAll, maxAttempts: 3 });
  records.push(sup);
  const supported: Record<string, number[]> = {};
  for (const r of okResults(sup)) {
    const off = !can && r.payload.length >= 7 ? 3 : 2;
    const list = bitmapPids(0, r.payload.slice(off, off + 4));
    supported[r.ecu] = list;
    const info = ctx.ecus.get(r.ecu);
    if (info) for (const p of list) info.infoPids.add(p);
  }
  const items: InfoItem[] = [];
  const order = can ? [0x02, 0x04, 0x06, 0x0a, 0x08, 0x0b, 0x0d] : [0x02, 0x04, 0x06, 0x0a, 0x08, 0x0b];
  for (const pid of order) {
    const expect = Object.entries(supported).filter(([, l]) => l.includes(pid)).map(([e]) => e);
    if (expect.length === 0) continue;
    const def = OBD.mode09.find((m) => parseInt(m.pid, 16) === pid)!;
    const rec = await ctx.runner.execute({ service: 0x09, params: [pid], purpose: 'identity', expectEcus: expect, maxAttempts: 5, mergeStatic: true });
    records.push(rec);
    for (const e of expect) {
      const r = rec.ecus[e];
      if (r?.status === 'ok') {
        // legacy: "49 PID SEQ d d d d" per message, joined in sequence order
        const data = can
          ? r.payload.slice(2)
          : [r.payload, ...(r.more ?? [])].sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0)).flatMap((m) => m.slice(3));
        items.push({ pid, name: def.name, ecu: e, status: 'ok', ...decodeInfoItem(pid, data, can), ...(r.merged ? { merged: true } : {}), raw: toHex(r.payload) });
      } else {
        items.push({ pid, name: def.name, ecu: e, status: r?.status === 'incomplete' ? 'incomplete' : 'unavailable', raw: r ? toHex(r.payload) : '' });
      }
    }
  }
  for (const it of items) {
    if (it.pid === 0x0a && it.status === 'ok' && it.text) {
      const info = ctx.ecus.get(it.ecu);
      if (info) info.name = it.text;
    }
  }
  const vinItem = items.find((i) => i.pid === 0x02 && i.status === 'ok' && i.text && i.text.length === 17);
  return { vin: vinItem?.text ?? null, vinSource: vinItem?.ecu ?? null, items, supported, records };
}
