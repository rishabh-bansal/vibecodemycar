#!/usr/bin/env node
/**
 * Reads a cloud log export (scripts/logs-pull.mjs) and prints what happened, item by item, in time order:
 * time, kind, mode, car (VIN), build (gitSha/buildId), recipe and setting, the outcome, then the events compactly
 * (writer decisions, readiness values, variant choice, markers, refusals…). With --uds, also the diagnostic
 * wire lines (AT commands and their answers left out) with the ms since the previous line.
 *
 *   npm run logs:summary -- <export.json> [--since 2026-11-01T16:28] [--kind experiment|journal|session]
 *                                         [--recipe <id>] [--vin <VIN>] [--uds]
 *   npm run logs:summary -- <export.json> --cars     # one line per car: VIN, items per kind, first/last seen
 *
 * Items that look like test-suite pollution (no wire trace and the simulator's VIN, MEXS…0001) are flagged
 * [TEST?]. VINs are printed in full.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find(
  (a, i) => !a.startsWith('--') && !['--since', '--kind', '--recipe', '--vin'].includes(args[i - 1]),
);
if (!file) {
  console.error('usage: logs-summary.mjs <export.json> [--since ISO] [--kind k] [--recipe id] [--vin VIN] [--uds] [--cars]');
  process.exit(2);
}
const sinceArg = option('since');
// An ISO time without a zone means UTC here (the log's own times are UTC), not this machine's local time.
const since = sinceArg ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(sinceArg) ? sinceArg : `${sinceArg}Z`) : undefined;
if (sinceArg && !Number.isFinite(since)) {
  console.error(`--since: not a time: ${sinceArg}`);
  process.exit(2);
}
const kind = option('kind');
const recipe = option('recipe');
const vinArg = option('vin')?.trim().toUpperCase();
const uds = flag('uds');
const carsOnly = flag('cars');

/** The car an item belongs to: its `vin` (current builds), else the full VIN its journal carries. */
const vinOf = (i) => i.vin ?? i.body?.vin?.full ?? i.body?.backup?.vin?.full ?? null;

const exported = JSON.parse(readFileSync(file, 'utf8'));
const items = (Array.isArray(exported) ? exported : (exported.items ?? []))
  .filter((i) => since === undefined || Date.parse(i.createdAt) >= since)
  .filter((i) => !kind || i.kind === kind)
  .filter((i) => !recipe || i.recipeId === recipe)
  .filter((i) => !vinArg || vinOf(i) === vinArg)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.kind.localeCompare(b.kind));

const out = (line) => console.log(String(line));
const clip = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const wireText = (t) =>
  String(t)
    .replace(/>\s*$/, '')
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');

// ---- events ----
const probeText = (p) =>
  [
    Object.entries(p?.reads ?? {})
      .map(([did, n]) => `${did}:${n ? `${n}B` : 'no'}`)
      .join(' '),
    p?.unit09NewGen !== undefined ? `unit09=${p.unit09NewGen ? 'new' : 'old'}-gen` : '',
    p?.isMib3 !== undefined ? (p.isMib3 ? 'MIB3' : 'MIB2.5') : '',
    p?.part ? `part=${p.part}` : '',
    p?.hardware ? `hw=${p.hardware}` : '',
  ]
    .filter(Boolean)
    .join(' ');

