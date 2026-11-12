import {
  type BitOp,
  type ByteChange,
  type CodingBlock,
  opsHold,
  ownedMask,
  ownedMaskOps,
  patchCodingBlock,
  patchOpsBlock,
  patchScalarBlock,
  validateCodingBlock,
} from '@obdcraft/coding/blocks';
import type { ModuleManagedChange } from '../backups/schema.ts';
import type {
  CodingRecipe,
  ModuleAddress,
  RecipeAuxWriteSpec,
  RecipeBitOp,
  RecipeChoiceSpec,
  RecipeFieldSpec,
  RecipeScalarSpec,
  RecipeSequenceSpec,
  RecipeVariantSpec,
} from './types.ts';

export type PlanErrorCode =
  | 'unsupported-recipe'
  | 'variant-unsettled'
  | 'unknown-setting'
  | 'bad-definition'
  | 'unexpected-current-value'
  | 'not-restorable';

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, message: string) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
  }
}

/** How a single-DID recipe is encoded once any variant is settled. */
export type Encoding = 'field' | 'scalar' | 'ops' | 'dataset';

/**
 * Which variant of an `alt` recipe to use, and the facts a choice may depend on.
 *  - `index`   position in `variants` (what `selectVariant` returns and what a backup records)
 *  - `selector` the variant's selector (must then be unique)
 *  - `isMib3`  infotainment generation, for ops choices with `when.mib3`
 * A bare string is a selector (the older call form).
 */
export type VariantPick = { index?: number; selector?: string; isMib3?: boolean };
type PickArg = string | VariantPick | undefined;

const asPick = (p: PickArg): VariantPick => (typeof p === 'string' ? { selector: p } : (p ?? {}));

/** A choice with its wire value normalised to a number (0 where the kind does not use one). */
export type ResolvedChoice = RecipeChoiceSpec & { value: number };

/** The recipe's concrete write target once any variant is settled. */
export interface Resolved {
  encoding: Encoding;
  did: string;
  password: string | null;
  /** `unit-default`: the password is the unit's usual code, backfilled because the recipe named none. */
  passwordSource?: 'recipe' | 'unit-default';
  /** The variant used (index into `variants`), for alt recipes. */
  variantIndex?: number;
  field?: RecipeFieldSpec;
  scalar?: RecipeScalarSpec;
  choices: ResolvedChoice[];
  auxWrites: RecipeAuxWriteSpec[];
  /** True for dataset recipes (kept for callers that predate `encoding`). */
  dataset?: boolean;
  sequence?: RecipeSequenceSpec;
  checksum?: 'crc32-trailer';
  readBytes?: number;
}

const ENCODINGS: readonly string[] = ['field', 'scalar', 'ops', 'dataset'];

function encodingOf(source: RecipeVariantSpec | CodingRecipe, recipe: CodingRecipe): Encoding {
  const own = source.kind;
  if (own && ENCODINGS.includes(own)) return own as Encoding;
  if (source !== recipe && recipe.kind === 'dataset') return 'dataset';
  if (source.scalar) return 'scalar';
  if (source.field) return 'field';
  if (source.choices?.some((c) => c.ops)) return 'ops';
  if (source.choices?.some((c) => c.payload)) return 'dataset';
  throw new PlanError('unsupported-recipe', 'This feature has no byte-level recipe to write.');
}

/** The variant a pick names. An absent pick, an unknown selector or an ambiguous one refuses. */
function variantOf(recipe: CodingRecipe, pick: VariantPick): { variant: RecipeVariantSpec; index: number } {
  const variants = recipe.variants ?? [];
  if (pick.index !== undefined) {
    const variant = variants[pick.index];
    if (!variant)
      throw new PlanError('variant-unsettled', "This feature isn't mapped for your control unit version.");
    return { variant, index: pick.index };
  }
  if (!pick.selector)
    throw new PlanError('variant-unsettled', "We couldn't tell which version of this control unit you have.");
  const matches = variants.flatMap((v, index) =>
    v.selector === pick.selector ? [{ variant: v, index }] : [],
  );
  if (matches.length === 0)
    throw new PlanError('variant-unsettled', "This feature isn't mapped for your control unit version.");
  if (matches.length > 1)
    throw new PlanError(
      'variant-unsettled',
      'This feature has more than one mapping for your control unit version.',
    );
  return matches[0] as { variant: RecipeVariantSpec; index: number };
}

