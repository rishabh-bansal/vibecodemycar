/**
 * Guarded backup planning + immutable capture schema (G9).
 *
 * `BackupPlan` is a REVIEWABLE candidate plan: every DID arrives from an
 * external list (Car Scanner backup templates today) marked `candidate` —
 * never asserted capability. `BackupCapture` is the immutable evidence record
 * an executor appends to: each entry keeps its candidate provenance plus the
 * exact outcome — raw response bytes or the exact failure reason — and the
 * counts stay separated: proposed / attempted / responding / decoded.
 *
 * Nothing here performs I/O, scans the car automatically, or grants write
 * permission. A capture is evidence for a later, separately authorized write.
 */

import { IDENTITY_DIDS, type ReadOutcome } from './readplan.ts';
import type { VariantResolution } from './variant.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const hex = (v: unknown, len: number): v is string => typeof v === 'string' && new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(v);
const byteArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => Number.isInteger(x) && x >= 0 && x <= 255);

export interface BackupPlanEntry {
  did: string;
  request: string;
  /** Every plan entry is unverified until the live capture proves otherwise. */
  status: 'candidate';
  source: string;
}

export interface BackupPlan {
  schema: 'obdcraft.backup-plan/1';
  id: string;
  createdAt: string;
  module: { request: string; response: string; unit: string; platform: string };
  /** The variant settlement this plan was built under — ambiguity is preserved, never collapsed. */
  variant: VariantResolution;
  entries: readonly BackupPlanEntry[];
  counts: { proposed: number };
  /** Honest caveats shown to a reviewer — candidates are not capabilities. */
  notes: readonly string[];
}

export type CaptureEntryStatus = 'candidate' | 'attempted' | 'responded' | 'decoded' | 'failed' | 'skipped';

export interface CaptureFailure {
  kind: 'nrc' | 'no-reply' | 'desync' | 'error' | 'unexpected-reply';
  /** Exact NRC byte when the ECU refused, hex string when absent. */
  nrc?: string;
  detail: string;
}

export interface BackupCaptureEntry {
  did: string;
  request: string;
  status: CaptureEntryStatus;
  source: string;
  /** True once the request was actually put on the wire — skipped-before-
   *  attempt entries never inflate the attempted count. */
  attempted?: boolean;
  /** Raw reply bytes after service echo — preserved verbatim. serviceEcho is
   *  `62<DID>`: the bound positive-response SID plus the requested DID. */
  response?: { raw: number[]; serviceEcho: string };
  failure?: CaptureFailure;
  /** Set ONLY by recordDecoded — a NAMED decoder accepted the payload and
   *  produced actual field values; byteLength alone is not meaningful decode
   *  (C5). */
  decoded?: { decoder: string; fields: number; values: Record<string, number | string | boolean>; byteLength?: number };
  reason?: string;
}

export interface BackupCapture {
  schema: 'obdcraft.backup-capture/1';
  createdAt: string;
  planId: string;
  module: { request: string; response: string; unit: string; platform: string };
  identity?: Record<string, string>;
  aborted?: { at: string; reason: string };
  entries: BackupCaptureEntry[];
  counts: { proposed: number; attempted: number; responding: number; decoded: number; failed: number; skipped: number };
}

export interface BackupDidList {
  platform: string;
  unit: string;
  count: number;
  dids: string[];
}

const isDidList = (v: unknown): v is BackupDidList =>
  object(v) && text(v.platform, 20) && text(v.unit, 4) &&
  typeof v.count === 'number' && Array.isArray(v.dids) &&
  v.dids.every(d => hex(d, 4)) && v.dids.length === v.count;

/** Parse the exported per-module backup lists; every entry stays a candidate. */
export function parseBackupDidLists(json: string): Record<string, BackupDidList> {
  const p: unknown = JSON.parse(json);
  if (!object(p)) throw new Error('Backup DID lists must be an object keyed by template id.');
  const out: Record<string, BackupDidList> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!/^vag\.[a-z0-9]+\.backup\.[0-9A-F]{2}$/i.test(k) || !isDidList(v)) {
      throw new Error(`Malformed backup DID list entry: ${JSON.stringify(k)}`);
    }
    out[k] = Object.freeze({ ...v, dids: Object.freeze([...v.dids]) }) as BackupDidList;
  }
  return out;
}

const now = () => new Date().toISOString();

/**
 * Emit the reviewable candidate plan for one module. `variant` is recorded
 * verbatim — a refused/ambiguous settlement stays visible on the plan and
 * does not reduce the candidate set (no automatic narrowing).
 */