function eventText(e) {
  switch (e.type) {
    case 'writer':
      return `writer ${e.step}${e.did ? ` ${e.did}` : ''}${e.module ? ` @${e.module}` : ''}${e.detail ? `: ${e.detail}` : ''}${e.passwordSource ? ` [code: ${e.passwordSource}]` : ''}`;
    case 'readiness':
      return `readiness ${e.ok ? 'ok' : 'OUT-OF-BAND'} rpm=${e.rpm} speed=${e.speedKmh} V=${e.voltage} age=${e.ageMs}ms`;
    case 'variant-selected':
      return `variant ${e.selector} (${e.did}): ${e.reason} — ${probeText(e.probe)}`;
    case 'variant-refused':
      return `variant REFUSED: ${clip(e.reason, 100)} — ${probeText(e.probe)}`;
    case 'car-verified':
      return `car ${e.vinMasked} part ${e.part}`;
    case 'backup-saved':
      return `backup-saved ${String(e.backupId).slice(0, 8)}`;
    case 'request-sent':
      return `request-sent ${e.did}`;
    case 'warning':
      return `warning ${e.code}: ${clip(e.detail)}`;
    case 'refused':
      return `refused ${e.reason}: ${clip(e.detail)}`;
    case 'markers':
      return `markers ${(e.markers ?? []).map((m) => `${m.did}=${m.outcome}`).join(' ')}`;
    case 'sequence':
      return `sequence ${(e.steps ?? []).map((s) => `${s.cmd}=${s.outcome}${s.nrc ? `(${s.nrc})` : ''}`).join(' ')}${e.incomplete ? ` STOPPED at ${e.incomplete.step}: ${e.incomplete.reason}` : ''}`;
    case 'readback':
      return `readback ${e.matches ? 'match' : 'MISMATCH'} ${clip(e.observed, 60)}${e.moduleManaged?.length ? ` (+${e.moduleManaged.length} module-managed)` : ''}`;
    case 'group-step':
      return `group-step ${e.index + 1}/${e.of} ${e.module?.request ?? ''} ${e.did}`;
    case 'relink':
      return `relink attempt ${e.attempt}`;
    case 'module-scan':
      return `module-scan unit ${e.unit} ${e.part}: ${Object.keys(e.answered ?? {}).length} answered, ${Object.keys(e.refused ?? {}).length} refused, ${(e.silent ?? []).length} silent${e.complete ? '' : ' (partial)'}`;
    case 'feature-report':
      return `feature-report unit ${e.unit}: ${(e.entries ?? []).length} entries`;
    case 'audit-failed':
      return `audit-failed ${clip(e.detail)}`;
    case 'cancel-requested':
      return `cancel-requested${e.afterSend ? ' (after send)' : ''}`;
    case 'outcome':
      return `outcome ${e.outcome}: ${clip(e.phase)}`;
    default: {
      const { at: _at, type, ...rest } = e;
      const more = JSON.stringify(rest);
      return more === '{}' ? type : `${type} ${clip(more, 120)}`;
    }
  }
}

const isUdsTx = (t) => !/^\s*AT/i.test(t);