/**
 * The concrete encoding of a single-DID recipe (field, scalar, ops, dataset) or of the picked variant of
 * an `alt` recipe. Groups are planned step by step (`groupStepsOf`), never here.
 */
export function resolveRecipe(recipe: CodingRecipe, pickArg?: PickArg): Resolved {
  if (recipe.kind === 'group' || recipe.steps?.length)
    throw new PlanError(
      'unsupported-recipe',
      'This feature changes several settings; it is planned step by step.',
    );
  const pick = asPick(pickArg);
  let source: RecipeVariantSpec | CodingRecipe = recipe;
  let variantIndex: number | undefined;
  if (recipe.variants?.length) {
    const found = variantOf(recipe, pick);
    source = found.variant;
    variantIndex = found.index;
  }
  const encoding = encodingOf(source, recipe);
  const did = source.did?.toUpperCase();
  if (!did) throw new PlanError('unsupported-recipe', 'This feature has no identifier to write.');
  const choices: ResolvedChoice[] = (source.choices ?? []).map((c) => ({ ...c, value: c.value ?? 0 }));
  const scalar = source.scalar ?? (source === recipe ? undefined : recipe.scalar);
  switch (encoding) {
    case 'dataset':
      if (!choices.length || choices.some((c) => !c.payload))
        throw new PlanError('unsupported-recipe', 'This dataset has no complete payload options.');
      break;
    case 'field':
      if (!source.field || !choices.length)
        throw new PlanError('unsupported-recipe', 'This feature has no field and options to write.');
      break;
    case 'scalar':
      if (!scalar) throw new PlanError('unsupported-recipe', 'This feature has no value range to write.');
      break;
    case 'ops':
      if (!choices.length || choices.some((c) => !Array.isArray(c.ops)))
        throw new PlanError('unsupported-recipe', 'This feature has no bit operations for its options.');
      break;
  }
  const sequence = source.sequence ?? recipe.sequence;
  const checksum = source.checksum ?? recipe.checksum;
  const readBytes = source.readBytes ?? recipe.readBytes;
  return {
    encoding,
    did,
    password: (source.password === undefined ? recipe.password : source.password) ?? null,
    ...((source.passwordSource ?? recipe.passwordSource)
      ? { passwordSource: source.passwordSource ?? recipe.passwordSource }
      : {}),
    ...(variantIndex !== undefined ? { variantIndex } : {}),
    ...(source.field ? { field: source.field } : {}),
    ...(encoding === 'scalar' && scalar ? { scalar } : {}),
    choices,
    auxWrites: [...(source.auxWrites ?? [])],
    ...(encoding === 'dataset' ? { dataset: true } : {}),
    ...(sequence ? { sequence } : {}),
    ...(checksum ? { checksum } : {}),
    ...(readBytes ? { readBytes } : {}),
  };
}

/** The recipe runs a declared command sequence around its payload. */
export const needsSequence = (recipe: CodingRecipe): boolean =>
  !!recipe.sequence || recipe.kind === 'dataset';

/**
 * The bits a TRUSTED recipe owns in a block of `lengthBytes`. Restore and recheck judge with this, never
 * with a mask carried by a backup record: a record (or an imported file) cannot vouch for itself.
 */
export function trustedOwnedMask(recipe: CodingRecipe, lengthBytes: number, pick?: PickArg): number[] {
  return maskFor(resolveRecipe(recipe, pick), lengthBytes);
}

const toBitOp = (a: RecipeAuxWriteSpec | RecipeBitOp): BitOp =>
  'byte' in a
    ? { byte: a.byte, bit: a.bit, len: a.len, value: a.value, ...(a.fill ? { fill: true } : {}) }
    : { byte: a.byteOffset, bit: a.bitOffset, len: a.bitLength, value: a.value };

/** Every constant write a field recipe can make: block-level ones and each choice's own. */
const fieldAuxLists = (r: Resolved): BitOp[][] => [
  r.auxWrites.map(toBitOp),
  ...r.choices.map((c) => (c.aux ?? []).map(toBitOp)),
];

