import { BUILD_INFO } from '../../config/build.ts';
import type { BackupRecord } from '../../domain/backups/schema.ts';
import type { ExperimentRecord } from '../../domain/coding/audit.ts';
import type { LogItem, LogKind } from '../../domain/logs/contract.ts';
import {
  type ConnectionLog,
  experimentItem,
  fitItem,
  journalItem,
  sessionItem,
  unpreparedItem,
} from '../../domain/logs/redact.ts';
import { db, type ObdcraftDb } from '../storage/db.ts';
import { unsavedExperiments } from '../storage/unsaved.ts';
import { ensureCollector } from './api.ts';
import {
  type CloudEnrollment,
  logEndpoint,
  readEnrollment,
  retireEnrollment,
  uploadsOptedOut,
} from './config.ts';

/**
 * The durable outbox of the private cloud log. Records are persisted locally first (experiments, operation
 * journals and connection logs, in their own tables); this table only tracks each one's upload state. EVERY
 * local record uploads automatically — whenever it was made, enrolled or not at the time — unless this browser
 * opted out. Uploads are idempotent (the item id is the record id; the Worker ignores identical content).
 *
 * Nothing is given up for good: transient failures (offline, 5xx, 429) retry with backoff capped at an hour,
 * a used-up daily budget waits for the next UTC day, and an item the server refused is tried again after a
 * day or with the next build. This module reads local records and talks HTTP — it has no access to the car,
 * so no upload, failure or retry can ever start or repeat a vehicle operation.
 */

export type OutboxStatus = 'queued' | 'uploaded' | 'failed';

export interface OutboxEntry {
  /** `${kind}:${id}` */
  key: string;
  kind: LogKind;
  id: string;
  status: OutboxStatus;
  /** Hash of the item last queued; `uploadedHash` of the one the Worker accepted. */
  contentHash: string;
  uploadedHash?: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  updatedAt: string;
  /** The record's `updatedAt` and the build when `contentHash` was computed: unchanged ⇒ no rebuild needed. */
  sourceUpdatedAt?: string;
  builtBy?: string;
  /** Queued by an explicit user action. Kept for older entries; every record uploads automatically now. */
  manual?: true;
  /** The owner deleted the cloud copy: never re-uploaded automatically, only by an explicit upload. */
  deleted?: true;
}

const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
/** A refused item is tried again after this long (or at once with a new build). */
export const FAILED_RETRY_MS = 86_400_000;
export const backoffMs = (attempts: number): number =>
  Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, Math.min(20, attempts - 1)));

const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

const BUILD_ID: string = import.meta.env?.VITE_BUILD_ID || 'development';

type LocalRecord = ExperimentRecord | BackupRecord | ConnectionLog;

const timesOf = (kind: LogKind, r: LocalRecord) => ({
  createdAt:
    kind === 'journal' ? (r as BackupRecord).createdAt : (r as ExperimentRecord | ConnectionLog).startedAt,
  updatedAt: r.updatedAt,
});

/**
 * The item to upload for a record and its exact JSON text, fitted to the Worker's size limit. A record that cannot
 * be turned into an item becomes a minimal item saying so — never silence.
 */
export function buildUpload(kind: LogKind, record: LocalRecord): { item: LogItem; text: string } {
  let item: LogItem;
  try {
    item =
      kind === 'experiment'
        ? experimentItem(record as ExperimentRecord)
        : kind === 'session'
          ? sessionItem(record as ConnectionLog)
          : journalItem(record as BackupRecord);
  } catch (e) {
    const reason = `The record could not be prepared for upload (${e instanceof Error ? e.name : 'error'}).`;
    const buildId =
      (record as { buildId?: string }).buildId ?? (record as BackupRecord).build?.buildId ?? BUILD_ID;
    item = unpreparedItem(kind, record.id, timesOf(kind, record), buildId, BUILD_INFO, reason);
  }
  return fitItem(item);
}

async function load(database: ObdcraftDb, kind: LogKind, id: string): Promise<LocalRecord | undefined> {
  const stored = await (kind === 'experiment'
    ? database.experiments.get(id)
    : kind === 'session'
      ? database.connectionLogs.get(id)
      : database.backups.get(id));
  // A run IndexedDB could not save still uploads from its in-memory copy.
  return stored ?? (kind === 'experiment' ? unsavedExperiments.get(id) : undefined);
}

