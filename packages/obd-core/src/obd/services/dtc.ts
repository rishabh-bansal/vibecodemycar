import { DTC, classifyDtc, dtcFromBytes, type DtcInfo } from '@obdcraft/definitions';
import type { ObdContext } from '../context.ts';
import type { RequestRecord } from '../records.ts';

export type DtcKind = 'stored' | 'pending' | 'permanent';

export interface DtcListResult {
  kind: DtcKind;
  service: number;
  /** "codes" = the ECU answered (maybe with zero codes); "unavailable" = no answer (NO DATA / not supported); "incomplete" = reply lost frames. */
  /** 'codes': at least one code; 'none': every answering ECU sent a complete, empty list. */
  state: 'codes' | 'none' | 'unavailable' | 'incomplete' | 'error';
  perEcu: { ecu: string; state: 'codes' | 'none' | 'unavailable' | 'incomplete'; declaredCount: number | null; codes: (DtcInfo & { ecu: string; kind: DtcKind })[] }[];
  record: RequestRecord;
}

const SERVICE: Record<DtcKind, number> = { stored: 0x03, pending: 0x07, permanent: 0x0a };

/**
 * Parses a 43/47/4A reply. CAN: count byte, then 2 bytes per code.
 * Non-CAN: no count byte, 3 codes per message padded with 0000.
 */
export function parseDtcPayload(payload: number[], can: boolean): { count: number | null; codes: string[] } {
  const body = payload.slice(1);
  if (can) {
    const count = body[0] ?? 0;
    const codes: string[] = [];
    for (let i = 1; i + 1 < body.length && codes.length < count; i += 2) codes.push(dtcFromBytes(body[i]!, body[i + 1]!));
    return { count, codes };
  }
  const codes: string[] = [];
  for (let i = 0; i + 1 < body.length; i += 2) {
    if (body[i] === 0 && body[i + 1] === 0) continue;
    codes.push(dtcFromBytes(body[i]!, body[i + 1]!));
  }
  return { count: null, codes };
}

export async function readDtcs(ctx: ObdContext, kind: DtcKind): Promise<DtcListResult> {
  const service = SERVICE[kind];
  const expect = [...ctx.ecus.keys()];
  const record = await ctx.runner.execute({ service, params: [], purpose: 'dtc', expectEcus: expect, maxAttempts: 3 });
  const can = ctx.link.protocol.family !== 'legacy';
  const perEcu: DtcListResult['perEcu'] = [];
  const seen = new Set<string>();
  for (const r of Object.values(record.ecus)) {
    if (r.status === 'ok') {
      // legacy protocols send 3 codes per message, as many messages as needed
      const payload = can ? r.payload : [r.payload[0]!, ...[r.payload, ...(r.more ?? [])].flatMap((m) => m.slice(1))];
      const { count, codes } = parseDtcPayload(payload, can);
      perEcu.push({
        ecu: r.ecu, state: codes.length ? 'codes' : 'none', declaredCount: count,
        codes: codes.map((c) => ({ ...classifyDtc(DTC, c), ecu: r.ecu, kind })),
      });
    } else if (r.status === 'incomplete') {
      perEcu.push({ ecu: r.ecu, state: 'incomplete', declaredCount: null, codes: [] });
    } else {
      perEcu.push({ ecu: r.ecu, state: 'unavailable', declaredCount: null, codes: [] });
    }
    seen.add(r.ecu);
  }
  const has = (st: string) => perEcu.some((p) => p.state === st);
  // one incomplete reply means "no codes" cannot be claimed for the car
  const state: DtcListResult['state'] = has('codes')
    ? 'codes'
    : has('incomplete')
      ? 'incomplete'
      : has('none')
        ? 'none'
        : record.status === 'error' || record.status === 'timeout'
        ? 'error'
        : 'unavailable';
  return { kind, service, state, perEcu, record };
}
