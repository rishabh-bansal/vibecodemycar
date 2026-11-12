import {
  type BitOp,
  type CodingBlock,
  ownedMaskOps,
  patchCodingBlock,
  patchOpsBlock,
  patchScalarBlock,
} from '@obdcraft/coding/blocks';
import type { BackupRecord } from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { provenPartsOf } from '../../domain/catalog/features.ts';
import type { Recipe } from '../../domain/catalog/schema.ts';
import type { FeatureItem } from '../../domain/catalog/types.ts';
import {
  crc32Trailer,
  freeValueOf,
  groupStepsOf,
  isGroupRecipe,
  moduleOf,
  type Resolved,
  resolveRecipe,
  scalarRange,
  type VariantPick,
} from '../../domain/coding/plan.ts';
import type { CodingRecipe } from '../../domain/coding/types.ts';
import { selectVariant, variantRule } from '../../domain/coding/variant-select.ts';
import { type SimOptions, SimulatedCar } from './simulator.ts';

const DEMO_BANNER = 'DEMO · simulated car — nothing is sent to a vehicle';
const DEFAULT_BLOCK_BYTES = 5;

/** Demo pacing. Tests set these to 0; the app shows a believable "car is saving…" wait. */
export const demoTimings = { latencyMs: 350, pendingMs: 2800, restorePendingMs: 2000 };

/**
 * A block holding a value *other* than the one the user is about to pick, so the demo has something to change.
 * Built per recipe kind, with the real encoders — never by hand-placing bits:
 *  - field: the field's encoder (a synthetic zero choice makes an all-zero block legal to patch);
 *  - scalar: the scalar's encoder at the recipe's read length, with a valid CRC-32 trailer when it has one;
 *  - dataset: another of the recipe's own presets (or, with only one, a block of the same length).
 */
export function seedBlock(recipe: Recipe, avoidSettingId: string, minBytes = DEFAULT_BLOCK_BYTES): string {
  const resolved = resolveRecipe(recipe);
  if (resolved.dataset) {
    const other = resolved.choices.find((c) => c.id !== avoidSettingId && c.payload)?.payload;
    const length = (resolved.choices.find((c) => c.payload)?.payload?.length ?? 2) / 2;
    return other ?? 'FF'.repeat(length);
  }
  if (resolved.scalar) {
    // The value the user is about to pick: a preset, or a free `value:<n>`.
    const chosen =
      freeValueOf(avoidSettingId) ?? resolved.choices.find((c) => c.id === avoidSettingId)?.value;
    const range = scalarRange(resolved.scalar);
    // A value the user did not pick: another preset, else a range end, else one step off the chosen value.
    const value =
      resolved.choices.find((c) => c.id !== avoidSettingId && c.value !== chosen)?.value ??
      [range.min, range.max].find((v) => v !== chosen) ??
      (chosen ?? 0) + range.step;
    const trailer = recipe.checksum === 'crc32-trailer' ? 4 : 0;
    const total = Math.max(
      recipe.readBytes ?? 0,
      resolved.scalar.byteOffset + resolved.scalar.dataLength + trailer,
      minBytes,
    );
    const payloadBytes = total - trailer;
    const { after } = patchScalarBlock(
      '00'.repeat(payloadBytes),
      { length: payloadBytes, scalar: { ...resolved.scalar } },
      value,
    );
    return trailer ? `${after}${crc32Trailer(after)}` : after;
  }
  const f = resolved.field;
  if (!f) throw new Error('This recipe has no field, scalar or dataset to simulate.');
  // Long enough for the field and every constant write, whatever the recipe's offsets.
  const bytes = Math.max(
    minBytes,
    f.byteOffset + Math.ceil((f.bitOffset + f.bitLength) / 8),
    ...resolved.auxWrites.map((a) => a.byteOffset + 1),
  );
  const choices = resolved.choices.map((c) => ({ id: c.id, label: c.label, value: c.value }));
  if (!choices.some((c) => c.value === 0)) choices.push({ id: '__zero', label: 'zero', value: 0 });
  const block: CodingBlock = {
    length: bytes,
    field: { ...f, choices },
    auxWrites: resolved.auxWrites.map((a) => ({ ...a, bitLength: a.bitLength === 8 ? 8 : 1 })),
  };
  const pick = choices.find((c) => c.id !== avoidSettingId && c.id !== '__zero') ?? choices[0];
  if (!pick) throw new Error('recipe has no choices');
  return patchCodingBlock('00'.repeat(bytes), block, pick.id).after;
}

export interface DemoOptions {
  latencyMs?: number;
  pendingMs?: number;
  sleep?: SimOptions['sleep'];
}

const asciiHex = (text: string): string =>
  [...text].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

/** What the simulated car hosts: DID contents keyed `${request}:${did}` and an F187 part per module. */
interface DemoState {
  values: Record<string, string>;
  parts: Record<string, string>;
}