/** Queues (or re-queues, when changed) one record. Never sends anything. */
async function queue(
  database: ObdcraftDb,
  kind: LogKind,
  record: LocalRecord,
  now: Date,
  current: OutboxEntry | undefined,
  manual = false,
): Promise<void> {
  const key = `${kind}:${record.id}`;
  const hash = await sha256(buildUpload(kind, record).text);
  const seen = { sourceUpdatedAt: record.updatedAt, builtBy: BUILD_ID };
  if (current && (current.deleted || current.contentHash === hash || current.uploadedHash === hash)) {
    // Same content: keep its state (a refused item is retried by the daily / new-build rule, not every scan).
    await database.outbox.update(key, seen);
    return;
  }
  await database.outbox.put({
    key,
    kind,
    id: record.id,
    status: 'queued',
    contentHash: hash,
    ...(current?.uploadedHash ? { uploadedHash: current.uploadedHash } : {}),
    attempts: 0,
    nextAttemptAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...seen,
    ...(manual || current?.manual ? { manual: true as const } : {}),
  });
}

/** A connection log uploads when its chunk is closed, or once it has been quiet for two minutes (a crash). */
const SESSION_QUIET_MS = 120_000;
/** Incremental scans look this far behind the last scan, so a record saved mid-scan is never missed. */
const SCAN_OVERLAP_MS = 600_000;
/** A full scan (every record) at least this often, besides the first scan of every page. */
const FULL_SCAN_MS = 3_600_000;
let lastScan: { at: number; full: number; database: ObdcraftDb } | undefined;

/**
 * Queues every local record that changed since its last upload — all of them, from any time — and puts refused
 * items back in the queue after a day or with a new build. The first scan of a page (and one an hour) reads
 * every record; the others read only records updated since the previous scan. Never sends anything.
 */
export async function syncOutbox(
  _enrollment: CloudEnrollment | undefined = readEnrollment(),
  database: () => ObdcraftDb = db,
  now = new Date(),
  options: { full?: boolean } = {},
): Promise<void> {
  const d = database();
  const t = now.getTime();
  const full =
    options.full ||
    !lastScan ||
    lastScan.database !== d ||
    t - lastScan.full >= FULL_SCAN_MS ||
    t < lastScan.at;
  const since = full || !lastScan ? '' : new Date(lastScan.at - SCAN_OVERLAP_MS).toISOString();
  const [experiments, journals, sessions, entries] = await Promise.all([
    since ? d.experiments.where('updatedAt').aboveOrEqual(since).toArray() : d.experiments.toArray(),
    since ? d.backups.where('updatedAt').aboveOrEqual(since).toArray() : d.backups.toArray(),
    since ? d.connectionLogs.where('updatedAt').aboveOrEqual(since).toArray() : d.connectionLogs.toArray(),
    d.outbox.toArray(),
  ]);
  lastScan = { at: t, full: full ? t : (lastScan?.full ?? t), database: d };
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const visit = async (kind: LogKind, record: LocalRecord) => {
    const current = byKey.get(`${kind}:${record.id}`);
    if (current && current.sourceUpdatedAt === record.updatedAt && current.builtBy === BUILD_ID) return;
    await queue(d, kind, record, now, current);
  };
  for (const e of experiments) await visit('experiment', e);
  for (const e of unsavedExperiments.values()) await visit('experiment', e);
  for (const b of journals) await visit('journal', b);
  const quietSince = new Date(t - SESSION_QUIET_MS).toISOString();
  for (const s of sessions) if (s.closed || s.updatedAt < quietSince) await visit('session', s);
  // Refused items are not dead: tried again a day later, or straight away by a new build (which may fix them).
  const retryBefore = new Date(t - FAILED_RETRY_MS).toISOString();
  await d.outbox
    .where('status')
    .equals('failed')
    .filter((e) => !e.deleted && (e.updatedAt <= retryBefore || e.builtBy !== BUILD_ID))
    .modify((e) => {
      e.status = 'queued';
      e.attempts = 0;
      e.nextAttemptAt = now.toISOString();
      e.updatedAt = now.toISOString();
      e.builtBy = BUILD_ID;
      e.sourceUpdatedAt = undefined; // rebuild it on the next scan
    });
}

/** Queues one record now (for example from its history entry), whatever its state. */
export async function enqueueManual(
  kind: LogKind,
  id: string,
  database: () => ObdcraftDb = db,
  now = new Date(),
): Promise<void> {
  const d = database();
  const key = `${kind}:${id}`;
  const current = await d.outbox.get(key);
  if (current)
    await d.outbox.update(key, {
      manual: true,
      deleted: undefined,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now.toISOString(),
    });
  const record = await load(d, kind, id);
  if (record) await queue(d, kind, record, now, await d.outbox.get(key), true);
}

/** Puts failed entries back in the queue now (the panel's button; also done on every app start). */
export async function retryFailed(database: () => ObdcraftDb = db, now = new Date()): Promise<void> {
  await database()
    .outbox.where('status')
    .equals('failed')
    .filter((e) => !e.deleted)
    .modify({ status: 'queued', attempts: 0, nextAttemptAt: now.toISOString() });
}

const nextUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));

let draining: Promise<void> | undefined;

