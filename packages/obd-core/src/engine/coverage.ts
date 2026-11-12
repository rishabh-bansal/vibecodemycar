import { pidDefOrRaw, unitSymbol } from '@obdcraft/definitions';
import type { EcuInfo } from '../obd/context.ts';
import type { RequestStatus } from '../obd/records.ts';
import type { SessionStore } from './store.ts';

export interface PidCoverage {
  ecu: string;
  pid: string;
  name: string;
  units: string[];
  advertised: boolean;
  requests: number;
  decoded: number;
  lastStatus: RequestStatus | 'never_requested';
  /** Latest decoded value(s), formatted. */
  latest: string | null;
  confidence: string;
}

export interface CoverageSummary {
  advertised: number;
  decoded: number;
  neverRequested: number;
  failed: number;
  perEcu: Record<string, { advertised: number; decoded: number }>;
  rows: PidCoverage[];
}

/**
 * Coverage is derived from the request log every time it is asked for (v1
 * froze it at scan time, which is why its export said decoded=0).
 */
export function computeCoverage(ecus: Iterable<EcuInfo>, store: SessionStore): CoverageSummary {
  const rows: PidCoverage[] = [];
  const reqCount = new Map<string, { n: number; ok: number; last: RequestStatus }>();
  for (const r of store.records) {
    if (r.service !== 0x01) continue;
    for (const pid of r.params) {
      for (const [ecu, res] of Object.entries(r.ecus)) {
        const k = `${ecu}:${pid}`;
        const c = reqCount.get(k) ?? { n: 0, ok: 0, last: 'no_data' as RequestStatus };
        c.n++;
        // ok for this PID only if a reading for it exists from this record
        const ok = res.status === 'ok' && hasReading(store, ecu, pid, r.id);
        if (ok) c.ok++;
        c.last = ok
          ? 'decoded'
          : res.status === 'ok'
            ? 'invalid'
            : res.status === 'incomplete'
              ? 'incomplete'
              : res.status === 'negative'
                ? 'unsupported'
                : r.status === 'decoded' || r.status === 'invalid'
                  ? 'no_data'
                  : r.status;
        reqCount.set(k, c);
      }
    }
  }
  const perEcu: CoverageSummary['perEcu'] = {};
  for (const e of ecus) {
    let adv = 0;
    let dec = 0;
    for (const pid of [...e.pids].sort((a, b) => a - b)) {
      if (pid % 0x20 === 0) continue;
      const def = pidDefOrRaw(pid);
      const c = reqCount.get(`${e.id}:${pid}`);
      const latestVals = def
        ? def.fields
            .map((f) => store.latest.get(`${e.id}:${f.key}`))
            .filter((x) => x && x.state === 'ok')
            .map((x) => (x!.text !== undefined && x!.unit === null ? `${x!.short}: ${x!.text}` : `${x!.short}: ${fmt(x!.value)}${x!.unit ? ' ' + unitSymbol(x!.unit) : ''}`))
        : [];
      adv++;
      if (c && c.ok > 0) dec++;
      rows.push({
        ecu: e.id,
        pid: pid.toString(16).toUpperCase().padStart(2, '0'),
        name: def?.name ?? 'not in definition table',
        units: def ? [...new Set(def.fields.map((f) => unitSymbol(f.unit)).filter(Boolean))] : [],
        advertised: true,
        requests: c?.n ?? 0,
        decoded: c?.ok ?? 0,
        lastStatus: c ? c.last : 'never_requested',
        latest: latestVals.length ? latestVals.join('; ') : null,
        confidence: def?.confidence ?? 'none',
      });
    }
    perEcu[e.id] = { advertised: adv, decoded: dec };
  }
  return {
    advertised: rows.length,
    decoded: rows.filter((r) => r.decoded > 0).length,
    neverRequested: rows.filter((r) => r.requests === 0).length,
    failed: rows.filter((r) => r.requests > 0 && r.decoded === 0).length,
    perEcu,
    rows,
  };
}

function hasReading(store: SessionStore, ecu: string, pid: number, recordId: number): boolean {
  return store.decoded.has(`${ecu}:${pid.toString(16).toUpperCase().padStart(2, '0')}:${recordId}`);
}

function fmt(v: number | null): string {
  if (v === null) return '-';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}
