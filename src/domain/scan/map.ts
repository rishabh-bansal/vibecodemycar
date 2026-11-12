import { APP_DATA } from '../catalog/data.ts';
import { isGroupRecipe, resolveRecipe, type VariantPick } from '../coding/plan.ts';
import { decodeLayout } from '../coding/report.ts';
import type { CodingRecipe, ModuleAddress } from '../coding/types.ts';
import { isMib3Identity, selectVariant, type VariantProbe } from '../coding/variant-select.ts';
import { decodeLampRecord, isLampDid, type LampRecord } from './lamps.ts';
import { CODING_DID, IDENTITY_DIDS, recipeDids } from './plan.ts';
import type { UnitSource } from './units.ts';

// ---- what the scan collected ---------------------------------------------------------------------

/**
 * What one presence probe (F187) on a unit address answered: its part number, a refusal (the unit is there but
 * does not serve F187), silence, or the adapter's failed protocol search (UNABLE TO CONNECT) — or the address
 * was never probed because the scan stopped first.
 */
export interface ScanDiscovery {
  unit: string;
  aliases: readonly string[];
  request: string;
  response: string;
  label: string;
  source: UnitSource;
  fitted: boolean;
  answer: 'part' | 'refused' | 'silent' | 'unreachable' | 'not-probed';
  part?: string;
  nrc?: string;
}

/** One deep-sweep range as it was walked. */
export interface DeepSweep {
  from: string;
  to: string;
  /** Identifiers read in this range (answered, refused or silent). */
  read: number;
  /** Ended before `to`: the unit stopped answering, the budget ran out, or the scan stopped. */
  stoppedEarly: boolean;
}

/** Everything read on one fitted unit. */
export interface UnitReads {
  unit: string;
  aliases: readonly string[];
  module: ModuleAddress;
  label: string;
  /** DID → the complete answer (hex, DID data only). */
  answered: Record<string, string>;
  /** DID → the bytes that arrived of a truncated multi-frame answer. */
  truncated: Record<string, string>;
  /** DID → the negative response code (31 = not hosted). */
  refused: Record<string, string>;
  /** No answer at all (after one retry pass). */
  silent: string[];
  /** Answered 78 response-pending; the final answer never came. */
  pending: string[];
  /** The whole read plan was walked. */
  complete: boolean;
  deep?: DeepSweep[];
}

export type ScanStop = 'cancelled' | 'lost' | 'budget';

export interface ScanReads {
  startedAt: string;
  finishedAt: string;
  vin?: string;
  deep: boolean;
  stopped?: ScanStop;
  discovery: ScanDiscovery[];
  units: UnitReads[];
}

// ---- the map -------------------------------------------------------------------------------------

export interface CarMapValue {
  hex: string;
  length: number;
  /** A multi-frame answer that arrived short: `hex` holds only what arrived. */
  truncated?: true;
  /** The answer as text, when every byte is printable. */
  text?: string;
}

export interface UnitIdentity {
  part?: string;
  software?: string;
  hardware?: string;
  system?: string;
  odx?: string;
  odxVersion?: string;
  hardwareVersion?: string;
  workshopName?: string;
  fazit?: string;
  serial?: string;
  vin?: string;
}

export interface CarMapUnit {
  unit: string;
  aliases: readonly string[];
  request: string;
  response: string;
  label: string;
  complete: boolean;
  identity: UnitIdentity;
  values: Record<string, CarMapValue>;
  refused: Record<string, string>;
  silent: readonly string[];
  pending: readonly string[];
  /** Answering identifiers no recipe, identity read or lamp record explains. */
  unknown: readonly string[];
  deep?: readonly DeepSweep[];
}

/**
 * A feature's state on this car:
 *  - `set`        decoded from the unit's bytes (`choiceId`/`label` when it matches a declared option; `inferred`
 *                 for a multi-part "off" read as "no part holds the on setting")
 *  - `not-hosted` the unit is fitted but refused the feature's identifier
 *  - `not-fitted` the feature's unit did not answer the presence probe
 *  - `unknown`    anything else, with the reason (not read, truncated, no version matches the unit, …)
 */
export type FeatureState =
  | {
      kind: 'set';
      label: string;
      choiceId?: string;
      value?: number;
      unit?: string;
      did?: string;
      selector?: string;
      inferred?: true;
    }
  | { kind: 'not-hosted'; unit: string; did: string; code: string }
  | { kind: 'not-fitted'; unit: string }
  | { kind: 'unknown'; reason: string };

