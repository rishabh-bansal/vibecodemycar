import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../../workers/logs/src/worker.ts';
import { sqliteD1 } from '../../../workers/logs/test/d1-sqlite.ts';
import { recordDiag } from '../../domain/diagnostics.ts';
import {
  type ConnectionLog,
  createVinWatcher,
  createWireRedactor,
  sessionItem,
  vinInWire,
} from '../../domain/logs/redact.ts';
import { ObdcraftDb } from '../storage/db.ts';
import { ensureCollector } from './api.ts';
import { readEnrollment, setUploadsOptedOut, writeEnrollment } from './config.ts';
import { ConnectionLogger } from './connection-log.ts';
import { drainOutbox, syncOutbox } from './outbox.ts';

const ENDPOINT = 'https://logs.example';
let database: ObdcraftDb;
let env: Env & { DB: ReturnType<typeof sqliteD1> };
let calls = 0;
const server: typeof fetch = async (input, init) => {
  calls++;
  return worker.fetch(new Request(String(input), init), env);
};
const wire = (direction: 'tx' | 'rx', text: string) => ({
  at: new Date().toISOString(),
  elapsedMs: 0,
  direction,
  text,
});

/** A browser's localStorage (Node's own needs a backing file and otherwise drops writes). */
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

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  database = new ObdcraftDb(`connlog-${Math.random()}`);
  env = { DB: sqliteD1(), ENROLLMENT_CODE: 'owner-code-for-tests', ALLOWED_ORIGINS: '' };
  calls = 0;
  vi.stubEnv('VITE_LOG_ENDPOINT', ENDPOINT);
  writeEnrollment(undefined);
  setUploadsOptedOut(false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  writeEnrollment(undefined);
  setUploadsOptedOut(false);
});