/** A part number the variant's device pattern accepts (`*` dropped, `?` filled). */
const partFor = (pattern: string): string =>
  pattern.replace(/\*/g, '').replace(/\?/g, '0').trim() || 'DEMO-0001';

/** Bytes an ops recipe's choices touch, rounded up to whole bytes (validated by the encoder itself). */
function opsLength(choices: readonly { ops?: readonly BitOp[] }[], minBytes: number): number {
  const lists = choices.map((c) => [...(c.ops ?? [])]);
  const need = Math.max(minBytes, ...lists.flat().map((op) => op.byte + Math.ceil((op.bit + op.len) / 8)));
  for (let length = need; length < need + 8; length++) {
    try {
      ownedMaskOps(length, lists);
      return length;
    } catch {
      // a span that crosses bytes needs a longer block
    }
  }
  return need;
}

/**
 * An ops block where the chosen option does not hold yet: the option applied, then every bit it touches
 * flipped — so each of its operations reads a different value, and the demo has a change to make.
 */
function seedOpsBlock(
  resolved: Resolved,
  settingId: string,
  isMib3: boolean,
  base: string,
  minBytes: number,
): string {
  const usable = resolved.choices.filter((c) => c.when?.mib3 === undefined || c.when.mib3 === isMib3);
  const tests = (c: (typeof usable)[number]) => c.when?.bytes ?? [];
  const length = opsLength(
    [
      ...resolved.choices,
      ...resolved.choices.map((c) => ({ ops: tests(c).map((t) => ({ ...t, value: 0 })) })),
    ],
    minBytes,
  );
  const block = base.repeat(length);
  const chosen = usable.find((c) => c.id === settingId) ?? usable[0];
  const ops = [...(chosen?.ops ?? [])];
  if (!ops.length) return block;
  const applied = patchOpsBlock(block, ops).after;
  const mask = ownedMaskOps(length, [ops]);
  const flipped = (applied.match(/../g) ?? [])
    .map((b, i) => (Number.parseInt(b, 16) ^ (mask[i] ?? 0)).toString(16).toUpperCase().padStart(2, '0'))
    .join('');
  // A choice that only applies to some current contents (`when.bytes`): the block holds an accepted value,
  // preferably one the choice changes.
  const conditions = chosen ? tests(chosen) : [];
  if (!conditions.length) return flipped;
  const writes = (t: { byte: number; bit: number; len: number }) =>
    ops.find((o) => o.byte === t.byte && o.bit === t.bit && o.len === t.len)?.value;
  return patchOpsBlock(
    flipped,
    conditions.map((t) => ({
      byte: t.byte,
      bit: t.bit,
      len: t.len,
      value: t.in.find((v) => v !== writes(t)) ?? (t.in[0] as number),
    })),
  ).after;
}

/** A seeded block for one single-DID recipe (or the picked variant of an alt), holding another value. */
function seedTarget(
  recipe: CodingRecipe,
  settingId: string,
  pick: VariantPick | undefined,
  base: string,
  minBytes = DEFAULT_BLOCK_BYTES,
): string {
  const resolved = resolveRecipe(recipe, pick);
  if (resolved.encoding === 'ops')
    return seedOpsBlock(resolved, settingId, pick?.isMib3 === true, base, minBytes);
  if (!recipe.variants?.length) return seedBlock(recipe as Recipe, settingId, minBytes);
  // A field / scalar / dataset variant: seed it as if it were the whole recipe.
  const variant = recipe.variants[resolved.variantIndex ?? 0];
  const flat = { ...recipe, ...variant, variants: undefined, kind: resolved.encoding } as unknown as Recipe;
  return seedBlock(flat, settingId, minBytes);
}

/**
 * Seeds one target recipe into the simulated car. For an alt recipe the first variant the car can be made to
 * select is used: the probes the session makes (variant DIDs, the BCM's 0600, F19E, F187) are arranged so
 * `selectVariant` lands on it, exactly as it would on a real car.
 */