export function buildBackupPlan(
  lists: Record<string, BackupDidList>,
  platform: string,
  unit: string,
  module: { request: string; response: string },
  variant: VariantResolution,
): BackupPlan {
  const key = `vag.${platform}.backup.${unit.toUpperCase()}`;
  const list = lists[key];
  if (!list) throw new Error(`No backup candidate list for ${key}.`);
  const source = `${key} (candidate template — unverified per-ECU)`;
  const identitySet = new Set(IDENTITY_DIDS.map(d => d.toString(16).toUpperCase().padStart(4, '0')));
  const seen = new Set<string>();
  const entries: BackupPlanEntry[] = list.dids
    .filter(d => !identitySet.has(d.toUpperCase()))
    .map(d => {
      const did = d.toUpperCase();
      if (seen.has(did)) throw new Error(`Duplicate DID ${did} in ${key} — plan entries must be unique.`);
      seen.add(did);
      return { did, request: `22${did}`, status: 'candidate' as const, source };
    });
  const notes = [
    `Candidate list only — ${entries.length} DIDs are proposed, none verified on this unit.`,
    `Variant settlement: ${variant.status}${variant.status === 'settled' ? ` ${variant.name}` : ''} — plan does not narrow on ambiguous results.`,
    'Execution requires a separate, explicitly authorized read pass; this plan grants nothing.',
  ];
  return Object.freeze({
    schema: 'obdcraft.backup-plan/1',
    id: `backup-${platform}-${unit.toUpperCase()}-${now()}`,
    createdAt: now(),
    module: Object.freeze({ request: module.request.toUpperCase(), response: module.response.toUpperCase(), unit: unit.toUpperCase(), platform }),
    variant,
    entries: Object.freeze(entries),
    counts: Object.freeze({ proposed: entries.length }),
    notes: Object.freeze(notes),
  });
}

/** Deep-freeze a capture — nested raw byte arrays must not be mutable through
 *  a later snapshot. (Object.freeze is shallow; evidence needs depth.) */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const child of Object.values(v)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

function freezeCapture(c: BackupCapture): BackupCapture {
  return deepFreeze(c);
}

/** Begin an immutable capture against a plan — all entries start as candidates.
 *  A capture's DID set must be unique: duplicate DIDs would let later
 *  transitions corrupt counts they don't own (C5). */
export function beginCapture(plan: BackupPlan, identity?: Record<string, string>): BackupCapture {
  const dids = plan.entries.map(e => e.did);
  if (new Set(dids).size !== dids.length) throw new Error('Backup plan contains duplicate DIDs — cannot capture uniquely.');
  return freezeCapture({
    schema: 'obdcraft.backup-capture/1',
    createdAt: now(),
    planId: plan.id,
    module: { ...plan.module },
    identity,
    entries: plan.entries.map(e => ({ did: e.did, request: e.request, status: 'candidate' as const, source: e.source })),
    counts: { proposed: plan.entries.length, attempted: 0, responding: 0, decoded: 0, failed: 0, skipped: 0 },
  });
}

function recount(entries: readonly BackupCaptureEntry[]): BackupCapture['counts'] {
  const c = { proposed: entries.length, attempted: 0, responding: 0, decoded: 0, failed: 0, skipped: 0 };
  for (const e of entries) {
    if (e.attempted) c.attempted += 1;
    if (e.status === 'responded' || e.status === 'decoded') c.responding += 1;
    if (e.status === 'decoded') c.decoded += 1;
    if (e.status === 'failed') c.failed += 1;
    if (e.status === 'skipped') c.skipped += 1;
  }
  return c;
}

/** Legal capture lifecycle (C5): each transition preserves evidence —
 *  terminal states (decoded/skipped) never move, a recorded reply can only be
 *  deepened by a decoder, and a failed entry may retry via a fresh attempt. */
const TRANSITIONS: Record<CaptureEntryStatus, readonly CaptureEntryStatus[]> = {
  candidate: ['attempted', 'responded', 'failed', 'skipped'],   // atomic dispatch+result is allowed
  attempted: ['responded', 'failed'],
  responded: ['decoded'],
  failed: ['attempted'],                                       // retry via a fresh attempt only
  decoded: [],
  skipped: [],
};

