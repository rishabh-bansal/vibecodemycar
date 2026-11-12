import type { LiveProof, Period, Refusal } from './schema.ts';

/** UI-facing domain types and the recipe contract of src/data/app-data.json (validated by ./schema.ts). */

export type Brand = 'skoda' | 'volkswagen';
export type Cluster = 'analogue' | 'digital';

/**
 * The user's car. Screen 1 asks only for brand and model; everything else is read
 * from the car when it connects ({@link DetectedCar}), never asked. The VIN is read on connect, never typed.
 */
export interface CarSelection {
  brand: Brand;
  model: string;
  /** What the connected car reported about itself. Absent until a car has been connected. */
  detected?: DetectedCar;
  /**
   * Fields every backup records (src/domain/backups). Never asked: `variant` is {@link OTHER_VARIANT} unless a
   * selection saved by an earlier version named one; `year` and `cluster` follow {@link DetectedCar} once known.
   */
  variant: string;
  year: number;
  /** Only meaningful for a model year of 2024 named by an earlier saved selection. */
  period2024?: Period;
  cluster: Cluster;
}

/** Read from the car on connect. Each field is absent when the car did not say or we could not tell. */
export interface DetectedCar {
  /** Instrument cluster type, when the cluster's identity is one we know. */
  cluster?: Cluster;
  /** The cluster's part number (F187) as read. */
  clusterPart?: string;
  /** The cluster's dataset name (F19E) as read. */
  clusterDataset?: string;
  /** Model year from the VIN. */
  modelYear?: number;
  /** The body computer's (unit 09) part number (F187) as read. */
  bcmPart?: string;
  /** Platform family the body computer's part number names, when it is one we know (src/domain/catalog/platform.ts). */
  platform?: PlatformKey;
}

/** Sentinel for "variant not known". Variant-bound evidence then never applies. */
export const OTHER_VARIANT = 'other';

/**
 * Sentinel model for a Škoda or Volkswagen not in the list ("Other model"). Its features come from its platform
 * family, read from the car on connect (src/domain/catalog/platform.ts).
 */
export const OTHER_MODEL = 'other';

export type Tier = 'tested' | 'experimental' | 'unavailable';

export type UnavailableReason =
  /** Mapped to a recipe with no bytes to write (`reason: 'no-bytes'`). */
  | 'not-executable'
  /** No recipe for this car's platform. */
  | 'not-mapped'
  /** The car's own catalogue says this needs the other instrument cluster type, and the connected car has this one. */
  | 'wrong-cluster';

export interface FeatureSetting {
  id: string;
  label: string;
  /** Wire-encoded field value for this choice; absent for ops/group choices. */
  value?: number;
}