/**
 * Uploads every due entry once (at most one drain at a time). Each item is rebuilt from the local record at
 * send time, so what is sent is always what is stored now.
 */
export function drainOutbox(
  options: {
    enrollment?: CloudEnrollment;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    database?: () => ObdcraftDb;
    now?: () => Date;
  } = {},
): Promise<void> {
  draining ??= (async () => {
    try {
      await drain(options);
    } finally {
      draining = undefined;
    }
  })();
  return draining;
}

async function drain(options: Parameters<typeof drainOutbox>[0] = {}): Promise<void> {
  const enrollment = options.enrollment ?? readEnrollment();
  const endpoint = options.endpoint ?? logEndpoint();
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const d = (options.database ?? db)();
  const now = options.now ?? (() => new Date());
  if (!enrollment || !endpoint || uploadsOptedOut()) return;
  const due = await d.outbox
    .where('status')
    .equals('queued')
    .filter((e) => e.nextAttemptAt <= now().toISOString())
    .toArray();
  for (const entry of due) {
    const record = await load(d, entry.kind, entry.id);
    if (!record) {
      await d.outbox.delete(entry.key);
      continue;
    }
    const { text: body } = buildUpload(entry.kind, record);
    const hash = await sha256(body);
    const settle = (patch: Partial<OutboxEntry>) =>
      d.outbox.update(entry.key, { ...patch, updatedAt: now().toISOString() });
    const retry = (error: string, at?: Date) => {
      const attempts = entry.attempts + 1;
      return settle({
        attempts,
        lastError: error,
        nextAttemptAt: (at ?? new Date(now().getTime() + backoffMs(attempts))).toISOString(),
      });
    };
    let res: Response;
    try {
      res = await doFetch(`${endpoint}/v1/items/${entry.kind}/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch {
      await retry('Offline or the log service could not be reached.');
      continue;
    }
    const uploaded = async (note?: string) => {
      // The record may have changed while it was being sent: only what was sent counts as uploaded.
      const latest = await d.outbox.get(entry.key);
      const changed = latest && latest.contentHash !== hash && latest.contentHash !== entry.contentHash;
      await settle({
        status: changed ? 'queued' : 'uploaded',
        uploadedHash: hash,
        contentHash: changed ? latest.contentHash : hash,
        attempts: 0,
        lastError: note,
      });
    };
    if (res.ok) {
      await uploaded();
      continue;
    }
    let problem: { error?: string; message?: string } = {};
    try {
      problem = (await res.json()) as typeof problem;
    } catch {
      // keep the status line
    }
    const message = problem.message ?? `The log service answered ${res.status}.`;
    if (res.status === 401) {
      // This token was revoked (sign-out, retention): forget it, so the next sync registers again and takes its
      // items over; everything not yet uploaded goes back in the queue for the new token.
      if (!options.enrollment) retireEnrollment(enrollment.token);
      await d.outbox
        .where('status')
        .anyOf('queued', 'failed')
        .filter((e) => !e.deleted)
        .modify({ status: 'queued', attempts: 0, lastError: 'Registering this browser again.' });
      return;
    }
    if (res.status === 429 && problem.error === 'daily-budget') await retry(message, nextUtcDay(now()));
    else if (res.status === 408 || res.status === 429 || res.status >= 500) await retry(message);
    // The server keeps a newer version of this item: nothing of ours is missing there.
    else if (res.status === 409) await uploaded('The private log already holds a newer version.');
    else await settle({ status: 'failed', attempts: entry.attempts + 1, lastError: message });
  }
}

// ---- status heartbeat: what the outbox could not upload, visible in the cloud ----

const STATUS_EVERY_MS = 900_000;
let lastStatus: { at: number; text: string } | undefined;

/**
 * Tells the log service how this browser's uploads are doing — counts per state, the newest distinct errors,
 * the build — so failures are visible remotely. At most every 15 minutes unless something changed. An older
 * Worker without the endpoint (404) is ignored.
 */
export async function reportStatus(
  options: {
    enrollment?: CloudEnrollment;
    endpoint?: string;
    fetchImpl?: typeof fetch;
    database?: () => ObdcraftDb;
    now?: () => Date;
    force?: boolean;
  } = {},
): Promise<void> {
  const enrollment = options.enrollment ?? readEnrollment();
  const endpoint = options.endpoint ?? logEndpoint();
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = (options.now ?? (() => new Date()))();
  if (!enrollment || !endpoint || uploadsOptedOut()) return;
  const entries = await (options.database ?? db)().outbox.toArray();
  const counts: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    counts[e.kind] ??= {};
    const c = counts[e.kind] as Record<string, number>;
    c[e.status] = (c[e.status] ?? 0) + 1;
  }
  const errors = [
    ...new Set(
      entries
        .filter((e) => e.status !== 'uploaded' && e.lastError)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((e) => `${e.status} ${e.kind}: ${(e.lastError ?? '').slice(0, 200)}`),
    ),
  ].slice(0, 10);
  const oldestQueued = entries
    .filter((e) => e.status === 'queued')
    .map((e) => e.updatedAt)
    .sort()[0];
  const status = {
    schema: 'obdcraft.device-status/1',
    buildId: BUILD_ID,
    build: { ...BUILD_INFO },
    counts,
    errors,
    oldestQueued: oldestQueued ?? null,
    userAgent: (globalThis.navigator?.userAgent ?? 'unknown').slice(0, 200),
  };
  const text = JSON.stringify(status);
  if (
    !options.force &&
    lastStatus &&
    lastStatus.text === text &&
    now.getTime() - lastStatus.at < STATUS_EVERY_MS
  )
    return;
  try {
    const res = await doFetch(`${endpoint}/v1/status`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...status, at: now.toISOString() }),
    });
    if (res.ok || res.status === 404) lastStatus = { at: now.getTime(), text };
  } catch {
    // offline: the next sync reports it
  }
}

// ---- best effort when the page goes away ----

/** Browsers cap the bodies of all in-flight keepalive requests together at 64 KiB. */
const KEEPALIVE_BUDGET = 60_000;
let keepaliveUsed = 0;

/**
 * Sends one item with `fetch(…, { keepalive: true })`, which may outlive the page (pagehide). Best effort: no
 * outbox bookkeeping (the page is going away); the normal path uploads it again on the next start and the
 * Worker treats an identical item as a duplicate. Items too big for the keepalive budget are left to that.
 */
export function sendOnExit(kind: LogKind, record: LocalRecord): boolean {
  const enrollment = readEnrollment();
  const endpoint = logEndpoint();
  if (!enrollment || !endpoint || uploadsOptedOut()) return false;
  const { text } = buildUpload(kind, record);
  const size = new TextEncoder().encode(text).length;
  if (keepaliveUsed + size > KEEPALIVE_BUDGET) return false;
  keepaliveUsed += size;
  try {
    void fetch(`${endpoint}/v1/items/${kind}/${encodeURIComponent(record.id)}`, {
      method: 'PUT',
      keepalive: true,
      headers: { Authorization: `Bearer ${enrollment.token}`, 'Content-Type': 'application/json' },
      body: text,
    })
      .catch(() => {})
      .finally(() => {
        keepaliveUsed -= size;
      });
    return true;
  } catch {
    keepaliveUsed -= size;
    return false;
  }
}

// ---- the background loop ----

let registerFailures = 0;
let registerRetryAt = 0;

/** Registers this browser if it has no (working) token, backing off while registration is refused. */
async function registered(): Promise<CloudEnrollment | undefined> {
  const existing = readEnrollment();
  if (existing || uploadsOptedOut()) return existing;
  if (Date.now() < registerRetryAt) return undefined;
  try {
    const enrollment = await ensureCollector();
    registerFailures = 0;
    return enrollment;
  } catch {
    registerFailures++;
    registerRetryAt = Date.now() + backoffMs(registerFailures);
    return undefined;
  }
}

/**
 * One pass: queue what changed, register if needed, upload what is due, report status. The first pass of a
 * page (app start) also puts every failed item back in the queue and scans every record.
 */
async function cycle(full: boolean): Promise<void> {
  if (full) await retryFailed();
  await syncOutbox(undefined, db, new Date(), { full });
  if (!(await registered())) return;
  await drainOutbox();
  // A 401 retired the token during the drain: register again (taking its items over) and upload with it.
  if (!readEnrollment() && (await registered())) {
    await syncOutbox();
    await drainOutbox();
  }
  await reportStatus();
}

/** Starts the background sync: every `intervalMs`, when the browser comes online, and on demand (`kick`). */
export function startCloudSync(intervalMs = 30_000): { kick: () => void; stop: () => void } {
  let first = true;
  let running = false;
  let again = false;
  const run = () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const full = first;
    first = false;
    void cycle(full)
      .catch(() => {})
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          run();
        }
      });
  };
  const timer = setInterval(run, intervalMs);
  const online = () => run();
  globalThis.addEventListener?.('online', online);
  run();
  return {
    kick: run,
    stop: () => {
      clearInterval(timer);
      globalThis.removeEventListener?.('online', online);
    },
  };
}

let shared: ReturnType<typeof startCloudSync> | undefined;
/**
 * Automatic logging (on by default; off only after the person opts out): starts the background sync once per
 * page — which registers this browser as an upload-only collector when needed — or runs it now.
 */
export function kickCloudSync(): void {
  if (!logEndpoint() || uploadsOptedOut()) return;
  if (shared) shared.kick();
  else shared = startCloudSync();
}