describe('connection log', () => {
  it('preserves the monotonic clock for wire and Bluetooth observations', async () => {
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire({ ...wire('tx', 'ATI\r'), elapsedMs: 123.25 });
    logger.bluetooth({
      at: new Date().toISOString(),
      monoMs: 124.5,
      kind: 'write-resolved',
      details: { id: 1, bytes: 4, durationMs: 1.25, mode: 'without-response' },
    });
    await logger.stop('done');
    const [log] = await database.connectionLogs.toArray();
    expect(log?.entries.find((e) => e.direction === 'tx')).toMatchObject({ monoMs: 123.25 });
    expect(log?.entries.find((e) => e.text.startsWith('ble:write-resolved'))).toMatchObject({
      monoMs: 124.5,
      direction: 'event',
    });
  });

  const VIN = 'TMBJB7NS0P8012345';
  /** A 22 F190 reply carrying VIN, as the adapter shows it with CAN headers. */
  const vinReply = (header: string) =>
    `${header} 10 14 62 F1 90 54 4D 42 \r${header} 21 4A 42 37 4E 53 30 50 \r${header} 22 38 30 31 32 33 34 35 \r\r>`;
  /** A 22 F18C reply (the control unit's serial number), same framing. */
  const serialReply = (header: string) =>
    `${header} 10 10 62 F1 8C 53 4E 30 \r${header} 21 31 32 33 34 35 36 37 \r${header} 22 38 39 41 42 00 00 00 \r\r>`;

  it.each(['77E', '00 00 07 7E', '0000077E'])(
    'keeps the VIN reply with header %s as received and records the VIN on the log',
    async (header) => {
      const logger = new ConnectionLogger(() => database, 'build-test');
      logger.wire(wire('tx', '0322F190\r'));
      logger.wire(wire('rx', vinReply(header)));
      await logger.stop('test over');
      const [log] = (await database.connectionLogs.toArray()) as ConnectionLog[];
      expect(JSON.stringify(log)).toContain('62 F1 90 54 4D 42');
      expect(log?.vin).toBe(VIN);
      expect(sessionItem(log as ConnectionLog).vin).toBe(VIN);
    },
  );

  it('blanks a serial-number reply before it reaches IndexedDB', async () => {
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire(wire('tx', '03 22 F1 8C\r'));
    logger.wire(wire('rx', serialReply('77E')));
    await logger.stop('test over');
    const text = JSON.stringify(await database.connectionLogs.toArray());
    expect(text).not.toContain('53 4E 30');
    expect(text).toContain('62 F1 8C ·· ·· ··');
  });

  it('finds the VIN and blanks a serial across every possible BLE notification split', () => {
    const raw = vinReply('00 00 07 7E');
    for (let cut = 1; cut < raw.length; cut++) {
      const watch = createVinWatcher();
      watch(wire('tx', '0322F190\r'));
      const found = [watch(wire('rx', raw.slice(0, cut))), watch(wire('rx', raw.slice(cut)))];
      expect(found.filter(Boolean), `split at ${cut}`).toEqual([VIN]);
    }
    const serial = serialReply('00 00 07 7E');
    for (let cut = 1; cut < serial.length; cut++) {
      const redact = createWireRedactor();
      redact(wire('tx', '0322F18C\r'));
      const text = [
        redact(wire('rx', serial.slice(0, cut))).text,
        redact(wire('rx', serial.slice(cut))).text,
      ].join('');
      expect(text, `split at ${cut}`).not.toMatch(/\b(?:53|4E|30|31|32|33|34|35|36|37|38|39|41|42)\b/);
    }
  });

  it('reads the VIN from an OBD 09 02 reply without CAN headers', () => {
    expect(
      vinInWire([
        wire('tx', '0902\r'),
        wire('rx', '014\r0: 49 02 01 54 4D 42\r1: 4A 42 37 4E 53 30 50\r2: 38 30 31 32 33 34 35\r\r>'),
      ]),
    ).toBe(VIN);
    expect(vinInWire([wire('tx', '03 22 0A 5E'), wire('rx', '778 07 62 0A 5E 3A 00 A0 00')])).toBeUndefined();
  });

  it('turns a stored session into an item with its VIN; serials of older chunks are blanked again', () => {
    const at = '2026-10-26T14:41:34.122Z';
    const log: ConnectionLog = {
      schema: 'obdcraft.connection-log/1',
      id: 'older-session-0000',
      session: 'older-session',
      chunk: 0,
      startedAt: at,
      updatedAt: at,
      buildId: 'older-build',
      closed: true,
      entries: [
        { at, direction: 'tx', text: '0322F190\r' },
        { at, direction: 'rx', text: vinReply('00 00 07 7E') },
        { at, direction: 'tx', text: '0322F18C\r' },
        { at, direction: 'rx', text: serialReply('00 00 07 7E') },
      ],
    };
    const item = sessionItem(log);
    expect(item.vin).toBe(VIN);
    expect(JSON.stringify(item)).toContain('54 4D 42');
    expect(JSON.stringify(item)).not.toContain('53 4E 30');
    expect(JSON.stringify(log)).toContain('53 4E 30'); // conversion never changes the source evidence
    expect(sessionItem(item.body as unknown as ConnectionLog)).toEqual(item);
    expect(item.body.build).toEqual({ gitSha: null, version: null }); // an older chunk carries no stamp
    expect(sessionItem({ ...log, gitSha: 'abc1234', version: '0.1.0' }).body.build).toEqual({
      gitSha: 'abc1234',
      version: '0.1.0',
    });
    expect(sessionItem({ ...log, entries: [] }).vin).toBeNull();
  });

  it('keeps blanking a serial through flow control and monitor commands, while retaining status and NRC evidence', () => {
    const redact = createWireRedactor();
    redact(wire('tx', '0322F18C\r'));
    expect(redact(wire('rx', 'SEARCHING...\r')).text).toBe('SEARCHING...\r');
    expect(redact(wire('rx', '00 00 07 78 03 7F 22 31 AA AA AA AA\r>')).text).toContain('7F 22 31');
    redact(wire('rx', '00 00 07 7E 10 10 62 F1 8C 53 4E 30\r>'));
    redact(wire('tx', '3000050000000000\r'));
    redact(wire('tx', 'ATMA\r'));
    expect(redact(wire('rx', '?\r>')).text).toBe('?\r>');
    const cf = redact(wire('rx', '00 00 07 7E 21 31 32 33 34 35 36 37\r')).text;
    expect(cf).toBe('00 00 07 7E 21 ·· ·· ·· ·· ·· ·· ··\r');
    expect(redact(wire('rx', 'NO DATA\r>')).text).toBe('NO DATA\r>');
    redact(wire('tx', '03220A5E\r'));
    expect(redact(wire('rx', '778 07 62 0A 5E 3A 00 A0 00\r>')).text).toContain('3A 00 A0 00');
  });

  it('records every adapter command and app stage; only serial numbers are blanked; the VIN carries to later chunks', async () => {
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire(wire('tx', 'ATZ'));
    logger.wire(wire('rx', 'ELM327 v1.5'));
    logger.wire(wire('tx', 'AT@2'));
    logger.wire(wire('rx', 'SERIAL-0042'));
    recordDiag('identify', 'started');
    logger.wire(wire('tx', '03 22 F1 90'));
    logger.wire(wire('rx', '77E 10 14 62 F1 90 54 4D 42\r'));
    logger.wire(wire('rx', '77E 21 4A 42 37 4E 53 30 50\r'));
    logger.wire(wire('rx', '77E 22 38 30 31 32 33 34 35\r'));
    logger.wire(wire('tx', '03 22 0A 5E'));
    logger.wire(wire('rx', '778 07 62 0A 5E 3A 00 A0 00'));
    for (let i = 0; i < 1500; i++) logger.wire(wire('tx', `line ${i}`));
    await logger.stop('test over');
    const [log, next] = (await database.connectionLogs.orderBy('id').toArray()) as ConnectionLog[];
    expect(log?.closed).toBe(true);
    const texts = log?.entries.slice(0, 13).map((e) => `${e.direction} ${e.text}`) ?? [];
    expect(texts).toEqual([
      'event connection-log started',
      'tx ATZ',
      'rx ELM327 v1.5',
      'tx AT@2',
      'rx [redacted: identity reply]',
      'event identify:started',
      'tx 03 22 F1 90',
      'rx 77E 10 14 62 F1 90 54 4D 42\r',
      'rx 77E 21 4A 42 37 4E 53 30 50\r',
      'rx 77E 22 38 30 31 32 33 34 35\r',
      'tx 03 22 0A 5E',
      'rx 778 07 62 0A 5E 3A 00 A0 00',
      'tx line 0',
    ]);
    expect(log?.vin).toBe(VIN);
    expect(next?.vin).toBe(VIN);
    expect(sessionItem(next as ConnectionLog).vin).toBe(VIN);
  });

  it('takes the VIN from the app when the log did not read it itself', async () => {
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.setVin(' tmbjb7ns0p8012345');
    logger.wire(wire('tx', 'ATZ'));
    await logger.stop('done');
    const [log] = (await database.connectionLogs.toArray()) as ConnectionLog[];
    expect(log?.vin).toBe(VIN);
  });

  it('closes a chunk at 1500 entries and continues in the next one', async () => {
    const logger = new ConnectionLogger(() => database, 'build-test');
    for (let i = 0; i < 1600; i++) logger.wire(wire(i % 2 ? 'rx' : 'tx', `line ${i}`));
    await logger.stop('done');
    const logs = (await database.connectionLogs.orderBy('id').toArray()) as ConnectionLog[];
    expect(logs.map((l) => [l.chunk, l.entries.length, l.closed])).toEqual([
      [0, 1500, true],
      [1, 102, true],
    ]);
  });
});

