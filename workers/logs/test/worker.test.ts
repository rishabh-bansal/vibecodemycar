import { beforeEach, describe, expect, it } from 'vitest';
import { LOG_SCHEMA, type LogItem, MAX_ITEM_BYTES } from '../../../src/domain/logs/contract.ts';
import worker, {
  applyRetention,
  COLLECTOR_DAILY_BYTES,
  type Env,
  MAX_REGISTRATIONS_PER_HOUR,
  RETENTION_DAYS,
} from '../src/worker.ts';
import { sqliteD1 } from './d1-sqlite.ts';

const CODE = 'synthetic-enrollment-code-for-tests-only';
const BASE = 'https://logs.example';
const VIN = 'TMBJB7NS0P8012345';
const OTHER_VIN = 'WVWZZZAWZNY000042';
let env: Env & { DB: ReturnType<typeof sqliteD1> };

const call = (method: string, path: string, init: { token?: string; body?: unknown; origin?: string; ip?: string } = {}) =>
  worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.origin ? { Origin: init.origin } : {}),
        'CF-Connecting-IP': init.ip ?? '203.0.113.7',
      },
      ...(init.body !== undefined ? { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) } : {}),
    }),
    env,
  );

async function enroll(): Promise<string> {
  const res = await call('POST', '/v1/enroll', { body: { code: CODE, label: 'test browser' } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

const item = (over: Partial<LogItem> = {}): LogItem => ({
  schema: LOG_SCHEMA,
  kind: 'experiment',
  id: 'synthetic-experiment-0001',
  buildId: 'f2ebeff397e20bbb31b7',
  recipeId: 'live-bcm-polite-blinks',
  recipeDigest: 'a1626fc88383417cf97d080e0fc8c6f52cb8d80169073ba8e19a4d3ecaf8d776',
  createdAt: '2026-10-25T12:00:00.000Z',
  updatedAt: '2026-10-25T12:01:00.000Z',
  facts: { operation: 'apply', mode: 'demo', outcome: 'verified', ack: 'received', sequenceComplete: null, physical: 'as-expected' },
  body: { synthetic: true, events: [{ type: 'outcome', outcome: 'verified' }] },
  ...over,
});

beforeEach(() => {
  env = { DB: sqliteD1(), ENROLLMENT_CODE: CODE, ALLOWED_ORIGINS: 'http://localhost:4173' };
});

describe('authentication', () => {
  it('refuses every data endpoint without a valid device token', async () => {
    for (const [method, path] of [
      ['GET', '/v1/items'],
      ['GET', '/v1/export'],
      ['PUT', '/v1/items/experiment/synthetic-experiment-0001'],
      ['DELETE', '/v1/items/experiment/synthetic-experiment-0001'],
    ] as const) {
      const res = await call(method, path, { body: method === 'PUT' ? item() : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await call(method, path, { token: 'x'.repeat(43) })).status).toBe(401);
    }
  });

  it('enrolls with the owner code; stores only a hash of the token; a wrong code is refused and rate-limited', async () => {
    const token = await enroll();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = env.DB.db.prepare('SELECT token_hash FROM devices').all() as { token_hash: string }[];
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/enroll', { body: { code: 'wrong' }, ip: '198.51.100.9' })).status).toBe(401);
    expect((await call('POST', '/v1/enroll', { body: { code: CODE }, ip: '198.51.100.9' })).status).toBe(429);
  });

  it('a revoked token stops working', async () => {
    const token = await enroll();
    expect((await call('DELETE', '/v1/device', { token })).status).toBe(200);
    expect((await call('GET', '/v1/items', { token })).status).toBe(401);
  });

  it('CORS answers only listed origins, and is not authentication', async () => {
    const pre = await call('OPTIONS', '/v1/items', { origin: 'http://localhost:4173' });
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4173');
    const other = await call('OPTIONS', '/v1/items', { origin: 'https://evil.example' });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await call('GET', '/v1/items', { origin: 'http://localhost:4173' })).status).toBe(401);
  });

  it.each([
    ['https://obdcraft.pages.dev', true],
    ['https://vibecodemycar.pages.dev', true],
    ['https://3f2a91bc.vibecodemycar.pages.dev', true],
    ['https://3f2a91bc.obdcraft.pages.dev', true],
    ['https://fix-logs.obdcraft.pages.dev', true],
    ['http://localhost:5174', true],
    ['http://127.0.0.1:4173', true],
    ['http://localhost', true],
    ['https://obdcraft.pages.dev.evil.example', false],
    ['https://evilobdcraft.pages.dev', false],
    ['https://evilvibecodemycar.pages.dev', false],
    ['http://obdcraft.pages.dev', false],
    ['http://localhost.evil.example', false],
  ])('CORS for %s: %s (production, Pages previews, local dev on any port)', async (origin, ok) => {
    env.ALLOWED_ORIGINS = '';
    const pre = await call('OPTIONS', '/v1/register', { origin });
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ok ? origin : null);
  });
});