function withEntry(c: BackupCapture, did: string, to: CaptureEntryStatus, patch: (e: BackupCaptureEntry) => BackupCaptureEntry): BackupCapture {
  const entries = c.entries.map(e => {
    if (e.did !== did.toUpperCase()) return e;
    if (!TRANSITIONS[e.status].includes(to)) {
      throw new Error(`Illegal capture transition ${e.status} -> ${to} for DID ${e.did} — evidence lifecycle enforced.`);
    }
    return patch({ ...e });
  });
  return freezeCapture({ ...c, entries, counts: recount(entries) });
}

/** Mark an entry attempted — the request was put on the wire. */
export function recordAttempted(c: BackupCapture, did: string): BackupCapture {
  const cur = c.entries.find(e => e.did === did.toUpperCase());
  if (cur?.status === 'attempted') return c;                     // idempotent
  return withEntry(c, did, 'attempted', e => {
    const { failure: _failure, ...rest } = e;
    return { ...rest, status: 'attempted', attempted: true };
  });
}

/** Record a bound positive reply — raw bytes preserved verbatim, status
 *  `responded` only. Retrieval is NOT decode; `recordDecoded` is a separate,
 *  explicit step only a real decoder may take. */
export function recordResponded(c: BackupCapture, did: string, raw: number[]): BackupCapture {
  return withEntry(c, did, 'responded', e => ({
    ...e,
    status: 'responded',
    attempted: true,
    response: { raw: [...raw], serviceEcho: `62${did.toUpperCase()}` },
  }));
}

/** Decoder-only transition — a NAMED decoder accepted the payload and
 *  produced real field values; byteLength alone is not meaningful decode.
 *  Never reached by raw retrieval. */
function validDecoded(decoded: unknown): decoded is NonNullable<BackupCaptureEntry['decoded']> {
  return object(decoded) && text(decoded.decoder, 128) && Number.isInteger(decoded.fields) &&
    (decoded.fields as number) > 0 && object(decoded.values) && Object.keys(decoded.values).length === decoded.fields &&
    Object.entries(decoded.values).every(([k, v]) => text(k, 128) &&
      (typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)))) &&
    (decoded.byteLength === undefined || (Number.isInteger(decoded.byteLength) && (decoded.byteLength as number) >= 0));
}

export function recordDecoded(c: BackupCapture, did: string, decoded: NonNullable<BackupCaptureEntry['decoded']>): BackupCapture {
  if (!validDecoded(decoded)) {
    throw new Error('recordDecoded requires decoder provenance, actual values and their positive integer field count.');
  }
  return withEntry(c, did, 'decoded', e => {
    if (decoded.byteLength !== undefined && decoded.byteLength !== e.response?.raw.length) throw new Error('Decoder byte length does not match captured payload.');
    return { ...e, status: 'decoded', decoded };
  });
}

/** Record the exact failure reason — refusal class is never fabricated. */
export function recordFailed(c: BackupCapture, did: string, failure: CaptureFailure): BackupCapture {
  return withEntry(c, did, 'failed', e => ({ ...e, status: 'failed', attempted: true, failure }));
}

/** Record a deliberate skip (policy abort, operator stop) with its reason. */
export function recordSkipped(c: BackupCapture, did: string, reason: string): BackupCapture {
  return withEntry(c, did, 'skipped', e => ({ ...e, status: 'skipped', reason }));
}

/** Apply a readplan outcome — the positive reply must be a bound `62` echo;
 *  a wrong-service reply is recorded as `unexpected-reply`, never invented. */
export function recordOutcome(c: BackupCapture, did: string, outcome: ReadOutcome): BackupCapture {
  switch (outcome.kind) {
    case 'reply':
      if (outcome.serviceEcho !== 0x62 || outcome.did?.toUpperCase() !== did.toUpperCase()) {
        return recordFailed(c, did, {
          kind: 'unexpected-reply',
          detail: `positive-echo mismatch: SID ${outcome.serviceEcho.toString(16).toUpperCase()}, DID ${outcome.did ?? 'absent'} for a 22${did.toUpperCase()} request`,
        });
      }
      return recordResponded(c, did, outcome.data);
    case 'nrc': return recordFailed(c, did, { kind: 'nrc', nrc: outcome.nrc.toString(16).toUpperCase().padStart(2, '0'), detail: `negative response ${outcome.nrc.toString(16).toUpperCase()}` });
    case 'no-reply': return recordFailed(c, did, { kind: 'no-reply', detail: 'request produced no bound reply' });
    case 'desync': return recordFailed(c, did, { kind: 'desync', detail: 'link desynchronized during the read' });
    case 'error': return recordFailed(c, did, { kind: 'error', detail: outcome.detail });
  }
}

/** Mark the capture aborted — entries never attempted stay `candidate` with a
 *  skip reason; attempted entries keep their real status. */
