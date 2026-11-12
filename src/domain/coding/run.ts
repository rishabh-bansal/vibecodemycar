import { POLICY } from '../../config/policy.ts';
import {
  BACKUP_SCHEMA,
  type BackupRecord,
  boundTxFrames,
  type GroupStepEntry,
  type ModuleManagedChange,
  type TxFrameEntry,
} from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { findFeature } from '../catalog/features.ts';
import { featureDids, SCAN_TARGETS } from '../catalog/modules.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { feedCodingEvent } from '../diagnostics.ts';
import { runFullScan } from '../scan/run.ts';
import { fingerprintVin, maskVin, normalizeVin } from '../vin.ts';
import type { SessionAudit } from './audit.ts';
import { knownReadbacksFor } from './known-readbacks.ts';
import { explainNrc } from './nrc.ts';
import {
  buildApplyPlan,
  buildRestorePlan,
  type CodingPlan,
  compareReadback,
  digestAccepted,
  groupStepsOf,
  guardMask,
  isGroupRecipe,
  moduleOf,
  needsSequence,
  ownedToHex,
  PlanError,
  planGroupStep,
  type ReadbackComparison,
  recipeDigest,
  resolveRecipe,
  selectorForDid,
  stepActionFor,
  strayBytes,
  trustedOwnedMask,
  type VariantPick,
  variantIndexesForDid,
} from './plan.ts';
import { applyKnownRepairs, describeRepair } from './repairs.ts';
import { reportFeatures } from './report.ts';
import { describeIncomplete, describeSteps } from './sequence-copy.ts';
import type {
  BackupPatch,
  BackupStore,
  CarLink,
  CarReader,
  CodingEvent,
  CodingRecipe,
  CodingRequest,
  DidRead,
  DidWrite,
  IdentifyResult,
  MarkerWrite,
  ModuleAddress,
  Outcome,
  RefusalReason,
  SequenceIncomplete,
  SequenceSpec,
  SequenceStep,
  TxFrameRecord,
  VariantProbeSummary,
  WarningCode,
  WriterNote,
} from './types.ts';
import {
  isMib3Identity,
  isNewGenBcm,
  selectVariant,
  type VariantProbe,
  variantProbePlan,
} from './variant-select.ts';

