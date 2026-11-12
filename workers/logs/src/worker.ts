/**
 * OBDCraft private log Worker (Cloudflare Workers + D1).
 *
 * Two roles, each holding a random device token (`Authorization: Bearer …`; only its SHA-256 is stored; revocable):
 *  - collector: any browser registers itself automatically (POST /v1/register, rate-limited per IP). It may only
 *    add and update its OWN items, within a daily byte budget. It cannot list, read, export or delete anything.
 *  - owner: enrolled with the owner's code (the Worker secret ENROLLMENT_CODE, never in the frontend). Owners can
 *    also list, read, export and delete, per car too: every item is filed under the car's full VIN (`vin` column),
 *    GET /v1/cars lists the cars, and `?vin=` narrows GET /v1/items and GET /v1/export to one car.
 * CORS restricts which pages may call the API; it is not the authentication.
 *
 * Items are idempotent: PUT /v1/items/:kind/:id with the same content is a no-op ("duplicate"); new content
 * for the same id replaces it as the next revision, unless it is older than what is stored ("stale").
 * Nothing here can reach a vehicle.
 */
import {
  LOG_KINDS,
  type LogItem,
  MAX_ITEM_BYTES,
  STORED_VIN,
  validateLogItem,
  vinOfItem,
} from '../../../src/domain/logs/contract.ts';

export interface D1Result<T> {
  results: T[];
}
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
}

export interface Env {
  DB: D1Like;
  ENROLLMENT_CODE?: string;
  /** Comma-separated origins allowed to call the API from a browser. */
  ALLOWED_ORIGINS?: string;
}

export const RETENTION_DAYS = 180;
const MAX_ENROLL_FAILURES_PER_HOUR = 5;
/** Automatic registrations per IP per hour (each browser registers once; a shared network has several). */
export const MAX_REGISTRATIONS_PER_HOUR = 30;
/** Largest upload-status report a device may send. */
export const MAX_STATUS_BYTES = 16_384;
/** Bytes a collector may upload per UTC day (new revisions count too). */
export const COLLECTOR_DAILY_BYTES = 50_000_000;
const DAY = 86_400_000;

const enc = new TextEncoder();
const sha256 = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
/** Constant-time comparison of two strings' SHA-256 digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Pages that may call the API from a browser, besides ALLOWED_ORIGINS: the site's Pages preview and deployment
 * URLs, and local development on any port. (CORS is not the authentication; tokens are.)
 */
const ALWAYS_ALLOWED = [
  /^https:\/\/(?:[a-z0-9-]+\.)?(?:vibecodemycar|obdcraft)\.pages\.dev$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/,
];

export function originAllowed(origin: string, env: Env): boolean {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) || ALWAYS_ALLOWED.some((p) => p.test(origin));
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  return origin && originAllowed(origin, env)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
const problem = (status: number, error: string, message: string, headers?: Record<string, string>) =>
  json(status, { error, message }, headers);

interface Device {
  id: string;
  role: 'owner' | 'collector';
}

async function authenticate(req: Request, env: Env): Promise<Device | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(header)?.[1];
  if (!token) return null;
  const device = await env.DB.prepare('SELECT id, role FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256(token))
    .first<Device>();
  if (device)
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), device.id)
      .run();
  return device;
}

async function readBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; res: Response }> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_ITEM_BYTES)
    return { ok: false, res: problem(413, 'too-large', `Items are limited to ${MAX_ITEM_BYTES} bytes.`) };
  const text = await req.text();
  if (enc.encode(text).length > MAX_ITEM_BYTES)
    return { ok: false, res: problem(413, 'too-large', `Items are limited to ${MAX_ITEM_BYTES} bytes.`) };
  return { ok: true, text };
}

