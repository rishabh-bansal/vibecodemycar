import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../../../workers/logs/src/worker.ts';
import { sqliteD1 } from '../../../workers/logs/test/d1-sqlite.ts';
import type { BackupRecord } from '../../domain/backups/schema.ts';
import type { ExperimentRecord } from '../../domain/coding/audit.ts';
import { experimentItem, journalItem } from '../../domain/logs/redact.ts';
import { ObdcraftDb } from '../storage/db.ts';
import type { CloudEnrollment } from './config.ts';
import {
  buildUpload,
  drainOutbox,
  enqueueManual,
  FAILED_RETRY_MS,
  retryFailed,
  syncOutbox,
} from './outbox.ts';

const ENDPOINT = 'https://logs.example';
const CODE = 'synthetic-enrollment-code-for-tests-only';
let database: ObdcraftDb;
let env: Env & { DB: ReturnType<typeof sqliteD1> };
let enrollment: CloudEnrollment;
let calls = 0;
let offline = false;
/** The real Worker, in process, as the server. */
const server: typeof fetch = async (input, init) => {
  calls++;
  if (offline) throw new TypeError('Failed to fetch');
  return worker.fetch(new Request(String(input), init), env);
};
let clock = Date.parse('2026-10-25T12:00:00.000Z');
const now = () => new Date(clock);
const drain = () =>
  drainOutbox({ enrollment, endpoint: ENDPOINT, fetchImpl: server, database: () => database, now });
const sync = () => syncOutbox(enrollment, () => database, now());

const journal = (over: Partial<BackupRecord> = {}): BackupRecord => ({
  schema: 'vibecode-my-car.backup/2',
  operation: 'apply',
  linkMode: 'live',
  ack: 'received',
  outcome: 'verified',
  history: [],
  id: 'journal-00000001',
  createdAt: '2026-10-25T12:00:10.000Z',
  updatedAt: '2026-10-25T12:00:20.000Z',
  featureId: 'comfort-lane-change-indicator-5-flashes',
  featureName: 'Comfort lane change',
  recipeId: 'live-bcm-polite-blinks',
  recipeDigest: 'a1626fc88383417cf97d080e0fc8c6f52cb8d80169073ba8e19a4d3ecaf8d776',
  settingId: 'value-3',
  settingLabel: '3 blinks',
  car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
  vin: { masked: 'TMBJ…2345', fingerprint: 'ab12cd34'.repeat(8) },
  module: { request: '70E', response: '778', part: '2Q0937089D' },
  did: '0A5E',
  before: '3E00A00000',
  intended: '3A00A00000',
  observed: '3A00A00000',
  status: 'verified',
  moduleSnapshot: { F190: '544D424A42374E5330503830313233343', '0A5E': '3E00A00000' },
  ...over,
});
const experiment = (over: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  schema: 'obdcraft.experiment/1',
  id: 'experiment-00000001',
  startedAt: '2026-10-25T12:00:05.000Z',
  updatedAt: '2026-10-25T12:00:30.000Z',
  buildId: 'f2ebeff397e20bbb31b7',
  featureId: 'comfort-lane-change-indicator-5-flashes',
  featureName: 'Comfort lane change',
  recipeId: 'live-bcm-polite-blinks',
  operation: 'apply',
  mode: 'live',
  state: 'complete',
  needsAttention: false,
  summary: 'verified',
  events: [],
  wire: [
    { at: '2026-10-25T12:00:06.000Z', elapsedMs: 0, direction: 'tx', text: '03 22 F1 90' },
    {
      at: '2026-10-25T12:00:06.100Z',
      elapsedMs: 100,
      direction: 'rx',
      text: '77E 10 14 62 F1 90 54 4D 42\r',
    },
    {
      at: '2026-10-25T12:00:06.200Z',
      elapsedMs: 200,
      direction: 'rx',
      text: '77E 21 4A 42 37 4E 53 30 50\r',
    },
    { at: '2026-10-25T12:00:07.000Z', elapsedMs: 1000, direction: 'tx', text: '03 22 0A 5E' },
    { at: '2026-10-25T12:00:07.100Z', elapsedMs: 1100, direction: 'rx', text: '778 07 62 0A 5E 3E 00 A0 00' },
  ],
  traceTruncated: false,
  backup: journal(),
  observations: [
    { at: '2026-10-25T12:01:00.000Z', expected: '3 blinks', verdict: 'as-expected', note: '3 counted' },
  ],
  ...over,
});
const stored = () => env.DB.db.prepare('SELECT kind, id, revision FROM items ORDER BY kind').all();