describe('uploads', () => {
  it('stores an item once: a duplicate upload is a no-op, new content is the next revision, older content is refused', async () => {
    const token = await enroll();
    const path = '/v1/items/experiment/synthetic-experiment-0001';
    expect(await (await call('PUT', path, { token, body: item() })).json()).toEqual({ status: 'stored', revision: 1 });
    expect(await (await call('PUT', path, { token, body: item() })).json()).toEqual({ status: 'duplicate', revision: 1 });
    const later = item({ updatedAt: '2026-10-25T12:05:00.000Z', facts: { ...item().facts, physical: 'different' } });
    expect(await (await call('PUT', path, { token, body: later })).json()).toEqual({ status: 'stored', revision: 2 });
    expect((await call('PUT', path, { token, body: item({ body: { older: true } }) })).status).toBe(409);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
    const row = env.DB.db.prepare('SELECT ack, sequence_complete, physical, revision FROM items').get();
    expect(row).toEqual({ ack: 'received', sequence_complete: null, physical: 'different', revision: 2 });
  });

  it.each([
    ['its vin field', { vin: VIN }, { synthetic: true }],
    ['a full VIN in an older item’s body', {}, { note: VIN }],
    ['a VIN inside hex frames of an older item', {}, { rx: '62 F1 90 54 4D 42 4A 42 37 4E 53 30 50 38 30 31 32 33 34 35' }],
  ])('stores an item with a VIN and files it under the car (from %s)', async (_name, over, body) => {
    const token = await enroll();
    const res = await call('PUT', '/v1/items/experiment/synthetic-experiment-0001', { token, body: item({ ...over, body }) });
    expect(res.status).toBe(201);
    expect(env.DB.db.prepare('SELECT vin FROM items').get()).toEqual({ vin: VIN });
  });

  it('keeps an item without a VIN unfiled, and refuses a malformed vin field', async () => {
    const token = await enroll();
    const put = (body: unknown) => call('PUT', '/v1/items/experiment/synthetic-experiment-0001', { token, body });
    expect((await put(item({ vin: null }))).status).toBe(201);
    expect(env.DB.db.prepare('SELECT vin FROM items').get()).toEqual({ vin: null });
    expect(await (await put(item({ vin: 'tmb jb7' }))).json()).toMatchObject({ message: expect.stringMatching(/vin/) });
  });

  it('validates the item and the URL, and limits size', async () => {
    const token = await enroll();
    const put = (body: unknown, id = 'synthetic-experiment-0001') => call('PUT', `/v1/items/experiment/${id}`, { token, body });
    expect((await put('{not json')).status).toBe(400);
    expect(await (await put({ ...item(), schema: 'other' })).json()).toMatchObject({ message: expect.stringMatching(/schema/) });
    expect((await put(item(), 'synthetic-experiment-0002')).status).toBe(422);
    expect((await put({ ...item(), facts: { ...item().facts, sequenceComplete: 'yes' } })).status).toBe(422);
    const huge = item({ body: { pad: 'A'.repeat(MAX_ITEM_BYTES) } });
    expect((await put(huge)).status).toBe(413);
  });
});