/** Free-value input range of a scalar recipe, in physical units (raw = (physical - offset) / multiplier). */
export interface ScalarInput {
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export interface FeatureItem {
  id: string;
  name: string;
  tier: Tier;
  reason?: UnavailableReason;
  /** Micro-label under the name, e.g. "TESTED ON YOUR CAR". */
  statusLabel: string;
  recipeId?: string;
  settings: FeatureSetting[];
  /** Present for scalar recipes: the UI offers a number input, requested as setting id `value:<n>`. */
  scalar?: ScalarInput;
  /** Live proof bound to this exact car; its module part is re-checked at runtime. */
  proof?: LiveProof;
  /**
   * The instrument cluster type this feature needs on this model, while the car's cluster is not yet known
   * (checked when the car connects). Absent once resolved, or when the feature works with either.
   */
  needsCluster?: Cluster;
}

// ---------------------------------------------------------------------------------------------------------------
// Recipe contract (scripts/build-data.mjs writes it, ./schema.ts validates it).

/**
 * One bit-level write. `bit` is the LSB index (0..7). `len` ≤ 32; a span wider than the bits left in `byte`
 * continues big-endian into the following bytes, read like a big-endian field starting at `byte`: the LAST byte
 * of the span holds the LSBs, and `bit` is the LSB's index within that last byte (packages/coding blocks.ts).
 * `len: 8, bit: 0` is the whole byte. No shipped recipe uses a crossing span with `bit` ≠ 0.
 */
export interface BitOp {
  byte: number;
  bit: number;
  len: number;
  value: number;
  /** Whole-byte op (`bit: 0, len: 8`) repeated on every byte from `byte` to the end of the block as read. */
  fill?: boolean;
}

export interface RecipeField {
  byteOffset: number;
  bitOffset: number;
  bitLength: number;
  byteOrder: 'big' | 'little';
}

/** A fixed write applied with every choice of a field recipe. */
export interface RecipeAuxWrite {
  byteOffset: number;
  bitOffset: number;
  bitLength: number;
  value: number;
}

export interface RecipeScalar {
  byteOffset: number;
  dataLength: 1 | 2 | 3 | 4;
  multiplier: number;
  offset: number;
  signed?: boolean;
  reverseOrder?: boolean;
  /** Physical-value bounds; when absent the full raw range of `dataLength` applies. */
  min?: number;
  max?: number;
  unit?: string;
}

/** Declared wire ritual of a dataset recipe: verbatim command lists around the payload write. */
export interface RecipeSequence {
  pre?: string[];
  post?: string[];
  download?: { address: string; addressFormat: number; lengthFormat: number };
}

/** Keys that belong to one choice shape or another. */
type ChoiceKey = 'value' | 'payload' | 'aux' | 'ops' | 'when';
/** Declares the other choice shapes' keys as absent, so `choice.value` reads as `number | undefined` on the union. */
type ExclusiveChoice<T> = T & { [K in Exclude<ChoiceKey, keyof T>]?: never };

export type FieldChoice = ExclusiveChoice<{
  id: string;
  label: string;
  /** Wire-encoded field integer — never a display label. */
  value: number;
  /** Extra bit writes for this choice only. */
  aux?: BitOp[];
}>;

export type ScalarPreset = ExclusiveChoice<{
  id: string;
  label: string;
  /** Physical value. */
  value: number;
}>;

export type OpsChoice = ExclusiveChoice<{
  id: string;
  label: string;
  ops: BitOp[];
  /**
   * Applies only when the condition holds: MIB generation from the F19E/ASAM probe, and/or bit fields of the
   * block as read (`bytes`, each value in `in`). No choice of that id holding refuses the plan.
   */
  when?: { mib3?: boolean; bytes?: { byte: number; bit: number; len: number; in: number[] }[] };
}>;

export type DatasetChoice = ExclusiveChoice<{
  id: string;
  label: string;
  value: number;
  /** The complete block this option writes verbatim. */
  payload: string;
}>;

export type GroupChoice = ExclusiveChoice<{
  id: string;
  label: string;
}>;

/** Any choice shape, for code that only needs id/label (or reads the optional keys). */
export type RecipeChoice = FieldChoice | ScalarPreset | OpsChoice | DatasetChoice | GroupChoice;

/** Present only on a recipe (or variant) with nothing to write: a raw block nobody has decoded into ops yet. */
interface NotExecutable {
  executable?: false;
  reason?: 'no-bytes';
}

export interface FieldEncoding extends NotExecutable {
  kind: 'field';
  field: RecipeField;
  choices: FieldChoice[];
  auxWrites?: RecipeAuxWrite[];
  /** Commands around the write (e.g. a vendor `PreWriteCommands` session switch); absent → the standard writer. */
  sequence?: RecipeSequence;
  toggle?: boolean;
  stateBits?: [number, number][];
}

export interface ScalarEncoding extends NotExecutable {
  kind: 'scalar';
  scalar: RecipeScalar;
  choices?: ScalarPreset[];
  /** 'crc32-trailer': write = patched payload + CRC32(payload); the last 4 bytes are recomputed. */
  checksum?: 'crc32-trailer';
  /** Exact block length the module must return. */
  readBytes?: number;
  sequence?: RecipeSequence;
  toggle?: boolean;
  stateBits?: [number, number][];
}

export interface OpsEncoding extends NotExecutable {
  kind: 'ops';
  choices: OpsChoice[];
  /** Bits that, all set, mean the feature is currently enabled (display / no-op detection only). */
  stateBits?: [number, number][];
  /** Commands around the write (e.g. a vendor `PreWriteCommands` session switch); absent → the standard writer. */
  sequence?: RecipeSequence;
  toggle?: boolean;
}

export interface DatasetEncoding extends NotExecutable {
  kind: 'dataset';
  choices: DatasetChoice[];
  sequence?: RecipeSequence;
  checksum?: 'crc32-trailer';
  readBytes?: number;
  toggle?: boolean;
  stateBits?: [number, number][];
}

export type VariantEncoding = FieldEncoding | ScalarEncoding | OpsEncoding | DatasetEncoding;

export type PasswordSource = 'recipe' | 'unit-default';

export type RecipeVariant = Exclusive<VariantEncoding> & {
  /** Selection rule name (see src/domain/coding/variant-select.ts); first match in array order wins. */
  selector: string;
  requiresNewBcm?: boolean;
  /** F187 part-number pattern with `*`/`?` wildcards. */
  devicePattern?: string;
  did: string;
  password?: string | null;
  passwordSource?: PasswordSource;
};

export interface RecipeCommon {
  id: string;
  name: string;
  category?: string | null;
  domain?: string | null;
  unit: string | null;
  requestId: string | null;
  responseId: string | null;
  password: string | null;
  passwordSource?: PasswordSource;
  did?: string;
  /** Digests of earlier, byte-identical definitions of this recipe (old backups still restore). */
  legacyDigests?: string[];
}

/** Keys that belong to one encoding or another. */
type EncodingKey =
  | 'field'
  | 'scalar'
  | 'choices'
  | 'auxWrites'
  | 'variants'
  | 'steps'
  | 'sequence'
  | 'checksum'
  | 'readBytes';
/**
 * Declares the other encodings' keys as absent, so code may read `recipe.choices` / `recipe.field` on the union
 * (getting `undefined` for kinds without it) and still narrow by `kind`.
 */
export type Exclusive<T> = T extends unknown ? T & { [K in Exclude<EncodingKey, keyof T>]?: never } : never;

export type FieldRecipe = Exclusive<RecipeCommon & FieldEncoding>;
export type ScalarRecipe = Exclusive<RecipeCommon & ScalarEncoding>;
export type OpsRecipe = Exclusive<RecipeCommon & OpsEncoding>;
export type DatasetRecipe = Exclusive<RecipeCommon & DatasetEncoding>;

export type AltRecipe = Exclusive<
  RecipeCommon &
    NotExecutable & {
      kind: 'alt';
      variants: RecipeVariant[];
      toggle?: boolean;
      stateBits?: [number, number][];
    }
>;

/** A recipe that can be one step of a group (each with its own unit, CAN ids, password and DID). */
export type StepRecipe = FieldRecipe | ScalarRecipe | OpsRecipe | DatasetRecipe | AltRecipe;

/**
 * Multi-part feature. For each group choice id, every step either has a choice with that id or has exactly one
 * choice — applied for every group choice except 'disabled'/'off', where that step is restored from its backup.
 * The group itself has no encoding and no module (unit/requestId/responseId/password are null).
 */
export type GroupRecipe = Exclusive<
  RecipeCommon &
    NotExecutable & {
      kind: 'group';
      steps: StepRecipe[];
      choices: GroupChoice[];
    }
>;

export type Recipe = StepRecipe | GroupRecipe;
export type RecipeKind = Recipe['kind'];

// ---------------------------------------------------------------------------------------------------------------
// Features.

/** Platform keys used by recipeByPlatform. */
export type PlatformKey = 'MQB-A0-IN' | 'MQB' | 'PQ';

export interface FeatureRecord {
  /** Catalogue slug (source 'catalogue') or legacy matrix feature id (source 'matrix', kept for old backups). */
  id: string;
  /** Source name (catalogue card or legacy list); kept as the stable fallback. */
  name: string;
  /** Plain consumer name (data/source/feature-copy.json); present on every codable feature. */
  displayName?: string;
  /** One or two sentences on what the feature does in the car; present on every codable feature. */
  description?: string;
  /** Consumer label per setting id the feature offers (choice id → label); empty for free-value-only features. */
  settingLabels?: Record<string, string>;
  category: string;
  source: 'catalogue' | 'matrix';
  /** Build ids (Vehicle.listedBuilds) this feature is listed for. */
  listedOn: string[];
  /** Default recipe (the MQB-A0-IN one when per-platform); use {@link FeatureRecord.recipeByPlatform} for a car. */
  recipeId: string | null;
  /** Recipe per platform key; empty when the feature is not codable. */
  recipeByPlatform: Partial<Record<PlatformKey, string>>;
  matchConfidence: string | null;
  liveProof: LiveProof[];
  refusals: Refusal[];
  /** Ordered relabel/subset of the recipe's choices for display; labels follow {@link FeatureRecord.settingLabels}. */
  settings?: { id: string; label: string }[];
  /** Legacy matrix feature this catalogue slug was joined to. */
  aliasOf?: string;
}
