import type { BleObservation } from '@obdcraft/obd-core';
import { BUILD_INFO } from '../../config/build.ts';
import type { WireTrace } from '../../domain/coding/audit.ts';
import { type DiagEvent, onDiag } from '../../domain/diagnostics.ts';
import { type ConnectionLog, createVinWatcher, createWireRedactor } from '../../domain/logs/redact.ts';
import { normalizeVin } from '../../domain/vin.ts';
import { db, type ObdcraftDb } from '../storage/db.ts';

/**
 * Records every adapter command of a connection — setup, identification, reads, coding — and the app's stage
 * events, from the first adapter command to the disconnect. The VIN reply is kept as received, and the VIN it
 * carries is recorded on the log (`vin`, on this chunk and every later one); serial-number replies are blanked
 * as they arrive. Entries are saved locally within a second, in chunks
 * that close when full (CHUNK_ENTRIES entries or about CHUNK_BYTES) or a minute old, so a long connection
 * uploads as it goes; each closed chunk tells the uploader (`onChunkClosed`). Recording never throws into
 * the link.
 */

const CHUNK_ENTRIES = 1500;
/** Well under the Worker's 1.5 MB item limit, counting JSON escaping and the item envelope. */
const CHUNK_BYTES = 900_000;
const CHUNK_MAX_AGE_MS = 60_000;
const FLUSH_MS = 1000;
const MAX_TEXT = 4096;

const active = new Set<ConnectionLogger>();
/** Loggers of connections still being recorded (for the page lifecycle: flush or end them on exit). */
export const activeConnectionLoggers = (): readonly ConnectionLogger[] => [...active];

export class ConnectionLogger {
  readonly session = crypto.randomUUID();
  private chunk = 0;
  private log: ConnectionLog;
  private readonly redact = createWireRedactor();
  private readonly watchVin = createVinWatcher();
  private vin: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private stopped = false;
  private bytes = 0;
  private openedAt = Date.now();

  private readonly database: () => ObdcraftDb;
  private readonly buildId: string;
  private readonly onChunkClosed: () => void;

  constructor(
    database: () => ObdcraftDb = db,
    buildId: string = import.meta.env?.VITE_BUILD_ID || 'development',
    onChunkClosed: () => void = () => {},
  ) {
    this.database = database;
    this.buildId = buildId;
    this.onChunkClosed = onChunkClosed;
    this.log = this.fresh();
    this.unsubscribe = onDiag((e) => this.event(e));
    active.add(this);
    this.push({ at: new Date().toISOString(), direction: 'event', text: 'connection-log started' });
  }

  private fresh(): ConnectionLog {
    const at = new Date().toISOString();
    this.bytes = 0;
    this.openedAt = Date.now();
    return {
      schema: 'obdcraft.connection-log/1',
      id: `${this.session}-${String(this.chunk).padStart(4, '0')}`,
      session: this.session,
      chunk: this.chunk,
      startedAt: at,
      updatedAt: at,
      buildId: this.buildId,
      ...(this.vin ? { vin: this.vin } : {}),
      ...BUILD_INFO,
      entries: [],
      closed: false,
    };
  }

  /** The link's wire listener: one adapter line. */
  readonly wire = (entry: WireTrace): void => {
    this.push({ at: entry.at, monoMs: entry.elapsedMs, direction: entry.direction, text: entry.text });
  };

  /** Uses the batched log directly: per-packet metrics must not synchronously rewrite localStorage. */
  readonly bluetooth = (entry: BleObservation): void => {
    this.push({
      at: entry.at,
      monoMs: entry.monoMs,
      direction: 'event',
      text: `ble:${entry.kind} ${JSON.stringify(entry.details)}`,
    });
  };

  /** The car's VIN, when the app identified it by other means than this log's wire trace. */
  setVin(vin: string): void {
    if (this.stopped || !vin.trim()) return;
    this.vin = normalizeVin(vin);
    this.log.vin = this.vin;
  }

  private event(e: DiagEvent): void {
    const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : '';
    this.push({ at: e.at, direction: 'event', text: `${e.stage}:${e.kind}${detail}` });
  }

  private push(entry: ConnectionLog['entries'][number]): void {
    if (this.stopped) return;
    try {
      const vin = this.watchVin(entry);
      if (vin && !this.vin) this.setVin(vin);
      const stored = this.redact({ ...entry, text: entry.text.slice(0, MAX_TEXT) });
      this.log.entries.push(stored);
      // JSON escaping can double control characters: count generously.
      this.bytes += stored.text.length * 2 + 80;
      this.log.updatedAt = entry.at;
      if (
        this.log.entries.length >= CHUNK_ENTRIES ||
        this.bytes >= CHUNK_BYTES ||
        Date.now() - this.openedAt >= CHUNK_MAX_AGE_MS
      )
        this.rotate();
      else
        this.timer ??= setTimeout(() => {
          this.timer = undefined;
          if (this.stopped) return;
          if (Date.now() - this.openedAt >= CHUNK_MAX_AGE_MS) this.rotate();
          else this.save();
        }, FLUSH_MS);
    } catch {
      // Recording must never affect the connection.
    }
  }

  /** Closes the current chunk (saved, then announced for upload) and continues in the next one. */
  private rotate(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.log.closed = true;
    this.save(true);
    this.chunk++;
    this.log = this.fresh();
  }

  private save(announce = false): ConnectionLog {
    const snapshot = structuredClone(this.log);
    this.saving = this.saving
      .then(() => this.database().connectionLogs.put(snapshot))
      .then(
        () => {
          if (announce) this.onChunkClosed();
        },
        () => undefined,
      );
    return snapshot;
  }

  /** Saves the open chunk now (the page is being hidden) and returns a copy of it. Recording continues. */
  flush(): ConnectionLog {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.save();
  }

  /**
   * Ends the log at once (the page is going away): closes and saves the last chunk and returns it, so it can
   * still be sent. Saving continues in the background.
   */
  end(reason: string): ConnectionLog | undefined {
    if (this.stopped) return undefined;
    this.push({ at: new Date().toISOString(), direction: 'event', text: `connection-log ended: ${reason}` });
    this.stopped = true;
    active.delete(this);
    this.unsubscribe();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // The end marker may itself have filled (and closed) the last chunk: no empty chunk after it.
    if (this.log.entries.length === 0) return undefined;
    this.log.closed = true;
    return this.save(true);
  }

  /** Ends the log (disconnect, failed connect). Resolves once it is saved. */
  async stop(reason: string): Promise<void> {
    this.end(reason);
    return this.saving;
  }
}