function seedRecipe(state: DemoState, recipe: CodingRecipe, settingId: string, part: string): void {
  const module = moduleOf(recipe);
  const key = (did: string, m = module) => `${m.request}:${did.toUpperCase()}`;
  state.parts[module.request] ??= part;
  const mib3Dependent = [recipe, ...(recipe.variants ?? [])].some((r) =>
    r.choices?.some((c) => c.when?.mib3 !== undefined),
  );
  const variants = recipe.variants ?? [];
  if (!variants.length) {
    if (mib3Dependent) state.values[key('F19E')] ??= asciiHex('EV_MUSMAMQB');
    state.values[key(resolveRecipe(recipe).did)] ??= seedTarget(recipe, settingId, { isMib3: false }, '00');
    return;
  }
  for (const [index, variant] of variants.entries()) {
    const rule = variantRule(variant);
    const isMib3 = rule.kind === 'mib' ? rule.wantsMib3 : false;
    const did = variant.did.toUpperCase();
    // An old-generation BCM shows a populated 0600; a new one leaves it unhosted (or zero).
    const oldBcm = rule.kind === 'unit09' && !rule.wantsNew;
    const base = oldBcm && did === UNIT09_CODING_DID ? 'A5' : '00';
    let bytes: string;
    try {
      bytes = seedTarget(recipe, settingId, { index, isMib3 }, base);
    } catch {
      continue;
    }
    const devicePart = rule.kind === 'device' ? partFor(rule.pattern) : state.parts[module.request];
    const read0600 = oldBcm ? (did === UNIT09_CODING_DID ? bytes : 'A5'.repeat(8)) : undefined;
    const probe = {
      reads: { [did]: bytes },
      ...(read0600 ? { read0600Unit09: read0600 } : {}),
      isMib3,
      ...(devicePart ? { part: devicePart } : {}),
    };
    const chosen = selectVariant(recipe, probe);
    if (!chosen.ok || chosen.index !== index) continue;
    if (rule.kind === 'device') state.parts[module.request] = devicePart as string;
    if (read0600) state.values[`${UNIT09_MODULE.request}:${UNIT09_CODING_DID}`] ??= read0600;
    state.values[key('F19E')] ??= asciiHex(isMib3 ? 'EV_MUOIMQB' : 'EV_MUSMAMQB');
    state.values[key(did)] ??= bytes;
    return;
  }
  throw new Error('This feature has no control-unit version the demo can simulate.');
}

const UNIT09_CODING_DID = '0600';
const UNIT09_MODULE = { request: '70E' } as const;

/**
 * A simulated car holding the module and value this feature would act on. With live proof on this car
 * it presents that module's part number and the proven "before" value of the recipe's byte (the rest of
 * the block is not in the proof, so it is zero). A recipe proven elsewhere presents a proven part, so
 * the demo passes the same module check a real write would (F43). Every recipe kind is simulated: an alt
 * recipe's probes are arranged to select a real variant, and a multi-part change hosts each part's DID.
 */
export function createDemoCar(feature: FeatureItem, settingId: string, opts: DemoOptions = {}): SimulatedCar {
  const recipe = feature.recipeId ? APP_DATA.recipes[feature.recipeId] : undefined;
  if (!recipe) throw new Error('This feature has nothing to simulate.');
  const coding = recipe as CodingRecipe;
  const state: DemoState = { values: {}, parts: {} };
  const part = provenPartsOf(recipe.id)[0] ?? 'DEMO-0001';

  if (feature.proof && !isGroupRecipe(coding) && !coding.variants?.length) {
    const module = moduleOf(coding);
    const { did } = resolveRecipe(coding);
    const length = Math.max(1, feature.proof.readback.length / 2, feature.proof.recipe.byte + 1);
    const bytes = Array.from({ length }, () => '00');
    bytes[feature.proof.recipe.byte] = feature.proof.recipe.from;
    state.parts[module.request] = feature.proof.module.part;
    state.values[`${module.request}:${did}`] = bytes.join('');
  } else if (isGroupRecipe(coding)) {
    for (const step of groupStepsOf(coding)) {
      const ids = [...new Set((step.choices ?? step.variants?.[0]?.choices ?? []).map((c) => c.id))];
      const stepSetting = ids.includes(settingId) ? settingId : (ids[0] ?? settingId);
      seedRecipe(state, step, stepSetting, part);
    }
  } else {
    seedRecipe(state, coding, settingId, part);
  }

  return new SimulatedCar({
    parts: state.parts,
    values: state.values,
    write: { kind: 'ack-after-pending' },
    latencyMs: opts.latencyMs ?? demoTimings.latencyMs,
    pendingMs: opts.pendingMs ?? demoTimings.pendingMs,
    sleep: opts.sleep,
    banner: DEMO_BANNER,
  });
}

/**
 * A simulated car holding the value a backed-up change left behind, for restoring in demo mode. A multi-part
 * change hosts every part's DID, each holding what that part's write left there.
 */
export function createDemoCarFromBackup(backup: BackupRecord, opts: DemoOptions = {}): SimulatedCar {
  const parts: Record<string, string> = { [backup.module.request]: backup.module.part };
  const values: Record<string, string> = { [`${backup.module.request}:${backup.did}`]: backup.intended };
  for (const step of backup.steps ?? []) {
    parts[step.module.request] ??= step.module.part;
    values[`${step.module.request}:${step.did}`] = step.action === 'restore' ? step.before : step.intended;
  }
  return new SimulatedCar({
    parts,
    values,
    write: { kind: 'ack-after-pending' },
    latencyMs: opts.latencyMs ?? demoTimings.latencyMs,
    pendingMs: opts.pendingMs ?? demoTimings.restorePendingMs,
    sleep: opts.sleep,
    banner: DEMO_BANNER,
  });
}
