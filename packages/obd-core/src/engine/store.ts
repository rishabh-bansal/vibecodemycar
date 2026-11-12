import type { Reading } from '../obd/context.ts';
import type { RequestRecord, RequestStatus } from '../obd/records.ts';

/** In-memory session data: request log, latest value per data point, and a bounded history. */
export class SessionStore {
  readonly records: RequestRecord[] = [];
  private byId = new Map<number, RequestRecord>();
  readonly latest = new Map<string, Reading>();
  readonly history = new Map<string, { t: number; v: number }[]>();
  /** "ecu:pid:recordId" for every PID that decoded, so coverage can be derived from the log. */
  readonly decoded = new Set<string>();
  private listeners = new Set<(e: StoreEvent) => void>();

  private readonly maxRecords: number;
  private readonly maxHistory: number;

  constructor(maxRecords = 20_000, maxHistory = 6_000) {
    this.maxRecords = maxRecords;
    this.maxHistory = maxHistory;
  }

  on(cb: (e: StoreEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: StoreEvent) {
    for (const l of this.listeners) l(e);
  }

  /** Records may be updated in place (late replies); they are replaced, not duplicated. */
  addRecord(r: RequestRecord): void {
    if (!this.byId.has(r.id)) {
      this.records.push(r);
      this.byId.set(r.id, r);
      if (this.records.length > this.maxRecords) {
        const old = this.records.shift()!;
        this.byId.delete(old.id);
      }
    }
    this.emit({ type: 'record', record: r });
  }

  addReadings(rs: Reading[]): void {
    for (const r of rs) {
      // freeze-frame (service 02) values are history, not the current state
      if (r.service !== 1) continue;
      const k = `${r.ecu}:${r.key}`;
      this.decoded.add(`${r.ecu}:${r.pid}:${r.recordId}`);
      this.latest.set(k, r);
      if (r.value !== null && r.state === 'ok') {
        let h = this.history.get(k);
        if (!h) this.history.set(k, (h = []));
        h.push({ t: r.t, v: r.value });
        if (h.length > this.maxHistory) h.splice(0, h.length - this.maxHistory);
      }
    }
    if (rs.length) this.emit({ type: 'readings', readings: rs });
  }

  statusCounts(filter?: (r: RequestRecord) => boolean): Record<RequestStatus, number> {
    const out = { decoded: 0, unsupported: 0, no_data: 0, incomplete: 0, conflict: 0, timeout: 0, invalid: 0, error: 0, refused: 0 } as Record<RequestStatus, number>;
    for (const r of this.records) if (!filter || filter(r)) out[r.status]++;
    return out;
  }
}

export type StoreEvent = { type: 'record'; record: RequestRecord } | { type: 'readings'; readings: Reading[] };
