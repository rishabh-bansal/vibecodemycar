import { decodePid, dtcFromBytes, pidDefOrRaw, DTC, classifyDtc, type DtcInfo } from '@obdcraft/definitions';
import { readingsFrom, type ObdContext, type Reading } from '../context.ts';
import type { RequestRecord } from '../records.ts';
import { discoverSupport } from './service01.ts';

export interface FreezeFrameResult {
  perEcu: {
    ecu: string;
    /** "none" = 0202 answered 0000: no freeze frame stored. */
    state: 'stored' | 'none' | 'unavailable';
    dtc: (DtcInfo & { ecu: string }) | null;
    readings: Reading[];
  }[];
  records: RequestRecord[];
}

/**
 * Freeze frame 00: read 0202 (the code that stored it) first. 0000 means no
 * frame is stored and nothing else is requested. Otherwise read the service 02
 * support pages and every supported PID of frame 00.
 */
export async function readFreezeFrame(ctx: ObdContext): Promise<FreezeFrameResult> {
  const records: RequestRecord[] = [];
  const expect = [...ctx.ecus.keys()];
  const head = await ctx.runner.execute({ service: 0x02, params: [0x02, 0x00], purpose: 'freeze', expectEcus: expect });
  records.push(head);
  const perEcu: FreezeFrameResult['perEcu'] = [];
  const stored: string[] = [];
  for (const e of expect) {
    const r = head.ecus[e];
    if (!r || r.status !== 'ok' || r.payload.length < 5) {
      perEcu.push({ ecu: e, state: 'unavailable', dtc: null, readings: [] });
      continue;
    }
    const hi = r.payload[3]!;
    const lo = r.payload[4]!;
    if (hi === 0 && lo === 0) {
      perEcu.push({ ecu: e, state: 'none', dtc: null, readings: [] });
      continue;
    }
    stored.push(e);
    perEcu.push({ ecu: e, state: 'stored', dtc: { ...classifyDtc(DTC, dtcFromBytes(hi, lo)), ecu: e }, readings: [] });
  }
  if (stored.length === 0) return { perEcu, records };
  const sup = await discoverSupport(ctx, 0x02);
  records.push(...sup.records);
  for (const e of stored) {
    const info = ctx.ecus.get(e)!;
    const entry = perEcu.find((p) => p.ecu === e)!;
    for (const pid of [...info.freezePids].sort((a, b) => a - b)) {
      if (pid % 0x20 === 0 || pid === 0x02) continue;
      const def = pidDefOrRaw(pid);
      if (!def) continue;
      const rec = await ctx.runner.execute({ service: 0x02, params: [pid, 0x00], purpose: 'freeze', expectEcus: [e], timeoutMs: undefined });
      records.push(rec);
      const r = rec.ecus[e];
      if (r?.status !== 'ok') continue;
      const d = decodePid(ctx.defs, def, r.payload.slice(3));
      if (d.status === 'decoded') entry.readings.push(...readingsFrom(d, e, 2, rec.endedAt, rec.id));
    }
  }
  return { perEcu, records };
}