async function enroll(req: Request, env: Env, h: Record<string, string>): Promise<Response> {
  if (!env.ENROLLMENT_CODE) return problem(503, 'not-configured', 'Enrollment is not configured.', h);
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const failures = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM enroll_attempts WHERE ip = ? AND at > ? AND ok = 0',
  )
    .bind(ip, since)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_ENROLL_FAILURES_PER_HOUR)
    return problem(429, 'too-many-attempts', 'Too many failed enrollment attempts. Try again in an hour.', h);
  const body = await readBody(req);
  if (!body.ok) return body.res;
  let input: { code?: unknown; label?: unknown };
  try {
    input = JSON.parse(body.text);
  } catch {
    return problem(400, 'bad-json', 'The body must be JSON.', h);
  }
  const ok = typeof input.code === 'string' && (await sameSecret(input.code, env.ENROLLMENT_CODE));
  await env.DB.prepare('INSERT INTO enroll_attempts (ip, at, ok) VALUES (?, ?, ?)')
    .bind(ip, new Date().toISOString(), ok ? 1 : 0)
    .run();
  if (!ok) return problem(401, 'bad-code', 'That enrollment code is not right.', h);
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 64) : 'browser';
  const token = randomToken();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO devices (id, token_hash, label, created_at, role) VALUES (?, ?, ?, ?, 'owner')")
    .bind(id, await sha256(token), label, new Date().toISOString())
    .run();
  return json(201, { deviceId: id, token, role: 'owner' }, h);
}

/**
 * Automatic, anonymous registration of an upload-only collector. A browser whose earlier tokens stopped working
 * (revoked by sign-out or retention, or replaced) may present them as `previousTokens`: proving it held them, the
 * new device takes over the items and status they uploaded, and those tokens are revoked for good.
 */
async function register(req: Request, env: Env, h: Record<string, string>): Promise<Response> {
  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
  const now = new Date();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM registrations WHERE ip = ? AND at > ?')
    .bind(ip, new Date(now.getTime() - 3_600_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_REGISTRATIONS_PER_HOUR)
    return problem(429, 'too-many-registrations', 'Too many registrations from this network. Try again later.', h);
  const body = await readBody(req);
  if (!body.ok) return body.res;
  let previous: string[] = [];
  if (body.text.trim()) {
    try {
      const input = JSON.parse(body.text) as { previousTokens?: unknown };
      if (Array.isArray(input.previousTokens))
        previous = input.previousTokens
          .filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t))
          .slice(0, 5);
    } catch {
      return problem(400, 'bad-json', 'The body must be JSON (or empty).', h);
    }
  }
  await env.DB.prepare('INSERT INTO registrations (ip, at) VALUES (?, ?)').bind(ip, now.toISOString()).run();
  const token = randomToken();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO devices (id, token_hash, label, created_at, role) VALUES (?, ?, 'auto', ?, 'collector')",
  )
    .bind(id, await sha256(token), now.toISOString())
    .run();
  let tookOver = 0;
  for (const old of previous) {
    const prior = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ?')
      .bind(await sha256(old))
      .first<{ id: string }>();
    if (!prior || prior.id === id) continue;
    await env.DB.prepare('UPDATE items SET device_id = ? WHERE device_id = ?').bind(id, prior.id).run();
    await env.DB.prepare('DELETE FROM device_status WHERE device_id = ?').bind(prior.id).run();
    await env.DB.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .bind(now.toISOString(), prior.id)
      .run();
    tookOver++;
  }
  return json(201, { deviceId: id, token, role: 'collector', tookOver }, h);
}

/** A device's report of its own upload health (see migrations/0003_device_status.sql). Replaces the last one. */
async function putStatus(req: Request, env: Env, device: Device, h: Record<string, string>): Promise<Response> {
  const text = await req.text();
  if (enc.encode(text).length > MAX_STATUS_BYTES)
    return problem(413, 'too-large', `A status report is limited to ${MAX_STATUS_BYTES} bytes.`, h);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return problem(400, 'bad-json', 'The body must be JSON.', h);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return problem(422, 'invalid-status', 'The status must be a JSON object.', h);
  await env.DB.prepare(
    `INSERT INTO device_status (device_id, received_at, body) VALUES (?, ?, ?)
     ON CONFLICT (device_id) DO UPDATE SET received_at = excluded.received_at, body = excluded.body`,
  )
    .bind(device.id, new Date().toISOString(), text)
    .run();
  return json(200, { status: 'stored' }, h);
}