export interface CodingDeps {
  audit?: SessionAudit;
  link: CarLink;
  backups: BackupStore;
  /** Cancelling is honoured only until the write is on the wire. */
  signal: AbortSignal;
  /**
   * Full-module snapshot scan before the write (default: on). Off: only the coded DID is read, matching the
   * proven native sequence — on 2026-10-28 the 301-DID inventory scan is what made this BCM go silent (F73).
   */
  moduleSnapshot?: boolean;
  /**
   * Fingerprint of the VIN this car profile was first paired with. An apply on another car is noted as a
   * warning (the backup records the car actually written); a restore always requires the backup's own car.
   */
  expectedVinFingerprint?: string;
  /**
   * Forces the variant of an `alt` recipe by selector. Absent: an apply settles it with `selectVariant` from
   * the module's own answers; a restore or recheck uses the variant the backup records.
   */
  selector?: string;
  recipeFor?: (id: string) => CodingRecipe | undefined;
  /** The catalogue's own entry for a feature; the request's copy of a recipe id is checked against it. */
  featureFor?: (car: CarSelection, featureId: string) => FeatureItem | undefined;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Hard ceiling on one write: the backstop against a wedged link. Links own their own deadlines;
   * by default this is the link's `maxWriteMs` plus a margin, or 60 s for a link that declares none.
   */
  writeDeadlineMs?: number;
  /** Exact read-back attempts after a write (reads are safe to repeat; writes are never repeated). */
  readbackAttempts?: number;
  readbackDelayMs?: number;
  /**
   * Re-establishes the adapter on the device the chooser already granted (no picker, no gesture)
   * and returns the fresh link — undefined when no relink is possible. Invoked only where nothing
   * that could have mutated the car was sent, or for read-only scans; a run that already put a
   * request on the wire finishes its honest outcome on the dead link instead.
   */
  relink?: () => Promise<CarLink | undefined>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const IDENTITY_PART_DID = 'F187';
/** The module's hardware number: CheckDevice tests device patterns against it as well as F187. */
const IDENTITY_HARDWARE_DID = 'F191';
/** The BCM's coding block: its zero-run decides the unit-09 generation (`MQBAlternativeContainerForUnit09`). */
const UNIT09_CODING_DID = '0600';
const UNIT09_MODULE: ModuleAddress = { request: '70E', response: '778' };
/** Part recorded when the module would not say its F187 (journaled; never a gate on apply). */
const UNKNOWN_PART = 'unknown';

const asciiOf = (hex: string): string =>
  (hex.match(/../g) ?? [])
    .map((b) => String.fromCharCode(Number.parseInt(b, 16)))
    .join('')
    .replace(/\0/g, '')
    .trim();

/**
 * Links that carried a write whose fate is unknown (deadline expired, link lost or threw
 * mid-write). A timed-out promise is not a cancelled write: the old exchange may still be
 * running or its frames may still arrive. Such a link is closed and never used again —
 * every later session on it refuses, so "check again" happens on a fresh connection.
 */
const quarantined = new WeakSet<CarLink>();

export const isQuarantined = (link: CarLink): boolean => quarantined.has(link);

function quarantine(link: CarLink): void {
  if (quarantined.has(link)) return;
  quarantined.add(link);
  // Best effort; the WeakSet already guarantees no reuse even if close() never settles.
  void link.close().catch(() => {});
}

const INCONSISTENT =
  "This backup doesn't match the setting it names, so we won't use it. Nothing was read or changed.";

const defaultRecipeFor = (id: string): CodingRecipe | undefined =>
  APP_DATA.recipes[id] as CodingRecipe | undefined;

/** The variant a record was written with: its recorded index, else the one variant writing its DID. */
function recordedPick(
  recipe: CodingRecipe,
  b: Pick<BackupRecord, 'did' | 'intended' | 'ownedMask'> & { variant?: number },
  given: string | undefined,
): VariantPick | undefined {
  if (!recipe.variants?.length) return undefined;
  if (b.variant !== undefined) return { index: b.variant };
  if (given) return { selector: given };
  const selector = selectorForDid(recipe, b.did);
  if (selector) return { selector };
  // Several variants share the DID (e.g. a unit-09 new/old pair on 0600): the one whose mask the record holds.
  const fits = variantIndexesForDid(recipe, b.did).filter((index) => {
    try {
      return (
        ownedToHex(trustedOwnedMask(recipe, b.intended.length / 2, { index })) === b.ownedMask?.toUpperCase()
      );
    } catch {
      return false;
    }
  });
  return fits.length === 1 ? { index: fits[0] as number } : undefined;
}

/**
 * How a recheck may judge a record: with the trusted recipe's mask when the recipe it names still has
 * the recorded revision, module and DID, and the record's own mask (if any) agrees; on the exact bytes
 * otherwise. The record's own mask never decides. (A read is harmless, so an inconsistent record is
 * judged strictly rather than refused.)
 */
async function recheckJudge(
  backup: BackupRecord,
  deps: CodingDeps,
): Promise<{ kind: 'trusted'; owned: number[]; recipe: CodingRecipe } | { kind: 'exact' }> {
  const recipe = (deps.recipeFor ?? defaultRecipeFor)(backup.recipeId);
  if (!recipe || isGroupRecipe(recipe) || !(await digestAccepted(recipe, backup.recipeDigest)))
    return { kind: 'exact' };
  const pick = recordedPick(recipe, backup, deps.selector);
  try {
    const module = moduleOf(recipe);
    const did = resolveRecipe(recipe, pick).did;
    if (
      module.request !== backup.module.request ||
      module.response !== backup.module.response ||
      did !== backup.did
    )
      return { kind: 'exact' };
  } catch {
    return { kind: 'exact' };
  }
  const trusted = trustedMaskFor(recipe, backup, pick);
  return trusted.ok ? { kind: 'trusted', owned: trusted.owned, recipe } : { kind: 'exact' };
}

/** The trusted recipe's mask for a record's block; refuses when the record carries a different one. */
function trustedMaskFor(
  recipe: CodingRecipe,
  b: Pick<BackupRecord, 'intended' | 'ownedMask'>,
  pick: VariantPick | string | undefined,
): { ok: true; owned: number[] } | { ok: false; detail: string } {
  let owned: number[];
  try {
    owned = trustedOwnedMask(recipe, b.intended.length / 2, pick);
  } catch {
    return { ok: false, detail: INCONSISTENT };
  }
  if (b.ownedMask !== undefined && b.ownedMask.toUpperCase() !== ownedToHex(owned))
    return { ok: false, detail: INCONSISTENT };
  return { ok: true, owned };
}

/**
 * Says, in plain words, that the car kept its change-history entry (or may have) although the setting was not
 * changed. Which entries (F199 / F198) is in the `markers` event and the journal, never in this text.
 */
function describeStoredMarkers(markers: readonly MarkerWrite[]): string {
  if (markers.some((m) => m.outcome === 'acked'))
    return ' Your car did note the date of this change attempt in its service history, as dealer tools also do.';
  if (markers.some((m) => m.outcome === 'no-answer'))
    return ' Your car may have noted the date of this change attempt in its service history.';
  return '';
}

/** A read-back matched in the recipe's own bytes (other bytes may differ). */
/** `observed` holds `intended` in every bit of `mask` (same block length). */
function bitsMatch(intended: string, observed: string, mask: readonly number[]): boolean {
  if (intended.length !== observed.length || mask.length * 2 !== intended.length) return false;
  return mask.every((m, i) => {
    const a = Number.parseInt(intended.slice(i * 2, i * 2 + 2), 16);
    const b = Number.parseInt(observed.slice(i * 2, i * 2 + 2), 16);
    return ((a ^ b) & m) === 0;
  });
}

const ownedBytesMatch = (v: ReadbackComparison): boolean =>
  v.kind !== 'mismatch' || v.unexplained !== undefined;

/** Why a check is not a success. Which values differ is in the `readback` event and the journal, not here. */
const mismatchPhase = (unexplained: readonly ModuleManagedChange[]): string =>
  unexplained.length
    ? 'Your setting is in place, but your car also changed something else we have no record of. Check the car before doing anything else.'
    : "Your car didn't save the setting we sent.";

/**
 * Appended to a success phase so a change outside the setting is never hidden behind "exactly". Being a
 * recorded observation for this exact write says it was seen before — not what it means or that it is
 * harmless (brief C5): the wording stays factual and the run stays flagged for review.
 */
const moduleNote = (changes: readonly ModuleManagedChange[]): string =>
  changes.length
    ? " Your car also changed something next to this setting on its own. We've seen it do this before, but we don't know yet what it means, so we've flagged it for review."
    : '';

const QUARANTINED_DETAIL =
  "This connection had a change it couldn't confirm, so we closed it. Reconnect your adapter before doing anything else.";

/**
 * Plain words for a refusal of the data write. The code itself goes in the event's `code`; the access code is
 * never put in any message.
 */
function nrcDetail(code: string, plan: Pick<CodingPlan, 'password' | 'passwordSource'>): string {
  const base = explainNrc(code);
  const c = code.toUpperCase();
  if ((c === '33' || c === '35') && plan.passwordSource === 'unit-default')
    return `${base} Your car needs a different access code for this setting than the one we have.`;
  if (c === '33' && !plan.password)
    return `${base} Your car asked for an access code we don't have for this setting.`;
  return base;
}

/** Plain words for a change that couldn't be planned; the planner's own message is kept as `technical`. */
function planFailure(e: unknown): { detail: string; technical: string } {
  const technical = e instanceof Error ? e.message : String(e);
  const code = e instanceof PlanError ? e.code : undefined;
  const detail =
    code === 'variant-unsettled'
      ? VARIANT_UNSETTLED
      : code === 'unknown-setting'
        ? "That option isn't offered for this setting on your car. Nothing was changed."
        : code === 'unexpected-current-value'
          ? "Your car is set up in a way this setting doesn't cover, so we stopped. Nothing was changed."
          : "This setting can't be changed from the app on your car. Nothing was changed.";
  return { detail, technical };
}

/** A version the variant check couldn't settle, in plain words (its own reason is kept as `technical`). */
const VARIANT_UNSETTLED =
  "We couldn't tell which version of this setting your car has, so we stopped. Nothing was changed.";

/**
 * The guarded coding session — the ONLY place that decides what happened.
 *
 *   target  → the recipe for this feature (a restore must still point at its saved target)
 *   verify  → car (VIN) and control unit (part number) identified and journaled; a restore needs the same ones
 *   backup  → original bytes read, change planned, operation record made DURABLE before any write
 *   write   → sent once; never retransmitted by the session, never "cancelled" once on the wire
 *   check   → fresh read-back must hold every bit the recipe owns exactly as intended
 *
 * Nothing about the car's state is a gate: readiness, the part number and the paired car are measured,
 * journaled and shown as warnings. Success is derived from the read-back alone.
 */
type WriteRequest = Exclude<CodingRequest, { kind: 'recheck' } | { kind: 'inspect' }>;

type Target =
  | {
      ok: true;
      recipe: CodingRecipe;
      module: ModuleAddress;
      did: string;
      /** The catalogue entry (apply): the record takes its name and labels from here when there is one. */
      trusted?: FeatureItem;
      /** The variant this target writes (from the backup, or forced by selector). */
      pick?: VariantPick;
      /** The variant is settled from the identified module (`did` is then empty until it is). */
      probe?: true;
      /** A multi-part recipe: planned and written step by step. */
      group?: true;
    }
  | { ok: false; reason: RefusalReason; detail: string; technical?: string };

const NO_RECIPE = "This setting can't be changed from the app yet. Nothing was changed.";

/**
 * What this request may touch: the recipe from the bundled data (never bytes from the request), and — for a
 * restore — the exact target the backup was made against (same recipe definition, module and DID).
 */
async function resolveTarget(
  req: WriteRequest,
  recipeFor: (id: string) => CodingRecipe | undefined,
  featureFor: (car: CarSelection, featureId: string) => FeatureItem | undefined,
  given: string | undefined,
): Promise<Target> {
  const refuse = (reason: RefusalReason, detail: string, technical?: string): Target => ({
    ok: false,
    reason,
    detail,
    ...(technical ? { technical } : {}),
  });

  let recipeId: string;
  let trustedItem: FeatureItem | undefined;
  if (req.kind === 'apply') {
    const trusted = featureFor(req.car, req.feature.id);
    // The catalogue's own mapping wins; a request naming a different recipe for this feature is not ours.
    if (trusted?.recipeId && req.feature.recipeId && trusted.recipeId !== req.feature.recipeId)
      return refuse('not-eligible', "This request doesn't match this setting, so nothing was changed.");
    const id = trusted?.recipeId ?? req.feature.recipeId;
    if (!id) return refuse('invalid-plan', NO_RECIPE);
    recipeId = id;
    trustedItem = trusted;
  } else {
    const b = req.backup;
    if (b.operation !== 'apply')
      return refuse(
        'invalid-plan',
        'This record is itself an undo, so there is nothing to put back from it.',
      );
    recipeId = b.recipeId;
  }

  const recipe = recipeFor(recipeId);
  if (
    !recipe ||
    (recipe.executable === false &&
      !isGroupRecipe(recipe) &&
      !recipe.variants?.length &&
      !recipe.choices?.length)
  )
    return refuse('invalid-plan', NO_RECIPE);

  if (req.kind === 'restore') {
    const b = req.backup;
    // A missing revision is not evidence that the recipe is unchanged: legacy records never auto-restore.
    if (!b.recipeDigest)
      return refuse(
        'needs-requalification',
        "This backup is from an older version of the app, so it can't be undone automatically. Your original setting is still saved and can be downloaded.",
      );
    if (!(await digestAccepted(recipe, b.recipeDigest)))
      return refuse(
        'target-changed',
        "This setting has been updated in the app since this backup was made, so it can't be undone automatically. Nothing was changed.",
      );
  }

  if (isGroupRecipe(recipe)) {
    if (req.kind === 'restore' && !req.backup.steps?.length)
      return refuse('backup-inconsistent', INCONSISTENT);
    return {
      ok: true,
      recipe,
      module: { request: '', response: '' },
      did: '',
      group: true,
      ...(trustedItem ? { trusted: trustedItem } : {}),
    };
  }

  let module: ModuleAddress;
  try {
    module = moduleOf(recipe);
  } catch (e) {
    const failed = planFailure(e);
    return refuse('invalid-plan', failed.detail, failed.technical);
  }

  let pick: VariantPick | undefined = given ? { selector: given } : undefined;
  if (recipe.variants?.length && !pick) {
    if (req.kind === 'restore') pick = recordedPick(recipe, req.backup, undefined);
    else
      return {
        ok: true,
        recipe,
        module,
        did: '',
        probe: true,
        ...(trustedItem ? { trusted: trustedItem } : {}),
      };
  }
  let did: string;
  try {
    did = resolveRecipe(recipe, pick).did;
  } catch (e) {
    const code =
      e instanceof PlanError && e.code === 'variant-unsettled' ? 'variant-unsettled' : 'invalid-plan';
    const failed = planFailure(e);
    return refuse(code, failed.detail, failed.technical);
  }
  if (req.kind === 'restore') {
    const b = req.backup;
    if (module.request !== b.module.request || module.response !== b.module.response || did !== b.did)
      return refuse(
        'target-changed',
        "This setting has been updated in the app since this backup was made, so it can't be undone automatically. Nothing was changed.",
      );
  }
  return {
    ok: true,
    recipe,
    module,
    did,
    ...(pick ? { pick } : {}),
    ...(trustedItem ? { trusted: trustedItem } : {}),
  };
}

/** The recipe (or one of its variants) has ops choices that depend on the infotainment generation. */
const dependsOnMib3 = (recipe: CodingRecipe): boolean =>
  [recipe, ...(recipe.variants ?? [])].some((r) => r.choices?.some((c) => c.when?.mib3 !== undefined));

/**
 * Reads what variant selection and MIB-conditional ops need (all harmless reads): every variant DID, the
 * BCM's 0600 when a unit-09 generation rule applies, and F19E when the infotainment generation matters.
 */
async function probeModule(
  link: CarLink,
  module: ModuleAddress,
  recipe: CodingRecipe,
  part: string,
): Promise<{ ok: true; probe: VariantProbe } | { ok: false }> {
  const plan = variantProbePlan(recipe);
  const reads: Record<string, string | undefined> = {};
  const read = async (m: ModuleAddress, did: string): Promise<string | undefined | 'lost'> => {
    const r = await link.readDid(m, did).catch((): DidRead => ({ kind: 'link-lost' }));
    if (r.kind === 'link-lost') return 'lost';
    return r.kind === 'ok' && r.bytes ? r.bytes.toUpperCase() : undefined;
  };
  for (const did of plan.dids) {
    const r = await read(module, did);
    if (r === 'lost') return { ok: false };
    reads[did] = r;
  }
  const probe: VariantProbe = { reads, ...(part && part !== UNKNOWN_PART ? { part } : {}) };
  if (plan.needsPart) {
    if (!probe.part) {
      const r = await read(module, IDENTITY_PART_DID);
      if (r === 'lost') return { ok: false };
      const text = r ? asciiOf(r) : '';
      if (text) probe.part = text;
    }
    const r = await read(module, IDENTITY_HARDWARE_DID);
    if (r === 'lost') return { ok: false };
    const text = r ? asciiOf(r) : '';
    if (text) probe.hardware = text;
  }
  if (plan.needs0600Unit09) {
    const bcm = recipe.unit === '09' || module.request === UNIT09_MODULE.request ? module : UNIT09_MODULE;
    const cached = bcm === module ? reads[UNIT09_CODING_DID] : undefined;
    const r = cached ?? (await read(bcm, UNIT09_CODING_DID));
    if (r === 'lost') return { ok: false };
    if (r) probe.read0600Unit09 = r;
  }
  if (plan.needsIdentity || dependsOnMib3(recipe)) {
    const r = await read(module, IDENTITY_ODX_DID);
    if (r === 'lost') return { ok: false };
    const mib3 = isMib3Identity(r);
    if (mib3 !== undefined) probe.isMib3 = mib3;
  }
  return { ok: true, probe };
}

/** What the probe read, compactly enough for the journal: answer lengths, never the bytes themselves. */
function summariseProbe(recipe: CodingRecipe, probe: VariantProbe): VariantProbeSummary {
  return {
    reads: Object.fromEntries(
      Object.entries(probe.reads).map(([did, bytes]) => [did, (bytes ?? '').length / 2]),
    ),
    ...(variantProbePlan(recipe).needs0600Unit09 ? { unit09NewGen: isNewGenBcm(probe.read0600Unit09) } : {}),
    ...(probe.isMib3 !== undefined ? { isMib3: probe.isMib3 } : {}),
    ...(probe.part ? { part: probe.part } : {}),
    ...(probe.hardware ? { hardware: probe.hardware } : {}),
  };
}

/** The journal event for a variant decision (`selectVariant` ran). */
type VariantNote = DistributiveOmit<
  Extract<CodingEvent, { type: 'variant-selected' | 'variant-refused' }>,
  'at'
>;

/**
 * The variant (and MIB generation) for an apply on this module; refuses only on a genuine no-match. `note`
 * says what `selectVariant` decided and from which answers, whenever it ran.
 */
async function settleVariant(
  link: CarLink,
  module: ModuleAddress,
  recipe: CodingRecipe,
  part: string,
  forced: VariantPick | undefined,
): Promise<
  | { ok: true; pick: VariantPick | undefined; why?: string; note?: VariantNote }
  | { ok: false; lost: boolean; detail: string; note?: VariantNote }
> {
  const needsProbe = (!!recipe.variants?.length && !forced) || dependsOnMib3(recipe);
  if (!needsProbe) return { ok: true, pick: forced };
  const probed = await probeModule(link, module, recipe, part);
  if (!probed.ok)
    return { ok: false, lost: true, detail: 'The adapter disconnected before anything was sent.' };
  const mib = probed.probe.isMib3 !== undefined ? { isMib3: probed.probe.isMib3 } : {};
  if (!recipe.variants?.length || forced) return { ok: true, pick: { ...(forced ?? {}), ...mib } };
  const chosen = selectVariant(recipe, probed.probe);
  const probe = summariseProbe(recipe, probed.probe);
  if (!chosen.ok)
    return {
      ok: false,
      lost: false,
      detail: chosen.detail,
      note: { type: 'variant-refused', recipeId: recipe.id, reason: chosen.detail, probe },
    };
  return {
    ok: true,
    pick: { index: chosen.index, ...mib },
    why: chosen.why,
    note: {
      type: 'variant-selected',
      recipeId: recipe.id,
      selector: chosen.variant.selector,
      did: chosen.variant.did,
      reason: chosen.why,
      probe,
    },
  };
}

/** Everything one data write needs, shared by single-recipe and multi-part runs. */
interface WriteJob {
  link: CarLink;
  module: ModuleAddress;
  plan: CodingPlan;
  originalBytes: string;
  deps: CodingDeps;
  now: () => Date;
  emit: Emit;
}

/** What one data write produced, before anyone judges it. */
interface Transmitted {
  write: DidWrite | undefined;
  writeError: unknown;
  deadlineHit: boolean;
  markers: readonly MarkerWrite[];
  rxFrames: readonly string[];
  sequenceSteps: readonly SequenceStep[];
  incomplete: SequenceIncomplete | undefined;
  txFrames: TxFrameEntry[];
}

/** First byte after the ISO-TP PCI of a CAN frame (the UDS service id), or undefined. */
function serviceOf(frameHex: string): string | undefined {
  const pci = Number.parseInt(frameHex.slice(0, 2), 16);
  if (!Number.isFinite(pci)) return undefined;
  const kind = pci >> 4;
  if (kind === 0) return frameHex.slice(2, 4).toUpperCase();
  if (kind === 1) return frameHex.slice(4, 6).toUpperCase();
  return undefined;
}

/**
 * Sends one write (plain DID write, or the recipe's declared sequence) and collects every fact the link
 * reports. Emits `request-sent` / `response-pending` / `security-access` as they happen, then `markers` and
 * `sequence` once it settles. Never retransmits.
 */
async function* transmit(job: WriteJob): AsyncGenerator<CodingEvent, Transmitted> {
  const { link, module, plan, originalBytes, deps, now, emit } = job;
  const pendingEvents: CodingEvent[] = [];
  let wake: (() => void) | null = null;
  let write: DidWrite | undefined;
  let writeError: unknown;
  let settled = false;
  let deadlineHit = false;
  let sentEmitted = false;
  let securityEmitted = false;
  const poke = () => {
    wake?.();
    wake = null;
  };
  const sequenceSpec: SequenceSpec | undefined = plan.sequence
    ? {
        pre: plan.sequence.pre ?? [],
        write: plan.sequence.download
          ? { kind: 'download', ...plan.sequence.download, bytes: plan.after }
          : { kind: 'did', did: plan.did, bytes: plan.after },
        post: plan.sequence.post ?? [],
        password: plan.password,
      }
    : undefined;
  // The backstop exceeds the longest the link's own steps can take — for a sequence, that sequence's.
  const linkBudget = sequenceSpec ? (link.maxSequenceMs?.(sequenceSpec) ?? link.maxWriteMs) : link.maxWriteMs;
  const deadline = setTimeout(
    () => {
      deadlineHit = true;
      settled = true;
      poke();
    },
    deps.writeDeadlineMs ?? (linkBudget ? linkBudget + 10_000 : 60_000),
  );
  /** The data write is on the wire (from here on nothing can be un-sent). */
  const markSent = () => {
    if (sentEmitted || deadlineHit) return;
    sentEmitted = true;
    pendingEvents.push(emit({ type: 'request-sent', did: plan.did }));
    poke();
  };
  /** SecurityAccess left for the module: a run that got this far is never replayed (seed/key budget). */
  const noteSecurity = () => {
    if (securityEmitted || deadlineHit) return;
    securityEmitted = true;
    pendingEvents.push(emit({ type: 'security-access' }));
    poke();
  };
  /** Markers as the link reports them during the write: kept even if the write never returns. */
  const liveMarkers = new Map<MarkerWrite['did'], MarkerWrite>();
  /** Frames as the link reports them, stamped when first seen: kept even if the write throws or never returns. */
  const liveTx: TxFrameEntry[] = [];
  const onTxFrame = (n: number, frame: TxFrameRecord) => {
    if (deadlineHit || !Number.isInteger(n) || n < 0) return;
    liveTx[n] = { ...frame, at: liveTx[n]?.at ?? now().toISOString() };
    if (serviceOf(frame.data) === '27') noteSecurity();
  };
  const common = {
    securityPassword: plan.password,
    ...(plan.passwordSource ? { passwordSource: plan.passwordSource } : {}),
    signal: deps.signal,
    onSend: markSent,
    onMarker: (m: MarkerWrite) => {
      // After the deadline the outcome is already recorded; a late callback must not rewrite history.
      if (!deadlineHit) liveMarkers.set(m.did, m);
    },
    onTxFrame,
    onNote: (n: WriterNote) => {
      // Journal only; after the deadline the record is settled and late notes are dropped.
      if (deadlineHit) return;
      pendingEvents.push(emit({ type: 'writer', ...n }));
      poke();
    },
    onPending: () => {
      // A late callback from an exchange we already gave up on must not rewrite history.
      if (deadlineHit) return;
      markSent(); // a pending marker proves the request left
      pendingEvents.push(emit({ type: 'response-pending' }));
      poke();
    },
  };
  // The capability was checked before the car was touched; a link without it never reaches here with a sequence.
  const runSequence = link.sequence?.bind(link);
  const writeCall: Promise<DidWrite> = sequenceSpec
    ? (runSequence ?? (() => Promise.reject(new Error('This link cannot run declared sequences.'))))(
        module,
        sequenceSpec,
        // The pre-write bytes let the writer re-send a payload its proof read shows was not stored (BRIEF D5).
        { ...common, originalBytes },
      )
    : link.writeDid(module, plan.did, plan.after, { ...common, originalBytes });
  void writeCall
    .then(
      (r) => {
        if (!deadlineHit) write = r;
      },
      (e: unknown) => {
        if (!deadlineHit) writeError = e;
      },
    )
    .finally(() => {
      settled = true;
      poke();
    });
  try {
    while (true) {
      while (pendingEvents.length) yield pendingEvents.shift() as CodingEvent;
      if (settled) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  } finally {
    clearTimeout(deadline);
  }
  // A link that never reported the send (older/simple links) has sent once it answers with something only
  // the data write can produce. A deadline, a throw or a lost link before `onSend` claims nothing: the
  // outcome is still "uncertain", but the history does not say the request left when we cannot know.
  // Events for the send always precede its consequences.
  const answerImpliesSend =
    write?.kind === 'acked' ||
    write?.kind === 'nrc' ||
    write?.kind === 'pending-no-final' ||
    write?.kind === 'no-reply' ||
    write?.kind === 'partial';
  // The write's final frame list may name SecurityAccess the live callback never reported.
  const finalTx = write?.txFrames ?? [];
  if (!securityEmitted && !deadlineHit && finalTx.some((f) => serviceOf(f.data) === '27')) {
    securityEmitted = true;
    yield emit({ type: 'security-access' });
  }
  if (!sentEmitted && answerImpliesSend) {
    sentEmitted = true;
    yield emit({ type: 'request-sent', did: plan.did });
  }
  // The write's own final list when it returned one; otherwise what it reported along the way.
  const markers = write?.markers ?? [...liveMarkers.values()];
  if (markers.length) yield emit({ type: 'markers', markers });
  const sequenceSteps = write?.steps ?? [];
  const incomplete = write?.kind === 'acked' ? write.incomplete : undefined;
  if (sequenceSteps.length || incomplete)
    yield emit({ type: 'sequence', steps: sequenceSteps, ...(incomplete ? { incomplete } : {}) });
  // Every frame the writer handed to its adapter (T-1), whatever the outcome: the write's final list when it
  // returned one (final stages), else what it reported along the way.
  const learnedAt = now().toISOString();
  const txFrames = Array.from({ length: Math.max(finalTx.length, liveTx.length) }, (_, i) => {
    const frame = finalTx[i] ?? liveTx[i];
    return frame
      ? { can: frame.can, data: frame.data, stage: frame.stage, at: liveTx[i]?.at ?? learnedAt }
      : undefined;
  }).filter((f): f is TxFrameEntry => f !== undefined);
  return {
    write,
    writeError,
    deadlineHit,
    markers,
    rxFrames: write?.rxFrames ?? [],
    sequenceSteps,
    incomplete,
    txFrames,
  };
}

/** How a write ended: stopped (recorded and reported as is), or sent and now to be read back. */
type WriteVerdict =
  | {
      kind: 'stop';
      pre: CodingEvent[];
      patch: Omit<BackupPatch, 'updatedAt'>;
      outcome: Outcome;
      phase: string;
      /** Something may have reached the module (uncertain), as opposed to a clean stop. */
      maybeLanded: boolean;
    }
  | { kind: 'check'; pre: CodingEvent[]; acknowledged: boolean; markersNote: string; incompleteNote: string };

function judgeWrite(t: Transmitted, job: Pick<WriteJob, 'link' | 'plan' | 'emit'>): WriteVerdict {
  const { link, plan, emit } = job;
  const { write } = t;
  const markersNote = describeStoredMarkers(t.markers) + describeSteps(t.sequenceSteps);
  const incompleteNote = t.incomplete ? describeIncomplete(t.incomplete) : '';
  const uncertain = (
    pre: CodingEvent[],
    phase: string,
    ack: 'received' | 'not-received' = 'not-received',
  ): WriteVerdict => ({
    kind: 'stop',
    pre,
    patch: { status: 'unconfirmed', outcome: 'pending-uncertain', ack },
    outcome: 'pending-uncertain',
    phase,
    maybeLanded: true,
  });
  if (t.deadlineHit) {
    // The write may still be in flight. Retire this link before anyone can start another exchange on it.
    quarantine(link);
    return uncertain(
      [emit({ type: 'link-lost' })],
      `The car didn't answer in time. Reconnect and check the setting before doing anything else.${markersNote}`,
    );
  }
  // A throwing link is treated as lost: after the request left, that is *uncertain*, never failure.
  if (t.writeError !== undefined || write?.kind === 'link-lost') {
    quarantine(link);
    return uncertain(
      [emit({ type: 'link-lost' })],
      `The connection dropped while the change was being made. Reconnect and check the setting.${markersNote}`,
    );
  }
  // Part of a multi-request payload was accepted, then it stopped: the module may hold part of it. Never
  // "rejected" or "nothing changed"; the link is retired so the next step starts from a fresh connection.
  if (write?.kind === 'partial') {
    quarantine(link);
    return uncertain(
      [],
      `${write.detail} Part of the change may already be stored. Reconnect and check the car before doing anything else.${markersNote}`,
    );
  }
  // The payload was acknowledged, then the sequence lost the link or a step went unanswered: the
  // acknowledgement stands, nothing is repeated, and nothing more is done on this connection.
  if (
    write?.kind === 'acked' &&
    (t.incomplete?.reason === 'link-lost' || t.incomplete?.reason === 'no-answer')
  ) {
    const acked = emit({ type: 'write-acked' });
    quarantine(link);
    return uncertain(
      [acked, emit({ type: 'link-lost' })],
      `Your car accepted the change.${incompleteNote} Reconnect and check the setting before doing anything else.${markersNote}`,
      'received',
    );
  }
  if (write?.kind === 'cancelled')
    return {
      kind: 'stop',
      pre: [],
      patch: { status: 'refused', outcome: 'cancelled', ack: 'not-received' },
      outcome: 'cancelled',
      phase: markersNote
        ? `Cancelled before the setting was sent.${markersNote}`
        : 'Cancelled before anything was sent.',
      maybeLanded: false,
    };
  if (write?.kind === 'not-sent') {
    // A step before the data write (session, security, marker) stopped the sequence: the setting itself was never sent.
    const detail = `${write.detail} The setting itself was not sent.${markersNote}`;
    return {
      kind: 'stop',
      pre: [
        emit({ type: 'refused', reason: write.reason === 'not-ready' ? 'not-ready' : 'ecu-refused', detail }),
      ],
      patch: { status: 'refused', outcome: 'not-sent', ack: 'not-received' },
      outcome: 'not-sent',
      phase: detail,
      maybeLanded: false,
    };
  }
  if (write?.kind === 'nrc')
    return {
      kind: 'stop',
      pre: [
        emit({
          type: 'refused',
          reason: 'ecu-refused',
          detail: `${write.detail ?? nrcDetail(write.code, plan)}${markersNote}`,
          code: write.code.toUpperCase(),
        }),
      ],
      patch: { status: 'refused', outcome: 'rejected', ack: 'not-received' },
      outcome: 'rejected',
      phase: markersNote
        ? `Your car didn't accept the change. The setting was not changed.${markersNote}`
        : "Your car didn't accept the change. Nothing was changed.",
      maybeLanded: false,
    };
  const acknowledged = write?.kind === 'acked';
  return {
    kind: 'check',
    pre: acknowledged ? [emit({ type: 'write-acked' })] : [],
    acknowledged,
    markersNote,
    incompleteNote,
  };
}

/** Read-back facts for one write. */
interface Confirmed {
  matched: boolean;
  lastObserved?: string;
  readbackAt?: string;
  moduleManaged: ModuleManagedChange[];
  unexplained: ModuleManagedChange[];
  /** The link dropped (or threw) before the read-backs finished: an earlier non-match is not the last word. */
  lostDuringCheck: boolean;
}

/** Reads the DID back (reads are safe to repeat) until every owned bit matches or the attempts run out. */
async function* confirm(
  job: WriteJob,
  known: readonly string[],
  sleep: (ms: number) => Promise<void>,
): AsyncGenerator<CodingEvent, Confirmed> {
  const { link, module, plan, deps, now, emit } = job;
  yield emit({ type: 'check-started' });
  const attempts = Math.max(1, deps.readbackAttempts ?? 3);
  const c: Confirmed = { matched: false, moduleManaged: [], unexplained: [], lostDuringCheck: false };
  for (let i = 0; i < attempts && !c.matched; i++) {
    if (i > 0) await sleep(deps.readbackDelayMs ?? 1500);
    let r: DidRead;
    try {
      r = await link.readDid(module, plan.did);
    } catch {
      // A throwing link is treated as lost, exactly like a throwing write: retire it.
      quarantine(link);
      r = { kind: 'link-lost' };
    }
    if (r.kind === 'link-lost') {
      c.lostDuringCheck = true;
      yield emit({ type: 'link-lost' });
      break;
    }
    if (r.kind !== 'ok') continue;
    c.lastObserved = r.bytes.toUpperCase();
    c.readbackAt = now().toISOString();
    const verdict = compareReadback({ ...plan, known }, c.lastObserved);
    c.matched = verdict.kind !== 'mismatch';
    c.moduleManaged = verdict.kind === 'owned-match' ? verdict.moduleManaged : [];
    c.unexplained = verdict.kind === 'mismatch' ? (verdict.unexplained ?? []) : [];
    yield emit({
      type: 'readback',
      observed: c.lastObserved,
      matches: c.matched,
      ...(c.moduleManaged.length ? { moduleManaged: c.moduleManaged } : {}),
    });
  }
  return c;
}

/** The record patch, outcome and phase a read-back leads to. */
function judgeConfirm(
  c: Confirmed,
  v: Extract<WriteVerdict, { kind: 'check' }>,
  sequenceSteps: readonly SequenceStep[],
): { patch: Omit<BackupPatch, 'updatedAt'>; outcome: Outcome; phase: string } {
  const ack = v.acknowledged ? 'received' : 'not-received';
  const evidence = {
    ack,
    ...(c.lastObserved ? { observed: c.lastObserved, readbackAt: c.readbackAt } : {}),
    ...(c.moduleManaged.length ? { moduleManaged: c.moduleManaged } : {}),
  } as const;
  if (c.matched) {
    const outcome: Outcome = v.acknowledged ? 'verified' : 'observed-match';
    return {
      patch: { status: 'verified', outcome, ...evidence },
      outcome,
      phase: `${
        c.moduleManaged.length
          ? `${v.acknowledged ? 'Your car accepted it and the setting matches.' : "The setting matches, though your car didn't send its final confirmation."}${moduleNote(c.moduleManaged)}`
          : v.acknowledged
            ? 'Your car accepted it and the setting matches exactly.'
            : "The setting matches exactly, though your car didn't send its final confirmation."
      }${v.incompleteNote}${sequenceSteps.length ? v.markersNote : ''}`,
    };
  }
  if (c.lastObserved !== undefined && !c.lostDuringCheck)
    return {
      patch: { status: 'unconfirmed', outcome: 'mismatch', ...evidence },
      outcome: 'mismatch',
      phase: `${mismatchPhase(c.unexplained)}${v.incompleteNote}`,
    };
  if (c.lastObserved !== undefined)
    // An early read can be stale (the module commits slowly); the link dropped before a later one.
    return {
      patch: { status: 'unconfirmed', outcome: 'pending-uncertain', ...evidence },
      outcome: 'pending-uncertain',
      phase: `The connection dropped while we were checking, before the setting matched. Reconnect and check the setting.${v.incompleteNote}`,
    };
  return {
    patch: { status: 'unconfirmed', outcome: 'pending-uncertain', ...evidence },
    outcome: 'pending-uncertain',
    phase: `We couldn't check the setting to confirm it.${v.incompleteNote}`,
  };
}

/** Journal bookkeeping for one operation record: status changes plus the write evidence gathered so far. */
function journalOf(deps: CodingDeps, now: () => Date, emit: Emit, initial: BackupRecord) {
  const state = {
    journal: initial,
    markers: [] as readonly MarkerWrite[],
    rxFrames: [] as readonly string[],
    sequenceEvidence: {} as Pick<BackupPatch, 'sequenceSteps' | 'sequenceIncomplete'>,
    /** Frames the writer handed to its adapter; folded into the next durable patch once, then cleared (T-1). */
    pendingTxFrames: [] as readonly TxFrameEntry[],
  };
  /**
   * Record a status change. A failed bookkeeping update never masks the car-side
   * outcome — but it is never hidden either: it is reported with our in-memory copy
   * of the journal so the user can export it.
   */
  const record = async (id: string, patch: Omit<BackupPatch, 'updatedAt'>): Promise<CodingEvent[]> => {
    const at = now().toISOString();
    const own = id === state.journal.id;
    const tx = own ? state.pendingTxFrames : [];
    if (own) state.pendingTxFrames = [];
    const full: BackupPatch = {
      ...patch,
      ...(own && state.markers.length ? { markers: [...state.markers] } : {}),
      ...(own && state.rxFrames.length ? { rxFrames: [...state.rxFrames] } : {}),
      ...(own ? state.sequenceEvidence : {}),
      ...(own && tx.length ? boundTxFrames(tx) : {}),
      updatedAt: at,
    };
    if (own) {
      state.journal = {
        ...state.journal,
        ...full,
        history: [
          ...state.journal.history,
          { at, status: full.status, ...(full.outcome ? { outcome: full.outcome } : {}) },
        ],
      };
    }
    try {
      await deps.backups.update(id, full);
      return [];
    } catch {
      return [
        emit({
          type: 'audit-failed',
          backupId: id,
          detail: "We couldn't save this result to your backups. Download the record below to keep it.",
          ...(own ? { record: state.journal } : {}),
        }),
      ];
    }
  };
  /** Folds one write's evidence into what the next status change records. */
  const absorb = (t: Transmitted) => {
    state.markers = [...state.markers, ...t.markers].slice(-4);
    state.rxFrames = [...state.rxFrames, ...t.rxFrames].slice(-64);
    state.sequenceEvidence = {
      ...(t.sequenceSteps.length ? { sequenceSteps: [...t.sequenceSteps] } : {}),
      ...(t.incomplete ? { sequenceIncomplete: t.incomplete } : {}),
    };
    state.pendingTxFrames = [...state.pendingTxFrames, ...t.txFrames];
  };
  return { state, record, absorb };
}

export async function* runCoding(req: WriteRequest, deps: CodingDeps): AsyncGenerator<CodingEvent, void> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const recipeFor = deps.recipeFor ?? defaultRecipeFor;
  const featureFor = deps.featureFor ?? findFeature;
  const emit: Emit = (e) => {
    const event = { ...e, at: now().toISOString() } as CodingEvent;
    feedCodingEvent(event);
    return event;
  };

  /** Everything before the wire: stop, explain, nothing changed. */
  const refuse: Refuse = (reason, detail, outcome = 'not-sent', extra = {}) => [
    emit({ type: 'refused', reason, detail, ...extra }),
    emit({ type: 'outcome', outcome, phase: detail }),
  ];

  const { link } = deps;
  yield emit({ type: 'verify-started' });
  if (quarantined.has(link)) {
    for (const e of refuse('link-quarantined', QUARANTINED_DETAIL)) yield e;
    return;
  }

  // ---- 0. what are we about to change? ---------------------------------------------------
  const target = await resolveTarget(req, recipeFor, featureFor, deps.selector);
  if (!target.ok) {
    for (const e of refuse(
      target.reason,
      target.detail,
      undefined,
      target.technical ? { technical: target.technical } : {},
    ))
      yield e;
    return;
  }
  if (target.group) {
    yield* runGroup(req, deps, target.recipe, target.trusted, { now, sleep, emit, refuse });
    return;
  }
  const { recipe, module } = target;

  // A declared sequence runs only on a link that can run it — never through the generic writer (C1).
  if (needsSequence(recipe) && !link.sequence) {
    for (const e of refuse(
      'not-eligible',
      "This connection can't make this change on your car. Nothing was changed.",
    ))
      yield e;
    return;
  }

  // ---- 1. verify: car and control unit (identified and journaled; a restore needs the same ones) -------
  const verified = await verifyCar(
    link,
    module,
    req.kind === 'restore'
      ? {
          expectedFingerprint: req.backup.vin.fingerprint,
          expectedLabel: req.backup.vin.full ?? req.backup.vin.masked,
          strict: true,
          requiredPart: req.backup.module.part,
        }
      : {
          expectedFingerprint: deps.expectedVinFingerprint,
          expectedLabel: 'the car you set up',
          strict: false,
        },
    emit,
    refuse,
  );
  if (!verified.ok) {
    for (const e of verified.events) yield e;
    return;
  }
  const { vin, fingerprint, part } = verified;
  const verifiedPart = part;
  yield emit({ type: 'car-verified', vin: normalizeVin(vin), vinMasked: maskVin(vin), part });
  const warnings: { code: WarningCode; detail: string; technical?: string }[] = [...verified.warnings];
  for (const w of verified.warnings) yield emit({ type: 'warning', ...w });

  // A variant split (or MIB-conditional options): settle it from this module before anything is planned.
  let pick = target.pick;
  let did = target.did;
  if (req.kind === 'apply') {
    const settled = await settleVariant(link, module, recipe, part, target.probe ? undefined : target.pick);
    if (settled.note) yield emit(settled.note);
    if (!settled.ok) {
      if (settled.lost) yield emit({ type: 'link-lost' });
      for (const e of settled.lost
        ? refuse('module-silent', settled.detail)
        : refuse('variant-unsettled', VARIANT_UNSETTLED, undefined, { technical: settled.detail }))
        yield e;
      return;
    }
    pick = settled.pick;
    try {
      did = resolveRecipe(recipe, pick).did;
    } catch (e) {
      for (const ev of refuse('variant-unsettled', VARIANT_UNSETTLED, undefined, {
        technical: planFailure(e).technical,
      }))
        yield ev;
      return;
    }
  }

  // ---- 2. backup: original value + plan, durable BEFORE the write ------------------------
  if (deps.signal.aborted) {
    yield emit({ type: 'outcome', outcome: 'cancelled', phase: 'Cancelled before anything was sent.' });
    return;
  }
  const original = await link.readDid(module, did);
  if (original.kind !== 'ok') {
    for (const e of readFailure(original, refuse)) yield e;
    return;
  }
  // Links report hex; planning and every comparison work on upper case.
  const originalBytes = original.bytes.toUpperCase();

  if (req.kind === 'restore') {
    // Only undo what this operation left behind. If the value has moved on since (another
    // change, another tool), writing the old bytes would silently discard that later change.
    const b = req.backup;
    // "What that operation left" is judged on the bytes the TRUSTED recipe writes into (resolved and
    // digest-matched above), never on a mask the record carries.
    let owned: number[];
    try {
      owned = trustedOwnedMask(recipe, b.intended.length / 2, pick);
    } catch {
      for (const e of refuse('backup-inconsistent', INCONSISTENT)) yield e;
      return;
    }
    if (!stillOurs(recipe, owned, b, originalBytes)) {
      for (const e of refuse(
        'restore-conflict',
        'This setting has been changed since this backup was made, so restoring it would undo a later change. Nothing was changed.',
      ))
        yield e;
      return;
    }
    // A record whose own mask disagrees with the trusted one is not what it claims to be (e.g. an edited
    // file): never restore from it, even when the car still holds what it says.
    if (b.ownedMask !== undefined && b.ownedMask.toUpperCase() !== ownedToHex(owned)) {
      for (const e of refuse('backup-inconsistent', INCONSISTENT)) yield e;
      return;
    }
  }

  let plan: CodingPlan;
  try {
    plan =
      req.kind === 'apply'
        ? buildApplyPlan(recipe, req.settingId, originalBytes, pick)
        : buildRestorePlan(
            recipe,
            originalBytes,
            req.backup.before.toUpperCase(),
            pick,
            strayBytes(req.backup.before, req.backup.intended, req.backup.observed, originalBytes),
          );
  } catch (e) {
    const reason: RefusalReason =
      e instanceof PlanError && e.code === 'variant-unsettled' ? 'variant-unsettled' : 'invalid-plan';
    const failed = planFailure(e);
    for (const ev of refuse(reason, failed.detail, undefined, { technical: failed.technical })) yield ev;
    return;
  }
  if (req.kind === 'apply') {
    const fixed = applyKnownRepairs(plan, verifiedPart);
    plan = fixed.plan;
    for (const r of fixed.repaired)
      yield emit({
        type: 'warning',
        code: 'repair',
        detail: 'We also put back a value an earlier change had left wrong on your car.',
        technical: describeRepair(r),
      });
  }
  if (plan.noop) {
    for (const e of refuse('already-set', "It's already set that way. Nothing needed changing.")) yield e;
    return;
  }
  // A read-only link really cannot write (a simulator, a replay): that is a capability, not a switch.
  if (!link.canWrite) {
    for (const e of refuse(
      'live-writes-disabled',
      "This connection can't write to the car. Nothing was changed.",
    ))
      yield e;
    return;
  }

  // ---- 2a. module snapshot: before the write, best-effort ----------------------------------------
  const snapshot: Snapshot =
    deps.moduleSnapshot === false
      ? { kind: 'complete', values: {}, scanned: false }
      : await snapshotModule(link, module, recipe, plan.did, deps.signal, now);
  if (snapshot.kind === 'cancelled') {
    yield emit({ type: 'outcome', outcome: 'cancelled', phase: 'Cancelled before anything was sent.' });
    return;
  }
  if (snapshot.kind === 'lost') {
    yield emit({ type: 'link-lost' });
    yield emit({
      type: 'outcome',
      outcome: 'not-sent',
      phase: 'The adapter disconnected before anything was sent.',
    });
    return;
  }
  // The plan was made from the value read before the scan: it must still be what the car holds.
  // Without a scan there is nothing between the plan read and here for it to drift across — and
  // this car drops rapid repeats of the same DID (live sessions 2026-10-28, F73/F74).
  const fresh: DidRead =
    deps.moduleSnapshot === false || !snapshot.scanned
      ? { kind: 'ok', bytes: originalBytes }
      : await link.readDid(module, did).catch((): DidRead => ({ kind: 'link-lost' }));
  if (fresh.kind !== 'ok') {
    for (const e of readFailure(fresh, refuse)) yield e;
    return;
  }
  if (fresh.bytes.toUpperCase() !== originalBytes) {
    for (const e of refuse(
      'value-changed',
      'The setting changed while we were saving your original, so we stopped. Nothing was changed.',
    ))
      yield e;
    return;
  }

  // ---- 2b. readiness: measured and journaled; a warning, never a refusal -------------------
  const ready = await measureReadiness(link, now);
  if (ready.lost) {
    yield emit({ type: 'link-lost' });
    for (const e of refuse('module-silent', 'The adapter disconnected before anything was sent.')) yield e;
    return;
  }
  const measured = readinessEvent(ready, now);
  if (measured) yield emit(measured);
  if (ready.warning) {
    warnings.push({ code: 'readiness', detail: ready.warning });
    yield emit({ type: 'warning', code: 'readiness', detail: ready.warning });
  }

  // Every write — apply or restore — gets its own durable operation record first.
  const stamp = now().toISOString();
  const digest = await recipeDigest(recipe);
  const shared = {
    schema: BACKUP_SCHEMA,
    id: (deps.newId ?? (() => crypto.randomUUID()))(),
    createdAt: stamp,
    updatedAt: stamp,
    recipeId: recipe.id,
    vin: { masked: maskVin(vin), fingerprint, full: normalizeVin(vin) },
    module: { ...module, part },
    did: plan.did,
    before: plan.before,
    intended: plan.after,
    ownedMask: ownedToHex(plan.owned),
    status: 'prepared',
    linkMode: link.mode,
    recipeDigest: digest,
    ...(ready.evidence ? { readiness: ready.evidence } : {}),
    ...(warnings.length
      ? {
          warnings: warnings
            .map((w) => (w.technical ? `${w.detail} (${w.technical})` : w.detail).slice(0, 400))
            .slice(0, 16),
        }
      : {}),
    ...(plan.variantIndex !== undefined ? { variant: plan.variantIndex } : {}),
    ...(snapshot.scanned ? { moduleSnapshot: { ...snapshot.values, [plan.did]: originalBytes } } : {}),
    ...(snapshot.kind === 'partial' ? { moduleSnapshotPartial: true as const } : {}),
    ack: 'unknown',
    history: [{ at: stamp, status: 'prepared' }],
  } as const;
  const initial: BackupRecord =
    req.kind === 'apply'
      ? {
          ...shared,
          operation: 'apply',
          featureId: req.feature.id,
          featureName: (target.trusted ?? req.feature).name,
          settingId: req.settingId,
          settingLabel: settingLabelOf(target.trusted ?? req.feature, req.settingId),
          car: carOf(req.car),
          history: [...shared.history],
        }
      : {
          ...shared,
          operation: 'restore',
          restoreOf: req.backup.id,
          featureId: req.backup.featureId,
          featureName: req.backup.featureName,
          settingId: req.backup.settingId,
          settingLabel: 'original value',
          car: req.backup.car,
          history: [...shared.history],
        };
  try {
    await deps.backups.save(initial);
  } catch {
    for (const e of refuse('backup-failed', "We couldn't save a backup, so we didn't change anything."))
      yield e;
    return;
  }
  yield emit({ type: 'backup-saved', backupId: initial.id });
  const { state, record, absorb } = journalOf(deps, now, emit, initial);

  // ---- 3. write: once -----------------------------------------------------------------------
  if (deps.signal.aborted) {
    for (const e of await record(state.journal.id, { status: 'refused', outcome: 'cancelled' })) yield e;
    yield emit({ type: 'outcome', outcome: 'cancelled', phase: 'Cancelled before anything was sent.' });
    return;
  }
  const job: WriteJob = { link, module, plan, originalBytes, deps, now, emit };
  const t = yield* transmit(job);
  absorb(t);
  const verdict = judgeWrite(t, job);
  for (const e of verdict.pre) yield e;
  if (verdict.kind === 'stop') {
    for (const e of await record(state.journal.id, verdict.patch)) yield e;
    yield emit({ type: 'outcome', outcome: verdict.outcome, phase: verdict.phase });
    return;
  }

  // ---- 4. check: every bit the recipe owns must read back exactly ---------------------------
  const known = knownReadbacksFor({
    recipeId: recipe.id,
    recipeDigest: digest,
    module,
    part,
    did: plan.did,
    intended: plan.after,
  });
  const c = yield* confirm(job, known, sleep);
  const judged = judgeConfirm(c, verdict, t.sequenceSteps);
  for (const e of await record(state.journal.id, judged.patch)) yield e;
  if (c.matched && req.kind === 'restore') {
    // Append the resolution to the change this undid; its own history stays intact.
    for (const e of await record(req.backup.id, { status: 'restored', restoredBy: state.journal.id }))
      yield e;
  }
  yield emit({ type: 'outcome', outcome: judged.outcome, phase: judged.phase });
}

/** The car still holds what the operation left (before, intended or observed) in the recipe's own bits. */
function stillOurs(
  recipe: Pick<CodingRecipe, 'checksum'>,
  owned: readonly number[],
  b: Pick<BackupRecord, 'before' | 'intended' | 'observed'>,
  current: string,
): boolean {
  // Only the recipe's own bytes matter here: a restore puts back nothing else (and recomputes a checksum).
  const guard = guardMask(recipe, owned);
  const same = (left: string | undefined): boolean =>
    left !== undefined &&
    ownedBytesMatch(compareReadback({ after: left.toUpperCase(), owned: guard }, current));
  return same(b.before) || same(b.intended) || same(b.observed);
}

const settingLabelOf = (feature: FeatureItem, settingId: string): string => {
  const listed = feature.settings.find((s) => s.id === settingId)?.label;
  if (listed) return listed;
  const free = /^value:(.+)$/.exec(settingId)?.[1];
  return free ? `${free}${feature.scalar?.unit ? ` ${feature.scalar.unit}` : ''}` : settingId;
};

const carOf = (car: CarSelection): BackupRecord['car'] => ({
  brand: car.brand,
  model: car.model,
  variant: car.variant,
  year: car.year,
  ...(car.period2024 ? { period2024: car.period2024 } : {}),
  cluster: car.cluster,
});

// ---- multi-part (group) changes ------------------------------------------------------------------

interface RunTools {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  emit: Emit;
  refuse: Refuse;
}

/** One planned part of a group run. */
interface PlannedStep {
  index: number;
  step: CodingRecipe;
  module: ModuleAddress;
  part: string;
  pick: VariantPick | undefined;
  plan: CodingPlan;
  action: 'apply' | 'restore';
  settingId?: string;
  originalBytes: string;
}

const stepEntry = (p: PlannedStep, status: GroupStepEntry['status']): GroupStepEntry => ({
  index: p.index,
  recipeId: p.step.id,
  module: { ...p.module, part: p.part },
  did: p.plan.did,
  before: p.plan.before,
  intended: p.plan.after,
  ownedMask: ownedToHex(p.plan.owned),
  action: p.action,
  ...(p.settingId ? { settingId: p.settingId } : {}),
  ...(p.plan.variantIndex !== undefined ? { variant: p.plan.variantIndex } : {}),
  status,
});

/** Group statuses that mean bytes may be on the car for that part (and so can be put back). */
const LANDED: readonly GroupStepEntry['status'][] = ['prepared', 'verified', 'unconfirmed'];

/**
 * The latest original bytes recorded for part `index` of this group on this car: what an "off" choice puts a
 * single-choice part back to. Absent when no earlier change of this group wrote that part.
 */
async function priorStepOriginal(
  store: BackupStore,
  groupId: string,
  fingerprint: string,
  index: number,
): Promise<string | undefined> {
  const all = (await store.list?.().catch(() => [])) ?? [];
  const candidates = all
    .filter(
      (b) =>
        b.operation === 'apply' &&
        b.groupId === groupId &&
        b.vin.fingerprint === fingerprint &&
        b.status !== 'restored' &&
        b.status !== 'refused',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const b of candidates) {
    const entry = b.steps?.find(
      (s) => s.index === index && s.action === 'apply' && LANDED.includes(s.status),
    );
    if (entry) return entry.before;
  }
  return undefined;
}

/**
 * A multi-part feature: every part is planned (its module identified, its variant settled, its original read)
 * before anything is written; ONE operation record journals every part; the parts are written in order, each
 * on its own module, and each is read back. A part that stops leaves the parts before it recorded as landed
 * (each restorable on its own); a restore walks the landed parts in reverse.
 */
async function* runGroup(
  req: WriteRequest,
  deps: CodingDeps,
  recipe: CodingRecipe,
  trusted: FeatureItem | undefined,
  tools: RunTools,
): AsyncGenerator<CodingEvent, void> {
  const { now, sleep, emit, refuse } = tools;
  const { link } = deps;
  let steps: CodingRecipe[];
  try {
    steps = groupStepsOf(recipe);
  } catch (e) {
    const failed = planFailure(e);
    for (const ev of refuse('invalid-plan', failed.detail, undefined, { technical: failed.technical }))
      yield ev;
    return;
  }
  // Which parts this run touches: an apply plans every part; a restore only the parts that landed.
  const entries =
    req.kind === 'restore'
      ? [...(req.backup.steps ?? [])].filter((s) => LANDED.includes(s.status)).reverse()
      : undefined;
  if (entries && !entries.length) {
    for (const e of refuse(
      'already-set',
      'No part of this change reached the car, so there is nothing to put back.',
    ))
      yield e;
    return;
  }
  const indexes = entries ? entries.map((s) => s.index) : steps.map((_, i) => i);
  const modules = new Map<number, ModuleAddress>();
  for (const i of indexes) {
    const step = steps[i];
    if (!step) {
      for (const e of refuse('backup-inconsistent', INCONSISTENT)) yield e;
      return;
    }
    try {
      modules.set(i, moduleOf(step));
    } catch (e) {
      const failed = planFailure(e);
      for (const ev of refuse('invalid-plan', failed.detail, undefined, { technical: failed.technical }))
        yield ev;
      return;
    }
    if (needsSequence(step) && !link.sequence) {
      for (const e of refuse(
        'not-eligible',
        "This connection can't make this change on your car. Nothing was changed.",
      ))
        yield e;
      return;
    }
  }
  const firstModule = modules.get(indexes[0] as number) as ModuleAddress;

  // ---- verify the car once, then identify every part's module ----------------------------------
  const verified = await verifyCar(
    link,
    firstModule,
    req.kind === 'restore'
      ? {
          expectedFingerprint: req.backup.vin.fingerprint,
          expectedLabel: req.backup.vin.full ?? req.backup.vin.masked,
          strict: true,
          requiredPart: entries?.[0]?.module.part,
        }
      : {
          expectedFingerprint: deps.expectedVinFingerprint,
          expectedLabel: 'the car you set up',
          strict: false,
        },
    emit,
    refuse,
  );
  if (!verified.ok) {
    for (const e of verified.events) yield e;
    return;
  }
  const { vin, fingerprint } = verified;
  yield emit({ type: 'car-verified', vin: normalizeVin(vin), vinMasked: maskVin(vin), part: verified.part });
  const warnings = [...verified.warnings];
  for (const w of verified.warnings) yield emit({ type: 'warning', ...w });
  const partOf = new Map<string, string>([[`${firstModule.request}:${firstModule.response}`, verified.part]]);
  const digest = await recipeDigest(recipe);

  // ---- plan every part before anything is written ------------------------------------------------
  const planned: PlannedStep[] = [];
  /**
   * What each module DID will hold once the parts planned so far are written. Parts that share a DID are
   * written one after another, so a later part is planned on top of the earlier part's bytes — planning it
   * on the bytes read now would write those back and silently undo the earlier part.
   */
  const pendingBytes = new Map<string, string>();
  /** Parts skipped because no control-unit version matched (the vendor writes those back unchanged). */
  const unmatched: string[] = [];
  for (const [n, index] of indexes.entries()) {
    const step = steps[index] as CodingRecipe;
    const module = modules.get(index) as ModuleAddress;
    const key = `${module.request}:${module.response}`;
    let part = partOf.get(key);
    if (part === undefined) {
      const r = await link.readDid(module, IDENTITY_PART_DID).catch((): DidRead => ({ kind: 'link-lost' }));
      if (r.kind === 'link-lost') {
        yield emit({ type: 'link-lost' });
        for (const e of refuse('module-silent', 'The adapter disconnected before anything was sent.'))
          yield e;
        return;
      }
      part = (r.kind === 'ok' && asciiOf(r.bytes)) || UNKNOWN_PART;
      partOf.set(key, part);
    }
    const entry = entries?.[n];
    if (entry && entry.module.part !== UNKNOWN_PART && part !== UNKNOWN_PART && entry.module.part !== part) {
      for (const e of refuse(
        'unknown-module',
        'Part of this backup was made on a different part than the one in your car now. Nothing was changed.',
        undefined,
        { technical: `Part ${index + 1}: backup made on ${entry.module.part}, car has ${part}.` },
      ))
        yield e;
      return;
    }
    if (part === UNKNOWN_PART) {
      const w = {
        code: 'identity' as const,
        detail: "We couldn't identify one part of your car. It is recorded as unknown.",
        technical: `Part ${index + 1} (${module.request}) didn't report its part number (F187).`,
      };
      warnings.push(w);
      yield emit({ type: 'warning', ...w });
    }
    let pick: VariantPick | undefined;
    if (entry) {
      pick = entry.variant !== undefined ? { index: entry.variant } : recordedPick(step, entry, undefined);
    } else {
      const settled = await settleVariant(link, module, step, part, undefined);
      if (settled.note) yield emit(settled.note);
      if (!settled.ok && !settled.lost) {
        // The vendor writes a part whose control-unit version doesn't match back unchanged: skip it, keep going.
        const w = {
          code: 'group' as const,
          detail: "Part of this change didn't apply to your car, so that part was left as it was.",
          technical: `Part ${index + 1} of ${steps.length}: ${settled.detail}`,
        };
        warnings.push(w);
        yield emit({ type: 'warning', ...w });
        unmatched.push(settled.detail);
        continue;
      }
      if (!settled.ok) {
        if (settled.lost) yield emit({ type: 'link-lost' });
        for (const e of settled.lost
          ? refuse('module-silent', settled.detail)
          : refuse('variant-unsettled', VARIANT_UNSETTLED, undefined, {
              technical: `Part ${index + 1} of ${steps.length}: ${settled.detail}`,
            }))
          yield e;
        return;
      }
      pick = settled.pick;
    }
    let did: string;
    try {
      did = resolveRecipe(step, pick).did;
    } catch (e) {
      for (const ev of refuse('variant-unsettled', VARIANT_UNSETTLED, undefined, {
        technical: planFailure(e).technical,
      }))
        yield ev;
      return;
    }
    if (
      entry &&
      (entry.did !== did ||
        entry.module.request !== module.request ||
        entry.module.response !== module.response)
    ) {
      for (const e of refuse(
        'target-changed',
        "This setting has been updated in the app since this backup was made, so it can't be undone automatically. Nothing was changed.",
      ))
        yield e;
      return;
    }
    const read = await link.readDid(module, did).catch((): DidRead => ({ kind: 'link-lost' }));
    if (read.kind !== 'ok') {
      for (const e of readFailure(read, refuse)) yield e;
      return;
    }
    const didKey = `${module.request}:${module.response}:${did}`;
    const originalBytes = pendingBytes.get(didKey) ?? read.bytes.toUpperCase();
    try {
      if (entry) {
        const owned = trustedOwnedMask(step, entry.intended.length / 2, pick);
        if (!stillOurs(step, owned, entry, originalBytes)) {
          for (const e of refuse(
            'restore-conflict',
            'Part of this setting has been changed since this backup was made, so undoing it would also undo that later change. Nothing was changed.',
          ))
            yield e;
          return;
        }
        if (entry.ownedMask.toUpperCase() !== ownedToHex(owned)) {
          for (const e of refuse('backup-inconsistent', INCONSISTENT)) yield e;
          return;
        }
        const plan = buildRestorePlan(
          step,
          originalBytes,
          entry.before,
          pick,
          strayBytes(entry.before, entry.intended, entry.observed, originalBytes),
        );
        planned.push({ index, step, module, part, pick, plan, action: 'restore', originalBytes });
      } else {
        const groupChoice = (req as Extract<WriteRequest, { kind: 'apply' }>).settingId;
        const resolved = resolveRecipe(step, pick);
        const action = stepActionFor(resolved.choices, groupChoice, resolved.encoding === 'scalar');
        const prior =
          action.kind === 'restore'
            ? await priorStepOriginal(deps.backups, recipe.id, fingerprint, index)
            : undefined;
        if (action.kind === 'restore' && !prior) {
          const w = {
            code: 'group' as const,
            detail: 'One part had nothing to undo, so it was left as it was.',
            technical: `Part ${index + 1} has no earlier change of this feature on record to put back.`,
          };
          warnings.push(w);
          yield emit({ type: 'warning', ...w });
        }
        const plan = planGroupStep(step, groupChoice, originalBytes, pick, prior);
        planned.push({
          index,
          step,
          module,
          part,
          pick,
          plan,
          action: plan.action,
          ...(action.kind === 'apply' ? { settingId: action.settingId } : {}),
          originalBytes,
        });
      }
    } catch (e) {
      const reason: RefusalReason =
        e instanceof PlanError && e.code === 'variant-unsettled' ? 'variant-unsettled' : 'invalid-plan';
      const failed = planFailure(e);
      for (const ev of refuse(reason, failed.detail, undefined, {
        technical: `Part ${index + 1} of ${steps.length}: ${failed.technical}`,
      }))
        yield ev;
      return;
    }
    const last = planned.at(-1);
    if (last) pendingBytes.set(didKey, last.plan.after.toUpperCase());
  }
  const work = planned.filter((p) => !p.plan.noop);
  if (!planned.length && unmatched.length) {
    for (const e of refuse('variant-unsettled', VARIANT_UNSETTLED, undefined, { technical: unmatched[0] }))
      yield e;
    return;
  }
  if (!work.length) {
    for (const e of refuse('already-set', "It's already set that way. Nothing needed changing.")) yield e;
    return;
  }
  if (!link.canWrite) {
    for (const e of refuse(
      'live-writes-disabled',
      "This connection can't write to the car. Nothing was changed.",
    ))
      yield e;
    return;
  }
  const ready = await measureReadiness(link, now);
  if (ready.lost) {
    yield emit({ type: 'link-lost' });
    for (const e of refuse('module-silent', 'The adapter disconnected before anything was sent.')) yield e;
    return;
  }
  const measured = readinessEvent(ready, now);
  if (measured) yield emit(measured);
  if (ready.warning) {
    warnings.push({ code: 'readiness', detail: ready.warning });
    yield emit({ type: 'warning', code: 'readiness', detail: ready.warning });
  }

  // ---- one durable record for the whole change ---------------------------------------------------
  let journalSteps: GroupStepEntry[] = planned.map((p) => stepEntry(p, p.plan.noop ? 'skipped' : 'planned'));
  const lead = work[0] as PlannedStep;
  const stamp = now().toISOString();
  const shared = {
    schema: BACKUP_SCHEMA,
    id: (deps.newId ?? (() => crypto.randomUUID()))(),
    createdAt: stamp,
    updatedAt: stamp,
    recipeId: recipe.id,
    vin: { masked: maskVin(vin), fingerprint, full: normalizeVin(vin) },
    module: { ...lead.module, part: lead.part },
    did: lead.plan.did,
    before: lead.plan.before,
    intended: lead.plan.after,
    ownedMask: ownedToHex(lead.plan.owned),
    status: 'prepared',
    linkMode: link.mode,
    recipeDigest: digest,
    groupId: recipe.id,
    stepIndex: lead.index,
    steps: journalSteps,
    ...(lead.plan.variantIndex !== undefined ? { variant: lead.plan.variantIndex } : {}),
    ...(ready.evidence ? { readiness: ready.evidence } : {}),
    ...(warnings.length
      ? {
          warnings: warnings
            .map((w) => (w.technical ? `${w.detail} (${w.technical})` : w.detail).slice(0, 400))
            .slice(0, 16),
        }
      : {}),
    ack: 'unknown',
    history: [{ at: stamp, status: 'prepared' }],
  } as const;
  const initial: BackupRecord =
    req.kind === 'apply'
      ? {
          ...shared,
          operation: 'apply',
          featureId: req.feature.id,
          featureName: (trusted ?? req.feature).name,
          settingId: req.settingId,
          settingLabel: settingLabelOf(trusted ?? req.feature, req.settingId),
          car: carOf(req.car),
          history: [...shared.history],
        }
      : {
          ...shared,
          operation: 'restore',
          restoreOf: req.backup.id,
          featureId: req.backup.featureId,
          featureName: req.backup.featureName,
          settingId: req.backup.settingId,
          settingLabel: 'original value',
          car: req.backup.car,
          history: [...shared.history],
        };
  try {
    await deps.backups.save(initial);
  } catch {
    for (const e of refuse('backup-failed', "We couldn't save a backup, so we didn't change anything."))
      yield e;
    return;
  }
  yield emit({ type: 'backup-saved', backupId: initial.id });
  const { state, record, absorb } = journalOf(deps, now, emit, initial);
  const setStep = (index: number, patch: Partial<GroupStepEntry>) => {
    journalSteps = journalSteps.map((s) => (s.index === index ? { ...s, ...patch } : s));
  };

  // ---- write each part in order, each on its own module, each read back -----------------------------
  let landed = 0;
  let allAcked = true;
  let lastPhase = '';
  for (const [n, p] of work.entries()) {
    const label = `Part ${n + 1} of ${work.length}`;
    if (deps.signal.aborted) {
      const outcome: Outcome = landed ? 'pending-uncertain' : 'cancelled';
      for (const e of await record(state.journal.id, {
        status: landed ? 'unconfirmed' : 'refused',
        outcome,
        steps: journalSteps,
      }))
        yield e;
      yield emit({
        type: 'outcome',
        outcome,
        phase: landed
          ? `Cancelled after ${landed} of ${work.length} parts were changed. They are saved in this backup and can be undone.`
          : 'Cancelled before anything was sent.',
      });
      return;
    }
    yield emit({ type: 'group-step', index: n, of: work.length, module: p.module, did: p.plan.did });
    setStep(p.index, { status: 'prepared' });
    // The record says this part may be written from here on, before its first frame leaves.
    for (const e of await record(state.journal.id, { status: 'prepared', steps: journalSteps })) yield e;
    const job: WriteJob = {
      link,
      module: p.module,
      plan: p.plan,
      originalBytes: p.originalBytes,
      deps,
      now,
      emit,
    };
    const t = yield* transmit(job);
    absorb(t);
    const verdict = judgeWrite(t, job);
    for (const e of verdict.pre) yield e;
    if (t.markers.length) setStep(p.index, { markers: [...t.markers] });
    if (verdict.kind === 'stop') {
      setStep(p.index, {
        status: verdict.maybeLanded ? 'unconfirmed' : 'refused',
        ...(verdict.patch.outcome ? { outcome: verdict.patch.outcome } : {}),
        ...(verdict.patch.ack ? { ack: verdict.patch.ack } : {}),
      });
      const partial = landed > 0 || verdict.maybeLanded;
      const outcome: Outcome = landed > 0 ? 'pending-uncertain' : verdict.outcome;
      for (const e of await record(state.journal.id, {
        ...(partial ? { status: 'unconfirmed', outcome, ack: verdict.patch.ack } : verdict.patch),
        steps: journalSteps,
      }))
        yield e;
      yield emit({
        type: 'outcome',
        outcome,
        phase:
          landed > 0
            ? `${label} stopped: ${verdict.phase} The ${landed} part${landed > 1 ? 's' : ''} before it ${landed > 1 ? 'were' : 'was'} changed and can be undone from this backup.`
            : work.length > 1
              ? `${label}: ${verdict.phase}`
              : verdict.phase,
      });
      return;
    }
    const known = knownReadbacksFor({
      recipeId: p.step.id,
      recipeDigest: digest,
      module: p.module,
      part: p.part,
      did: p.plan.did,
      intended: p.plan.after,
    });
    const c = yield* confirm(job, known, sleep);
    const judged = judgeConfirm(c, verdict, t.sequenceSteps);
    setStep(p.index, {
      status: judged.patch.status === 'verified' ? 'verified' : 'unconfirmed',
      ...(judged.patch.outcome ? { outcome: judged.patch.outcome } : {}),
      ...(judged.patch.ack ? { ack: judged.patch.ack } : {}),
      ...(judged.patch.observed ? { observed: judged.patch.observed } : {}),
      ...(judged.patch.readbackAt ? { readbackAt: judged.patch.readbackAt } : {}),
    });
    if (!c.matched) {
      const outcome: Outcome = landed > 0 ? 'pending-uncertain' : judged.outcome;
      for (const e of await record(state.journal.id, {
        ...judged.patch,
        status: 'unconfirmed',
        outcome,
        steps: journalSteps,
      }))
        yield e;
      yield emit({
        type: 'outcome',
        outcome,
        phase: `${work.length > 1 ? `${label}: ` : ''}${judged.phase}${landed > 0 ? ` The ${landed} part${landed > 1 ? 's' : ''} before it ${landed > 1 ? 'were' : 'was'} changed and can be undone from this backup.` : ''} Later parts were not sent.`,
      });
      return;
    }
    landed += 1;
    allAcked &&= verdict.acknowledged;
    lastPhase = judged.phase;
  }
  const outcome: Outcome = allAcked ? 'verified' : 'observed-match';
  for (const e of await record(state.journal.id, {
    status: 'verified',
    outcome,
    ack: allAcked ? 'received' : 'not-received',
    steps: journalSteps,
  }))
    yield e;
  if (req.kind === 'restore') {
    for (const e of await record(req.backup.id, {
      status: 'restored',
      restoredBy: state.journal.id,
      steps: (req.backup.steps ?? []).map((s) =>
        planned.some((p) => p.index === s.index) ? { ...s, status: 'restored' as const } : s,
      ),
    }))
      yield e;
  }
  yield emit({
    type: 'outcome',
    outcome,
    phase: work.length > 1 ? `All ${work.length} parts were changed and checked. ${lastPhase}` : lastPhase,
  });
}

/** Upper bound on the full-module snapshot. A longer scan stops and is recorded as partial. */
export const SNAPSHOT_BUDGET_MS = 90_000;
/** This many unanswered reads in a row: the module has stopped answering; the scan stops (partial). */
const SNAPSHOT_SILENT_STREAK = 5;

type Snapshot =
  /** `scanned`: the unit has an inventory and the scan ran (its values may still all be absent). */
  | { kind: 'complete' | 'partial'; values: Record<string, string>; scanned: boolean }
  | { kind: 'cancelled' }
  | { kind: 'lost' };

/**
 * Full-module snapshot (CarScanner backup manifests): every DID the unit's inventory lists, read best-effort
 * before the write. Bounded in time, stopped by cancellation and by a lost link, and stopped (recorded as
 * partial) when the module goes silent. The inventory is keyed by unit number only — there is no
 * variant-specific list — so DIDs a variant does not host simply refuse and are left out. The coded DID is
 * not read here: the session re-reads it right after the scan and adds that value.
 */
async function snapshotModule(
  link: CarLink,
  module: ModuleAddress,
  recipe: CodingRecipe,
  did: string,
  signal: AbortSignal,
  now: () => Date,
): Promise<Snapshot> {
  const inventory = recipe.unit ? APP_DATA.backupDids?.[recipe.unit] : undefined;
  const values: Record<string, string> = {};
  if (!inventory?.length) return { kind: 'complete', values, scanned: false };
  const started = now().getTime();
  let silent = 0;
  const scan = async (reader: CarReader): Promise<Snapshot> => {
    for (const id of new Set(inventory.filter((d) => d !== did))) {
      if (signal.aborted) return { kind: 'cancelled' };
      if (now().getTime() - started > SNAPSHOT_BUDGET_MS) return { kind: 'partial', values, scanned: true };
      const r = await reader.readDid(module, id).catch((): DidRead => ({ kind: 'link-lost' }));
      if (r.kind === 'link-lost') return { kind: 'lost' };
      if (r.kind === 'ok') values[id] = r.bytes.toUpperCase();
      silent = r.kind === 'no-reply' ? silent + 1 : 0;
      if (silent >= SNAPSHOT_SILENT_STREAK) return { kind: 'partial', values, scanned: true };
    }
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'complete', values, scanned: true };
  };
  if (signal.aborted) return { kind: 'cancelled' };
  return (link.withReads ? link.withReads(module, scan) : scan(link)).catch(
    (): Snapshot => ({ kind: 'lost' }),
  );
}

