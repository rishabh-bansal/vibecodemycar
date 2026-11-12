import { z } from 'zod';
import type { FeatureRecord, Recipe } from './types.ts';

/**
 * Contract of src/data/app-data.json (written by scripts/build-data.mjs).
 * The bundled file is a trusted, versioned build artefact, so it is validated in
 * the test suite on every change rather than at runtime. Anything a *user*
 * supplies (backup files) is validated at runtime — see domain/backups.
 */

export const MidSchema = z.enum(['Analogue', 'Digital', 'Mixed', 'unknown']);
export const PeriodSchema = z.enum(['pre-2024-04', 'post-2024-04']);

const Hex4 = z.string().regex(/^[0-9A-F]{4}$/, 'DID must be 4 upper-case hex digits');
const CanId = z.string().regex(/^[0-7][0-9A-F]{2}$/, 'CAN id must be an 11-bit id');

const BitOpSchema = z.strictObject({
  byte: z.number().int().min(0),
  bit: z.number().int().min(0).max(7),
  len: z.number().int().min(1).max(32),
  value: z.number().int().min(0),
  fill: z.boolean().optional(),
});

export const FieldSchema = z.strictObject({
  byteOffset: z.number().int().min(0),
  bitOffset: z.number().int().min(0).max(7),
  bitLength: z.number().int().min(1).max(32),
  byteOrder: z.enum(['big', 'little']),
});

export const AuxWriteSchema = z.strictObject({
  byteOffset: z.number().int().min(0),
  bitOffset: z.number().int().min(0).max(7),
  bitLength: z.number().int().min(1).max(32),
  value: z.number().int().min(0),
});

const ScalarSchema = z.strictObject({
  byteOffset: z.number().int().min(0),
  dataLength: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  multiplier: z.number(),
  offset: z.number(),
  signed: z.boolean().optional(),
  reverseOrder: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
});

/**
 * Declared wire ritual (dataset recipes): verbatim command lists run around the payload
 * step. `HHH:hex` sends on that CAN header; `download` selects the 34/36/37 transfer.
 */
const SequenceSchema = z.strictObject({
  pre: z.array(z.string().min(1)).optional(),
  post: z.array(z.string().min(1)).optional(),
  download: z
    .strictObject({
      address: z.string().regex(/^[0-9A-Fa-f]+$/),
      addressFormat: z.number().int().min(1).max(4),
      lengthFormat: z.number().int().min(1).max(4),
    })
    .optional(),
});

const StateBitsSchema = z.array(z.tuple([z.number().int().min(0), z.number().int().min(0).max(7)]));
const Hex = z.string().regex(/^[0-9A-F]+$/);

/** Only a recipe with no bytes to write is non-executable, and it says why. */
const notExecutable = {
  executable: z.literal(false).optional(),
  reason: z.literal('no-bytes').optional(),
};
const shared = { toggle: z.boolean().optional(), stateBits: StateBitsSchema.optional(), ...notExecutable };

const FieldEncoding = {
  kind: z.literal('field'),
  field: FieldSchema,
  /** `value` is the wire-encoded field integer — never a display label. */
  choices: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      value: z.number().int().min(0),
      aux: z.array(BitOpSchema).optional(),
    }),
  ),
  auxWrites: z.array(AuxWriteSchema).optional(),
  sequence: SequenceSchema.optional(),
  ...shared,
};
const ScalarEncoding = {
  kind: z.literal('scalar'),
  scalar: ScalarSchema,
  /** Presets (physical values); any value in range is legal as setting `value:<n>`. */
  choices: z
    .array(z.strictObject({ id: z.string().min(1), label: z.string().min(1), value: z.number() }))
    .optional(),
  /** 'crc32-trailer': write = patched payload + CRC32(payload); the last 4 bytes are recomputed. */
  checksum: z.enum(['crc32-trailer']).optional(),
  /** Exact block length the module must return. */
  readBytes: z.number().int().positive().optional(),
  sequence: SequenceSchema.optional(),
  ...shared,
};
const OpsEncoding = {
  kind: z.literal('ops'),
  choices: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      ops: z.array(BitOpSchema),
      when: z
        .strictObject({
          mib3: z.boolean().optional(),
          bytes: z
            .array(
              z.strictObject({
                byte: z.number().int().nonnegative(),
                bit: z.number().int().min(0).max(7),
                len: z.number().int().min(1).max(32),
                in: z.array(z.number().int().nonnegative()).min(1),
              }),
            )
            .optional(),
        })
        .optional(),
    }),
  ),
  sequence: SequenceSchema.optional(),
  ...shared,
};
const DatasetEncoding = {
  kind: z.literal('dataset'),
  choices: z.array(
    z.strictObject({
      id: z.string().min(1),
      label: z.string().min(1),
      value: z.number().int().min(0),
      payload: Hex,
    }),
  ),
  sequence: SequenceSchema.optional(),
  checksum: z.enum(['crc32-trailer']).optional(),
  readBytes: z.number().int().positive().optional(),
  ...shared,
};

const PasswordSourceSchema = z.enum(['recipe', 'unit-default']);
const variantKeys = {
  selector: z.string().min(1),
  requiresNewBcm: z.boolean().optional(),
  devicePattern: z.string().min(1).optional(),
  did: Hex4,
  password: z.string().nullable().optional(),
  passwordSource: PasswordSourceSchema.optional(),
};
export const RecipeVariantSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...variantKeys, ...FieldEncoding }),
  z.strictObject({ ...variantKeys, ...ScalarEncoding }),
  z.strictObject({ ...variantKeys, ...OpsEncoding }),
  z.strictObject({ ...variantKeys, ...DatasetEncoding }),
]);