/** The `vin` query parameter, upper-cased; undefined when absent. */
const vinParam = (url: URL): string | undefined => url.searchParams.get('vin')?.trim().toUpperCase() || undefined;
const badVin = (h: Record<string, string>) =>
  problem(400, 'bad-vin', 'vin must be the car’s VIN: letters and digits only.', h);

/** One page of the export: at most `limit` items (and about EXPORT_PAGE_BYTES), in (kind, id) order. */
export const EXPORT_PAGE_BYTES = 20_000_000;
async function exportPage(url: URL, env: Env, h: Record<string, string>): Promise<Response> {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const after = url.searchParams.get('after') ?? '';
  const [afterKind = '', afterId = ''] = after ? after.split('/') : [];
  const since = url.searchParams.get('since');
  const excludeMode = url.searchParams.get('excludeMode');
  const vin = vinParam(url);
  const where: string[] = ['(kind > ? OR (kind = ? AND id > ?))'];
  const values: unknown[] = [afterKind, afterKind, afterId];
  if (vin) {
    where.push('vin = ?');
    values.push(vin);
  }
  if (since) {
    where.push('updated_at >= ?');
    values.push(since);
  }
  if (excludeMode) {
    where.push('mode != ?');
    values.push(excludeMode);
  }
  // Sizes first, so one page never loads more bodies than it can return.
  const rows = await env.DB.prepare(
    `SELECT kind, id, size FROM items WHERE ${where.join(' AND ')} ORDER BY kind, id LIMIT ?`,
  )
    .bind(...values, limit)
    .all<{ kind: string; id: string; size: number }>();
  const picked: { kind: string; id: string }[] = [];
  let bytes = 0;
  for (const r of rows.results) {
    if (picked.length && bytes + r.size > EXPORT_PAGE_BYTES) break;
    picked.push(r);
    bytes += r.size;
  }
  const bodies: string[] = [];
  for (const r of picked) {
    const row = await env.DB.prepare('SELECT body FROM items WHERE kind = ? AND id = ?')
      .bind(r.kind, r.id)
      .first<{ body: string }>();
    if (row) bodies.push(row.body);
  }
  const last = picked.at(-1);
  const more = picked.length < rows.results.length || rows.results.length === limit;
  const next = last && more ? `${last.kind}/${last.id}` : null;
  return new Response(
    `{"schema":"obdcraft.log-export-page/1","exportedAt":"${new Date().toISOString()}","retentionDays":${RETENTION_DAYS},"next":${JSON.stringify(next)},"items":[${bodies.join(',')}]}`,
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } },
  );
}