type Readiness = {
  lost: boolean;
  evidence?: {
    at: string;
    rpm: number | null;
    speedKmh: number | null;
    voltage: number | null;
    warning?: string;
  };
  /** What was outside the usual band or unreadable (absent: all usual). */
  warning?: string;
};

const usable = (v: number | null): number | null => (v === null || !Number.isFinite(v) || v < 0 ? null : v);

/**
 * Engine speed, road speed and supply voltage, read now over THIS connection and journaled with the write. They are
 * a WARNING, never a gate (owner directive 2026-11-01): the control unit itself answers NRC 0x22 / 0x93 when it
 * won't code in this state. Only a lost link stops here (nothing more can be done on it).
 */
export async function measureReadiness(link: CarLink, now: () => Date): Promise<Readiness> {
  const band = POLICY.writeReadiness;
  const r = await link.readiness().catch(() => ({ kind: 'link-lost' as const }));
  if (r.kind === 'link-lost') return { lost: true };
  const rpm = usable(r.rpm);
  const speedKmh = usable(r.speedKmh);
  const voltage = usable(r.voltage) !== null && (r.voltage as number) <= 40 ? r.voltage : null;
  const notes: string[] = [];
  // Plain words only: the measured numbers are in the `readiness` event and the journal.
  if (rpm === null) notes.push("we couldn't tell whether the engine is off");
  else if (rpm > 0) notes.push('the engine is running');
  if (speedKmh === null) notes.push("we couldn't tell whether the car is parked");
  else if (speedKmh > 0) notes.push('the car is moving');
  if (voltage === null) notes.push("we couldn't check the battery");
  else if (voltage < band.minVoltage) notes.push('the battery is low');
  else if (voltage > band.maxVoltage) notes.push('the battery charge is unusually high');
  const warning = notes.length
    ? `Car check: ${notes.join('; ')}. We continued anyway. For best results, keep the car parked with the engine off and the ignition on.`
    : undefined;
  const at = Number.isFinite(Date.parse(r.at))
    ? new Date(Date.parse(r.at)).toISOString()
    : now().toISOString();
  return {
    lost: false,
    evidence: { at, rpm, speedKmh, voltage, ...(warning ? { warning } : {}) },
    ...(warning ? { warning } : {}),
  };
}