function badDefinition<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof PlanError) throw e;
    throw new PlanError('bad-definition', e instanceof Error ? e.message : 'Invalid coding definition.');
  }
}

/**
 * The one ownership rule, by encoding, shared by the apply plan, the restore plan and the trusted mask:
 *  - dataset: the whole block (it is written verbatim);
 *  - CRC-32 trailer: the payload's owned bits, plus all four trailer bytes (recomputed on every write);
 *  - field: the field's bits and every constant write's bits (block-level and per choice);
 *  - scalar: the scalar's bytes;
 *  - ops: the union of every bit any choice's ops touch.
 */
function maskFor(resolved: Resolved, lengthBytes: number): number[] {
  if (resolved.encoding === 'dataset') return new Array<number>(lengthBytes).fill(0xff);
  if (resolved.checksum === 'crc32-trailer') {
    if (lengthBytes <= TRAILER_BYTES)
      throw new PlanError('bad-definition', 'Checksum block is too short for a trailer.');
    return [...payloadMask(resolved, lengthBytes - TRAILER_BYTES), ...TRAILER_MASK];
  }
  return payloadMask(resolved, lengthBytes);
}

function payloadMask(resolved: Resolved, lengthBytes: number): number[] {
  return badDefinition(() => {
    if (resolved.encoding === 'ops')
      return ownedMaskOps(
        lengthBytes,
        resolved.choices.map((c) => (c.ops ?? []).map(toBitOp)),
      );
    const owned = ownedMask(toBlock(resolved, lengthBytes));
    if (resolved.encoding !== 'field') return owned;
    const aux = ownedMaskOps(lengthBytes, fieldAuxLists(resolved));
    return owned.map((m, i) => m | (aux[i] ?? 0));
  });
}

/**
 * The bytes a restore guard compares to decide whether the car still holds what an operation left there.
 * A checksum trailer is derived from the whole payload, including bits other features or the module own,
 * so it is not evidence of a later change to OUR bits: it is left out (the restore recomputes it).
 */
export function guardMask(recipe: Pick<CodingRecipe, 'checksum'>, owned: readonly number[]): number[] {
  return recipe.checksum === 'crc32-trailer'
    ? owned.map((m, i) => (i >= owned.length - TRAILER_BYTES ? 0 : m))
    : [...owned];
}

/** The selector of the one variant writing `did` (how an older backup's recipe variant is re-established). */
export function selectorForDid(recipe: CodingRecipe, did: string): string | undefined {
  const matches = (recipe.variants ?? []).filter((v) => v.did.toUpperCase() === did.toUpperCase());
  return matches.length === 1 ? matches[0]?.selector : undefined;
}

/** Indexes of the variants writing `did`, in order. */
export function variantIndexesForDid(recipe: CodingRecipe, did: string): number[] {
  return (recipe.variants ?? []).flatMap((v, i) => (v.did.toUpperCase() === did.toUpperCase() ? [i] : []));
}

/** Bytes a variant's block must hold for its field and constant writes. */
export function variantMinBytes(v: RecipeVariantSpec): number {
  const f = v.field;
  return Math.max(
    f ? f.byteOffset + Math.ceil((f.bitOffset + f.bitLength) / 8) : 1,
    ...(v.auxWrites ?? []).map((a) => a.byteOffset + 1),
  );
}

export function moduleOf(recipe: Pick<CodingRecipe, 'requestId' | 'responseId'>): ModuleAddress {
  if (!recipe.requestId || !recipe.responseId)
    throw new PlanError('unsupported-recipe', 'This feature has no module address.');
  return { request: recipe.requestId.toUpperCase(), response: recipe.responseId.toUpperCase() };
}

/** The field or scalar container for the blocks encoder (constant writes are applied as ops). */
function toBlock(resolved: Resolved, lengthBytes: number): CodingBlock {
  const { field } = resolved;
  if (!resolved.scalar && !field)
    throw new PlanError('unsupported-recipe', 'This feature is not a settable field or value.');
  const block: CodingBlock = resolved.scalar
    ? { length: lengthBytes, scalar: { ...resolved.scalar } }
    : {
        length: lengthBytes,
        field: {
          ...(field as RecipeFieldSpec),
          choices: resolved.choices.map((c) => ({ id: c.id, label: c.label, value: c.value })),
        },
      };
  badDefinition(() => validateCodingBlock(block));
  return block;
}

