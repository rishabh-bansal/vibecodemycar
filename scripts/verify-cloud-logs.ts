/**
 * Verifies the deployed private log Worker with SYNTHETIC items only (no vehicle data; the VIN is a made-up one
 * starting with SYNTH, so it never matches a real car):
 *   node scripts/verify-cloud-logs.ts <endpoint>
 * Reads the enrollment code from ~/.obdcraft/cloud-enrollment-code; never prints it or the device token.
 * Cleans up after itself: deletes its synthetic items and revokes the device it enrolled.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { LOG_SCHEMA, type LogItem } from '../src/domain/logs/contract.ts';
import { drainOutbox, syncOutbox } from '../src/infra/cloud/outbox.ts';
import { ObdcraftDb } from '../src/infra/storage/db.ts';

const endpoint = process.argv[2] ?? '';
if (!/^https:\/\//.test(endpoint)) throw new Error('usage: node scripts/verify-cloud-logs.ts https://<worker>');
const code = readFileSync(`${homedir()}/.obdcraft/cloud-enrollment-code`, 'utf8').trim();
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const stamp = Date.now();
const iso = (ms = 0) => new Date(stamp + ms).toISOString();

const unauth = await fetch(`${endpoint}/v1/items`);
check('unauthenticated list is refused', unauth.status === 401, `HTTP ${unauth.status}`);
const forged = await fetch(`${endpoint}/v1/export`, { headers: { Authorization: `Bearer ${'A'.repeat(43)}` } });
check('a forged token is refused', forged.status === 401, `HTTP ${forged.status}`);
const badCode = await fetch(`${endpoint}/v1/enroll`, { method: 'POST', body: JSON.stringify({ code: 'not-the-code' }) });
check('a wrong enrollment code is refused', badCode.status === 401, `HTTP ${badCode.status}`);

const enrolled = await fetch(`${endpoint}/v1/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, label: 'synthetic verification' }),
});
check('enrollment with the owner code succeeds', enrolled.status === 201, `HTTP ${enrolled.status}`);
const { token, deviceId } = (await enrolled.json()) as { token: string; deviceId: string };
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const id = `synthetic-verify-${stamp}`;
const SYNTH_VIN = `SYNTH${String(stamp).slice(-12).padStart(12, '0')}`;
const item: LogItem = {
  schema: LOG_SCHEMA, kind: 'experiment', id, buildId: 'synthetic', recipeId: 'live-bcm-polite-blinks', recipeDigest: null,
  createdAt: iso(), updatedAt: iso(), vin: SYNTH_VIN,
  facts: { operation: 'apply', mode: 'demo', outcome: 'verified', ack: 'received', sequenceComplete: null, physical: 'as-expected' },
  body: { synthetic: true, note: 'verification item, no vehicle data' },
};
const put = (body: unknown) => fetch(`${endpoint}/v1/items/experiment/${id}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
const first = await put(item);
check('authenticated upload succeeds', first.status === 201, `HTTP ${first.status} ${JSON.stringify(await first.json())}`);
const again = await put(item);
const againBody = (await again.json()) as { status: string };
check('a duplicate upload creates no duplicate', again.status === 200 && againBody.status === 'duplicate', JSON.stringify(againBody));
const list = (await (await fetch(`${endpoint}/v1/items?limit=500`, { headers: auth })).json()) as { items: { id: string; vin?: string }[] };
check('exactly one stored copy', list.items.filter((i) => i.id === id).length === 1);
const listed = list.items.find((i) => i.id === id) as { vin?: string } | undefined;
check('the item is filed under its VIN', listed?.vin === SYNTH_VIN, `${listed?.vin}`);
const cars = (await (await fetch(`${endpoint}/v1/cars`, { headers: auth })).json()) as { cars?: { vin: string; items: number }[] };
check('the car appears in the car list', cars.cars?.some((c) => c.vin === SYNTH_VIN && c.items >= 1) === true);
const perCar = (await (await fetch(`${endpoint}/v1/items?vin=${SYNTH_VIN}`, { headers: auth })).json()) as { items: { id: string }[] };
check('the item list narrows to that car', perCar.items.length === 1 && perCar.items[0]?.id === id, `${perCar.items.length} items`);
const carExport = (await (await fetch(`${endpoint}/v1/export?limit=50&vin=${SYNTH_VIN}`, { headers: auth })).json()) as { items: LogItem[] };
check('the export narrows to that car, VIN included', carExport.items.length === 1 && carExport.items[0]?.vin === SYNTH_VIN, `${carExport.items.length} items`);
const preflight = await fetch(`${endpoint}/v1/items`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
check('CORS does not answer a foreign origin', preflight.headers.get('Access-Control-Allow-Origin') === null);

// Offline recovery through the real outbox: the first attempt cannot reach the network, a later one does.
const db = new ObdcraftDb(`verify-${stamp}`);
const enrollment = { token, deviceId, label: 'synthetic verification', enrolledAt: iso(-60_000) };
const journalId = `synthetic-journal-${stamp}`;
await db.backups.put({
  schema: 'vibecode-my-car.backup/2', operation: 'apply', linkMode: 'demo', ack: 'received', outcome: 'verified', history: [],
  id: journalId, createdAt: iso(), updatedAt: iso(), featureId: 'synthetic', featureName: 'Synthetic', recipeId: 'synthetic',
  settingId: 'x', settingLabel: 'x', car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
  vin: { masked: `${SYNTH_VIN.slice(0, 4)}…${SYNTH_VIN.slice(-4)}`, fingerprint: '0'.repeat(64), full: SYNTH_VIN }, module: { request: '70E', response: '778', part: 'SYNTHETIC' },
  did: '0A5E', before: '3A00000000', intended: '3E00000000', status: 'verified',
});
let clock = stamp;
const now = () => new Date(clock);
await syncOutbox(enrollment, () => db, now());
await drainOutbox({ enrollment, endpoint, database: () => db, now, fetchImpl: async () => { throw new TypeError('offline'); } });
const waiting = await db.outbox.get(`journal:${journalId}`);
check('offline: the item stays queued with a backoff', waiting?.status === 'queued' && waiting.attempts === 1, `${waiting?.status}, attempts ${waiting?.attempts}`);
clock += 31_000;
await drainOutbox({ enrollment, endpoint, database: () => db, now });
const after = await db.outbox.get(`journal:${journalId}`);
check('back online: it uploads', after?.status === 'uploaded', `${after?.status}`);
const stored = await fetch(`${endpoint}/v1/items/journal/${journalId}`, { headers: auth });
const storedJournal = stored.status === 200 ? ((await stored.json()) as LogItem) : undefined;
check('the uploaded journal is on the server, with its full VIN', storedJournal?.vin === SYNTH_VIN, `HTTP ${stored.status}`);

// Automatic logging: a browser registers itself as an upload-only collector.
const reg = await fetch(`${endpoint}/v1/register`, { method: 'POST' });
const collector = (await reg.json()) as { token: string; role: string };
check('a browser registers itself automatically (no code)', reg.status === 201 && collector.role === 'collector', `HTTP ${reg.status}`);
const cAuth = { Authorization: `Bearer ${collector.token}`, 'Content-Type': 'application/json' };
const sessionId = `synthetic-session-${stamp}`;
const sessionPut = await fetch(`${endpoint}/v1/items/session/${sessionId}`, {
  method: 'PUT',
  headers: cAuth,
  body: JSON.stringify({
    ...item, kind: 'session', id: sessionId,
    facts: { operation: 'connection', mode: 'live', outcome: null, ack: null, sequenceComplete: null, physical: null },
    body: { synthetic: true, entries: [{ direction: 'tx', text: 'ATZ' }] },
  }),
});
check('the collector uploads a connection log', sessionPut.status === 201, `HTTP ${sessionPut.status}`);
for (const path of ['/v1/items', '/v1/export', `/v1/items/session/${sessionId}`]) {
  const r = await fetch(`${endpoint}${path}`, { headers: cAuth });
  check(`the collector cannot read ${path}`, r.status === 403, `HTTP ${r.status}`);
}
const ownerSees = (await (await fetch(`${endpoint}/v1/items?kind=session&limit=500`, { headers: auth })).json()) as { items: { id: string }[] };
check('the owner sees the uploaded connection log', ownerSees.items.some((i) => i.id === sessionId));
await fetch(`${endpoint}/v1/items/session/${sessionId}`, { method: 'DELETE', headers: auth });
await fetch(`${endpoint}/v1/device`, { method: 'DELETE', headers: cAuth });

// Clean up: delete the synthetic items, revoke this verification device.
for (const [kind, key] of [['experiment', id], ['journal', journalId]] as const) {
  const del = await fetch(`${endpoint}/v1/items/${kind}/${key}`, { method: 'DELETE', headers: auth });
  check(`deleted synthetic ${kind}`, del.status === 200);
}
await fetch(`${endpoint}/v1/device`, { method: 'DELETE', headers: auth });
const revoked = await fetch(`${endpoint}/v1/items`, { headers: auth });
check('the verification device is revoked afterwards', revoked.status === 401, `HTTP ${revoked.status}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