/** The measured values as a journal event (absent when the link was lost before anything was read). */
function readinessEvent(
  ready: Readiness,
  now: () => Date,
): Extract<DistributiveOmit<CodingEvent, 'at'>, { type: 'readiness' }> | undefined {
  const e = ready.evidence;
  if (!e) return undefined;
  return {
    type: 'readiness',
    ok: !e.warning,
    rpm: e.rpm,
    speedKmh: e.speedKmh,
    voltage: e.voltage,
    measuredAt: e.at,
    ageMs: Math.max(0, now().getTime() - Date.parse(e.at)),
  };
}

/**
 * The old gate's verdict, kept for callers that show it: `ok` when everything read is in the usual band. It never
 * stops a write any more (see `measureReadiness`).
 */
export async function checkReadiness(
  link: CarLink,
  now: () => Date,
): Promise<
  { ok: true; evidence: NonNullable<Readiness['evidence']> } | { ok: false; lost: boolean; detail: string }
> {
  const m = await measureReadiness(link, now);
  if (m.lost || !m.evidence)
    return { ok: false, lost: true, detail: 'The adapter disconnected before anything was sent.' };
  if (m.warning) return { ok: false, lost: false, detail: m.warning };
  return { ok: true, evidence: m.evidence };
}

function readFailure(read: Exclude<DidRead, { kind: 'ok' }>, refuse: Refuse): CodingEvent[] {
  switch (read.kind) {
    case 'nrc':
      return refuse(
        'ecu-refused',
        "Your car wouldn't let us read this setting. Nothing was changed.",
        undefined,
        {
          code: read.code.toUpperCase(),
        },
      );
    case 'no-reply':
      return refuse('module-silent', "This part of your car didn't answer. Nothing was changed.");
    case 'link-lost':
      return refuse('module-silent', 'The adapter disconnected before anything was sent.');
  }
}