/** Physical range of a scalar: the recipe's declared bounds, else what its raw bytes can hold. */
export function scalarRange(s: RecipeScalarSpec): { min: number; max: number; step: number } {
  const bits = s.dataLength * 8;
  const rawMin = s.signed ? -(2 ** (bits - 1)) : 0;
  const rawMax = s.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const ends = [rawMin * s.multiplier + s.offset, rawMax * s.multiplier + s.offset].sort((a, b) => a - b);
  return {
    min: s.min ?? (ends[0] as number),
    max: s.max ?? (ends[1] as number),
    step: Math.abs(s.multiplier),
  };
}

/** `value:<physical number>` → the number; undefined for any other setting id. */
export function freeValueOf(settingId: string): number | undefined {
  const m = /^value:(.+)$/.exec(settingId);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[1]?.trim() !== '' && Number.isFinite(n) ? n : Number.NaN;
}

export interface CodingPlan {
  did: string;
  module: ModuleAddress;
  password: string | null;
  /** Where the password came from (`unit-default`: the unit's usual code, not one the recipe declared). */
  passwordSource?: 'recipe' | 'unit-default';
  /** Bytes read from the car, upper-case hex. */
  before: string;
  /** Bytes to write — computed here from the recipe, never supplied by the UI. */
  after: string;
  changes: ByteChange[];
  /** Per byte, the bits this recipe can write. Read-back verification is judged on these bits. */
  owned: number[];
  /** The car already holds the requested value. */
  noop: boolean;
  /** The recipe's declared command sequence (any kind); absent → the module's standard writer (`writeDid`). */
  sequence?: RecipeSequenceSpec;
  /** The alt variant this plan writes (index into the recipe's `variants`). */
  variantIndex?: number;
}

export type ReadbackComparison =
  | { kind: 'exact' }
  /**
   * The recipe's bytes are exactly as written, and every other difference is a RECORDED observation for
   * this exact write (`known`): the control unit manages those bytes itself.
   */
  | { kind: 'owned-match'; moduleManaged: ModuleManagedChange[] }
  /**
   * Not the value written. `unexplained`: the recipe's bytes match, but bytes it does not write changed
   * in a way nobody has recorded — never treated as module behaviour; it needs review.
   */
  | { kind: 'mismatch'; unexplained?: ModuleManagedChange[] };

/** `owned` as stored on a backup record (hex, one byte per block byte). */
export const ownedToHex = (owned: readonly number[]): string => owned.map(hex2).join('');

/** The stored mask back to bytes; undefined when absent or not the block's length (judge exactly). */
export function ownedFromHex(mask: string | undefined, intended: string): number[] | undefined {
  if (!mask || mask.length !== intended.length || !HEX.test(mask)) return undefined;
  return Array.from({ length: mask.length / 2 }, (_, i) => Number.parseInt(mask.slice(i * 2, i * 2 + 2), 16));
}

/**
 * Judges a read-back against the plan.
 *
 *  - A different length, or any difference in a byte that holds one of the recipe's bits, is a
 *    mismatch. Bytes we write into must come back exactly as written.
 *  - Differences only in bytes the recipe does not touch are module-managed ONLY when the whole observed
 *    block is a recorded observation for this exact write (`known`, from `knownReadbacksFor`): e.g. the
 *    BCM storing 0A5E byte 2 = A0 after polite blinks = 5 (owner decision D3). Otherwise they are
 *    reported as `unexplained` and the read-back is a mismatch (independent review 2026-10-25, R2).
 */
export function compareReadback(
  plan: Pick<CodingPlan, 'after' | 'owned'> & { known?: readonly string[] },
  observed: string,
): ReadbackComparison {
  const seen = observed.toUpperCase();
  if (seen === plan.after) return { kind: 'exact' };
  if (!HEX.test(seen) || seen.length !== plan.after.length || plan.owned.length * 2 !== plan.after.length)
    return { kind: 'mismatch' };
  const moduleManaged: ModuleManagedChange[] = [];
  for (let i = 0; i < plan.owned.length; i++) {
    const wrote = Number.parseInt(plan.after.slice(i * 2, i * 2 + 2), 16);
    const stored = Number.parseInt(seen.slice(i * 2, i * 2 + 2), 16);
    if (wrote === stored) continue;
    if (plan.owned[i] !== 0) return { kind: 'mismatch' };
    moduleManaged.push({ offset: i, wrote: hex2(wrote), stored: hex2(stored) });
  }
  return plan.known?.includes(seen)
    ? { kind: 'owned-match', moduleManaged }
    : { kind: 'mismatch', unexplained: moduleManaged };
}