const common = {
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().nullable().optional(),
  domain: z.string().nullable().optional(),
  unit: z.string().nullable(),
  requestId: CanId.nullable(),
  responseId: CanId.nullable(),
  password: z.string().nullable(),
  passwordSource: PasswordSourceSchema.optional(),
  did: Hex4.optional(),
  legacyDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).optional(),
};

export const StepRecipeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, ...FieldEncoding }),
  z.strictObject({ ...common, ...ScalarEncoding }),
  z.strictObject({ ...common, ...OpsEncoding }),
  z.strictObject({ ...common, ...DatasetEncoding }),
  z.strictObject({
    ...common,
    kind: z.literal('alt'),
    variants: z.array(RecipeVariantSchema).min(1),
    ...shared,
  }),
]);

export const RecipeSchema = z.union([
  StepRecipeSchema,
  z.strictObject({
    ...common,
    kind: z.literal('group'),
    steps: z.array(StepRecipeSchema).min(1),
    choices: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
    ...notExecutable,
  }),
]);

export const VehicleSchema = z.strictObject({
  brand: z.enum(['skoda', 'volkswagen']),
  model: z.string().min(1),
  variant: z.string().min(1),
  label: z.string(),
  powertrains: z.array(z.string()),
  mid: MidSchema,
  platform: z.string().nullable(),
  listedBuilds: z.array(z.string()),
});

export const LiveProofSchema = z.strictObject({
  vehicle: z.strictObject({
    brand: z.string(),
    model: z.string(),
    variant: z.string(),
    mid: z.string().optional(),
    build: PeriodSchema.optional(),
  }),
  module: z.strictObject({
    request: CanId,
    response: CanId,
    part: z.string().min(1),
    odx: z.string().optional(),
  }),
  recipe: z.strictObject({
    did: Hex4,
    byte: z.number().int().min(0),
    from: z.string(),
    to: z.string(),
  }),
  readback: z.string(),
});

export const RefusalSchema = z.strictObject({
  vehicle: z.strictObject({ brand: z.string(), model: z.string(), variant: z.string(), mid: z.string() }),
  module: z.strictObject({ part: z.string(), odx: z.string() }).partial(),
  reason: z.string(),
});

export const PlatformKeySchema = z.enum(['MQB-A0-IN', 'MQB', 'PQ']);

export const FeatureSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  settingLabels: z.record(z.string().min(1), z.string().min(1)).optional(),
  category: z.string(),
  source: z.enum(['catalogue', 'matrix']),
  listedOn: z.array(z.string()),
  recipeId: z.string().nullable(),
  recipeByPlatform: z.partialRecord(PlatformKeySchema, z.string().min(1)),
  matchConfidence: z.string().nullable(),
  liveProof: z.array(LiveProofSchema),
  refusals: z.array(RefusalSchema),
  settings: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })).optional(),
  aliasOf: z.string().min(1).optional(),
});

export const AppDataSchema = z
  .strictObject({
    schema: z.literal('obdcraft.app-data/1'),
    sourceGeneratedAt: z.string(),
    vehicles: z.array(VehicleSchema).min(1),
    features: z.record(z.string(), FeatureSchema),
    recipes: z.record(z.string(), RecipeSchema),
    /** Per-ECU-unit DID read lists for full-module snapshots (CarScanner backup manifests). */
    backupDids: z.record(z.string(), z.array(z.string().regex(/^[0-9A-F]{4}$/))).optional(),
  })
  .superRefine((data, ctx) => {
    for (const [id, f] of Object.entries(data.features)) {
      if (f.id !== id) ctx.addIssue({ code: 'custom', message: `feature key ${id} != id ${f.id}` });
      for (const r of new Set([f.recipeId, ...Object.values(f.recipeByPlatform)])) {
        if (r && !data.recipes[r])
          ctx.addIssue({ code: 'custom', message: `feature ${id} → missing recipe ${r}` });
      }
    }
  });

export type Mid = z.infer<typeof MidSchema>;
export type Period = z.infer<typeof PeriodSchema>;
export type Vehicle = z.infer<typeof VehicleSchema>;
export type LiveProof = z.infer<typeof LiveProofSchema>;
export type Refusal = z.infer<typeof RefusalSchema>;
/** Recipe types are hand-written in ./types.ts (the contract); the schema must accept exactly those shapes. */
export type {
  BitOp,
  FeatureRecord as DataFeature,
  Recipe,
  RecipeAuxWrite,
  RecipeChoice,
  RecipeField,
  RecipeVariant,
} from './types.ts';
export type AppData = Omit<z.infer<typeof AppDataSchema>, 'recipes' | 'features'> & {
  recipes: Record<string, Recipe>;
  features: Record<string, FeatureRecord>;
};

// Compile-time: what the schema accepts is assignable to the contract types (and back).
type Assert<T extends true> = T;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export type _RecipeContract = Assert<Mutual<z.infer<typeof RecipeSchema>, Recipe>>;
export type _FeatureContract = Assert<Mutual<z.infer<typeof FeatureSchema>, FeatureRecord>>;