type Emit = (e: DistributiveOmit<CodingEvent, 'at'>) => CodingEvent;
/** `extra`: the car's code and the engineering detail behind a refusal (logs only, never shown). */
type Refuse = (
  reason: RefusalReason,
  detail: string,
  outcome?: Outcome,
  extra?: { code?: string; technical?: string },
) => CodingEvent[];

type Verified =
  | {
      ok: true;
      vin: string;
      fingerprint: string;
      part: string;
      warnings: { code: WarningCode; detail: string; technical?: string }[];
    }
  | { ok: false; events: CodingEvent[] };

/** What the owner is told when no VIN was read: what the car (or the adapter) actually did, and what helps. */
export function noVinMessage(ident: Extract<IdentifyResult, { kind: 'no-vin' }>): string {
  if (ident.why === 'bus-silent')
    return "The adapter is connected, but your car didn't answer. It may be asleep or still waking up. Switch the ignition on (dashboard lit, engine off), wait about a minute, then try again. Nothing was changed.";
  if (ident.why === 'no-answer')
    return "Your car didn't tell us its VIN in time. Keep the ignition on (dashboard lit, engine off), wait about a minute, then try again. Nothing was changed.";
  return "The car didn't tell us its VIN, so we can't be sure which car this is. Switch the ignition on (dashboard lit, engine off) and try again. Nothing was changed.";
}