const HEX = /^(?:[0-9A-F]{2})+$/;
const hex2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

/** CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — table-based, as Crc32.Calculate in the source. */
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (bytes: readonly number[]): number[] => {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC32_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  const v = c ^ 0xffffffff;
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
};

const hexBytes = (hex: string): number[] =>
  Array.from({ length: hex.length / 2 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));

const TRAILER_BYTES = 4;
const TRAILER_MASK = [0xff, 0xff, 0xff, 0xff];

/**
 * Checksum-trailer blocks (e.g. VIM MIB3): the last 4 bytes are a CRC32 over the payload, recomputed on
 * every write. Patching applies to the payload only; the trailer is fully ours (see `maskFor`).
 */
function payloadSplit(block: string): { payload: string; trailer: string } {
  const total = block.length / 2;
  if (total <= TRAILER_BYTES)
    throw new PlanError('bad-definition', 'Checksum block is too short for a trailer.');
  return {
    payload: block.slice(0, (total - TRAILER_BYTES) * 2),
    trailer: block.slice((total - TRAILER_BYTES) * 2),
  };
}

/** The CRC-32 trailer (IEEE, little-endian bytes) this recipe kind appends to a payload. */
export const crc32Trailer = (payloadHex: string): string => crc32(hexBytes(payloadHex)).map(hex2).join('');
const trailerOf = crc32Trailer;

function assertHex(hex: string): void {
  if (!HEX.test(hex)) throw new PlanError('bad-definition', 'The car returned data we could not read.');
}

/** Every `when.bytes` test holds on the block as read (each field's value is one of its `in` set). */
function bytesHold(choice: ResolvedChoice, payload: string): boolean {
  return (choice.when?.bytes ?? []).every((t) =>
    t.in.some((value) => opsHold(payload, [{ byte: t.byte, bit: t.bit, len: t.len, value }])),
  );
}

/**
 * The ops choice for a setting. Choices may repeat an id with a `when` condition: `mib3` (an `IsMIB3()` branch
 * in the vendor delegate) and/or `bytes` (a branch on the block's current contents). The first one whose
 * conditions hold wins, a MIB-specific one before an unconditional one; an unconditional one applies when the
 * generation is unknown. No choice holding refuses.
 */
function opsChoice(
  resolved: Resolved,
  settingId: string,
  isMib3: boolean | undefined,
  payload: string,
): ResolvedChoice {
  const candidates = resolved.choices.filter((c) => c.id === settingId);
  if (!candidates.length)
    throw new PlanError('unknown-setting', 'That option is not offered for this feature.');
  const fits = candidates.filter(
    (c) => (c.when?.mib3 === undefined || c.when.mib3 === isMib3) && bytesHold(c, payload),
  );
  const exact = fits.find((c) => c.when?.mib3 !== undefined) ?? fits[0];
  if (exact) return exact;
  if (
    candidates.some((c) => c.when?.bytes?.length) &&
    candidates.some((c) => bytesHold(c, payload) === false)
  )
    throw new PlanError(
      'unexpected-current-value',
      "Your control unit is set up in a way this feature doesn't cover (the slot it changes is already used for something else), so we stopped. Nothing was changed.",
    );
  throw new PlanError(
    'variant-unsettled',
    "This option depends on your infotainment generation, and we couldn't tell which one you have.",
  );
}

/**
 * Read-modify-write the whole block; only the recipe's own bits may change. `settingId` is a choice id, or
 * `value:<physical number>` for a free scalar value.
 */