/** `on` / `off` for an enabled/disabled-style setting, `other` for any other decoded value. */
export type FeatureClass = 'on' | 'off' | 'other' | 'unknown' | 'absent';

export interface CarMapFeature {
  recipeId: string;
  name: string;
  featureIds: readonly string[];
  kind: string;
  state: FeatureState;
  class: FeatureClass;
  /** A multi-part feature: each part's own state. */
  parts?: readonly { unit?: string; did?: string; state: FeatureState }[];
}

export interface CarMap {
  schema: 'obdcraft.car-map/1';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  vin?: string;
  deep: boolean;
  /** Every fitted unit's whole read plan was walked and the scan was not stopped. */
  complete: boolean;
  stopped?: ScanStop;
  discovery: readonly ScanDiscovery[];
  units: readonly CarMapUnit[];
  features: readonly CarMapFeature[];
  lamps: readonly LampRecord[];
  totals: {
    probed: number;
    fitted: number;
    values: number;
    truncated: number;
    refused: number;
    silent: number;
    unknown: number;
    features: Record<FeatureClass, number>;
  };
}

// ---- building it ---------------------------------------------------------------------------------

const asciiOf = (hex: string): string =>
  (hex.match(/../g) ?? [])
    .map((b) => String.fromCharCode(Number.parseInt(b, 16)))
    .join('')
    .replace(/\0/g, '')
    .trim();

/** The bytes as text when every byte (padding aside) is printable ASCII. */
function textOf(hex: string): string | undefined {
  const bytes = (hex.match(/../g) ?? [])
    .map((b) => Number.parseInt(b, 16))
    .filter((b) => b !== 0 && b !== 0xaa);
  if (!bytes.length || !bytes.every((b) => b >= 0x20 && b < 0x7f)) return undefined;
  return String.fromCharCode(...bytes).trim() || undefined;
}

const IDENTITY_FIELDS: Readonly<Record<string, keyof UnitIdentity>> = {
  F187: 'part',
  F189: 'software',
  F191: 'hardware',
  F197: 'system',
  F19E: 'odx',
  F1A2: 'odxVersion',
  F1A3: 'hardwareVersion',
  F1AA: 'workshopName',
  F17C: 'fazit',
  F18C: 'serial',
  F190: 'vin',
};

const ON = /^(enabled?|on|activ(e|ated)?|yes)$/i;
const OFF = /^(disabled?|off|deactivated|inactive|not-active|no)$/i;

function classOf(state: FeatureState): FeatureClass {
  switch (state.kind) {
    case 'set': {
      const id = state.choiceId ?? '';
      if (ON.test(id)) return 'on';
      if (OFF.test(id)) return 'off';
      return 'other';
    }
    case 'not-hosted':
    case 'not-fitted':
      return 'absent';
    case 'unknown':
      return 'unknown';
  }
}

interface Ctx {
  byRequest: Map<string, UnitReads>;
  discovery: Map<string, ScanDiscovery>;
}

/** What `selectVariant` needs, from the unit's own answers (and the BCM's 0600 for the unit-09 rule). */
function probeOf(u: UnitReads, ctx: Ctx): VariantProbe {
  const probe: VariantProbe = { reads: { ...u.answered } };
  const part = u.answered.F187;
  if (part) probe.part = asciiOf(part);
  const hardware = u.answered.F191;
  if (hardware) probe.hardware = asciiOf(hardware);
  const bcm0600 = ctx.byRequest.get('70E')?.answered[CODING_DID];
  if (bcm0600) probe.read0600Unit09 = bcm0600;
  const mib3 = isMib3Identity(u.answered.F19E);
  if (mib3 !== undefined) probe.isMib3 = mib3;
  return probe;
}