async function putItem(
  req: Request,
  env: Env,
  device: Device,
  kind: string,
  id: string,
  h: Record<string, string>,
): Promise<Response> {
  const body = await readBody(req);
  if (!body.ok) return body.res;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return problem(400, 'bad-json', 'The body must be JSON.', h);
  }
  const v = validateLogItem(parsed);
  if (!v.ok) return problem(422, 'invalid-item', v.error, h);
  const item: LogItem = v.item;
  if (item.kind !== kind || item.id !== id)
    return problem(422, 'invalid-item', 'The URL and the item disagree on kind or id.', h);
  const hash = await sha256(body.text);
  const existing = await env.DB.prepare(
    'SELECT content_hash, updated_at, revision, device_id FROM items WHERE kind = ? AND id = ?',
  )
    .bind(kind, id)
    .first<{ content_hash: string; updated_at: string; revision: number; device_id: string }>();
  if (existing?.content_hash === hash) return json(200, { status: 'duplicate', revision: existing.revision }, h);
  if (device.role === 'collector') {
    // A collector only ever writes its own items, within its daily budget.
    if (existing && existing.device_id !== device.id)
      return problem(403, 'not-yours', 'This item was uploaded by another device.', h);
    const today = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const used = await env.DB.prepare(
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM items WHERE device_id = ? AND received_at >= ?',
    )
      .bind(device.id, today)
      .first<{ bytes: number }>();
    if ((used?.bytes ?? 0) + enc.encode(body.text).length > COLLECTOR_DAILY_BYTES)
      return problem(429, 'daily-budget', "This device's upload budget for today is used up; it will try again tomorrow.", h);
  }
  if (existing && existing.updated_at > item.updatedAt)
    return problem(409, 'stale', 'A newer version of this item is already stored.', h);
  const revision = (existing?.revision ?? 0) + 1;
  const f = item.facts;
  const vin = vinOfItem(item);
  await env.DB.prepare(
    `INSERT INTO items (kind, id, schema, build_id, recipe_id, recipe_digest, operation, mode, outcome, ack,
       sequence_complete, physical, created_at, updated_at, received_at, revision, content_hash, size, device_id, body,
       vin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE SET
       schema = excluded.schema, build_id = excluded.build_id, recipe_id = excluded.recipe_id,
       recipe_digest = excluded.recipe_digest, operation = excluded.operation, mode = excluded.mode,
       outcome = excluded.outcome, ack = excluded.ack, sequence_complete = excluded.sequence_complete,
       physical = excluded.physical, updated_at = excluded.updated_at, received_at = excluded.received_at,
       revision = excluded.revision, content_hash = excluded.content_hash, size = excluded.size,
       device_id = excluded.device_id, body = excluded.body, vin = COALESCE(excluded.vin, items.vin)`,
  )
    .bind(
      kind,
      id,
      item.schema,
      item.buildId,
      item.recipeId,
      item.recipeDigest,
      f.operation,
      f.mode,
      f.outcome,
      f.ack,
      f.sequenceComplete === null ? null : f.sequenceComplete ? 1 : 0,
      f.physical,
      item.createdAt,
      item.updatedAt,
      new Date().toISOString(),
      revision,
      hash,
      enc.encode(body.text).length,
      device.id,
      body.text,
      vin,
    )
    .run();
  // A connection reads the VIN after its first chunk may already be stored: file the earlier chunks of the
  // same connection (and device) under the car too.
  const session = item.body.session;
  if (vin && kind === 'session' && typeof session === 'string' && /^[A-Za-z0-9-]{8,58}$/.test(session))
    await env.DB.prepare(
      "UPDATE items SET vin = ? WHERE kind = 'session' AND vin IS NULL AND device_id = ? AND id LIKE ?",
    )
      .bind(vin, device.id, `${session}-%`)
      .run();
  return json(existing ? 200 : 201, { status: 'stored', revision }, h);
}

const SUMMARY =
  'kind, id, vin, schema, build_id, recipe_id, recipe_digest, operation, mode, outcome, ack, sequence_complete, physical, created_at, updated_at, received_at, revision, size';