interface Expect {
  expectedFingerprint?: string;
  expectedLabel: string;
  /** Restore/recheck: another car or another control unit refuses. Apply: they are warnings. */
  strict: boolean;
  /** The part the backup was made on (strict only; a part unreadable on either side is a warning). */
  requiredPart?: string;
}

/** Which car and control unit is this? Read-only; shared by every flow. */
async function verifyCar(
  link: CarLink,
  module: ModuleAddress,
  expect: Expect,
  emit: Emit,
  refuse: Refuse,
): Promise<Verified> {
  const inspect = (reader: CarReader) => inspectCar(reader, module, expect, emit, refuse);
  try {
    return await (link.withReads ? link.withReads(module, inspect) : inspect(link));
  } catch {
    return {
      ok: false,
      events: [
        emit({ type: 'link-lost' }),
        emit({
          type: 'outcome',
          outcome: 'not-sent',
          phase: 'The adapter disconnected before anything was sent.',
        }),
      ],
    };
  }
}

async function inspectCar(
  link: CarReader,
  module: ModuleAddress,
  expect: Expect,
  emit: Emit,
  refuse: Refuse,
): Promise<Verified> {
  const lost = (): Verified => ({
    ok: false,
    events: [
      emit({ type: 'link-lost' }),
      emit({
        type: 'outcome',
        outcome: 'not-sent',
        phase: 'The adapter disconnected before anything was sent.',
      }),
    ],
  });
  const warnings: { code: WarningCode; detail: string; technical?: string }[] = [];
  const ident = await link.identify(module);
  if (ident.kind === 'link-lost') return lost();
  // The VIN binds the backup to this car: without it a restore could never prove it is on the same car.
  if (ident.kind === 'no-vin')
    return {
      ok: false,
      events: refuse(
        'no-vin',
        noVinMessage(ident),
        undefined,
        ident.why || ident.adapter
          ? {
              technical: `${ident.why ?? 'no-vin'}${ident.adapter ? `; the adapter reported "${ident.adapter}"` : ''}`,
            }
          : {},
      ),
    };
  const fingerprint = await fingerprintVin(ident.vin);
  if (expect.expectedFingerprint && expect.expectedFingerprint !== fingerprint) {
    if (expect.strict)
      return {
        ok: false,
        events: refuse(
          'wrong-car',
          `This isn't the car this change was made on (${expect.expectedLabel}). This car's VIN is ${normalizeVin(ident.vin)}. Nothing was changed.`,
        ),
      };
    warnings.push({
      code: 'other-car',
      detail: `This car's VIN is ${normalizeVin(ident.vin)}. It isn't ${expect.expectedLabel}, so the record of this change names this car.`,
    });
  }
  const partRead = await link.readDid(module, IDENTITY_PART_DID);
  if (partRead.kind === 'link-lost') return lost();
  const read = partRead.kind === 'ok' ? asciiOf(partRead.bytes) : '';
  if (!read)
    warnings.push({
      code: 'identity',
      detail: "We couldn't identify this part of your car. It is recorded as unknown.",
      technical: `No part number (F187).${partRead.kind === 'no-reply' && partRead.adapter ? ` The adapter reported "${partRead.adapter}".` : ''}`,
    });
  const part = read || UNKNOWN_PART;
  // A backup's bytes belong to the unit they came from: restoring them onto another unit is not a restore.
  if (
    expect.strict &&
    expect.requiredPart &&
    expect.requiredPart !== UNKNOWN_PART &&
    part !== UNKNOWN_PART &&
    expect.requiredPart !== '*' &&
    expect.requiredPart !== part
  )
    return {
      ok: false,
      events: refuse(
        'unknown-module',
        'This backup was made on a different part than the one in your car now. Nothing was changed.',
        undefined,
        { technical: `Backup made on ${expect.requiredPart}, car has ${part}.` },
      ),
    };
  return { ok: true, vin: ident.vin, fingerprint, part, warnings };
}

