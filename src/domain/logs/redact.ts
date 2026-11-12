import type { BackupRecord } from '../backups/schema.ts';
import type { ExperimentRecord } from '../coding/audit.ts';
import type { CarMap } from '../scan/map.ts';
import { normalizeVin } from '../vin.ts';
import {
  type BuildInfo,
  findVin,
  LOG_SCHEMA,
  type LogFacts,
  type LogItem,
  MAX_ITEM_BYTES,
} from './contract.ts';

/**
 * Turns local records into cloud log items. Each item carries the car's full VIN (`vin`, and in the record
 * itself), so every log can be tied to its car; replies to VIN reads (`22 F190`, `09 02`) stay in the wire trace
 * as received. Only serial numbers are blanked: the control unit's serial (`22 F18C`, also dropped from module
 * snapshots) and the adapter's (`AT@2`, `STSN`).
 */

/** DIDs whose values are a unit's serial number rather than a coding. */
const SERIAL_DIDS = new Set(['F18C']);
const SERIAL_REQUEST = /(22F18C|AT@2|STSN)/;

function journalBody(b: BackupRecord): Record<string, unknown> {
  const { moduleSnapshot, ...rest } = b;
  const snapshot = moduleSnapshot
    ? Object.fromEntries(Object.entries(moduleSnapshot).filter(([did]) => !SERIAL_DIDS.has(did)))
    : undefined;
  return { ...rest, ...(snapshot ? { moduleSnapshot: snapshot } : {}) };
}

/** Adapter commands whose reply is itself an identifier (serial numbers): blanked entirely. */
const ADAPTER_IDENTITY = /^(AT@2|STSN)/;
// Both forms occurred in the successful native runs and in the 2026-10-26 browser capture.
const FRAME_LINE =
  /^((?:[0-9A-F]{2}\s+){3}[0-9A-F]{2}|[0-9A-F]{8}|[0-9A-F]{3})((?:\s+(?:[0-9A-F]{2}|··))+)\s*$/i;
const IDENTITY_FRAGMENT = '[redacted: identity fragment]';
const SAFE_IDENTITY_STATUS =
  /^(?:OK|NO DATA|CAN ERROR|BUS ERROR|BUS BUSY|BUFFER FULL|DATA ERROR|FB ERROR|RX ERROR|STOPPED|UNABLE TO CONNECT|LV RESET|ACT ALERT|ERR\d*|\?|SEARCHING\.*|BUS INIT[. ]*ERROR|\d{1,2}\.\d+V)$/i;

/**
 * Keeps a serial-number reply's structure for diagnosis and blanks its data: per CAN frame, the identifier and the
 * ISO-TP control byte stay, a first or single frame also keeps the service and DID echo (`62 F1 8C`), and a negative
 * response (`7F ..`) stays whole. Status lines (NO DATA, ?, OK, STOPPED) stay. Every data byte becomes `··`.
 */
function blankIdentityData(text: string): string {
  return text
    .split(/(\r\n|\r|\n|>)/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '>' || SAFE_IDENTITY_STATUS.test(trimmed)) return line;
      const m = FRAME_LINE.exec(trimmed);
      // An unknown/compact/malformed line may still contain the serial. Never pass it through.
      if (!m) return IDENTITY_FRAGMENT;
      const bytes = (m[2] ?? '').trim().split(/\s+/);
      const pci = Number.parseInt(bytes[0] ?? '0', 16) >> 4;
      const isNrc = bytes[0] === '03' && bytes[1]?.toUpperCase() === '7F' && bytes.length <= 8;
      if (isNrc) return line;
      const prefix = pci === 1 ? 2 : 1;
      const echo = bytes
        .slice(prefix, prefix + 3)
        .join('')
        .toUpperCase();
      // Preserve only the recognised echo; malformed bytes in its place may themselves be data.
      const keep = (pci === 0 || pci === 1) && echo === '62F18C' ? prefix + 3 : prefix;
      return [m[1], ...bytes.map((b, i) => (i < keep ? b : '··'))].join(' ');
    })
    .join('');
}

/**
 * A redactor for a live wire trace: replies following a serial-number request keep their structure when a
 * complete line arrives. Partial/unknown fragments are hidden; their timestamps remain. Flow control and AT
 * commands do not end redaction of a pending serial reply. A new diagnostic request does. Every other reply —
 * VIN reads included — passes through unchanged.
 */