/** Wire lines with the AT traffic removed; rx after an AT command is its answer and is dropped too. */
function* udsLines(entries) {
  let lastTxAt = false;
  let prev;
  for (const e of entries) {
    if (e.direction === 'event') {
      // Only the app's coding/link stages: Bluetooth notifications and write receipts are noise here.
      if (/^(?:coding|link|adapter|identify|journal):/.test(e.text)) {
        const t = Date.parse(e.at);
        // `coding:<type> {"type":"<type>",…}` repeats the type: keep the rest.
        const text = e.text.replace(/\{"type":"[^"]+",?/, '{').replace(/ \{\}$/, '');
        yield { t, prev, line: `ev ${clip(text, 180)}` };
        prev = t;
      }
      continue;
    }
    if (e.direction === 'tx') lastTxAt = !isUdsTx(e.text);
    if (lastTxAt) continue;
    // An experiment's lines share one elapsed clock; a session's events have only wall time, so a session
    // uses wall time throughout (ms resolution) rather than mix two clocks.
    const t = e.elapsedMs ?? Date.parse(e.at);
    yield { t, prev, line: `${e.direction.padEnd(5)} ${clip(wireText(e.text), 180)}` };
    prev = t;
  }
}

const SIM_VIN = /MEXSIM|MEXS…0001/;

if (carsOnly) {
  const cars = new Map();
  for (const item of items) {
    const vin = vinOf(item) ?? '(no VIN)';
    const c = cars.get(vin) ?? { vin, items: 0, kinds: {}, first: item.createdAt, last: item.updatedAt };
    c.items++;
    c.kinds[item.kind] = (c.kinds[item.kind] ?? 0) + 1;
    if (item.createdAt < c.first) c.first = item.createdAt;
    if (item.updatedAt > c.last) c.last = item.updatedAt;
    cars.set(vin, c);
  }
  const sorted = [...cars.values()].sort((a, b) => b.last.localeCompare(a.last));
  const known = sorted.filter((c) => c.vin !== '(no VIN)').length;
  out(`== ${known} car(s), most recently seen first${known < sorted.length ? '; items without a VIN listed as (no VIN)' : ''}`);
  for (const c of sorted)
    out(
      `   ${c.vin.padEnd(17)} ${String(c.items).padStart(5)} items (${Object.entries(c.kinds)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')})  first ${c.first}  last ${c.last}`,
    );
  if (!sorted.length) out('No items match.');
  process.exit(0);
}

for (const item of items) {
  const b = item.body ?? {};
  const f = item.facts ?? {};
  const build = `${b.build?.gitSha ?? b.gitSha ?? '-'}/${String(item.buildId ?? '-').slice(0, 8)}`;
  const setting = b.settingId ?? b.backup?.settingId ?? '';
  const what = item.recipeId ? `${item.recipeId}${setting ? `=${setting}` : ''}` : (b.featureId ?? '');
  const wire = b.wire ?? (item.kind === 'session' ? b.entries : []) ?? [];
  // Simulator VIN outside demo mode: no real car produces it, so it is test pollution. Demo runs are tagged
  // [DEMO] (a real demo-mode session in the browser looks the same).
  const demo = f.mode === 'demo';
  const test = !demo && item.kind !== 'session' && SIM_VIN.test(JSON.stringify(b));
  const result =
    item.kind === 'experiment'
      ? clip(b.summary, 140)
      : item.kind === 'journal'
        ? `${f.outcome ?? b.status} ack=${f.ack ?? b.ack}`
        : `${wire.length} entries${b.closed ? '' : ' (open)'}`;
  out('');
  out(
    `== ${item.createdAt} ${item.kind} ${f.mode ?? '-'} ${vinOf(item) ?? 'no-VIN'} ${build} ${what} :: ${result}${test ? '  [TEST?]' : demo ? '  [DEMO]' : ''}`,
  );

  if (item.kind === 'experiment') {
    const events = b.events ?? [];
    const t0 = Date.parse(events[0]?.at ?? item.createdAt);
    // Older records have no readiness event: the journal still carries what was measured.
    const r = b.backup?.readiness;
    if (r && !events.some((e) => e.type === 'readiness'))
      out(`   (journal) readiness rpm=${r.rpm} speed=${r.speedKmh} V=${r.voltage} at ${r.at}`);
    for (const e of events) {
      const dt = ((Date.parse(e.at) - t0) / 1000).toFixed(1).padStart(6);
      out(`   +${dt}s ${eventText(e)}`);
    }
    if (b.traceTruncated) out('   (wire trace truncated)');
  } else if (item.kind === 'journal') {
    const r = b.readiness;
    out(
      `   ${b.module?.request ?? ''} ${b.did ?? ''} ${b.before ?? ''} → ${b.intended ?? ''} observed ${b.observed ?? '-'} status ${b.status ?? '-'}`,
    );
    if (r) out(`   readiness rpm=${r.rpm} speed=${r.speedKmh} V=${r.voltage} at ${r.at}`);
    for (const m of b.markers ?? []) out(`   marker ${m.did}=${m.outcome}`);
    for (const w of b.warnings ?? []) out(`   warning ${clip(w)}`);
  } else if (item.kind === 'session' && !uds) {
    const events = (b.entries ?? []).filter((e) => e.direction === 'event' && !/^ble:/.test(e.text));
    const tx = (b.entries ?? []).filter((e) => e.direction === 'tx').length;
    out(`   ${tx} tx; stage events:`);
    for (const e of events.slice(0, 12)) out(`   ${e.at.slice(11, 23)} ${clip(e.text, 160)}`);
    if (events.length > 12) out(`   … ${events.length - 12} more (use --uds for the full exchange)`);
  }

  if (uds && wire.length) {
    out('   -- UDS (AT traffic omitted) --');
    for (const { t, prev, line } of udsLines(wire)) {
      const dt = prev === undefined ? '' : `+${Math.round(t - prev)}ms`;
      out(`   ${dt.padStart(8)} ${line}`);
    }
  }
}
if (!items.length) out('No items match.');

// ---- upload health per device (what each browser could not upload, as it last reported) ----
const devices = Array.isArray(exported.deviceStatus) ? exported.deviceStatus : [];
if (devices.length) {
  out('');
  out(`== upload status of ${devices.length} device(s), newest report first`);
  for (const d of devices) {
    const s = d.status ?? {};
    const counts = Object.entries(s.counts ?? {})
      .map(([k, c]) => `${k} ${Object.entries(c).map(([st, n]) => `${st}=${n}`).join(',')}`)
      .join('; ');
    const failed = Object.values(s.counts ?? {}).reduce((n, c) => n + (c.failed ?? 0), 0);
    out(
      `   ${d.received_at} ${d.role} ${String(d.device_id).slice(0, 8)} ${s.build?.gitSha ?? '-'}/${String(s.buildId ?? '-').slice(0, 8)}${d.revoked_at ? ' (revoked)' : ''}${failed ? `  FAILED ${failed}` : ''}`,
    );
    if (counts) out(`      ${counts}${s.oldestQueued ? ` · oldest queued ${s.oldestQueued}` : ''}`);
    for (const e of s.errors ?? []) out(`      ! ${clip(e, 200)}`);
  }
}
