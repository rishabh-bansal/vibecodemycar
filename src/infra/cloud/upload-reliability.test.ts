import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../../workers/logs/src/worker.ts';
import { sqliteD1 } from '../../../workers/logs/test/d1-sqlite.ts';
import type { ExperimentRecord } from '../../domain/coding/audit.ts';
import type { ConnectionLog } from '../../domain/logs/redact.ts';
import { ObdcraftDb } from '../storage/db.ts';
import { unsavedExperiments } from '../storage/unsaved.ts';
import { ensureCollector, signOut } from './api.ts';
import { readEnrollment, readPreviousTokens, writeEnrollment } from './config.ts';
import { activeConnectionLoggers, ConnectionLogger } from './connection-log.ts';
import { drainOutbox, reportStatus, sendOnExit, syncOutbox } from './outbox.ts';

/**
 * Logs must reach the cloud by themselves and keep trying: across a revoked token, a closed tab, a long
 * connection, and a run IndexedDB could not save.
 */
const ENDPOINT = 'https://logs.example';
let database: ObdcraftDb;
let env: Env & { DB: ReturnType<typeof sqliteD1> };
const server: typeof fetch = async (input, init) => worker.fetch(new Request(String(input), init), env);
const rows = () =>
  env.DB.db.prepare('SELECT kind, id, revision, device_id FROM items ORDER BY id').all() as {
    kind: string;
    id: string;
    revision: number;
    device_id: string;
  }[];

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

const session = (over: Partial<ConnectionLog> = {}): ConnectionLog => ({
  schema: 'obdcraft.connection-log/1',
  id: 'synthetic-session-0000',
  session: 'synthetic-session',
  chunk: 0,
  startedAt: '2026-10-25T12:00:00.000Z',
  updatedAt: '2026-10-25T12:00:01.000Z',
  buildId: 'build-test',
  closed: true,
  entries: [{ at: '2026-10-25T12:00:00.000Z', direction: 'tx', text: 'ATZ' }],
  ...over,
});

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubEnv('VITE_LOG_ENDPOINT', ENDPOINT);
  database = new ObdcraftDb(`reliability-${Math.random()}`);
  env = { DB: sqliteD1(), ENROLLMENT_CODE: 'owner-code-for-tests', ALLOWED_ORIGINS: '' };
  writeEnrollment(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  unsavedExperiments.clear();
});

const drain = () => drainOutbox({ endpoint: ENDPOINT, fetchImpl: server, database: () => database });

describe('a token that stops working', () => {
  it('is retired on 401; the browser registers again, takes its items over, and keeps updating them', async () => {
    const first = await ensureCollector(server);
    await database.connectionLogs.put(session());
    await syncOutbox(first, () => database, new Date(), { full: true });
    await drain();
    expect(rows()).toMatchObject([{ revision: 1, device_id: first?.deviceId }]);

    // Retention (or a sign-out elsewhere) revoked the token.
    env.DB.db.exec(
      `UPDATE devices SET revoked_at = '2026-10-25T12:00:00.000Z' WHERE id = '${first?.deviceId}'`,
    );
    await database.connectionLogs.put(session({ updatedAt: '2026-10-25T12:05:00.000Z', closed: true }));
    await syncOutbox(undefined, () => database, new Date(), { full: true });
    await drain();
    expect(readEnrollment()).toBeUndefined();
    expect(readPreviousTokens()).toEqual([first?.token]);
    expect(await database.outbox.get('session:synthetic-session-0000')).toMatchObject({ status: 'queued' });

    const second = await ensureCollector(server);
    expect(second?.deviceId).not.toBe(first?.deviceId);
    expect(readPreviousTokens()).toEqual([]);
    await drain();
    expect(rows()).toMatchObject([{ revision: 2, device_id: second?.deviceId }]);
  });

  it('after an owner signs out, automatic logging continues and keeps the owner’s items', async () => {
    const res = await server(`${ENDPOINT}/v1/enroll`, {
      method: 'POST',
      body: JSON.stringify({ code: 'owner-code-for-tests', label: 'owner' }),
    });
    const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
    writeEnrollment({ token, deviceId, label: 'owner', role: 'owner', enrolledAt: new Date().toISOString() });
    await database.connectionLogs.put(session());
    await syncOutbox(undefined, () => database, new Date(), { full: true });
    await drain();
    vi.stubGlobal('fetch', server);
    await signOut();
    const collector = await ensureCollector(server);
    await database.connectionLogs.put(session({ updatedAt: '2026-10-25T12:09:00.000Z' }));
    await syncOutbox(undefined, () => database, new Date(), { full: true });
    await drain();
    expect(rows()).toMatchObject([{ revision: 2, device_id: collector?.deviceId }]);
  });
});