export function createWireRedactor(
  hideOrphanReplies = false,
): <T extends { direction: string; text: string }>(entry: T) => T {
  let hiding: 'none' | 'data' | 'all' = hideOrphanReplies ? 'data' : 'none';
  // Notifications can end inside a header, a byte, or a line. Only a terminated line is safe to parse.
  // Its incomplete tail stays in memory; the stored entry contains a placeholder, never those bytes.
  let tail = '';
  return (entry) => {
    if (entry.direction === 'tx') {
      const cmd = entry.text.replace(/\s+/g, '').toUpperCase();
      tail = '';
      if (ADAPTER_IDENTITY.test(cmd)) hiding = 'all';
      else if (SERIAL_REQUEST.test(cmd)) hiding = 'data';
      // Flow control, monitoring and configuration are not a new diagnostic request: serial CFs may follow.
      else if (!(hiding === 'data' && /^(?:AT(?!Z$)|X$|3[0-2][0-9A-F]{4,14}$)/.test(cmd))) hiding = 'none';
      return entry;
    }
    if (entry.direction === 'event' || hiding === 'none') return entry;
    if (hiding === 'all') return { ...entry, text: '[redacted: identity reply]' };
    // Re-redacting an older log must be safe and must keep placeholders from incomplete notifications.
    if (entry.text === IDENTITY_FRAGMENT) return entry;
    const text = tail + entry.text;
    const end = Math.max(text.lastIndexOf('\r'), text.lastIndexOf('\n'), text.lastIndexOf('>')) + 1;
    tail = text.slice(end);
    if (tail.length > 4096) tail = ''; // malformed endless line: discard, never persist
    return {
      ...entry,
      text: blankIdentityData(text.slice(0, end)) || IDENTITY_FRAGMENT,
    };
  };
}

/**
 * Blanks serial replies in a stored wire trace. A trace may start midway through a reply, so replies before its
 * first command are treated as a serial reply until that command.
 */
function redactWire<T extends { direction: string; text: string }>(wire: readonly T[]): T[] {
  return wire.map(createWireRedactor(true));
}

/** Requests whose reply is the VIN: UDS `22 F190` and OBD `09 02`. */
const VIN_REQUEST = /(22F190|0902)/;

/**
 * Watches a wire trace for the car's VIN: the reply to a VIN request, reassembled across CAN frames (with or
 * without CAN headers) and notification splits. Returns the VIN once, on the entry that completes it.
 */
export function createVinWatcher(): (entry: { direction: string; text: string }) => string | undefined {
  let listening = false;
  let tail = '';
  let plain: string[] = [];
  let framed: string[] = [];
  return (entry) => {
    if (entry.direction === 'tx') {
      const cmd = entry.text.replace(/\s+/g, '').toUpperCase();
      tail = '';
      if (VIN_REQUEST.test(cmd)) {
        listening = true;
        plain = [];
        framed = [];
      } else if (!(listening && /^(?:AT(?!Z$)|X$|3[0-2][0-9A-F]{4,14}$)/.test(cmd))) listening = false;
      return undefined;
    }
    if (entry.direction !== 'rx' || !listening) return undefined;
    const text = tail + entry.text;
    const end = Math.max(text.lastIndexOf('\r'), text.lastIndexOf('\n'), text.lastIndexOf('>')) + 1;
    tail = text.slice(end);
    if (tail.length > 4096) tail = '';
    for (const raw of text.slice(0, end).split(/[\r\n>]+/)) {
      const line = raw.trim();
      if (!line) continue;
      // Without CAN headers: `49 02 01 54 4D …`, or a multi-frame reply's `0: 49 02 01 …` lines.
      const bare = line.replace(/^[0-9A-F]:\s*/i, '');
      const tokens = bare.split(/\s+/);
      if (tokens.every((t) => /^[0-9A-F]{2}$/i.test(t))) plain.push(tokens.join(''));
      else if (/^(?:[0-9A-F]{2})+$/i.test(bare)) plain.push(bare);
      // With CAN headers: drop the identifier and the ISO-TP control bytes.
      const m = FRAME_LINE.exec(line);
      if (m) {
        const bytes = (m[2] ?? '').trim().split(/\s+/);
        const pci = Number.parseInt(bytes[0] ?? '0', 16) >> 4;
        framed.push(bytes.slice(pci === 1 ? 2 : 1).join(''));
      }
    }
    const vin = findVin(framed.join('')) ?? findVin(plain.join(''));
    if (!vin) return undefined;
    listening = false;
    return vin;
  };
}

/** The VIN read in a wire trace, if the trace holds a complete VIN reply. */
export function vinInWire(wire: readonly { direction: string; text: string }[]): string | undefined {
  const watch = createVinWatcher();
  for (const entry of wire) {
    const vin = watch(entry);
    if (vin) return vin;
  }
  return undefined;
}