/** One single-unit recipe (or one part of a group) on this car, and the choice ids its settled layout declares. */
function stepState(r: CodingRecipe, ctx: Ctx): { state: FeatureState; choiceIds: string[] } {
  const unknown = (reason: string) => ({ state: { kind: 'unknown', reason } as FeatureState, choiceIds: [] });
  const request = r.requestId?.toUpperCase();
  if (!request) return unknown('The feature names no control unit.');
  const unitName = r.unit?.toUpperCase() ?? request;
  const u = ctx.byRequest.get(request);
  if (!u) {
    const d = ctx.discovery.get(request);
    if (d && !d.fitted && d.answer !== 'not-probed')
      return { state: { kind: 'not-fitted', unit: unitName }, choiceIds: [] };
    return unknown(`Unit ${unitName} was not scanned.`);
  }
  let pick: VariantPick | undefined;
  let selector: string | undefined;
  if (r.variants?.length) {
    const probe = probeOf(u, ctx);
    const chosen = selectVariant(r, probe);
    if (!chosen.ok) return unknown(chosen.detail);
    pick = { index: chosen.index, ...(probe.isMib3 !== undefined ? { isMib3: probe.isMib3 } : {}) };
    selector = chosen.variant.selector;
  }
  let resolved: ReturnType<typeof resolveRecipe>;
  try {
    resolved = resolveRecipe(r, pick);
  } catch (e) {
    return unknown(e instanceof Error ? e.message : 'The feature has no byte-level layout.');
  }
  const did = resolved.did;
  const choiceIds = resolved.choices.map((c) => c.id);
  const bytes = u.answered[did];
  if (!bytes) {
    const code = u.refused[did];
    if (code) return { state: { kind: 'not-hosted', unit: unitName, did, code }, choiceIds };
    if (u.truncated[did] !== undefined)
      return { state: { kind: 'unknown', reason: `The ${did} answer arrived truncated.` }, choiceIds };
    if (u.pending.includes(did))
      return { state: { kind: 'unknown', reason: `${did} answered "busy" and never finished.` }, choiceIds };
    return { state: { kind: 'unknown', reason: `${did} was not read.` }, choiceIds };
  }
  const decoded = decodeLayout(resolved, bytes);
  if (!decoded)
    return { state: { kind: 'unknown', reason: `The ${did} bytes do not fit this layout.` }, choiceIds };
  const choice = decoded.choiceId ? resolved.choices.find((c) => c.id === decoded.choiceId) : undefined;
  const scalarUnit = resolved.scalar?.unit ? ` ${resolved.scalar.unit}` : '';
  const label = choice
    ? choice.label
    : resolved.encoding === 'scalar'
      ? `${decoded.value}${scalarUnit}`
      : resolved.encoding === 'field'
        ? `raw value ${decoded.value} (no listed option)`
        : 'no listed option matches';
  return {
    state: {
      kind: 'set',
      label,
      ...(choice ? { choiceId: choice.id } : {}),
      value: decoded.value,
      unit: unitName,
      did,
      ...(selector ? { selector } : {}),
    },
    choiceIds,
  };
}

/**
 * A multi-part feature's state: the group choice every part agrees on. A part that has the choice's own id must
 * hold it; a single-choice part holds its one choice for every "on"-style group choice, and for "off" must NOT
 * hold it (the "off" of such a part restores whatever was there, so that reading is marked inferred).
 */
function groupState(r: CodingRecipe, ctx: Ctx): { state: FeatureState; parts: CarMapFeature['parts'] } {
  const steps = r.steps ?? [];
  const states = steps.map((s) => stepState(s, ctx));
  const parts = states.map(({ state }, i) => ({
    ...(steps[i]?.unit ? { unit: steps[i]?.unit as string } : {}),
    ...(state.kind === 'set' || state.kind === 'not-hosted' ? { did: state.did } : {}),
    state,
  }));
  const notFitted = states.find((s) => s.state.kind === 'not-fitted');
  if (notFitted) return { state: notFitted.state, parts };
  const unsettled = states.find((s) => s.state.kind !== 'set');
  if (unsettled) return { state: unsettled.state, parts };
  for (const c of r.choices ?? []) {
    let inferred = false;
    const agrees = states.every(({ state, choiceIds }) => {
      if (state.kind !== 'set') return false;
      if (choiceIds.includes(c.id)) return state.choiceId === c.id;
      if (choiceIds.length !== 1) return false;
      if (OFF.test(c.id)) {
        inferred = true;
        return state.choiceId !== choiceIds[0];
      }
      return state.choiceId === choiceIds[0];
    });
    if (agrees)
      return {
        state: { kind: 'set', label: c.label, choiceId: c.id, ...(inferred ? { inferred: true } : {}) },
        parts,
      };
  }
  return {
    state: { kind: 'unknown', reason: 'The parts do not all hold one setting of this feature.' },
    parts,
  };
}