describe('a long connection uploads as it goes', () => {
  it('closes a chunk every minute (and by size), announcing each for upload', async () => {
    vi.useFakeTimers({
      now: Date.parse('2026-10-25T12:00:00.000Z'),
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
    });
    try {
      const closed = vi.fn();
      const logger = new ConnectionLogger(() => database, 'build-test', closed);
      const tx = (text: string) =>
        logger.wire({ at: new Date().toISOString(), elapsedMs: 0, direction: 'tx', text });
      tx('ATZ');
      await vi.advanceTimersByTimeAsync(30_000);
      tx('ATI');
      await vi.advanceTimersByTimeAsync(31_000);
      tx('0100'); // over a minute since the chunk opened: closes it
      await vi.advanceTimersByTimeAsync(2_000);
      for (let i = 0; i < 300; i++) tx(`03 22 0A 5E ${'A'.repeat(4000)}`); // ~2.4 MB: closes by size
      await logger.stop('done');
      const logs = (await database.connectionLogs.orderBy('id').toArray()) as ConnectionLog[];
      expect(logs.length).toBeGreaterThanOrEqual(4);
      expect(logs.every((l) => l.closed)).toBe(true);
      expect(logs[0]?.entries.map((e) => e.text)).toEqual(['connection-log started', 'ATZ', 'ATI', '0100']);
      for (const l of logs) expect(JSON.stringify(l).length).toBeLessThan(1_400_000);
      expect(closed).toHaveBeenCalledTimes(logs.length);
      expect(activeConnectionLoggers()).not.toContain(logger);
    } finally {
      vi.useRealTimers();
    }
  });

  it('on page close, ends the log and sends its last chunk with a keepalive request', async () => {
    await ensureCollector(server);
    const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      sent.push(init);
      return server(input, init);
    });
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire({ at: new Date().toISOString(), elapsedMs: 0, direction: 'tx', text: 'ATZ' });
    expect(activeConnectionLoggers()).toContain(logger);
    const last = logger.end('page closed');
    expect(last?.closed).toBe(true);
    expect(sendOnExit('session', last as ConnectionLog)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toMatchObject({ method: 'PUT', keepalive: true });
    expect(rows()).toMatchObject([{ kind: 'session', id: last?.id }]);
    expect(activeConnectionLoggers()).not.toContain(logger);
  });
});

describe('nothing is left behind', () => {
  it('a run IndexedDB could not save still uploads from its in-memory copy', async () => {
    const enrollment = await ensureCollector(server);
    const at = '2026-10-25T12:00:00.000Z';
    const record = {
      schema: 'obdcraft.experiment/1',
      id: 'unsaved-experiment-0001',
      startedAt: at,
      updatedAt: at,
      buildId: 'build-test',
      featureId: 'inspect-09',
      featureName: 'Inspect',
      operation: 'inspect',
      mode: 'live',
      state: 'complete',
      needsAttention: false,
      summary: 'done',
      events: [],
      wire: [],
      traceTruncated: false,
    } as unknown as ExperimentRecord;
    unsavedExperiments.set(record.id, record);
    await syncOutbox(enrollment, () => database, new Date(), { full: true });
    await drain();
    expect(rows()).toMatchObject([{ kind: 'experiment', id: 'unsaved-experiment-0001' }]);
  });

  it('only changed records are rebuilt between full scans', async () => {
    const enrollment = await ensureCollector(server);
    await database.connectionLogs.put(session());
    const t0 = new Date();
    await syncOutbox(enrollment, () => database, t0, { full: true });
    const before = await database.outbox.get('session:synthetic-session-0000');
    await syncOutbox(enrollment, () => database, new Date(t0.getTime() + 30_000));
    expect(await database.outbox.get('session:synthetic-session-0000')).toEqual(before);
  });

  it('reports its upload health (counts, errors, build) so failures are visible remotely', async () => {
    const enrollment = await ensureCollector(server);
    await database.outbox.put({
      key: 'session:x-00000000',
      kind: 'session',
      id: 'x-00000000',
      status: 'failed',
      contentHash: 'h',
      attempts: 1,
      nextAttemptAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: 'refused for a test',
    });
    await reportStatus({
      enrollment,
      endpoint: ENDPOINT,
      fetchImpl: server,
      database: () => database,
      force: true,
    });
    const row = env.DB.db.prepare('SELECT device_id, body FROM device_status').get() as {
      device_id: string;
      body: string;
    };
    expect(row.device_id).toBe(enrollment?.deviceId);
    expect(JSON.parse(row.body)).toMatchObject({
      counts: { session: { failed: 1 } },
      errors: ['failed session: refused for a test'],
      build: { gitSha: expect.any(String) },
    });
  });
});