const fullVin = (vin: string | undefined | null): string | null => (vin ? normalizeVin(vin) : null);

/** A record's own build stamp; nulls when it predates stamping (so an old record's item never changes). */
const stampOf = (r: { gitSha?: string; version?: string }) => ({
  gitSha: r.gitSha ?? null,
  version: r.version ?? null,
});

/**
 * A journal carries the build that recorded it (`build`, stamped when it was saved); records from before that
 * stamping get `unrecorded` / nulls, so an item never changes just because a newer build uploads it.
 */
export function journalItem(b: BackupRecord): LogItem {
  return {
    schema: LOG_SCHEMA,
    kind: 'journal',
    id: b.id,
    buildId: b.build?.buildId ?? 'unrecorded',
    recipeId: b.recipeId,
    recipeDigest: b.recipeDigest ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    vin: fullVin(b.vin.full),
    facts: journalFacts(b, null),
    body: {
      ...journalBody(b),
      build: b.build ? { gitSha: b.build.gitSha, version: b.build.version } : stampOf({}),
    },
  };
}

function journalFacts(b: BackupRecord | undefined, physical: string | null): LogFacts {
  return {
    operation: b?.operation ?? 'unknown',
    mode: b?.linkMode ?? 'unknown',
    outcome: b?.outcome ?? null,
    ack: b?.ack ?? null,
    sequenceComplete: b?.sequenceSteps || b?.sequenceIncomplete ? !b.sequenceIncomplete : null,
    physical,
  };
}

/** One chunk of a connection's command log (see infra/cloud/connection-log.ts). Serial numbers blanked at capture. */
export interface ConnectionLog {
  schema: 'obdcraft.connection-log/1';
  /** `${session}-${chunk}` */
  id: string;
  session: string;
  chunk: number;
  startedAt: string;
  updatedAt: string;
  buildId: string;
  /** The car's VIN, once this connection has read it (absent before that, and on old chunks). */
  vin?: string;
  /** `tx` / `rx` / `stale`: adapter traffic as sent and received; `event`: a stage of the app (connect, identify…). */
  entries: {
    at: string;
    /** Monotonic browser clock; old captures only have wall time. Never compare origins between connections. */
    monoMs?: number;
    direction: 'tx' | 'rx' | 'stale' | 'event';
    text: string;
  }[];
  /** The chunk is full or the connection ended: it will not change again. */
  closed: boolean;
  /** The commit and package version of the build that recorded it; absent on old chunks. */
  gitSha?: string;
  version?: string;
}

export function sessionItem(log: ConnectionLog): LogItem {
  // A chunk may start midway through a reply, so orphan RX before its first command is treated as a serial reply.
  const entries = redactWire(log.entries);
  return {
    schema: LOG_SCHEMA,
    kind: 'session',
    id: log.id,
    buildId: log.buildId,
    recipeId: null,
    recipeDigest: null,
    createdAt: log.startedAt,
    updatedAt: log.updatedAt,
    vin: fullVin(log.vin ?? vinInWire(log.entries)),
    facts: {
      operation: 'connection',
      mode: 'live',
      outcome: null,
      ack: null,
      sequenceComplete: null,
      physical: null,
    },
    body: { ...log, entries, build: stampOf(log) },
  };
}

/** A scan's answered map without serial-number DIDs. */
const scanBody = (answered: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(answered).filter(([did]) => !SERIAL_DIDS.has(did)));

/** A car map without serial-number DIDs (values and the identity field they fill). */
const carMapBody = (map: CarMap): CarMap => ({
  ...map,
  units: map.units.map(({ identity: { serial: _serial, ...identity }, values, ...unit }) => ({
    ...unit,
    identity,
    values: Object.fromEntries(Object.entries(values).filter(([did]) => !SERIAL_DIDS.has(did))),
  })),
});

/** The full VIN a scan's car check read (an inspect journals no backup). */
const verifiedVin = (e: ExperimentRecord): string | undefined =>
  e.events.flatMap((ev) => (ev.type === 'car-verified' && ev.vin ? [ev.vin] : []))[0];