/**
 * "Check again": a READ-ONLY follow-up for a change we could not confirm. Same car/module checks,
 * then one fresh read per written part compared with what was intended. It never writes.
 */
export async function* runRecheck(backup: BackupRecord, deps: CodingDeps): AsyncGenerator<CodingEvent, void> {
  const now = deps.now ?? (() => new Date());
  const emit: Emit = (e) => ({ ...e, at: now().toISOString() }) as CodingEvent;
  const refuse: Refuse = (reason, detail, outcome = 'not-sent', extra = {}) => [
    emit({ type: 'refused', reason, detail, ...extra }),
    emit({ type: 'outcome', outcome, phase: detail }),
  ];
  const module: ModuleAddress = { request: backup.module.request, response: backup.module.response };

  yield emit({ type: 'verify-started' });
  if (!canRecheck(backup)) {
    for (const e of refuse(
      'not-checkable',
      backup.status === 'restored'
        ? 'This change was already restored, so there is nothing to check. Nothing was read or changed.'
        : 'This change was never applied, so there is nothing to check. Nothing was read or changed.',
    ))
      yield e;
    return;
  }
  if (quarantined.has(deps.link)) {
    for (const e of refuse('link-quarantined', QUARANTINED_DETAIL)) yield e;
    return;
  }
  // Judge with the trusted recipe's mask when the record's definition can be re-established (same recipe
  // revision, module and DID); otherwise compare the exact bytes. The record's own mask never decides.
  const judge = await recheckJudge(backup, deps);
  const verified = await verifyCar(
    deps.link,
    module,
    {
      expectedFingerprint: backup.vin.fingerprint,
      expectedLabel: backup.vin.full ?? backup.vin.masked,
      strict: true,
      requiredPart: backup.module.part,
    },
    emit,
    refuse,
  );
  if (!verified.ok) {
    for (const e of verified.events) yield e;
    return;
  }
  yield emit({
    type: 'car-verified',
    vin: normalizeVin(verified.vin),
    vinMasked: maskVin(verified.vin),
    part: verified.part,
  });
  for (const w of verified.warnings) yield emit({ type: 'warning', ...w });
  yield emit({ type: 'check-started' });
  if (backup.steps?.length) {
    yield* recheckGroup(backup, deps, emit);
    return;
  }

  const r = await deps.link.readDid(module, backup.did);
  const stamp = () => now().toISOString();
  if (r.kind !== 'ok') {
    if (r.kind === 'link-lost') yield emit({ type: 'link-lost' });
    yield emit({
      type: 'outcome',
      outcome: 'pending-uncertain',
      phase: "We couldn't check the setting.",
    });
    return;
  }
  const observed = r.bytes.toUpperCase();
  const readbackAt = stamp();
  const verdict: ReadbackComparison =
    judge.kind === 'trusted'
      ? compareReadback(
          {
            after: backup.intended,
            owned: judge.owned,
            known: knownReadbacksFor({
              recipeId: judge.recipe.id,
              recipeDigest: backup.recipeDigest ?? '',
              module,
              part: verified.part,
              did: backup.did,
              intended: backup.intended,
            }),
          },
          observed,
        )
      : observed === backup.intended
        ? { kind: 'exact' }
        : { kind: 'mismatch' };
  const matches = verdict.kind !== 'mismatch';
  const moduleManaged = verdict.kind === 'owned-match' ? verdict.moduleManaged : [];
  yield emit({ type: 'readback', observed, matches, ...(moduleManaged.length ? { moduleManaged } : {}) });
  try {
    // A later read can confirm the value; it can never supply the ACK the write did not get.
    await deps.backups.update(backup.id, {
      status: matches ? 'verified' : 'unconfirmed',
      outcome: matches ? 'observed-match' : 'mismatch',
      updatedAt: readbackAt,
      observed,
      readbackAt,
      ...(moduleManaged.length ? { moduleManaged } : {}),
    });
    // A confirmed restore resolves the change it undid, as a live restore does.
    if (matches && backup.operation === 'restore' && backup.restoreOf)
      await deps.backups.update(backup.restoreOf, {
        status: 'restored',
        restoredBy: backup.id,
        updatedAt: readbackAt,
      });
  } catch {
    // Non-fatal for the (read-only) result, but never silent.
    yield emit({
      type: 'audit-failed',
      backupId: backup.id,
      detail: "We couldn't save this check to your backups.",
    });
  }
  yield emit(
    matches
      ? {
          type: 'outcome',
          outcome: 'observed-match',
          phase: `We checked again and the setting is in place.${moduleNote(moduleManaged)}`,
        }
      : {
          type: 'outcome',
          outcome: 'mismatch',
          phase: mismatchPhase(verdict.kind === 'mismatch' ? (verdict.unexplained ?? []) : []),
        },
  );
}

/**
 * Recheck of a multi-part record: every part that may have landed is read on its own module and judged on the
 * trusted step recipe's mask (when the group definition is unchanged), else on its exact bytes.
 */
async function* recheckGroup(
  backup: BackupRecord,
  deps: CodingDeps,
  emit: Emit,
): AsyncGenerator<CodingEvent, void> {
  const now = deps.now ?? (() => new Date());
  const recipe = (deps.recipeFor ?? defaultRecipeFor)(backup.recipeId);
  const sameDefinition = !!recipe && (await digestAccepted(recipe, backup.recipeDigest));
  const steps =
    sameDefinition && recipe
      ? (() => {
          try {
            return groupStepsOf(recipe);
          } catch {
            return [];
          }
        })()
      : [];
  let journal = [...(backup.steps ?? [])];
  let all = true;
  let unreadable = false;
  const landed = journal.filter((s) => LANDED.includes(s.status));
  /** Each (module, DID) is read once: parts that share a DID are judged on the same fresh read. */
  const reads = new Map<string, string>();
  const keyOf = (e: GroupStepEntry) => `${e.module.request}:${e.module.response}:${e.did.toUpperCase()}`;
  const ownedOf = (e: GroupStepEntry): number[] | undefined => {
    const step = steps[e.index];
    if (!step) return undefined;
    const t = trustedMaskFor(step, e, e.variant !== undefined ? { index: e.variant } : undefined);
    return t.ok ? t.owned : undefined;
  };
  for (const [position, entry] of landed.entries()) {
    const module = { request: entry.module.request, response: entry.module.response };
    const key = keyOf(entry);
    let observed = reads.get(key);
    if (observed === undefined) {
      const r = await deps.link.readDid(module, entry.did).catch((): DidRead => ({ kind: 'link-lost' }));
      if (r.kind !== 'ok') {
        if (r.kind === 'link-lost') yield emit({ type: 'link-lost' });
        unreadable = true;
        break;
      }
      observed = r.bytes.toUpperCase();
      reads.set(key, observed);
    }
    const owned = ownedOf(entry);
    // A later part on the same DID was planned on top of this part's bytes, so the block now holds ITS
    // intended bytes: this part is judged only on the bits it owns that no later part rewrites.
    const later = landed.slice(position + 1).filter((e) => keyOf(e) === key);
    let matches: boolean;
    if (!later.length) {
      matches = owned
        ? compareReadback({ after: entry.intended, owned }, observed).kind !== 'mismatch'
        : observed === entry.intended;
    } else {
      const mine = owned
        ? owned.map((m, i) => later.reduce((acc, e) => acc & ~(ownedOf(e)?.[i] ?? 0xff), m))
        : undefined;
      matches = mine
        ? bitsMatch(entry.intended, observed, mine)
        : observed === (later.at(-1) as GroupStepEntry).intended;
    }
    all &&= matches;
    const at = now().toISOString();
    journal = journal.map((s) =>
      s.index === entry.index
        ? {
            ...s,
            status: matches ? ('verified' as const) : ('unconfirmed' as const),
            observed,
            readbackAt: at,
          }
        : s,
    );
    yield emit({ type: 'readback', observed, matches });
  }
  if (unreadable) {
    yield emit({
      type: 'outcome',
      outcome: 'pending-uncertain',
      phase: "We couldn't check every part of this setting.",
    });
    return;
  }
  const at = now().toISOString();
  try {
    await deps.backups.update(backup.id, {
      status: all ? 'verified' : 'unconfirmed',
      outcome: all ? 'observed-match' : 'mismatch',
      updatedAt: at,
      steps: journal,
    });
    if (all && backup.operation === 'restore' && backup.restoreOf)
      await deps.backups.update(backup.restoreOf, {
        status: 'restored',
        restoredBy: backup.id,
        updatedAt: at,
      });
  } catch {
    yield emit({
      type: 'audit-failed',
      backupId: backup.id,
      detail: "We couldn't save this check to your backups.",
    });
  }
  yield emit({
    type: 'outcome',
    outcome: all ? 'observed-match' : 'mismatch',
    phase: all
      ? 'We checked again and every part of the setting is in place.'
      : "At least one part of the setting isn't what we sent.",
  });
}

/**
 * A record can be rechecked while its outcome is open or confirmed. A refused change never reached the
 * car, and a restored one was deliberately put back: checking them against `intended` would rewrite a
 * settled record as a mismatch. A multi-part record that stopped part-way is still checkable.
 */
export const canRecheck = (backup: Pick<BackupRecord, 'status'>): boolean =>
  backup.status === 'prepared' || backup.status === 'unconfirmed' || backup.status === 'verified';