function unitMap(u: UnitReads): CarMapUnit {
  const values: Record<string, CarMapValue> = {};
  for (const [did, hex] of Object.entries(u.answered)) {
    const text = textOf(hex);
    values[did] = { hex, length: hex.length / 2, ...(text ? { text } : {}) };
  }
  for (const [did, hex] of Object.entries(u.truncated))
    if (!values[did]) values[did] = { hex, length: hex.length / 2, truncated: true };
  const identity: UnitIdentity = {};
  for (const [did, field] of Object.entries(IDENTITY_FIELDS)) {
    const hex = u.answered[did];
    if (hex) identity[field] = textOf(hex) ?? hex;
  }
  const known = new Set([...IDENTITY_DIDS, CODING_DID, ...recipeDids(u.module.request)]);
  const unknown = Object.keys(u.answered)
    .filter((d) => !known.has(d) && !isLampDid(d))
    .sort();
  return {
    unit: u.unit,
    aliases: u.aliases,
    request: u.module.request,
    response: u.module.response,
    label: u.label,
    complete: u.complete,
    identity,
    values,
    refused: { ...u.refused },
    silent: [...u.silent],
    pending: [...u.pending],
    unknown,
    ...(u.deep ? { deep: u.deep } : {}),
  };
}

/** The car map of a scan: pure, deterministic, from what was read. */
export function buildCarMap(reads: ScanReads): CarMap {
  const ctx: Ctx = {
    byRequest: new Map(reads.units.map((u) => [u.module.request.toUpperCase(), u])),
    discovery: new Map(reads.discovery.map((d) => [d.request.toUpperCase(), d])),
  };
  const featureIdsOf = (recipeId: string) =>
    Object.values(APP_DATA.features)
      .filter((f) => f.recipeId === recipeId || Object.values(f.recipeByPlatform ?? {}).includes(recipeId))
      .map((f) => f.id);
  const features: CarMapFeature[] = (Object.values(APP_DATA.recipes) as CodingRecipe[]).map((r) => {
    const ids = featureIdsOf(r.id);
    const name = (ids[0] && APP_DATA.features[ids[0]]?.name) || r.name;
    if (isGroupRecipe(r)) {
      const { state, parts } = groupState(r, ctx);
      return { recipeId: r.id, name, featureIds: ids, kind: 'group', state, class: classOf(state), parts };
    }
    const { state } = stepState(r, ctx);
    return { recipeId: r.id, name, featureIds: ids, kind: r.kind ?? 'field', state, class: classOf(state) };
  });
  features.sort((a, b) => a.name.localeCompare(b.name) || a.recipeId.localeCompare(b.recipeId));

  const bcm = ctx.byRequest.get('70E');
  const lamps = bcm
    ? Object.keys({ ...bcm.answered, ...bcm.truncated })
        .filter(isLampDid)
        .sort()
        .map((did) => decodeLampRecord(did, bcm.answered[did] ?? bcm.truncated[did] ?? ''))
    : [];

  const units = reads.units.map(unitMap);
  const featureTotals: Record<FeatureClass, number> = { on: 0, off: 0, other: 0, unknown: 0, absent: 0 };
  for (const f of features) featureTotals[f.class] += 1;
  const sum = (f: (u: UnitReads) => number) => reads.units.reduce((n, u) => n + f(u), 0);
  const durationMs = Math.max(0, Date.parse(reads.finishedAt) - Date.parse(reads.startedAt)) || 0;
  return {
    schema: 'obdcraft.car-map/1',
    startedAt: reads.startedAt,
    finishedAt: reads.finishedAt,
    durationMs,
    ...(reads.vin ? { vin: reads.vin } : {}),
    deep: reads.deep,
    complete: !reads.stopped && reads.units.every((u) => u.complete),
    ...(reads.stopped ? { stopped: reads.stopped } : {}),
    discovery: reads.discovery,
    units,
    features,
    lamps,
    totals: {
      probed: reads.discovery.filter((d) => d.answer !== 'not-probed').length,
      fitted: reads.discovery.filter((d) => d.fitted).length,
      values: sum((u) => Object.keys(u.answered).length),
      truncated: sum((u) => Object.keys(u.truncated).length),
      refused: sum((u) => Object.keys(u.refused).length),
      silent: sum((u) => u.silent.length + u.pending.length),
      unknown: units.reduce((n, u) => n + u.unknown.length, 0),
      features: featureTotals,
    },
  };
}