export function buildApplyPlan(
  recipe: CodingRecipe,
  settingId: string,
  before: string,
  pickArg?: PickArg,
): CodingPlan {
  before = before.toUpperCase();
  assertHex(before);
  const pick = asPick(pickArg);
  const resolved = resolveRecipe(recipe, pick);
  if (resolved.readBytes && before.length / 2 !== resolved.readBytes)
    throw new PlanError(
      'unexpected-current-value',
      `The control unit returned ${before.length / 2} bytes where this feature expects ${resolved.readBytes}.`,
    );
  const base = {
    did: resolved.did,
    module: moduleOf(recipe),
    password: resolved.password,
    ...(resolved.passwordSource ? { passwordSource: resolved.passwordSource } : {}),
    before,
    ...(resolved.sequence ? { sequence: resolved.sequence } : {}),
    ...(resolved.variantIndex !== undefined ? { variantIndex: resolved.variantIndex } : {}),
  };
  if (resolved.encoding === 'dataset') {
    const chosen = resolved.choices.find((c) => c.id === settingId);
    if (!chosen) throw new PlanError('unknown-setting', 'That option is not offered for this feature.');
    const after = (chosen.payload ?? '').toUpperCase();
    const target = hexBytes(after);
    const changes: ByteChange[] =
      before.length === after.length
        ? hexBytes(before)
            .map((b, i) => ({ offset: i, before: b, after: target[i] ?? 0, mask: 0xff }))
            .filter((c) => c.before !== c.after)
        : [];
    return { ...base, after, changes, owned: maskFor(resolved, after.length / 2), noop: after === before };
  }
  const { payload } = resolved.checksum === 'crc32-trailer' ? payloadSplit(before) : { payload: before };
  let patched: { after: string; changes: ByteChange[] };
  try {
    patched = patchPayload(resolved, settingId, payload, pick.isMib3);
  } catch (e) {
    if (e instanceof PlanError) throw e;
    throw new PlanError(
      'unexpected-current-value',
      e instanceof Error ? e.message : 'The current value could not be patched.',
    );
  }
  const after =
    resolved.checksum === 'crc32-trailer' ? patched.after + trailerOf(patched.after) : patched.after;
  return {
    ...base,
    after,
    changes: patched.changes,
    owned: maskFor(resolved, before.length / 2),
    noop: after === before,
  };
}

function patchPayload(
  resolved: Resolved,
  settingId: string,
  payload: string,
  isMib3: boolean | undefined,
): { after: string; changes: ByteChange[] } {
  const length = payload.length / 2;
  switch (resolved.encoding) {
    case 'scalar': {
      const block = toBlock(resolved, length);
      const free = freeValueOf(settingId);
      let value: number;
      if (free !== undefined) {
        if (!Number.isFinite(free)) throw new PlanError('unknown-setting', 'Enter a number for this value.');
        value = free;
      } else {
        const chosen = resolved.choices.find((c) => c.id === settingId);
        if (!chosen) throw new PlanError('unknown-setting', 'That option is not offered for this feature.');
        value = chosen.value;
      }
      const range = scalarRange(resolved.scalar as RecipeScalarSpec);
      if (value < range.min || value > range.max)
        throw new PlanError('unknown-setting', `The value must be between ${range.min} and ${range.max}.`);
      return patchScalarBlock(payload, block, value);
    }
    case 'ops': {
      const chosen = opsChoice(resolved, settingId, isMib3, payload);
      // Validate every choice against this block, so a definition that cannot fit never half-applies.
      payloadMask(resolved, length);
      return patchOpsBlock(payload, (chosen.ops ?? []).map(toBitOp));
    }
    case 'field': {
      const chosen = resolved.choices.find((c) => c.id === settingId);
      if (!chosen) throw new PlanError('unknown-setting', 'That option is not offered for this feature.');
      const block = toBlock(resolved, length);
      payloadMask(resolved, length);
      const field = patchCodingBlock(payload, block, settingId);
      // Constants after the field value: block-level first, then the choice's own.
      const aux = patchOpsBlock(field.after, [
        ...resolved.auxWrites.map(toBitOp),
        ...(chosen.aux ?? []).map(toBitOp),
      ]);
      const old = hexBytes(payload);
      const now = hexBytes(aux.after);
      const owned = payloadMask(resolved, length);
      const changes: ByteChange[] = now.flatMap((b, offset) =>
        b === old[offset]
          ? []
          : [{ offset, before: old[offset] as number, after: b, mask: owned[offset] ?? 0 }],
      );
      return { after: aux.after, changes };
    }
    case 'dataset':
      throw new PlanError('unsupported-recipe', 'A dataset is written verbatim.');
  }
}