describe('automatic upload', () => {
  it('registers this browser as an upload-only collector by itself, then uploads its connection logs', async () => {
    const enrollment = await ensureCollector(server);
    expect(enrollment).toMatchObject({ role: 'collector' });
    expect(readEnrollment()).toMatchObject({ role: 'collector' });
    // Registered once: a second call does not register again.
    await ensureCollector(server);
    expect(calls).toBe(1);

    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire(wire('tx', 'ATZ'));
    await logger.stop('disconnected');
    await syncOutbox(enrollment, () => database);
    await drainOutbox({ enrollment, endpoint: ENDPOINT, fetchImpl: server, database: () => database });
    const stored = env.DB.db.prepare('SELECT kind, operation FROM items').all();
    expect(stored).toEqual([{ kind: 'session', operation: 'connection' }]);
    // The collector cannot read what it uploaded.
    const res = await server(`${ENDPOINT}/v1/items`, {
      headers: { Authorization: `Bearer ${enrollment?.token}` },
    });
    expect(res.status).toBe(403);
  });

  it('a live chunk waits until it is closed or quiet, instead of uploading a revision every minute', async () => {
    const enrollment = await ensureCollector(server);
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire(wire('tx', 'ATZ'));
    await new Promise((r) => setTimeout(r, 1100)); // saved, still open
    await syncOutbox(enrollment, () => database);
    expect(await database.outbox.count()).toBe(0);
    await syncOutbox(enrollment, () => database, new Date(Date.now() + 121_000));
    expect(await database.outbox.count()).toBe(1);
    await logger.stop('done');
  });

  it('after an opt-out it registers nothing and uploads nothing; logs stay on this browser', async () => {
    setUploadsOptedOut(true);
    expect(await ensureCollector(server)).toBeUndefined();
    expect(calls).toBe(0);
    const logger = new ConnectionLogger(() => database, 'build-test');
    logger.wire(wire('tx', 'ATZ'));
    await logger.stop('done');
    expect(await database.connectionLogs.count()).toBe(1);
    await drainOutbox({
      enrollment: { token: 'x'.repeat(43), deviceId: 'd', label: 'x', enrolledAt: new Date(0).toISOString() },
      endpoint: ENDPOINT,
      fetchImpl: server,
      database: () => database,
    });
    expect(calls).toBe(0);
  });
});