/** The ODX dataset name a unit reports — the key a recipe variant is settled against. */
const IDENTITY_ODX_DID = 'F19E';
/** Upper bound on an inspect scan: a dedicated run gets real time, unlike the write-path snapshot. */
export const INSPECT_BUDGET_MS = 8 * 60_000;
/** Consecutive unanswered reads that end an inspect scan early (the unit went quiet — partial map). */
const INSPECT_SILENT_STREAK = 8;
/**
 * Adapter re-establishments a read-only scan may take. Nothing here can mutate the car, so each
 * relink is honest — but repeated drops mean a real problem, not more retries.
 */
const INSPECT_RELINK_MAX = 3;
/**
 * Full-pass reruns a coding session may take after a drop where the event stream proves nothing
 * mutation-capable left for the car (no request-sent, no acknowledgement, no mutating steps).
 * Beyond it the link is declared lost for this run and the outcome stands.
 */
const RERUN_MAX = 2;

/**
 * Read-only module inventory: identify the car and unit (recorded, never gated — an unknown unit is
 * the reason to scan), then walk the unit's backup manifest best-effort. Every identifier lands in
 * one of three classes in the `module-scan` event: answered (bytes kept), refused (the unit answered
 * with a negative response — the DID is not hosted there), silent (no answer at all). Nothing is
 * written; readiness is not a gate for reads.
 */
export async function* runInspect(
  req: Extract<CodingRequest, { kind: 'inspect' }>,
  deps: CodingDeps,
): AsyncGenerator<CodingEvent, void> {
  const now = deps.now ?? (() => new Date());
  const emit = (e: DistributiveOmit<CodingEvent, 'at'>): CodingEvent => {
    const event = { ...e, at: now().toISOString() } as CodingEvent;
    feedCodingEvent(event);
    return event;
  };
  // 'all' is the full car scan: every known unit address probed, every fitted unit's read plan, the car map.
  if (req.unit === 'all') {
    if (quarantined.has(deps.link)) {
      yield emit({ type: 'verify-started' });
      yield emit({ type: 'refused', reason: 'link-quarantined', detail: QUARANTINED_DETAIL });
      yield emit({ type: 'outcome', outcome: 'not-sent', phase: QUARANTINED_DETAIL });
      return;
    }
    yield* runFullScan(req, deps);
    return;
  }
  let link = deps.link;
  const { signal } = deps;
  const units = [req.unit];
  const planned = units
    .map((u) => {
      const module = SCAN_TARGETS[u]?.module;
      const manifest = [...new Set(APP_DATA.backupDids?.[u] ?? [])];
      // Recipe identifiers probe first (even ones missing from the manifest) — a scan that dies
      // early still resolves the unit's features; the manifest tail fills the rest of the window.
      const priority = new Set(featureDids(u, module?.request ?? ''));
      const inventory = [...[...priority].sort(), ...manifest.filter((d) => !priority.has(d))];
      return module && inventory.length ? { unit: u, module, inventory } : undefined;
    })
    .filter((p) => p !== undefined);
  yield emit({ type: 'verify-started' });
  if (quarantined.has(link)) {
    yield emit({
      type: 'refused',
      reason: 'link-quarantined',
      detail: QUARANTINED_DETAIL,
    });
    yield emit({ type: 'outcome', outcome: 'not-sent', phase: QUARANTINED_DETAIL });
    return;
  }
  const first = planned[0];
  if (!first) {
    const detail = "We can't read this part of your car yet, so there is nothing to read.";
    yield emit({ type: 'refused', reason: 'invalid-plan', detail });
    yield emit({ type: 'outcome', outcome: 'not-sent', phase: detail });
    return;
  }

  // A read-only scan may re-establish a dropped adapter and carry on: nothing here can mutate
  // the car, so a relink + resume is always honest. Bounded — repeated drops mean a real problem.
  let relinks = 0;
  const relinkOnce = async (): Promise<boolean> => {
    if (!deps.relink || relinks >= INSPECT_RELINK_MAX) return false;
    const next = await deps.relink();
    if (!next) return false;
    relinks += 1;
    link = next;
    deps.audit?.relink?.(next);
    return true;
  };

  // ---- identify: recorded, never gated ----------------------------------------------------
  let ident: IdentifyResult;
  let partRead: DidRead = { kind: 'link-lost' };
  for (;;) {
    ident = await link.identify(first.module).catch((): IdentifyResult => ({ kind: 'link-lost' }));
    if (ident.kind === 'link-lost' && (await relinkOnce())) {
      yield emit({ type: 'relink', attempt: relinks });
      continue;
    }
    if (ident.kind === 'link-lost') break;
    partRead = await link
      .readDid(first.module, IDENTITY_PART_DID)
      .catch((): DidRead => ({ kind: 'link-lost' }));
    if (partRead.kind !== 'link-lost' || !(await relinkOnce())) break;
    yield emit({ type: 'relink', attempt: relinks });
  }
  if (ident.kind === 'link-lost' || partRead.kind === 'link-lost') {
    yield emit({ type: 'link-lost' });
    yield emit({
      type: 'outcome',
      outcome: 'not-sent',
      phase: 'The adapter disconnected before anything was sent.',
    });
    return;
  }
  const vinMasked = ident.kind === 'ok' ? maskVin(ident.vin) : 'unidentified';
  const part = partRead.kind === 'ok' ? asciiOf(partRead.bytes) : '';
  yield emit({
    type: 'car-verified',
    ...(ident.kind === 'ok' ? { vin: normalizeVin(ident.vin) } : {}),
    vinMasked,
    part,
  });

  // ---- scan each unit's identifier list ----------------------------------------------------
  yield emit({ type: 'check-started' });
  type ScanState = 'complete' | 'partial' | 'cancelled' | 'lost';
  interface UnitScan {
    state: ScanState;
    /** Inventory still to probe: the whole list first, then (one bounded pass) every silent DID. */
    queue: string[];
    /** Position in `queue` — a DID the link died on is re-read, never skipped. */
    cursor: number;
    /** 'main' walks the inventory; 'retry' re-reads whatever went quiet, once. */
    stage: 'main' | 'retry';
    answered: Record<string, string>;
    refused: Record<string, string>;
    silent: string[];
    part: string;
    odx?: string;
  }
  /**
   * Continues `s` as far as the current link allows. A 'lost' result leaves `cursor` on the DID
   * that was being read — relinking and calling again resumes the scan, never restarts it.
   */
  const advanceUnit = async (
    target: (typeof planned)[number],
    s: UnitScan,
    started: number,
  ): Promise<ScanState> => {
    const scan = async (reader: CarReader): Promise<ScanState> => {
      let silentStreak = 0;
      for (;;) {
        for (; s.cursor < s.queue.length; s.cursor++) {
          if (signal.aborted) return 'cancelled';
          if (now().getTime() - started > INSPECT_BUDGET_MS) return 'partial';
          const did = s.queue[s.cursor];
          if (did === undefined) break;
          const r = await reader.readDid(target.module, did).catch((): DidRead => ({ kind: 'link-lost' }));
          if (r.kind === 'link-lost') return 'lost';
          if (r.kind === 'ok') s.answered[did] = r.bytes.toUpperCase();
          else if (r.kind === 'nrc') s.refused[did] = r.code;
          else s.silent.push(did);
          silentStreak = r.kind === 'no-reply' ? silentStreak + 1 : 0;
          if (silentStreak >= INSPECT_SILENT_STREAK) {
            s.cursor += 1;
            return 'partial';
          }
        }
        // First pass done: one bounded re-read of everything that went quiet — adapter timing
        // races make real identifiers look silent; a DID silent twice is honestly silent.
        if (s.stage === 'main' && s.silent.length) {
          s.queue = [...s.silent];
          s.silent = [];
          s.cursor = 0;
          s.stage = 'retry';
          silentStreak = 0;
          continue;
        }
        return signal.aborted ? 'cancelled' : 'complete';
      }
    };
    const state: ScanState = signal.aborted
      ? 'cancelled'
      : await (link.withReads ? link.withReads(target.module, scan) : scan(link)).catch(
          (): ScanState => 'lost',
        );
    if (state === 'lost' || state === 'cancelled') return state;
    // Per-unit identity is best-effort — an unknown unit is the reason to scan, never a gate.
    // A dead link or an abort skips these reads entirely: there is no one left to ask.
    const odxRead = await link
      .readDid(target.module, IDENTITY_ODX_DID)
      .catch((): DidRead => ({ kind: 'no-reply' }));
    s.odx = odxRead.kind === 'ok' ? asciiOf(odxRead.bytes) : s.odx;
    s.part = part;
    return state;
  };

  let found = 0;
  let listed = 0;
  let stopped: 'cancelled' | 'lost' | undefined;
  let incomplete = false;
  for (const target of planned) {
    if (signal.aborted) {
      stopped = 'cancelled';
      break;
    }
    const s: UnitScan = {
      state: 'complete',
      queue: [...target.inventory],
      cursor: 0,
      stage: 'main',
      answered: {},
      refused: {},
      silent: [],
      part: '',
    };
    // Bounded relinks for the unit; the unit's budget caps total runtime regardless.
    relinks = 0;
    const started = now().getTime();
    for (;;) {
      s.state = await advanceUnit(target, s, started);
      if (s.state === 'lost' && (await relinkOnce())) {
        yield emit({ type: 'relink', attempt: relinks });
        continue;
      }
      break;
    }
    found += Object.keys(s.answered).length;
    listed += target.inventory.length;
    yield emit({
      type: 'module-scan',
      unit: target.unit,
      part: s.part,
      ...(s.odx ? { odx: s.odx } : {}),
      answered: s.answered,
      refused: s.refused,
      silent: s.silent,
      complete: s.state === 'complete',
    });
    // What the map says about every recipe on this unit — decoded only where a field spec exists.
    // Silent and never-reached DIDs are "unprobed", so absence is never reported as "not hosted".
    const unresolved = new Set([...s.silent, ...s.queue.slice(s.cursor)]);
    yield emit({
      type: 'feature-report',
      unit: target.unit,
      entries: reportFeatures(target.unit, target.module.request, s.answered, unresolved),
    });
    if (s.state === 'cancelled' || s.state === 'lost') {
      stopped = s.state;
      break;
    }
    if (s.state === 'partial') incomplete = true;
  }
  if (stopped === 'lost') {
    yield emit({ type: 'link-lost' });
    yield emit({
      type: 'outcome',
      outcome: 'pending-uncertain',
      phase: 'The adapter disconnected during the scan. What we read so far is saved.',
    });
    return;
  }
  if (stopped === 'cancelled') {
    yield emit({ type: 'outcome', outcome: 'cancelled', phase: 'Scan cancelled.' });
    return;
  }
  if (incomplete) {
    yield emit({
      type: 'outcome',
      outcome: 'pending-uncertain',
      phase: 'The scan stopped early. What we read so far is saved.',
    });
    return;
  }
  yield emit({
    type: 'readback',
    observed: `${found} settings read`,
    matches: found > 0,
  });
  yield emit({
    type: 'outcome',
    outcome: 'verified',
    phase: `Read ${found} of ${listed} settings on this part of your car.`,
  });
}

/**
 * Events after which a run is never replayed: anything that could have changed the car or spent the module's
 * security budget — the data request (sent, pending, acknowledged), SecurityAccess, a coding marker (any
 * outcome: it was sent), a declared sequence's mutating steps, or a part of a multi-part change.
 */
export function mutationCapable(e: CodingEvent): boolean {
  switch (e.type) {
    case 'request-sent':
    case 'response-pending':
    case 'write-acked':
    case 'security-access':
    case 'group-step':
      return true;
    case 'markers':
      return e.markers.length > 0;
    case 'sequence':
      return e.steps.length > 0 || !!e.incomplete;
    default:
      return false;
  }
}

/**
 * Single entry point: routes a request to the flow that handles it.
 *
 * A coding run that ends with the stream proving nothing mutation-capable ever left (no data request, no
 * acknowledgement, no SecurityAccess, no coding marker, no sequence step) may be re-run on a re-established
 * adapter — a dead adapter is the common case for "stopped answering" and a bounded full pass is safer than
 * making the owner retry by hand. Once SecurityAccess or a marker went out the run is never replayed: a
 * replay would spend another seed/key exchange (lock-out risk) or repeat a persistent write; and nothing is
 * ever re-sent after an acknowledgement. The final outcome event is held while a rerun is still possible.
 */
export async function* runSession(req: CodingRequest, deps: CodingDeps): AsyncGenerator<CodingEvent, void> {
  if (req.kind === 'recheck') {
    yield* runRecheck(req.backup, deps);
    return;
  }
  if (req.kind === 'inspect') {
    yield* runInspect(req, deps);
    return;
  }
  const stamp = () => (deps.now ?? (() => new Date()))().toISOString();
  let link = deps.link;
  for (let attempt = 0; ; attempt++) {
    let held: Extract<CodingEvent, { type: 'outcome' }> | undefined;
    let lost = false;
    let mutation = false;
    /** A pre-payload stop (module silence, a refused preparation step) — retried only if nothing mutating left. */
    let stoppedEarly = false;
    for await (const e of runCoding(req, { ...deps, link })) {
      if (mutationCapable(e)) mutation = true;
      else if (e.type === 'link-lost') lost = true;
      else if (e.type === 'refused' && (e.reason === 'ecu-refused' || e.reason === 'module-silent'))
        stoppedEarly = true;
      if (e.type === 'outcome') {
        held = e;
        continue;
      }
      yield e;
    }
    const retryable =
      !mutation &&
      ((held?.outcome === 'not-sent' && (lost || stoppedEarly)) ||
        (held?.outcome === 'pending-uncertain' && lost));
    if (!retryable || attempt >= RERUN_MAX || !deps.relink) {
      if (held) yield held;
      return;
    }
    const next = await deps.relink();
    if (!next) {
      if (held) yield held;
      return;
    }
    link = next;
    deps.audit?.relink?.(next);
    yield { at: stamp(), type: 'relink', attempt: attempt + 1 };
  }
}