export function abortCapture(c: BackupCapture, reason: string): BackupCapture {
  const entries = c.entries.map(e =>
    e.status === 'candidate' ? ({ ...e, status: 'skipped' as const, reason }) : e);
  return freezeCapture({ ...c, entries, aborted: { at: now(), reason }, counts: recount(entries) });
}

/** Strict importer — a capture is evidence; malformed evidence is rejected
 *  outright. Echoes are bound (`request = 22<DID>`, `serviceEcho = 62<DID>`),
 *  status-specific evidence is required, and stored counts are recomputed —
 *  forged metrics never parse. */
export function parseBackupCapture(json: string): BackupCapture {
  const p: unknown = JSON.parse(json);
  const sts = ['candidate', 'attempted', 'responded', 'decoded', 'failed', 'skipped'];
  const failureKinds = ['nrc', 'no-reply', 'desync', 'error', 'unexpected-reply'];
  if (!object(p) || p.schema !== 'obdcraft.backup-capture/1' || !text(p.planId, 128) ||
    !object(p.module) || !hex(p.module.request, 3) || !hex(p.module.response, 3) ||
    !text(p.module.unit, 4) || !text(p.module.platform, 20) ||
    !Array.isArray(p.entries) || !object(p.counts)) throw new Error('Malformed backup capture.');
  const entries = p.entries as BackupCaptureEntry[];
  const seenDids = new Set<string>();
  for (const e of entries as unknown[]) {
    if (!object(e) || !hex(e.did, 4) || !sts.includes(String(e.status))) throw new Error('Malformed backup capture entry.');
    const ent = e as unknown as BackupCaptureEntry;
    const dkey = ent.did.toUpperCase();
    if (seenDids.has(dkey)) throw new Error(`Duplicate DID ${dkey} in imported capture — counts cannot be trusted.`);
    seenDids.add(dkey);
    if (ent.request !== `22${dkey}`) throw new Error(`Request/DID binding broken for ${ent.did}.`);
    if (ent.response !== undefined &&
        (!object(ent.response) || !byteArray(ent.response.raw) || ent.response.serviceEcho !== `62${dkey}`)) {
      throw new Error(`Service echo does not bind DID ${ent.did}.`);
    }
    if (ent.failure !== undefined &&
        (!object(ent.failure) || !failureKinds.includes(String(ent.failure.kind)) || !text(ent.failure.detail, 200))) {
      throw new Error('Malformed failure evidence.');
    }
    switch (ent.status) {
      case 'responded':
        if (!ent.response) throw new Error('responded entry lacks response evidence.');
        if (ent.attempted !== true) throw new Error('responded entry without attempted state — retrieval claim is forged.');
        break;
      case 'decoded':
        if (!ent.response || !validDecoded(ent.decoded) ||
            (ent.decoded.byteLength !== undefined && ent.decoded.byteLength !== ent.response.raw.length)) {
          throw new Error('decoded entry lacks decoder provenance or field evidence.');
        }
        if (ent.attempted !== true) throw new Error('decoded entry without attempted state — retrieval claim is forged.');
        break;
      case 'failed':
        if (!ent.failure) throw new Error('failed entry lacks failure evidence.');
        if (ent.attempted !== true) throw new Error('failed entry without attempted state — the attempt claim is forged.');
        break;
      case 'skipped': if (!text(ent.reason, 200)) throw new Error('skipped entry lacks its reason.');
        if (ent.attempted) throw new Error('skipped entry claims an attempt — lifecycle contradiction.'); break;
      case 'attempted': if (ent.attempted !== true) throw new Error('attempted status without attempted flag.'); break;
      case 'candidate': if (ent.response || ent.decoded || ent.failure || ent.attempted) throw new Error('candidate entry carries evidence it cannot have.'); break;
    }
    if (ent.attempted !== undefined && ent.attempted !== true) throw new Error('Malformed attempted flag.');
  }
  const actual = recount(entries);
  const stored = p.counts as unknown as BackupCapture['counts'];
  for (const k of ['proposed', 'attempted', 'responding', 'decoded', 'failed', 'skipped'] as const) {
    if (stored[k] !== actual[k]) throw new Error(`Forged counts: ${k} claims ${String(stored[k])}, recomputed ${actual[k]}.`);
  }
  // Imported evidence keeps the same immutability as a live capture — the
  // caller receives a deep-frozen snapshot, never mutable parsed JSON (C5).
  return freezeCapture(p as unknown as BackupCapture);
}
