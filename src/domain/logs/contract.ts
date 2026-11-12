/**
 * The private cloud log contract, shared by the browser (which builds items) and the log Worker (which
 * validates and stores them, filed under the car's VIN). One item is one local record: an experiment (events, adapter TX/RX trace,
 * observations) or an operation journal (backup record: outcome, ACK, read-back, sequence steps, restore).
 * The item id is the local record's id, so an upload is idempotent by construction.
 */

export const LOG_SCHEMA = 'obdcraft.log-item/1';
/** `session`: the full adapter command log of one connection (every TX/RX line and stage event). */
export type LogKind = 'experiment' | 'journal' | 'session';
export const LOG_KINDS: readonly LogKind[] = ['experiment', 'journal', 'session'];

/** Largest item the Worker accepts (UTF-8 bytes of the JSON body). A full experiment trace is far below it. */
export const MAX_ITEM_BYTES = 1_500_000;

/**
 * Facts kept as separate columns so they can never be conflated: the control unit's acknowledgement of the
 * payload, whether a declared sequence completed after it, and what the owner physically observed.
 */
export interface LogFacts {
  operation: string;
  mode: string;
  outcome: string | null;
  /** `received` / `not-received` / `unknown` — the payload's acknowledgement only. */
  ack: string | null;
  /** true: completed; false: stopped after the payload (`sequenceIncomplete`); null: not a sequence / unknown. */
  sequenceComplete: boolean | null;
  /** The owner's latest physical observation verdict, if any. */
  physical: string | null;
}

/** The commit and package version of a build (`unknown` when the build could not tell). */
export interface BuildInfo {
  gitSha: string;
  version: string;
}

export interface LogItem {
  schema: typeof LOG_SCHEMA;
  kind: LogKind;
  id: string;
  buildId: string;
  recipeId: string | null;
  recipeDigest: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The car's full VIN (upper-case), so the log can be read per car; null when the record does not know it.
   * Absent on items from older builds: the Worker then looks for it in the body (`vinOfItem`).
   */
  vin?: string | null;
  facts: LogFacts;
  /**
   * The record (serial numbers blanked), plus `build`: `{ gitSha, version }` of the build that made the record (experiments,
   * sessions) or that built this item (journals, which carry no build of their own); `null` values for a
   * record made before builds were stamped.
   */
  body: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9._:-]{8,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHORT = /^[\w .:-]{0,64}$/;
/** A VIN as stored: upper-case letters and digits (normally 17; some cars report a shorter or padded one). */
export const STORED_VIN = /^[A-Z0-9]{1,32}$/;

/** Validates an item the Worker received. Returns a reason a person can act on when it is refused. */
export function validateLogItem(x: unknown): { ok: true; item: LogItem } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!x || typeof x !== 'object') return fail('The body must be a JSON object.');
  const v = x as Record<string, unknown>;
  if (v.schema !== LOG_SCHEMA) return fail(`schema must be "${LOG_SCHEMA}".`);
  if (!LOG_KINDS.includes(v.kind as LogKind))
    return fail('kind must be "experiment", "journal" or "session".');
  if (typeof v.id !== 'string' || !ID.test(v.id)) return fail('id must be 8–64 letters, digits or . _ : -');
  if (typeof v.buildId !== 'string' || !SHORT.test(v.buildId) || !v.buildId)
    return fail('buildId is required.');
  for (const k of ['recipeId', 'recipeDigest'] as const)
    if (v[k] !== null && (typeof v[k] !== 'string' || !SHORT.test(v[k] as string)))
      return fail(`${k} is malformed.`);
  for (const k of ['createdAt', 'updatedAt'] as const)
    if (typeof v[k] !== 'string' || !ISO.test(v[k] as string))
      return fail(`${k} must be an ISO-8601 UTC time.`);
  const f = v.facts as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object') return fail('facts are required.');
  for (const k of ['operation', 'mode'] as const)
    if (typeof f[k] !== 'string' || !SHORT.test(f[k] as string)) return fail(`facts.${k} is malformed.`);
  for (const k of ['outcome', 'ack', 'physical'] as const)
    if (f[k] !== null && (typeof f[k] !== 'string' || !SHORT.test(f[k] as string)))
      return fail(`facts.${k} is malformed.`);
  if (f.sequenceComplete !== null && typeof f.sequenceComplete !== 'boolean')
    return fail('facts.sequenceComplete must be true, false or null.');
  if (!v.body || typeof v.body !== 'object' || Array.isArray(v.body))
    return fail('body must be a JSON object.');
  if (v.vin !== undefined && v.vin !== null && (typeof v.vin !== 'string' || !STORED_VIN.test(v.vin)))
    return fail('vin must be an upper-case VIN or null.');
  return { ok: true, item: v as unknown as LogItem };
}

/**
 * The car an item belongs to: its `vin`, else (items from older builds, which have no `vin` field) a VIN its record carries — a journal's
 * `vin.full` — or the first VIN found in its body (a VIN read in the wire trace, plain or hex-encoded).
 */
export function vinOfItem(item: LogItem): string | null {
  if (typeof item.vin === 'string' && STORED_VIN.test(item.vin)) return item.vin;
  if (item.vin === null) return null; // a current build looked and found none
  const b = item.body as { vin?: { full?: unknown }; backup?: { vin?: { full?: unknown } } };
  for (const full of [b.vin?.full, b.backup?.vin?.full])
    if (typeof full === 'string' && STORED_VIN.test(full)) return full;
  return findVin(JSON.stringify(item.body)) ?? null;
}

/** A VIN: 17 characters, no I/O/Q, with at least one letter outside hex (rules out plain hex data). */
const VIN = /(?<![A-Z0-9])(?=[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9]))(?=[0-9A-F]*[G-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}/;

/**
 * Finds a raw VIN in text, including one carried as hex-encoded ASCII (a read-back, a frame payload) at either
 * byte alignment and across whitespace-separated hex bytes. Returns the match or undefined.
 */
export function findVin(text: string): string | undefined {
  const plain = VIN.exec(text.toUpperCase());
  if (plain) return plain[0];
  for (const run of text.toUpperCase().match(/(?:[0-9A-F]{2}[ ]?){17,}/g) ?? []) {
    const hex = run.replace(/ /g, '');
    for (const start of [0, 1]) {
      const ascii = (hex.slice(start).match(/../g) ?? [])
        .map((b) => {
          const c = Number.parseInt(b, 16);
          return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' ';
        })
        .join('');
      const m = VIN.exec(ascii);
      if (m) return m[0];
    }
  }
  return undefined;
}