describe('viewing, export, deletion, retention', () => {
  it('lists summaries, returns an item, exports everything, deletes', async () => {
    const token = await enroll();
    await call('PUT', '/v1/items/experiment/synthetic-experiment-0001', { token, body: item() });
    await call('PUT', '/v1/items/journal/synthetic-journal-0001', { token, body: item({ kind: 'journal', id: 'synthetic-journal-0001' }) });
    const list = (await (await call('GET', '/v1/items', { token })).json()) as { items: unknown[]; retentionDays: number };
    expect(list.items).toHaveLength(2);
    expect(list.retentionDays).toBe(RETENTION_DAYS);
    expect(JSON.stringify(list)).not.toContain('"body"');
    expect(await (await call('GET', '/v1/items/journal/synthetic-journal-0001', { token })).json()).toMatchObject({ id: 'synthetic-journal-0001' });
    const exported = (await (await call('GET', '/v1/export', { token })).json()) as { items: LogItem[] };
    expect(exported.items.map((i) => i.id).sort()).toEqual(['synthetic-experiment-0001', 'synthetic-journal-0001']);
    expect((await call('DELETE', '/v1/items/journal/synthetic-journal-0001', { token })).status).toBe(200);
    expect((await call('GET', '/v1/items/journal/synthetic-journal-0001', { token })).status).toBe(404);
  });

  it('exports in pages, filtered by update time and mode, that together hold every item exactly once', async () => {
    const token = await enroll();
    for (let i = 0; i < 7; i++)
      await call('PUT', `/v1/items/experiment/synthetic-experiment-000${i}`, {
        token,
        body: item({
          id: `synthetic-experiment-000${i}`,
          updatedAt: `2026-10-2${i}T12:00:00.000Z`,
          createdAt: '2026-10-20T12:00:00.000Z',
          facts: { ...item().facts, mode: i % 2 ? 'live' : 'demo' },
        }),
      });
    const pages = async (query: string) => {
      const ids: string[] = [];
      let after = '';
      for (let n = 0; n < 20; n++) {
        const res = await call('GET', `/v1/export?limit=3${query}${after ? `&after=${encodeURIComponent(after)}` : ''}`, { token });
        const page = (await res.json()) as { items: LogItem[]; next: string | null };
        expect(page.items.length).toBeLessThanOrEqual(3);
        ids.push(...page.items.map((i) => i.id));
        if (!page.next) return ids;
        after = page.next;
      }
      throw new Error('no end');
    };
    expect(await pages('')).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `synthetic-experiment-000${i}`));
    expect(await pages('&excludeMode=demo')).toEqual([1, 3, 5].map((i) => `synthetic-experiment-000${i}`));
    expect(await pages('&since=2026-10-25T00:00:00.000Z')).toEqual([5, 6].map((i) => `synthetic-experiment-000${i}`));
  });

  it('lists the cars, and narrows the item list and the export to one car', async () => {
    const token = await enroll();
    const put = (kind: 'experiment' | 'journal', id: string, vin: string | null, updatedAt: string) =>
      call('PUT', `/v1/items/${kind}/${id}`, { token, body: item({ kind, id, vin, updatedAt }) });
    await put('experiment', 'synthetic-experiment-0001', VIN, '2026-10-25T12:01:00.000Z');
    await put('journal', 'synthetic-journal-0001', VIN, '2026-10-25T12:02:00.000Z');
    await put('experiment', 'synthetic-experiment-0002', OTHER_VIN, '2026-10-26T12:00:00.000Z');
    await put('experiment', 'synthetic-experiment-0003', null, '2026-10-26T13:00:00.000Z');
    const cars = (await (await call('GET', '/v1/cars', { token })).json()) as {
      cars: { vin: string; items: number; journals: number; experiments: number; last_seen: string }[];
      unfiled: number;
    };
    expect(cars.cars).toEqual([
      expect.objectContaining({ vin: OTHER_VIN, items: 1, experiments: 1, journals: 0, last_seen: '2026-10-26T12:00:00.000Z' }),
      expect.objectContaining({ vin: VIN, items: 2, experiments: 1, journals: 1, last_seen: '2026-10-25T12:02:00.000Z' }),
    ]);
    expect(cars.unfiled).toBe(1);
    const list = (await (await call('GET', `/v1/items?vin=${VIN.toLowerCase()}`, { token })).json()) as {
      items: { id: string; vin: string }[];
    };
    expect(list.items.map((i) => i.id)).toEqual(['synthetic-journal-0001', 'synthetic-experiment-0001']);
    const journals = (await (await call('GET', `/v1/items?vin=${VIN}&kind=journal`, { token })).json()) as { items: unknown[] };
    expect(journals.items).toHaveLength(1);
    const whole = (await (await call('GET', `/v1/export?vin=${OTHER_VIN}`, { token })).json()) as { items: LogItem[] };
    expect(whole.items.map((i) => i.id)).toEqual(['synthetic-experiment-0002']);
    const paged = (await (await call('GET', `/v1/export?limit=10&vin=${VIN}`, { token })).json()) as { items: LogItem[] };
    expect(paged.items.map((i) => i.id).sort()).toEqual(['synthetic-experiment-0001', 'synthetic-journal-0001']);
    expect((await call('GET', '/v1/items?vin=not-a-vin', { token })).status).toBe(400);
  });

  it('files a connection’s earlier chunks under the car once a later chunk carries the VIN', async () => {
    const token = await enroll();
    const chunk = (n: number, vin: string | null) =>
      item({
        kind: 'session',
        id: `synthetic-conn-000${n}`,
        vin,
        facts: { operation: 'connection', mode: 'live', outcome: null, ack: null, sequenceComplete: null, physical: null },
        body: { session: 'synthetic-conn', chunk: n },
      });
    await call('PUT', '/v1/items/session/synthetic-conn-0000', { token, body: chunk(0, null) });
    await call('PUT', '/v1/items/session/synthetic-other-0000', {
      token,
      body: { ...chunk(0, null), id: 'synthetic-other-0000', body: { session: 'synthetic-other' } },
    });
    await call('PUT', '/v1/items/session/synthetic-conn-0001', { token, body: chunk(1, VIN) });
    expect(env.DB.db.prepare('SELECT id, vin FROM items ORDER BY id').all()).toEqual([
      { id: 'synthetic-conn-0000', vin: VIN },
      { id: 'synthetic-conn-0001', vin: VIN },
      { id: 'synthetic-other-0000', vin: null },
    ]);
  });

  it('only an owner lists cars', async () => {
    const res = await call('POST', '/v1/register', {});
    const { token } = (await res.json()) as { token: string };
    expect((await call('GET', '/v1/cars', { token })).status).toBe(403);
    expect((await call('GET', '/v1/cars')).status).toBe(401);
  });

  it(`deletes items ${RETENTION_DAYS} days after their last update`, async () => {
    const token = await enroll();
    await call('PUT', '/v1/items/experiment/synthetic-experiment-0001', { token, body: item() });
    await applyRetention(env, Date.parse('2026-10-25T12:01:00.000Z') + (RETENTION_DAYS - 1) * 86_400_000);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
    await applyRetention(env, Date.parse('2026-10-25T12:01:00.000Z') + (RETENTION_DAYS + 1) * 86_400_000);
    expect(env.DB.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 0 });
  });
});

