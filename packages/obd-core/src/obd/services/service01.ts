import { decodePid, pidDef, pidDefOrRaw, type DecodedPid, type PidDef } from '@obdcraft/definitions';
import { physicalRequestId } from '../../elm/link.ts';
import { bitmapPids, newEcu, readingsFrom, type EcuInfo, type ObdContext, type Reading } from '../context.ts';
import type { RequestRecord } from '../records.ts';
import { okResults, type ObdRequest } from '../request.ts';

export interface SupportDiscovery {
  ecus: EcuInfo[];
  records: RequestRecord[];
}

/**
 * Service 01 support discovery, per ECU: 0100, then 0120 / 0140 ... while any
 * ECU says the next page exists. An ECU that answered page n but not page n+1
 * although it announced it is retried.
 */
export async function discoverSupport(ctx: ObdContext, service = 0x01): Promise<SupportDiscovery> {
  const records: RequestRecord[] = [];
  const announced = new Map<string, Set<number>>();
  let page = 0x00;
  const expectFor = (p: number) => [...announced.entries()].filter(([, s]) => s.has(p)).map(([e]) => e);
  while (page <= 0xe0) {
    const expect = page === 0 ? [] : expectFor(page);
    if (page !== 0 && expect.length === 0) break;
    const params = service === 0x02 ? [page, 0x00] : [page];
    const rec = await ctx.runner.execute({
      service, params, purpose: 'discovery', expectEcus: expect, retryNoData: page === 0, maxAttempts: page === 0 ? 4 : 3,
      timeoutMs: page === 0 && ctx.link.protocol.number === 0 ? 15000 : undefined,
    });
    records.push(rec);
    for (const r of okResults(rec)) {
      const data = service === 0x02 ? r.payload.slice(3, 7) : r.payload.slice(2, 6);
      if (data.length < 4) continue;
      let ecu = ctx.ecus.get(r.ecu);
      if (!ecu) {
        ecu = newEcu(r.ecu, physicalRequestId(r.ecu));
        ctx.ecus.set(r.ecu, ecu);
      }
      const target = service === 0x02 ? ecu.freezePids : ecu.pids;
      target.add(page);
      const list = bitmapPids(page, data);
      for (const p of list) target.add(p);
      const ann = announced.get(r.ecu) ?? new Set<number>();
      if (list.includes(page + 0x20)) ann.add(page + 0x20);
      announced.set(r.ecu, ann);
    }
    page += 0x20;
  }
  classifyRoles(ctx);
  return { ecus: [...ctx.ecus.values()], records };
}

/**
 * Standard ECU addresses: engine 7E8 / 18DAF110 / source 10 (K-line, J1850),
 * gearbox 7E9 / 18DAF118 / source 18. When no ECU sits at the engine address,
 * the one with the most PIDs is taken as the engine.
 */
export function classifyRoles(ctx: ObdContext): void {
  const list = [...ctx.ecus.values()];
  if (list.length === 0) return;
  const addr = (id: string) => (/^7E[8-F]$/.test(id) ? 0x10 + (parseInt(id, 16) - 0x7e8) * 8 : parseInt(id.slice(-2), 16));
  const engine = list.find((e) => addr(e.id) === 0x10) ?? [...list].sort((a, b) => b.pids.size - a.pids.size)[0]!;
  for (const e of list) e.role = e === engine ? 'engine' : addr(e.id) === 0x18 ? 'transmission' : 'other';
}

/** Data length this ECU uses for a PID: fixed definitions, or a learned variant. */
export function knownLength(def: PidDef, ecu: EcuInfo | undefined): number | null {
  if (def.lengths.length === 1) return def.lengths[0]!;
  return ecu?.learnedLengths.get(parseInt(def.pid, 16)) ?? null;
}

export interface ParsedPid {
  pid: number;
  data: number[];
}

/**
 * Splits a service 01 reply (41 PID data [PID data ...]) into PIDs using the
 * definition lengths. A variable-length PID is only accepted when its length is
 * known for this ECU, or when it is the last PID (it takes the rest).
 * Returns null when the reply does not parse exactly.
 */