async function route(req: Request, env: Env): Promise<Response> {
  const h = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/v1/health') return json(200, { ok: true }, h);
  if (path === '/v1/enroll' && req.method === 'POST') return enroll(req, env, h);
  if (path === '/v1/register' && req.method === 'POST') return register(req, env, h);

  const device = await authenticate(req, env);
  if (!device) return problem(401, 'unauthenticated', 'A valid device token is required.', h);

  if (path === '/v1/device' && req.method === 'DELETE') {
    await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), device.id).run();
    return json(200, { status: 'revoked' }, h);
  }
  const m = /^\/v1\/items\/([a-z]+)\/([A-Za-z0-9._:-]{8,64})$/.exec(path);
  if (path === '/v1/status' && req.method === 'PUT') return putStatus(req, env, device, h);
  if (m && req.method === 'PUT') {
    const [, kind = '', id = ''] = m;
    if (!LOG_KINDS.includes(kind as never)) return problem(404, 'not-found', 'Unknown item kind.', h);
    return putItem(req, env, device, kind, id, h);
  }
  // Everything below reads or removes logs: owners only.
  if (device.role !== 'owner') return problem(403, 'owner-only', 'Only an owner device can view or delete logs.', h);
  const vin = vinParam(url);
  if (vin && !STORED_VIN.test(vin)) return badVin(h);
  if (path === '/v1/items' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100));
    const kind = url.searchParams.get('kind');
    const where: string[] = [];
    const values: unknown[] = [];
    if (kind) {
      where.push('kind = ?');
      values.push(kind);
    }
    if (vin) {
      where.push('vin = ?');
      values.push(vin);
    }
    const rows = await env.DB.prepare(
      `SELECT ${SUMMARY} FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(...values, limit)
      .all();
    return json(200, { items: rows.results, retentionDays: RETENTION_DAYS }, h);
  }
  // The cars the log knows, most recently seen first, with how many items of each kind each has.
  if (path === '/v1/cars' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT vin, COUNT(*) AS items,
         SUM(kind = 'journal') AS journals, SUM(kind = 'experiment') AS experiments, SUM(kind = 'session') AS sessions,
         COUNT(DISTINCT device_id) AS devices, MIN(created_at) AS first_seen, MAX(updated_at) AS last_seen
       FROM items WHERE vin IS NOT NULL GROUP BY vin ORDER BY last_seen DESC LIMIT 1000`,
    ).all();
    const unfiled = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE vin IS NULL').first<{ n: number }>();
    return json(200, { cars: rows.results, unfiled: unfiled?.n ?? 0, retentionDays: RETENTION_DAYS }, h);
  }
  if (path === '/v1/status' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT s.device_id, s.received_at, s.body, d.role, d.label, d.last_seen_at, d.revoked_at
       FROM device_status s JOIN devices d ON d.id = s.device_id ORDER BY s.received_at DESC LIMIT 500`,
    ).all<{ device_id: string; received_at: string; body: string; role: string; label: string; last_seen_at: string | null; revoked_at: string | null }>();
    return json(
      200,
      {
        devices: rows.results.map(({ body, ...r }) => {
          try {
            return { ...r, status: JSON.parse(body) };
          } catch {
            return { ...r, status: null };
          }
        }),
      },
      h,
    );
  }
  // Paged export (`limit` given): the way to read a large log. Without it, the whole log in one response.
  if (path === '/v1/export' && req.method === 'GET' && url.searchParams.has('limit')) return exportPage(url, env, h);
  if (path === '/v1/export' && req.method === 'GET') {
    const rows = vin
      ? await env.DB.prepare('SELECT body FROM items WHERE vin = ? ORDER BY created_at').bind(vin).all<{ body: string }>()
      : await env.DB.prepare('SELECT body FROM items ORDER BY created_at').all<{ body: string }>();
    return new Response(
      `{"schema":"obdcraft.log-export/1","exportedAt":"${new Date().toISOString()}","retentionDays":${RETENTION_DAYS},"items":[${rows.results.map((r) => r.body).join(',')}]}`,
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } },
    );
  }
  if (m) {
    const [, kind = '', id = ''] = m;
    if (!LOG_KINDS.includes(kind as never)) return problem(404, 'not-found', 'Unknown item kind.', h);
    if (req.method === 'GET') {
      const row = await env.DB.prepare('SELECT body FROM items WHERE kind = ? AND id = ?').bind(kind, id).first<{ body: string }>();
      return row
        ? new Response(row.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } })
        : problem(404, 'not-found', 'No such item.', h);
    }
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM items WHERE kind = ? AND id = ?').bind(kind, id).run();
      return json(200, { status: 'deleted' }, h);
    }
  }
  return problem(404, 'not-found', 'No such endpoint.', h);
}

/** Daily retention: items 180 days after their last update, attempt records after a day, idle devices. */
export async function applyRetention(env: Env, now = Date.now()): Promise<void> {
  const cutoff = new Date(now - RETENTION_DAYS * DAY).toISOString();
  await env.DB.prepare('DELETE FROM items WHERE updated_at < ?').bind(cutoff).run();
  await env.DB.prepare('DELETE FROM enroll_attempts WHERE at < ?').bind(new Date(now - DAY).toISOString()).run();
  await env.DB.prepare('DELETE FROM registrations WHERE at < ?').bind(new Date(now - DAY).toISOString()).run();
  await env.DB.prepare('DELETE FROM device_status WHERE received_at < ?').bind(cutoff).run();
  await env.DB.prepare(
    'UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND COALESCE(last_seen_at, created_at) < ?',
  )
    .bind(new Date(now).toISOString(), cutoff)
    .run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch {
      return problem(500, 'internal', 'The log service failed; the item stays queued on your device.', cors(req, env));
    }
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await applyRetention(env);
  },
};