describe('automatic collectors (upload-only)', () => {
  async function register(ip = '203.0.113.50'): Promise<string> {
    const res = await call('POST', '/v1/register', { ip });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; role: string };
    expect(body.role).toBe('collector');
    return body.token;
  }
  const session = (id = 'synthetic-session-0001') =>
    item({ kind: 'session', id, facts: { operation: 'connection', mode: 'live', outcome: null, ack: null, sequenceComplete: null, physical: null } });

  it('registers without any code and can upload its own logs', async () => {
    const token = await register();
    const res = await call('PUT', '/v1/items/session/synthetic-session-0001', { token, body: session() });
    expect(await res.json()).toEqual({ status: 'stored', revision: 1 });
  });

  it('cannot list, read, export or delete anything — only an owner can', async () => {
    const collector = await register();
    await call('PUT', '/v1/items/session/synthetic-session-0001', { token: collector, body: session() });
    for (const [method, path] of [
      ['GET', '/v1/items'],
      ['GET', '/v1/export'],
      ['GET', '/v1/items/session/synthetic-session-0001'],
      ['DELETE', '/v1/items/session/synthetic-session-0001'],
    ] as const)
      expect((await call(method, path, { token: collector })).status, `${method} ${path}`).toBe(403);
    const owner = await enroll();
    const list = (await (await call('GET', '/v1/items', { token: owner })).json()) as { items: { kind: string }[] };
    expect(list.items.map((i) => i.kind)).toEqual(['session']);
  });

  it('cannot overwrite another device’s item', async () => {
    const a = await register('203.0.113.51');
    const b = await register('203.0.113.52');
    await call('PUT', '/v1/items/session/synthetic-session-0001', { token: a, body: session() });
    const res = await call('PUT', '/v1/items/session/synthetic-session-0001', {
      token: b,
      body: { ...session(), updatedAt: '2026-10-25T13:00:00.000Z', body: { overwritten: true } },
    });
    expect(res.status).toBe(403);
  });

  it(`limits registrations to ${MAX_REGISTRATIONS_PER_HOUR} per network per hour`, async () => {
    for (let i = 0; i < MAX_REGISTRATIONS_PER_HOUR; i++) await register('198.51.100.20');
    expect((await call('POST', '/v1/register', { ip: '198.51.100.20' })).status).toBe(429);
  });

  it('a re-registered browser proves its earlier tokens and takes over their items (and only those)', async () => {
    const old = await register('203.0.113.61');
    const stranger = await register('203.0.113.62');
    await call('PUT', '/v1/items/session/synthetic-session-0001', { token: old, body: session() });
    await call('PUT', '/v1/items/session/synthetic-session-0003', { token: stranger, body: session('synthetic-session-0003') });
    // The old token stopped working (sign-out or retention).
    expect((await call('DELETE', '/v1/device', { token: old })).status).toBe(200);
    const res = await call('POST', '/v1/register', { ip: '203.0.113.61', body: { previousTokens: [old, 'y'.repeat(43)] } });
    expect(res.status).toBe(201);
    const { token, tookOver } = (await res.json()) as { token: string; tookOver: number };
    expect(tookOver).toBe(1);
    const later = { ...session(), updatedAt: '2026-10-25T13:00:00.000Z', body: { later: true } };
    expect(await (await call('PUT', '/v1/items/session/synthetic-session-0001', { token, body: later })).json()).toEqual({
      status: 'stored',
      revision: 2,
    });
    // Another device's items stay out of reach.
    const theirs = { ...session('synthetic-session-0003'), updatedAt: '2026-10-25T13:00:00.000Z', body: { x: 1 } };
    expect((await call('PUT', '/v1/items/session/synthetic-session-0003', { token, body: theirs })).status).toBe(403);
    expect((await call('POST', '/v1/register', { body: '{nope' })).status).toBe(400);
  });

  it('stores each device’s upload status (one row, replaced); only an owner can read it', async () => {
    const token = await register();
    const report = { schema: 'obdcraft.device-status/1', counts: { session: { failed: 2 } }, errors: ['failed session: x'] };
    expect((await call('PUT', '/v1/status', { token, body: report })).status).toBe(200);
    expect((await call('PUT', '/v1/status', { token, body: { ...report, errors: [] } })).status).toBe(200);
    expect((await call('PUT', '/v1/status', { token, body: { ...report, errors: [`failed journal ${VIN}`] } })).status).toBe(200);
    expect((await call('PUT', '/v1/status', { token, body: { ...report, errors: [] } })).status).toBe(200);
    expect((await call('PUT', '/v1/status', { token, body: { pad: 'x'.repeat(20_000) } })).status).toBe(413);
    expect((await call('PUT', '/v1/status', { body: report })).status).toBe(401);
    expect((await call('GET', '/v1/status', { token })).status).toBe(403);
    const owner = await enroll();
    const { devices } = (await (await call('GET', '/v1/status', { token: owner })).json()) as {
      devices: { role: string; status: { errors: string[] } }[];
    };
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ role: 'collector', status: { errors: [] } });
  });

  it('stops a collector at its daily byte budget, with a reason', async () => {
    const token = await register();
    env.DB.db
      .prepare(
        `INSERT INTO items (kind, id, schema, build_id, operation, mode, created_at, updated_at, received_at, revision, content_hash, size, device_id, body)
         SELECT 'session', 'synthetic-filler-0001', 'x', 'x', 'connection', 'live', ?, ?, ?, 1, 'h', ?, id, '{}' FROM devices WHERE role = 'collector'`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), COLLECTOR_DAILY_BYTES);
    const res = await call('PUT', '/v1/items/session/synthetic-session-0002', { token, body: session('synthetic-session-0002') });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'daily-budget' });
  });
});
