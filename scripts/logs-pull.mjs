#!/usr/bin/env node
/**
 * Pulls the private cloud log: enrolls a temporary owner device with the enrollment code in
 * ~/.obdcraft/cloud-enrollment-code, downloads the export page by page (GET /v1/export?limit=…&after=…; an
 * older Worker answers the whole log at once, which is used as is) plus every device's upload status
 * (GET /v1/status, as `deviceStatus`) and the car list (GET /v1/cars, as `cars`), writes it OUTSIDE the repo to ~/.obdcraft/exports/export-<ISO>.json and
 * always revokes the temporary device again.
 *
 *   npm run logs:pull                    # then: npm run logs:summary -- <printed path>
 *   npm run logs:pull -- --since 2026-11-01T00:00:00Z --no-demo
 *   npm run logs:pull -- --vin TMBJB7NS0P8012345     # one car's logs only
 *   npm run logs:pull -- --cars                      # list the cars (VIN, items per kind, last seen); no export
 *   OBDCRAFT_LOG_ENDPOINT=http://localhost:8787 npm run logs:pull
 *
 * Never prints the enrollment code or the device token.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = process.env.OBDCRAFT_LOG_ENDPOINT ?? 'https://obdcraft-logs.rishabhbansal1855.workers.dev';
const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? args[sinceAt + 1] : undefined;
if (since !== undefined && !Number.isFinite(Date.parse(since ?? ''))) {
  console.error('--since needs an ISO time, e.g. 2026-11-01T00:00:00Z');
  process.exit(2);
}
const noDemo = args.includes('--no-demo');
const vinAt = args.indexOf('--vin');
const vin = vinAt >= 0 ? args[vinAt + 1]?.trim().toUpperCase() : undefined;
if (vinAt >= 0 && !/^[A-Z0-9]{1,32}$/.test(vin ?? '')) {
  console.error('--vin needs the car’s VIN, e.g. --vin TMBJB7NS0P8012345');
  process.exit(2);
}
const carsOnly = args.includes('--cars');
const home = join(homedir(), '.obdcraft');

let code;
try {
  code = readFileSync(join(home, 'cloud-enrollment-code'), 'utf8').trim();
} catch {
  console.error(`No enrollment code: put the owner code in ${join(home, 'cloud-enrollment-code')} (chmod 600).`);
  process.exit(1);
}
if (!code) {
  console.error('The enrollment code file is empty.');
  process.exit(1);
}

const label = `logs-pull ${new Date().toISOString().slice(0, 16)}`;
const enroll = await fetch(`${ENDPOINT}/v1/enroll`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, label }),
});
if (enroll.status !== 201) {
  console.error(`Enrollment refused: HTTP ${enroll.status}.`);
  process.exit(1);
}
let token;
let deviceId;
try {
  ({ token, deviceId } = await enroll.json());
} catch {
  // handled below
}
if (typeof token !== 'string' || !token) {
  console.error(
    `Enrollment answered 201 without a usable token: device ${deviceId ?? '(unknown id)'} "${label}" may exist; revoke it by hand.`,
  );
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };
let revoked = false;
const revoke = async () => {
  if (revoked) return true;
  revoked = true;
  const res = await fetch(`${ENDPOINT}/v1/device`, { method: 'DELETE', headers: auth }).catch(() => undefined);
  if (!res?.ok) {
    console.error(
      `Could not revoke the temporary device ${deviceId ?? '(unknown id)'} "${label}" (HTTP ${res?.status ?? 'offline'}); revoke it by hand.`,
    );
    return false;
  }
  return true;
};
// Ctrl-C skips `finally`: revoke first, then leave.
process.once('SIGINT', () => {
  revoke().finally(() => process.exit(130));
});
let failed = false;
/** The car list, or null from a Worker that does not file items per car yet. */
async function fetchCars() {
  const res = await fetch(`${ENDPOINT}/v1/cars`, { headers: auth }).catch(() => undefined);
  return res?.ok ? ((await res.json()).cars ?? null) : null;
}
try {
  if (carsOnly) {
    const cars = await fetchCars();
    if (!cars) throw new Error('This log Worker does not list cars yet: deploy it (npm run logs:deploy) first.');
    console.log(`${cars.length} car(s), most recently seen first`);
    for (const c of cars)
      console.log(
        `${c.vin.padEnd(17)} ${String(c.items).padStart(5)} items (journal ${c.journals}, experiment ${c.experiments}, session ${c.sessions})  first ${c.first_seen}  last ${c.last_seen}`,
      );
  } else await pull();
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.message : 'Export failed.');
} finally {
  if (!(await revoke())) failed = true;
}
process.exit(failed ? 1 : 0);

async function pull() {
  const items = [];
  let after = '';
  let legacy;
  for (let page = 0; page < 10_000; page++) {
    const query = new URLSearchParams({ limit: '100' });
    if (after) query.set('after', after);
    if (since) query.set('since', new Date(since).toISOString());
    if (noDemo) query.set('excludeMode', 'demo');
    if (vin) query.set('vin', vin);
    const res = await fetch(`${ENDPOINT}/v1/export?${query}`, { headers: auth });
    const text = await res.text();
    if (!res.ok) throw new Error(`Export failed: HTTP ${res.status}.`);
    const body = JSON.parse(text);
    if (body.schema !== 'obdcraft.log-export-page/1') {
      // An older Worker without paging: it sent the whole log.
      legacy = body;
      break;
    }
    items.push(...body.items);
    process.stderr.write(`\r${items.length} items…`);
    if (!body.next) break;
    after = body.next;
  }
  process.stderr.write('\n');
  let deviceStatus = null;
  const status = await fetch(`${ENDPOINT}/v1/status`, { headers: auth }).catch(() => undefined);
  if (status?.ok) deviceStatus = (await status.json()).devices ?? null;
  // An older Worker ignores the filters: apply them here.
  const kept = (
    legacy
      ? legacy.items.filter(
          (i) =>
            (!since || Date.parse(i.updatedAt) >= Date.parse(since)) && (!noDemo || i.facts?.mode !== 'demo'),
        )
      : items
  ).filter((i) => !vin || (i.vin ?? i.body?.vin?.full ?? i.body?.backup?.vin?.full) === vin);
  const cars = await fetchCars();
  const all = kept.sort(
    (a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)),
  );
  const text = JSON.stringify({
    schema: 'obdcraft.log-export/1',
    exportedAt: new Date().toISOString(),
    retentionDays: legacy?.retentionDays ?? 180,
    ...(since ? { since } : {}),
    ...(noDemo ? { excludedModes: ['demo'] } : {}),
    ...(vin ? { vin } : {}),
    items: all,
    deviceStatus,
    cars,
  });
  const dir = join(home, 'exports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, text, { mode: 0o600 });
  console.log(
    `${all.length} items${cars ? ` of ${new Set(all.map((i) => i.vin).filter(Boolean)).size} car(s)` : ''}, ${(text.length / 1e6).toFixed(1)} MB${deviceStatus ? `, status of ${deviceStatus.length} devices` : ''} → ${path}`,
  );
}
