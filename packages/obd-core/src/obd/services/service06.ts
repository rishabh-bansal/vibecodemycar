import { MODE06, decodeMode06Records, type Mode06Test } from '@obdcraft/definitions';
import { bitmapPids, type ObdContext } from '../context.ts';
import type { RequestRecord } from '../records.ts';
import { okResults } from '../request.ts';

export interface Mode06Result {
  /** CAN only: service 06 is MID-based; on legacy protocols the format differs and is not decoded. */
  applicable: boolean;
  perEcu: {
    ecu: string;
    mids: number[];
    /** partialReply: from a reply that lost a later frame; the record itself arrived whole. */
    tests: (Mode06Test & { partialReply?: boolean })[];
    /** MIDs whose reply was incomplete or missing after retries. */
    failedMids: { mid: number; status: string }[];
  }[];
  records: RequestRecord[];
}

const isPage = (mid: number) => mid % 0x20 === 0;

/** Service 06: supported MIDs per ECU (0600, 0620 ...), then every supported MID. Read-only. */
export async function readMonitorTests(ctx: ObdContext): Promise<Mode06Result> {
  const records: RequestRecord[] = [];
  if (ctx.link.protocol.family === 'legacy') return { applicable: false, perEcu: [], records };
  const announced = new Map<string, Set<number>>();
  for (let page = 0; page <= 0xe0; page += 0x20) {
    const expect = page === 0 ? [...ctx.ecus.keys()] : [...announced.entries()].filter(([, s]) => s.has(page)).map(([e]) => e);
    if (page !== 0 && expect.length === 0) break;
    const rec = await ctx.runner.execute({ service: 0x06, params: [page], purpose: 'monitor', expectEcus: expect, maxAttempts: 2 });
    records.push(rec);
    for (const r of okResults(rec)) {
      const data = r.payload.slice(2, 6);
      if (data.length < 4) continue;
      const info = ctx.ecus.get(r.ecu);
      const list = bitmapPids(page, data);
      if (info) for (const m of list) info.mids.add(m);
      const ann = announced.get(r.ecu) ?? new Set<number>();
      if (list.includes(page + 0x20)) ann.add(page + 0x20);
      announced.set(r.ecu, ann);
    }
  }
  const perEcu: Mode06Result['perEcu'] = [];
  for (const info of ctx.ecus.values()) {
    const mids = [...info.mids].filter((m) => !isPage(m)).sort((a, b) => a - b);
    if (mids.length === 0) continue;
    const entry: Mode06Result['perEcu'][number] = { ecu: info.id, mids, tests: [], failedMids: [] };
    for (const mid of mids) {
      const rec = await ctx.runner.execute({ service: 0x06, params: [mid], purpose: 'monitor', expectEcus: [info.id], maxAttempts: 3 });
      records.push(rec);
      const r = rec.ecus[info.id];
      if (r?.status === 'incomplete' && r.payload[0] === 0x46 && r.payload.length > 9) {
        // each 9-byte record stands alone: keep the ones that arrived whole before the lost frame
        const { tests } = decodeMode06Records(MODE06, r.payload.slice(1));
        const whole = tests.filter((t) => parseInt(t.mid, 16) === mid);
        entry.tests.push(...whole.map((t) => ({ ...t, partialReply: true })));
        entry.failedMids.push({ mid, status: `incomplete (${whole.length} complete record(s) kept)` });
        continue;
      }
      if (r?.status !== 'ok') {
        entry.failedMids.push({ mid, status: r?.status ?? rec.status });
        continue;
      }
      const { tests } = decodeMode06Records(MODE06, r.payload.slice(1));
      entry.tests.push(...tests);
    }
    perEcu.push(entry);
  }
  return { applicable: true, perEcu, records };
}
