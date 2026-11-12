import type { LampRecord } from './lamps.ts';
import type { CarMap, CarMapFeature, FeatureState } from './map.ts';

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
/** Table cells: no pipes or line breaks. */
const cell = (s: string | number | undefined) =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ');
const LONG_HEX = 96;
const clip = (hex: string) =>
  hex.length > LONG_HEX ? `${hex.slice(0, LONG_HEX)}… (${hex.length / 2} bytes)` : hex;

function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function describeState(state: FeatureState): string {
  switch (state.kind) {
    case 'set':
      return `${state.label}${state.inferred ? ' (inferred)' : ''}`;
    case 'not-hosted':
      return `not on this unit (${state.unit} refused ${state.did}, NRC ${state.code})`;
    case 'not-fitted':
      return `unit ${state.unit} not fitted`;
    case 'unknown':
      return `unknown: ${state.reason}`;
  }
}

const whereOf = (f: CarMapFeature): string => {
  if (f.parts) return f.parts.map((p) => `${p.unit ?? '?'}:${p.did ?? '?'}`).join(' + ');
  const s = f.state;
  return s.kind === 'set' || s.kind === 'not-hosted' ? `${s.unit}:${s.did}` : '';
};

function lampFunctions(r: LampRecord): string {
  if (r.empty) return 'not configured (all zero)';
  const fns = r.functions.map(
    (f) => `${f.slot} ${hx(f.code)} ${f.name}${f.confirmed ? '' : ' (unconfirmed on this BCM)'}`,
  );
  return fns.join('; ') || 'no function';
}

const lampDims = (r: LampRecord) =>
  r.dims
    .map(
      (d) => `${d.pair} ${d.level}${d.bit7 ? (d.pair === 'AB' ? ' tailgate-closed only' : ' minimise') : ''}`,
    )
    .join(', ');

/** A readable report of a car map: units, feature states, lamp records, then every value read. */
export function carMapMarkdown(map: CarMap): string {
  const out: string[] = [];
  const t = map.totals;
  out.push('# Full car scan');
  out.push('');
  out.push(`- VIN: ${map.vin ?? 'not read'}`);
  out.push(`- Started: ${map.startedAt} · took ${minutes(map.durationMs)}${map.deep ? ' · deep sweep' : ''}`);
  out.push(
    `- ${map.complete ? 'Complete' : `Incomplete${map.stopped ? ` (${map.stopped === 'lost' ? 'the adapter disconnected' : map.stopped === 'budget' ? 'time budget reached' : 'cancelled'})` : ' (some units stopped early)'}`}`,
  );
  out.push(
    `- ${t.fitted} of ${t.probed} unit addresses answered · ${t.values} values read · ${t.truncated} truncated · ${t.refused} refused · ${t.silent} unanswered`,
  );
  out.push(
    `- Features: ${t.features.on} on · ${t.features.off} off · ${t.features.other} other value · ${t.features.unknown} unknown · ${t.features.absent} not on this car`,
  );
  out.push('');
  out.push('Read-only: only 22 reads were sent. Nothing on the car was changed.');
  out.push('');

  out.push('## Control units');
  out.push('');
  out.push('| Unit | Address | Name | Part | Software | Hardware | ODX | Read | Refused | Unanswered |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const u of map.units) {
    const id = u.identity;
    out.push(
      `| ${cell([u.unit, ...u.aliases].join('/'))} | ${u.request}/${u.response} | ${cell(u.label)} | ${cell(id.part)} | ${cell(id.software)} | ${cell(id.hardware)} | ${cell(id.odx)} | ${Object.keys(u.values).length}${u.complete ? '' : ' (partial)'} | ${Object.keys(u.refused).length} | ${u.silent.length + u.pending.length} |`,
    );
  }
  const absent = map.discovery.filter((d) => !d.fitted);
  if (absent.length) {
    out.push('');
    out.push(
      `Not fitted or not answering: ${absent.map((d) => `${d.unit} ${d.label} (${d.request}, ${d.answer})`).join('; ')}.`,
    );
  }
  out.push('');

  out.push('## Features');
  out.push('');
  out.push('| Feature | State | Where | Recipe |');
  out.push('|---|---|---|---|');
  const order: CarMapFeature['class'][] = ['on', 'off', 'other', 'unknown', 'absent'];
  for (const cls of order)
    for (const f of map.features.filter((x) => x.class === cls))
      out.push(
        `| ${cell(f.name)} | ${cell(describeState(f.state))} | ${cell(whereOf(f))} | ${cell(f.recipeId)} |`,
      );
  out.push('');

  if (map.lamps.length) {
    out.push('## Lamp records (unit 09)');
    out.push('');
    out.push('| DID | Lamp | Type | Functions | Dim | Bytes |');
    out.push('|---|---|---|---|---|---|');
    for (const r of map.lamps)
      out.push(
        `| ${r.did}${r.short ? ' (short)' : ''} | ${cell(r.lamp)} | ${r.type ? `${hx(r.type.code)} ${cell(r.type.name)}` : ''} | ${cell(lampFunctions(r))} | ${cell(lampDims(r))} | ${r.hex} |`,
      );
    out.push('');
  }

  for (const u of map.units) {
    out.push(`## Unit ${u.unit} ${u.label} (${u.request}/${u.response})`);
    out.push('');
    if (u.unknown.length) out.push(`Answering identifiers no recipe explains: ${u.unknown.join(', ')}.`, '');
    out.push('| DID | Bytes | Value |');
    out.push('|---|---|---|');
    for (const did of Object.keys(u.values).sort()) {
      const v = u.values[did];
      if (!v) continue;
      out.push(
        `| ${did} | ${v.length}${v.truncated ? ' (truncated)' : ''} | ${cell(v.text ? `"${v.text}"` : clip(v.hex))} |`,
      );
    }
    const refused = Object.entries(u.refused);
    if (refused.length) {
      out.push('');
      out.push(`Refused: ${refused.map(([did, code]) => `${did} (${code})`).join(', ')}.`);
    }
    if (u.silent.length) out.push('', `Unanswered: ${u.silent.join(', ')}.`);
    if (u.pending.length) out.push('', `Busy, never finished: ${u.pending.join(', ')}.`);
    for (const d of u.deep ?? [])
      out.push(
        '',
        `Deep sweep ${d.from}..${d.to}: ${d.read} read${d.stoppedEarly ? ', stopped early' : ''}.`,
      );
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

/** A few lines for the end of a scan: units fitted, values read, features on and off. */
export function carMapSummary(map: CarMap): string[] {
  const t = map.totals;
  const lines = [
    `${t.fitted} of ${t.probed} units answered: ${map.units.map((u) => `${u.unit} ${u.label}${u.complete ? '' : ' (partial)'}`).join(', ') || 'none'}`,
    `${t.values} values read (${t.truncated} truncated, ${t.refused} refused, ${t.silent} unanswered), ${map.lamps.length} lamp records`,
    `features: ${t.features.on} on, ${t.features.off} off, ${t.features.other} other value, ${t.features.unknown} unknown, ${t.features.absent} not on this car`,
  ];
  const on = map.features.filter((f) => f.class === 'on').map((f) => f.name);
  if (on.length) lines.push(`on: ${on.join(', ')}`);
  if (!map.complete)
    lines.push(`incomplete${map.stopped ? `: ${map.stopped}` : ': some units stopped early'}`);
  return lines;
}