export function splitMode01(payload: number[], requested: number[], ecu: EcuInfo | undefined, offset = 1): ParsedPid[] | null {
  if (requested.length === 1) {
    // single PID: everything after the PID is its data; the decoder judges the length
    return payload[offset] === requested[0] ? [{ pid: requested[0]!, data: payload.slice(offset + 1) }] : null;
  }
  const out: ParsedPid[] = [];
  let i = offset;
  while (i < payload.length) {
    const pid = payload[i]!;
    if (!requested.includes(pid) || out.some((o) => o.pid === pid)) return null;
    const def = pidDef(pid);
    if (!def) return null;
    const rest = payload.length - i - 1;
    let len = knownLength(def, ecu);
    if (len === null) {
      // variable length and unknown: only valid if it is the last item and the rest is a valid length
      if (!def.lengths.includes(rest)) {
        // multi-PID: try each valid length that leaves a parseable tail
        const opt = def.lengths.find((l) => l < rest && requested.includes(payload[i + 1 + l]!));
        if (opt === undefined) return null;
        len = opt;
      } else len = rest;
    }
    if (len > rest) return null;
    out.push({ pid, data: payload.slice(i + 1, i + 1 + len) });
    i += 1 + len;
  }
  return out.length ? out : null;
}

export interface Mode01Result {
  record: RequestRecord;
  decoded: { ecu: string; pid: number; decoded: DecodedPid }[];
  readings: Reading[];
  /** PIDs requested that this ECU should have answered but did not. */
  missing: { ecu: string; pid: number }[];
  /** True when an ECU answered but the reply could not be split (multi-PID mis-parse). */
  parseFailed: string[];
}

export async function readMode01(ctx: ObdContext, pids: number[], req: Partial<ObdRequest> = {}): Promise<Mode01Result> {
  const expect = req.expectEcus ?? [...ctx.ecus.values()].filter((e) => pids.some((p) => e.pids.has(p))).map((e) => e.id);
  // `expectEcus` last: a caller passing `expectEcus: undefined` must not erase the computed list.
  const record = await ctx.runner.execute({ service: 0x01, params: pids, purpose: 'scan', ...req, expectEcus: expect });
  return decodeMode01Record(ctx, record, pids);
}

export function decodeMode01Record(ctx: ObdContext, record: RequestRecord, pids: number[]): Mode01Result {
  const decoded: Mode01Result['decoded'] = [];
  const readings: Reading[] = [];
  const parseFailed: string[] = [];
  const got = new Set<string>();
  const t = record.endedAt;
  for (const r of okResults(record)) {
    const ecu = ctx.ecus.get(r.ecu);
    const parts = splitMode01(r.payload, pids, ecu);
    if (!parts) {
      parseFailed.push(r.ecu);
      continue;
    }
    for (const part of parts) {
      const def = pidDefOrRaw(part.pid)!;
      const d = decodePid(ctx.defs, def, part.data);
      if (d.status === 'decoded' && def.lengths.length > 1 && ecu && pids.length === 1) ecu.learnedLengths.set(part.pid, part.data.length);
      decoded.push({ ecu: r.ecu, pid: part.pid, decoded: d });
      if (d.status === 'decoded') {
        got.add(`${r.ecu}:${part.pid}`);
        readings.push(...readingsFrom(d, r.ecu, 1, t, record.id));
      }
    }
  }
  if (record.status === 'decoded' && readings.length === 0) {
    record.status = 'invalid';
    record.note = parseFailed.length
      ? `reply from ${parseFailed.join(', ')} could not be split into the requested PIDs`
      : decoded.map((d) => `${d.ecu} ${d.decoded.pid}: ${d.decoded.error ?? 'invalid'}`).join('; ');
  }
  const missing: Mode01Result['missing'] = [];
  for (const e of record.expectEcus) {
    const info = ctx.ecus.get(e);
    for (const p of pids) if ((!info || info.pids.has(p)) && !got.has(`${e}:${p}`)) missing.push({ ecu: e, pid: p });
  }
  return { record, decoded, readings, missing, parseFailed };
}