beforeEach(async () => {
  database = new ObdcraftDb(`cloud-${Math.random()}`);
  env = { DB: sqliteD1(), ENROLLMENT_CODE: CODE, ALLOWED_ORIGINS: '' };
  const res = await worker.fetch(
    new Request(`${ENDPOINT}/v1/enroll`, {
      method: 'POST',
      body: JSON.stringify({ code: CODE, label: 'test' }),
    }),
    env,
  );
  const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
  enrollment = { token, deviceId, label: 'test', enrolledAt: '2026-10-25T12:00:00.000Z' };
  calls = 0;
  offline = false;
  clock = Date.parse('2026-10-25T12:02:00.000Z');
});

describe('items before transmission', () => {
  it('carry the full VIN and the VIN reply as received; only serial-number DIDs are left out', () => {
    const item = experimentItem(
      experiment({ backup: journal({ vin: { ...journal().vin, full: 'TMBJB7NS0P8012345' } }) }),
    );
    const body = JSON.stringify(item);
    expect(item.vin).toBe('TMBJB7NS0P8012345');
    expect(body).toContain('77E 10 14 62 F1 90 54 4D 42');
    expect(body).toContain('778 07 62 0A 5E 3E 00 A0 00'); // the coding read-back stays
    expect(item.body.backup).toMatchObject({
      vin: { masked: 'TMBJ…2345', fingerprint: 'ab12cd34'.repeat(8), full: 'TMBJB7NS0P8012345' },
      moduleSnapshot: { F190: '544D424A42374E5330503830313233343', '0A5E': '3E00A00000' },
    });
    expect(
      journalItem(journal({ moduleSnapshot: { F18C: '534E303132', '0A5E': '3E00A00000' } })).body
        .moduleSnapshot,
    ).toEqual({ '0A5E': '3E00A00000' });
  });

  it('take the VIN from the wire trace when the record has no full VIN; null when nothing says', () => {
    const vinTrace = [
      { at: '2026-10-25T12:00:06.000Z', elapsedMs: 0, direction: 'tx' as const, text: '03 22 F1 90' },
      {
        at: '2026-10-25T12:00:06.100Z',
        elapsedMs: 100,
        direction: 'rx' as const,
        text: '77E 10 14 62 F1 90 54 4D 42\r77E 21 4A 42 37 4E 53 30 50\r77E 22 38 30 31 32 33 34 35\r',
      },
    ];
    expect(experimentItem(experiment({ wire: vinTrace })).vin).toBe('TMBJB7NS0P8012345');
    expect(experimentItem(experiment()).vin).toBeNull();
    expect(journalItem(journal()).vin).toBeNull();
    expect(journalItem(journal({ vin: { ...journal().vin, full: 'TMBJB7NS0P8012345' } })).vin).toBe(
      'TMBJB7NS0P8012345',
    );
  });

  it('keeps acknowledgement, sequence completion and physical confirmation as separate facts', () => {
    expect(experimentItem(experiment()).facts).toEqual({
      operation: 'apply',
      mode: 'live',
      outcome: 'verified',
      ack: 'received',
      sequenceComplete: null,
      physical: 'as-expected',
    });
    const stopped = journal({
      sequenceSteps: [{ cmd: '1102', outcome: 'refused', nrc: '22' }],
      sequenceIncomplete: { step: '1102', reason: 'refused', nrc: '22' },
    });
    expect(journalItem(stopped).facts).toMatchObject({
      ack: 'received',
      sequenceComplete: false,
      physical: null,
    });
  });

  it('stamps every item with the build that recorded it (nulls on unstamped records)', () => {
    expect(experimentItem(experiment({ gitSha: 'abc1234-dirty', version: '0.1.0' })).body.build).toEqual({
      gitSha: 'abc1234-dirty',
      version: '0.1.0',
    });
    // An old record keeps a stable item: no stamp from today's build, so it is never re-uploaded for it.
    expect(experimentItem(experiment()).body.build).toEqual({ gitSha: null, version: null });
    // A journal carries the build that saved it, not the build that happens to upload it.
    const stamped = journalItem(
      journal({ build: { buildId: 'rec0rd1ng', gitSha: 'abc1234', version: '0.1.0' } }),
    );
    expect(stamped.buildId).toBe('rec0rd1ng');
    expect(stamped.body.build).toEqual({ gitSha: 'abc1234', version: '0.1.0' });
    expect(journalItem(journal())).toMatchObject({
      buildId: 'unrecorded',
      body: { build: { gitSha: null } },
    });
  });

  it('keeps writer, readiness and variant events compact', () => {
    const at = '2026-10-25T12:00:12.000Z';
    const item = experimentItem(
      experiment({
        events: [
          { at, type: 'readiness', ok: true, rpm: 0, speedKmh: 0, voltage: 12.4, measuredAt: at, ageMs: 40 },
          {
            at,
            type: 'variant-selected',
            recipeId: 'r',
            selector: 'new-bcm',
            did: '0D07',
            reason: 'new-generation body control module (0600 read)',
            probe: { reads: { '0D07': 4 }, unit09NewGen: true, part: '2Q0937089D' },
          },
          { at, type: 'writer', step: 'key', detail: 'accepted (67 04)', passwordSource: 'unit-default' },
        ],
      }),
    );
    expect(item.body.events).toHaveLength(3);
  });

  it('uploads a record that mentions a VIN as it is, and the server files it under that car', async () => {
    await database.experiments.put(
      experiment({
        summary: 'note: TMBJB7NS0P8012345',
        backup: journal({ vin: { ...journal().vin, full: 'TMBJB7NS0P8012345' } }),
      }),
    );
    await sync();
    await drain();
    const row = env.DB.db.prepare('SELECT vin, body FROM items').get() as { vin: string; body: string };
    expect(row.vin).toBe('TMBJB7NS0P8012345');
    expect(JSON.parse(row.body).body).toMatchObject({ summary: 'note: TMBJB7NS0P8012345' });
  });

  it('a record that cannot be turned into an item uploads as a minimal item saying so — none of its data', async () => {
    const odd = experiment({ events: null as never });
    await database.experiments.put(odd);
    await sync();
    await drain();
    const row = env.DB.db.prepare('SELECT operation, body FROM items').get() as {
      operation: string;
      body: string;
    };
    expect(row.operation).toBe('prepare-failed');
    expect(row.body).not.toContain('Comfort lane change');
    expect(JSON.parse(row.body).body).toMatchObject({
      withheld: true,
      reason: expect.stringMatching(/could not be prepared/),
    });
  });

  it('trims an oversize record to fit the upload limit, with an explicit marker, instead of losing it', async () => {
    const at = '2026-10-25T12:00:06.000Z';
    const wire = Array.from({ length: 4000 }, (_, i) => ({
      at,
      elapsedMs: i,
      direction: 'tx' as const,
      text: `03 22 0A 5E ${'3E 00 A0 00 '.repeat(40)}${i}`,
    }));
    await database.experiments.put(experiment({ wire }));
    const record = await database.experiments.get('experiment-00000001');
    if (!record) throw new Error('not saved');
    const { item, text } = buildUpload('experiment', record);
    expect(new TextEncoder().encode(text).length).toBeLessThan(1_500_000);
    expect(item.body.truncated).toMatchObject({
      originalBytes: expect.any(Number),
      omitted: { wire: expect.any(Number) },
    });
    expect((item.body.wire as { elapsedMs: number }[])[0]?.elapsedMs).toBe(0); // first and last parts stay
    expect((item.body.wire as { elapsedMs: number }[]).at(-1)?.elapsedMs).toBe(3999);
    await sync();
    await drain();
    expect(await database.outbox.get('experiment:experiment-00000001')).toMatchObject({ status: 'uploaded' });
  });
});