/**
 * Put a saved original back: the original's value in every bit the recipe owns, and the current
 * value everywhere else (bits other features or the module itself manage are not ours to roll back).
 * Any original value is accepted — it is what the car held before we changed it.
 */
/**
 * Bytes our own write left wrong: the module stored something other than what we sent there, and the car still
 * holds that stray value. A restore puts these back whole, even outside the recipe's bits (e.g. a byte lost to a
 * truncated CAN frame). Bytes the car changed for any other reason are left alone.
 */
export function strayBytes(
  before: string,
  intended: string,
  observed: string | undefined,
  current: string,
): number[] {
  if (!observed) return [];
  const [b, w, o, c] = [before, intended, observed, current].map((h) => hexBytes(h.toUpperCase()));
  if (!b || !w || !o || !c || o.length !== c.length || b.length !== c.length || w.length !== c.length)
    return [];
  return c.flatMap((cur, i) => (o[i] !== w[i] && cur === o[i] && cur !== b[i] ? [i] : []));
}

export function buildRestorePlan(
  recipe: CodingRecipe,
  current: string,
  original: string,
  pick?: PickArg,
  repair: readonly number[] = [],
): CodingPlan {
  current = current.toUpperCase();
  original = original.toUpperCase();
  assertHex(current);
  assertHex(original);
  const resolved = resolveRecipe(recipe, pick);
  if (current.length !== original.length)
    throw new PlanError('not-restorable', "This backup doesn't fit what the car holds now.");
  return restoreWithMask(
    {
      did: resolved.did,
      module: moduleOf(recipe),
      password: resolved.password,
      ...(resolved.passwordSource ? { passwordSource: resolved.passwordSource } : {}),
      ...(resolved.sequence ? { sequence: resolved.sequence } : {}),
      ...(resolved.variantIndex !== undefined ? { variantIndex: resolved.variantIndex } : {}),
    },
    resolved.encoding === 'dataset',
    resolved.checksum === 'crc32-trailer',
    maskFor(resolved, current.length / 2).map((m, i) => (repair.includes(i) ? 0xff : m)),
    current,
    original,
  );
}

/** `(cur & ~owned) | (orig & owned)`, a recomputed trailer, or the original verbatim for a dataset. */
function restoreWithMask(
  base: Pick<CodingPlan, 'did' | 'module' | 'password' | 'passwordSource' | 'sequence' | 'variantIndex'>,
  verbatim: boolean,
  trailer: boolean,
  owned: number[],
  current: string,
  original: string,
): CodingPlan {
  if (verbatim)
    return { ...base, before: current, after: original, changes: [], owned, noop: current === original };
  const cur = hexBytes(current);
  const orig = hexBytes(original);
  const payloadLength = trailer ? cur.length - TRAILER_BYTES : cur.length;
  if (payloadLength < 1) throw new PlanError('bad-definition', 'Checksum block is too short for a trailer.');
  const restoredBytes = cur
    .slice(0, payloadLength)
    .map((c, i) => (c & ~(owned[i] ?? 0) & 0xff) | ((orig[i] ?? 0) & (owned[i] ?? 0)));
  const restored = restoredBytes.map(hex2).join('');
  const after = trailer ? restored + trailerOf(restored) : restored;
  const afterBytes = hexBytes(after);
  const changes: ByteChange[] = afterBytes.flatMap((b, offset) =>
    b === cur[offset] ? [] : [{ offset, before: cur[offset] as number, after: b, mask: owned[offset] ?? 0 }],
  );
  return { ...base, before: current, after, changes, owned, noop: current === after };
}

// ---- groups: several recipes written as one feature ---------------------------------------------

/** Group choice ids that mean "switch it off": single-choice steps are then put back from their backup. */
export const OFF_CHOICES: readonly string[] = ['disabled', 'off', 'deactivated', 'not-active', 'inactive'];