export function experimentItem(e: ExperimentRecord): LogItem {
  const physical = e.observations?.at(-1)?.verdict ?? null;
  const auditVin = e.events.flatMap((ev) =>
    ev.type === 'audit-failed' && ev.record?.vin.full ? [ev.record.vin.full] : [],
  )[0];
  return {
    schema: LOG_SCHEMA,
    kind: 'experiment',
    id: e.id,
    buildId: e.buildId,
    recipeId: e.recipeId ?? null,
    recipeDigest: e.recipeDigest ?? null,
    createdAt: e.startedAt,
    updatedAt: e.updatedAt,
    vin: fullVin(e.backup?.vin.full ?? auditVin ?? verifiedVin(e) ?? vinInWire(e.wire)),
    facts: { ...journalFacts(e.backup, physical), operation: e.operation, mode: e.mode },
    body: {
      ...e,
      wire: redactWire(e.wire),
      ...(e.backup ? { backup: journalBody(e.backup) } : {}),
      events: e.events.map((ev) =>
        ev.type === 'audit-failed' && ev.record
          ? { ...ev, record: journalBody(ev.record) }
          : ev.type === 'module-scan'
            ? { ...ev, answered: scanBody(ev.answered) }
            : ev.type === 'car-map'
              ? { ...ev, map: carMapBody(ev.map) }
              : ev,
      ),
      build: stampOf(e),
    },
  };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * What uploads instead of a record that could not be turned into an item (a damaged local record): which record
 * it was and why — no data of the record itself. The item id is the record's, so a later build that can read
 * it replaces this as the next revision.
 */
export function unpreparedItem(
  kind: LogItem['kind'],
  id: string,
  times: { createdAt?: string; updatedAt?: string },
  buildId: string,
  build: BuildInfo,
  reason: string,
): LogItem {
  const now = new Date().toISOString();
  const createdAt = times.createdAt && ISO_TIME.test(times.createdAt) ? times.createdAt : now;
  const updatedAt = times.updatedAt && ISO_TIME.test(times.updatedAt) ? times.updatedAt : createdAt;
  return {
    schema: LOG_SCHEMA,
    kind,
    id,
    buildId,
    recipeId: null,
    recipeDigest: null,
    createdAt,
    updatedAt,
    facts: {
      operation: 'prepare-failed',
      mode: 'unknown',
      outcome: null,
      ack: null,
      sequenceComplete: null,
      physical: null,
    },
    body: {
      withheld: true,
      reason: reason.slice(0, 300),
      note: 'The record could not be prepared for upload, so none of its data was uploaded. It stays on the device.',
      build: { gitSha: build.gitSha, version: build.version },
    },
  };
}

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;

/**
 * Makes an item fit the Worker's size limit instead of letting it be refused: the middle of the largest arrays
 * in the body (session entries, wire trace, events) is dropped — the first and last parts stay — then over-long
 * strings are clipped. The body says so in `truncated` (original size, how many elements of which array were
 * left out). Returns the item and its JSON text. An item that fits is returned unchanged.
 */
export function fitItem(item: LogItem, limit = MAX_ITEM_BYTES - 16_384): { item: LogItem; text: string } {
  let text = JSON.stringify(item);
  const originalBytes = byteLength(text);
  if (originalBytes <= limit) return { item, text };
  const body: Record<string, unknown> = { ...item.body };
  const omitted: Record<string, number> = {};
  const mark = (step: string) => {
    body.truncated = { reason: 'The item exceeded the upload size limit.', step, originalBytes, omitted };
  };
  const rebuild = () => {
    text = JSON.stringify({ ...item, body });
    return byteLength(text) > limit;
  };
  for (let round = 0; round < 64; round++) {
    let key: string | undefined;
    let size = 0;
    for (const [k, v] of Object.entries(body))
      if (Array.isArray(v) && v.length > 2) {
        const n = JSON.stringify(v).length;
        if (n > size) [key, size] = [k, n];
      }
    if (!key) break;
    const list = body[key] as unknown[];
    const keep = Math.floor(list.length / 4);
    omitted[key] = (omitted[key] ?? 0) + list.length - 2 * keep;
    body[key] = [...list.slice(0, keep), ...list.slice(list.length - keep)];
    mark('middle-of-arrays');
    if (!rebuild()) return { item: { ...item, body }, text };
  }
  const clip = (v: unknown): unknown =>
    typeof v === 'string' && v.length > 2000
      ? `${v.slice(0, 2000)}…[truncated ${v.length - 2000} characters]`
      : Array.isArray(v)
        ? v.map(clip)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
          : v;
  for (const [k, v] of Object.entries(body)) if (k !== 'truncated') body[k] = clip(v);
  mark('long-strings');
  if (!rebuild()) return { item: { ...item, body }, text };
  const minimal: Record<string, unknown> = {
    build: item.body.build ?? null,
    truncated: {
      reason: 'The item exceeded the upload size limit; only its facts were kept.',
      step: 'facts-only',
      originalBytes,
      omitted,
    },
  };
  const fallback = { ...item, body: minimal };
  return { item: fallback, text: JSON.stringify(fallback) };
}