describe('outbox', () => {
  it('uploads records made after enrollment once; an identical re-upload creates no duplicate', async () => {
    await database.experiments.put(experiment());
    await database.backups.put(journal());
    await sync();
    await drain();
    expect(stored()).toEqual([
      { kind: 'experiment', id: 'experiment-00000001', revision: 1 },
      { kind: 'journal', id: 'journal-00000001', revision: 1 },
    ]);
    expect((await database.outbox.toArray()).map((e) => e.status)).toEqual(['uploaded', 'uploaded']);
    // Unchanged: nothing is sent again.
    await sync();
    await drain();
    expect(calls).toBe(2);
    // A forced resend of identical content is a server-side no-op.
    await database.outbox.update('journal:journal-00000001', { status: 'queued' });
    await drain();
    expect(stored()).toEqual(
      expect.arrayContaining([{ kind: 'journal', id: 'journal-00000001', revision: 1 }]),
    );
  });

  it('a later read-back / restore result updates the stored copy as its next revision', async () => {
    await database.backups.put(journal({ status: 'unconfirmed', outcome: 'pending-uncertain' }));
    await sync();
    await drain();
    await database.backups.put(
      journal({ status: 'restored', restoredBy: 'restore-00000001', updatedAt: '2026-10-25T12:30:00.000Z' }),
    );
    await sync();
    await drain();
    expect(stored()).toEqual([{ kind: 'journal', id: 'journal-00000001', revision: 2 }]);
  });

  it('uploads records made before this browser registered, by itself', async () => {
    await database.experiments.put(
      experiment({ id: 'experiment-historical', startedAt: '2026-10-24T09:00:00.000Z' }),
    );
    await sync();
    await drain();
    expect(stored()).toEqual([{ kind: 'experiment', id: 'experiment-historical', revision: 1 }]);
    // An explicit upload of an already uploaded record is harmless.
    await enqueueManual('experiment', 'experiment-historical', () => database, now());
    await drain();
    expect(stored()).toEqual([{ kind: 'experiment', id: 'experiment-historical', revision: 1 }]);
  });

  it('a later change to an old record (an observation) uploads as its next revision', async () => {
    await database.experiments.put(experiment({ startedAt: '2026-10-20T09:00:00.000Z' }));
    await sync();
    await drain();
    clock += 60_000;
    await database.experiments.put(
      experiment({
        startedAt: '2026-10-20T09:00:00.000Z',
        updatedAt: '2026-10-25T12:03:00.000Z',
        observations: [{ at: '2026-10-25T12:03:00.000Z', expected: '3', verdict: 'different' }],
      }),
    );
    await sync();
    await drain();
    expect(stored()).toEqual([{ kind: 'experiment', id: 'experiment-00000001', revision: 2 }]);
  });

  it('recovers after being offline: the item waits, backs off, then uploads', async () => {
    await database.backups.put(journal());
    await sync();
    offline = true;
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: expect.stringMatching(/Offline/),
    });
    offline = false;
    await drain(); // not due yet: no request
    expect(calls).toBe(1);
    clock += 31_000;
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({
      status: 'uploaded',
      attempts: 0,
    });
    expect(stored()).toHaveLength(1);
  });

  it('never gives up on a transient failure: the backoff stops growing at an hour', async () => {
    await database.backups.put(journal());
    await sync();
    offline = true;
    for (let i = 0; i < 30; i++) {
      await drain();
      clock += 3_600_001;
    }
    const entry = await database.outbox.get('journal:journal-00000001');
    expect(entry).toMatchObject({ status: 'queued', attempts: 30 });
    expect(Date.parse(entry?.nextAttemptAt ?? '') - (clock - 3_600_001)).toBeLessThanOrEqual(3_600_000);
    expect(calls).toBe(30);
    offline = false;
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'uploaded' });
  });

  it('a used-up daily budget waits for the next UTC day, then uploads', async () => {
    const budget: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'daily-budget', message: 'budget used up' }), { status: 429 });
    await database.backups.put(journal());
    await sync();
    await drainOutbox({ enrollment, endpoint: ENDPOINT, fetchImpl: budget, database: () => database, now });
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({
      status: 'queued',
      nextAttemptAt: '2026-10-26T00:05:00.000Z',
    });
  });

  it('an item the server refused is tried again a day later (and on demand) instead of dying', async () => {
    const refuse: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'invalid-item', message: 'refused for a test' }), { status: 422 });
    await database.backups.put(journal());
    await sync();
    await drainOutbox({ enrollment, endpoint: ENDPOINT, fetchImpl: refuse, database: () => database, now });
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({
      status: 'failed',
      lastError: 'refused for a test',
    });
    clock += 60_000;
    await sync();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'failed' });
    clock += FAILED_RETRY_MS;
    await sync();
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'uploaded' });
    // The panel's button (and every app start) does the same at once.
    await database.outbox.update('journal:journal-00000001', { status: 'failed' });
    await retryFailed(() => database, now());
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'queued' });
  });

  it('a cloud copy the owner deleted is not re-uploaded by itself, only by an explicit upload', async () => {
    await database.backups.put(journal());
    await sync();
    await drain();
    await database.outbox.update('journal:journal-00000001', { status: 'failed', deleted: true });
    await database.backups.put(journal({ updatedAt: '2026-10-25T12:30:00.000Z', status: 'restored' }));
    clock += FAILED_RETRY_MS * 2;
    await sync();
    await retryFailed(() => database, now());
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'failed' });
    await enqueueManual('journal', 'journal-00000001', () => database, now());
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'uploaded' });
  });

  it('a revoked token puts the work back in the queue instead of failing it', async () => {
    env.DB.db.exec("UPDATE devices SET revoked_at = '2026-10-25T12:00:00.000Z'");
    await database.backups.put(journal());
    await sync();
    await drain();
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
  });

  it('a newer version already stored counts as uploaded', async () => {
    const stale: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'stale', message: 'newer' }), { status: 409 });
    await database.backups.put(journal());
    await sync();
    await drainOutbox({ enrollment, endpoint: ENDPOINT, fetchImpl: stale, database: () => database, now });
    expect(await database.outbox.get('journal:journal-00000001')).toMatchObject({ status: 'uploaded' });
  });
});

it('the uploader cannot reach the car: none of its modules import a link, the session or the controller', () => {
  for (const file of ['outbox.ts', 'config.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(
      /infra\/link|coding\/run|coding\/controller|session-store|connection-store/,
    );
  }
  for (const file of ['contract.ts', 'redact.ts']) {
    const source = readFileSync(new URL(`../../domain/logs/${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(/infra\/link|coding\/run|coding\/controller/);
  }
});