/** The steps of a group recipe, in write order. */
export function groupStepsOf(recipe: CodingRecipe): CodingRecipe[] {
  if (recipe.kind !== 'group' && !recipe.steps?.length)
    throw new PlanError('unsupported-recipe', 'This feature is not a multi-part change.');
  const steps = [...(recipe.steps ?? [])];
  if (!steps.length) throw new PlanError('unsupported-recipe', 'This multi-part feature has no parts.');
  for (const s of steps)
    if (s.kind === 'group' || s.steps?.length)
      throw new PlanError('bad-definition', 'A multi-part feature cannot nest another one.');
  return steps;
}

export const isGroupRecipe = (recipe: CodingRecipe): boolean =>
  recipe.kind === 'group' || !!recipe.steps?.length;

/**
 * What one group step does for a group choice:
 *  - `apply`   the step's own choice with that id, or its only choice;
 *  - `restore` a single-choice step under an "off" choice: put back its original from the backup.
 * Refuses when the step has neither (the group definition does not cover that choice).
 */
export function stepActionFor(
  stepChoices: readonly Pick<RecipeChoiceSpec, 'id'>[],
  groupChoiceId: string,
  scalar = false,
): { kind: 'apply'; settingId: string } | { kind: 'restore' } {
  if (stepChoices.some((c) => c.id === groupChoiceId) || (scalar && freeValueOf(groupChoiceId) !== undefined))
    return { kind: 'apply', settingId: groupChoiceId };
  const ids = [...new Set(stepChoices.map((c) => c.id))];
  if (ids.length === 1) {
    if (OFF_CHOICES.includes(groupChoiceId.toLowerCase())) return { kind: 'restore' };
    return { kind: 'apply', settingId: ids[0] as string };
  }
  throw new PlanError('unknown-setting', 'That option is not offered for every part of this feature.');
}

/**
 * Plans one step of a group apply against the bytes just read from its module.
 * `original`: for a `restore` action, the step's original bytes from the earlier group change (absent:
 * there is nothing to put back, so the step is a no-op).
 */
export function planGroupStep(
  step: CodingRecipe,
  groupChoiceId: string,
  before: string,
  pick: VariantPick | undefined,
  original?: string,
): CodingPlan & { action: 'apply' | 'restore' } {
  const resolved = resolveRecipe(step, pick);
  const action = stepActionFor(resolved.choices, groupChoiceId, resolved.encoding === 'scalar');
  if (action.kind === 'apply')
    return { ...buildApplyPlan(step, action.settingId, before, pick), action: 'apply' };
  if (!original || original.length !== before.length) {
    const up = before.toUpperCase();
    return {
      did: resolved.did,
      module: moduleOf(step),
      password: resolved.password,
      ...(resolved.passwordSource ? { passwordSource: resolved.passwordSource } : {}),
      before: up,
      after: up,
      changes: [],
      owned: maskFor(resolved, up.length / 2),
      noop: true,
      ...(resolved.variantIndex !== undefined ? { variantIndex: resolved.variantIndex } : {}),
      action: 'restore',
    };
  }
  return { ...buildRestorePlan(step, before, original, pick), action: 'restore' };
}

/** Plans the undo of one group step from its journal entry: its original bits back under its own mask. */
export function planGroupStepRestore(
  step: CodingRecipe,
  current: string,
  original: string,
  pick: VariantPick | undefined,
): CodingPlan {
  return buildRestorePlan(step, current, original, pick);
}

/**
 * Provenance-only keys left out of the digest: they say where a value came from, not what is written, so adding
 * them to the data must not orphan every existing backup (`passwordSource` arrived with the 2026-11 contract;
 * `legacyDigests` lists the digests of earlier byte-identical definitions).
 */
const DIGEST_IGNORED: ReadonlySet<string> = new Set(['passwordSource', 'legacyDigests']);

/** The backup's digest is this recipe's current one, or one of its earlier byte-identical definitions. */
export async function digestAccepted(recipe: CodingRecipe, digest: string | undefined): Promise<boolean> {
  if (!digest) return false;
  if (recipe.legacyDigests?.includes(digest)) return true;
  return digest === (await recipeDigest(recipe));
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined && !DIGEST_IGNORED.has(k))
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;

/**
 * SHA-256 of the recipe's full definition (key order independent). A recipe id is a
 * name, not an immutable definition: a backup records this digest so a restore can
 * tell that the definition it was made with has since changed.
 */
export async function recipeDigest(recipe: CodingRecipe): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(recipe)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
