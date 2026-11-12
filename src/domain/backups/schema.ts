import { z } from 'zod';
import { PeriodSchema } from '../catalog/schema.ts';

/**
 * A backup is the safety net for one change: the module's original bytes, what
 * we intended to write, and which exact car/module/recipe definition it belongs
 * to. It is also the operation's journal: the final outcome, the evidence behind
 * it (ACK, read-back) and an append-only history. It is stored in IndexedDB and
 * exported as a file the user can load back later, so it is validated whenever
 * it crosses a boundary (file import, storage read).
 *
 * A restore is its own operation with its own record (`operation: 'restore'`,
 * `restoreOf` → the apply it undoes): it is made durable before its write, and
 * never rewrites the history of the change it undoes.
 */

export const BACKUP_SCHEMA = 'vibecode-my-car.backup/2';
/**
 * The same format under the app's old name (OBDCraft). Read-only: stored records and backup files that carry
 * it load as BACKUP_SCHEMA; it is never written.
 */
export const LEGACY_BACKUP_SCHEMA_V2 = 'obdcraft.backup/2';
/** First published format. Read-only: migrated on load, never written. */
export const LEGACY_BACKUP_SCHEMA_V1 = 'obdcraft.backup/1';

const HexBytes = z.string().regex(/^(?:[0-9A-F]{2}){1,4092}$/, 'expected upper-case hex bytes');
const CanId = z.string().regex(/^[0-7][0-9A-F]{2}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A VIN as identified (normally 17 characters; some cars report a shorter or padded one). */
const StoredVin = z.string().regex(/^[A-Z0-9]{1,32}$/, 'expected an upper-case VIN');

export const BackupStatusSchema = z.enum([
  'prepared', //   saved before sending; the outcome was never recorded — it MAY have been written
  'verified', //   written and read back exactly (see `outcome`/`ack` for how strongly)
  'unconfirmed', // written (or possibly written) but not confirmed by read-back
  'refused', //    the setting was refused or never sent (coding markers may still have been written — see `markers`)
  'restored', //   a later restore operation (`restoredBy`) put the original back and read it back exactly
]);

/** Mirrors the domain `Outcome` — what we can honestly say happened. */
export const OutcomeSchema = z.enum([
  'verified',
  'observed-match',
  'mismatch',
  'pending-uncertain',
  'rejected',
  'not-sent',
  'cancelled',
]);

/**
 * Final-acknowledgement evidence for the write.
 * `unknown` — not recorded (migrated v1 records, or nothing was sent yet).
 */
export const AckEvidenceSchema = z.enum(['received', 'not-received', 'unknown']);

/**
 * A byte where the module stored something other than what we wrote, in bits the recipe does not
 * own. Recorded as evidence; never treated as part of the requested change.
 */
export const ModuleManagedChangeSchema = z.strictObject({
  offset: z.number().int().min(0).max(4091),
  wrote: z.string().regex(/^[0-9A-F]{2}$/),
  stored: z.string().regex(/^[0-9A-F]{2}$/),
});
export type ModuleManagedChange = z.infer<typeof ModuleManagedChangeSchema>;

/** A coding-marker write made while preparing the change (see `MarkerWrite` in domain/coding/types.ts). */
export const MarkerWriteSchema = z.strictObject({
  did: z.enum(['F199', 'F198']),
  outcome: z.enum(['acked', 'not-hosted', 'refused', 'no-answer']),
});

/**
 * A CAN frame the link handed to its adapter during the write sequence (obd-core `TxFrame`): the
 * addressed CAN id, the frame bytes and the host-side stage (`attempted` → `submitted` / `failed`).
 * `submitted` means the adapter accepted it, not that the module received it. `at` is when the
 * session learned of the frame. Records written by builds `9e34b10`…`fb612c3` hold bare frame hex
 * (no address or stage); they are still read.
 */
export const TxFrameSchema = z.strictObject({
  can: CanId,
  data: z.string().regex(/^(?:[0-9A-F]{2}){1,8}$/),
  stage: z.enum(['attempted', 'submitted', 'failed']),
  /** What was handed to the adapter instead of `data`, when different (a trimmed frame, an STPX command). */
  sent: z.string().max(200).optional(),
  at: z.iso.datetime(),
});
export type TxFrameEntry = z.infer<typeof TxFrameSchema>;

/**
 * Capacity of a journal's `txFrames`. The largest request any link sends is one 4095-byte ISO-TP PDU:
 * a first frame and 585 consecutive frames, 586 in all. The remaining 438 cover preparation (sessions,
 * probes, security, markers, identity restores), the flow control sent while receiving, and post steps.
 * A sequence that could need more is refused before it starts (dataset writer). If a link still reports
 * more, the journal keeps the first and the last frames and records how many it left out (`txFramesOmitted`).
 */
export const MAX_TX_FRAMES = 1024;
/** Frames kept from the end when a journal has to leave some out: the last attempted frame always survives. */
const TX_TAIL = 64;

/** `frames` as the journal stores them: all of them, or the head and tail plus an explicit omission count. */
export function boundTxFrames<T>(frames: readonly T[]): { txFrames: T[]; txFramesOmitted?: number } {
  if (frames.length <= MAX_TX_FRAMES) return { txFrames: [...frames] };
  return {
    txFrames: [...frames.slice(0, MAX_TX_FRAMES - TX_TAIL), ...frames.slice(-TX_TAIL)],
    txFramesOmitted: frames.length - MAX_TX_FRAMES,
  };
}

/**
 * A mutating step of a declared sequence besides the payload (identity restore, routine, DTC clear, reset,
 * download request/exit). `no-answer`: sent without a clear answer — it may have taken effect.
 */
export const SequenceStepSchema = z.strictObject({
  cmd: z.string().regex(/^[0-9A-F]{2,64}$/),
  outcome: z.enum(['acked', 'refused', 'no-answer']),
  nrc: z
    .string()
    .regex(/^[0-9A-F]{2}$/)
    .optional(),
});
/** The payload was acknowledged and this later step stopped the sequence (it is never repeated). */
export const SequenceIncompleteSchema = z.strictObject({
  /** The step's command, or `adapter`: restoring the adapter after the sequence failed (the link was closed). */
  step: z.union([z.string().regex(/^[0-9A-F]{2,64}$/), z.literal('adapter')]),
  reason: z.enum(['refused', 'no-answer', 'not-ready', 'link-lost']),
  nrc: z
    .string()
    .regex(/^[0-9A-F]{2}$/)
    .optional(),
});

/**
 * One part of a multi-part (group) change: its own module, DID, original and intended bytes and owned mask,
 * so each landed part can be put back on its own. `status` follows the record statuses, plus `planned`
 * (not reached: nothing was sent for it) and `skipped` (nothing to change for this part).
 */
export const GroupStepSchema = z
  .strictObject({
    index: z.number().int().min(0).max(63),
    recipeId: z.string().min(1),
    module: z.strictObject({ request: CanId, response: CanId, part: z.string().min(1) }),
    did: z.string().regex(/^[0-9A-F]{4}$/),
    before: HexBytes,
    intended: HexBytes,
    ownedMask: HexBytes,
    /** `apply`: the part's own setting; `restore`: the part put back from an earlier change's bytes. */
    action: z.enum(['apply', 'restore']),
    settingId: z.string().min(1).optional(),
    /** The alt variant written (index into the step recipe's `variants`). */
    variant: z.number().int().min(0).optional(),
    status: z.enum(['planned', 'skipped', 'prepared', 'verified', 'unconfirmed', 'refused', 'restored']),
    outcome: OutcomeSchema.optional(),
    ack: AckEvidenceSchema.optional(),
    observed: HexBytes.optional(),
    readbackAt: z.iso.datetime().optional(),
    markers: z.array(MarkerWriteSchema).max(4).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.before.length !== s.intended.length)
      ctx.addIssue({ code: 'custom', path: ['intended'], message: 'before and intended differ in length' });
    if (s.ownedMask.length !== s.intended.length)
      ctx.addIssue({ code: 'custom', path: ['ownedMask'], message: 'the mask does not cover the block' });
  });
export type GroupStepEntry = z.infer<typeof GroupStepSchema>;

const HistoryEntry = z.strictObject({
  at: z.iso.datetime(),
  status: BackupStatusSchema,
  outcome: OutcomeSchema.optional(),
  note: z.string().max(200).optional(),
});

const CarSchema = z.strictObject({
  brand: z.enum(['skoda', 'volkswagen']),
  model: z.string().min(1),
  variant: z.string().min(1),
  year: z.number().int().min(1990).max(2100),
  period2024: PeriodSchema.optional(),
  cluster: z.enum(['analogue', 'digital']),
});

const common = {
  id: z.string().min(8).max(64),
  createdAt: z.iso.datetime(),
  featureId: z.string().min(1),
  featureName: z.string().min(1),
  recipeId: z.string().min(1),
  settingId: z.string().min(1),
  settingLabel: z.string().min(1),
  /**
   * The car: `masked` for screens, `fingerprint` to match the connected car, `full` — the VIN itself (upper-case),
   * so records can be grouped per car. Records saved before the full VIN was kept have no `full`.
   */
  vin: z.strictObject({ masked: z.string().min(1), fingerprint: Sha256, full: StoredVin.optional() }),
  module: z.strictObject({ request: CanId, response: CanId, part: z.string().min(1) }),
  did: z.string().regex(/^[0-9A-F]{4}$/),
  before: HexBytes,
  intended: HexBytes,
  observed: HexBytes.optional(),
  status: BackupStatusSchema,
  updatedAt: z.iso.datetime(),
};

export const BackupSchema = z
  .strictObject({
    // The old-name id is the same format: accepted, and normalised to the current id.
    schema: z
      .enum([BACKUP_SCHEMA, LEGACY_BACKUP_SCHEMA_V2])
      .transform((): typeof BACKUP_SCHEMA => BACKUP_SCHEMA),
    ...common,
    car: CarSchema,
    operation: z.enum(['apply', 'restore']),
    /** For a restore: the apply record whose `before` bytes it puts back. */
    restoreOf: z.string().min(8).max(64).optional(),
    /** For an apply: the restore operation that undid it. */
    restoredBy: z.string().min(8).max(64).optional(),
    /** Which kind of link carried the operation. Simulated history is never presented as a real car's. */
    linkMode: z.enum(['demo', 'live', 'unknown']),
    /** SHA-256 of the exact recipe definition used. Absent on migrated records (evidence-incomplete). */
    recipeDigest: Sha256.optional(),
    outcome: OutcomeSchema.optional(),
    ack: AckEvidenceSchema,
    /**
     * The readiness evidence measured before the write (absent: nothing was measured, or a migrated record).
     * Measured, never a gate: `null` = could not be read; `warning` = what was out of the usual band.
     */
    readiness: z
      .strictObject({
        at: z.iso.datetime(),
        rpm: z.number().min(0).nullable(),
        speedKmh: z.number().min(0).nullable(),
        voltage: z.number().min(0).max(40).nullable(),
        warning: z.string().max(400).optional(),
      })
      .optional(),
    /** Advisory facts noted before the write (e.g. an unrecorded part number, another car). Never gates. */
    warnings: z.array(z.string().max(400)).max(16).optional(),
    /** The alt variant written (index into the recipe's `variants`); absent for single-layout recipes. */
    variant: z.number().int().min(0).optional(),
    /**
     * Multi-part (group) change: the group recipe id, every part's journal entry (`steps`, in write order),
     * and which part the top-level `module`/`did`/`before`/`intended`/`ownedMask` mirror (`stepIndex`).
     */
    groupId: z.string().min(1).optional(),
    stepIndex: z.number().int().min(0).max(63).optional(),
    steps: z.array(GroupStepSchema).min(1).max(64).optional(),
    /** When the read-back recorded in `observed` was taken. */
    readbackAt: z.iso.datetime().optional(),
    /**
     * Per byte, the bits the recipe can write (hex, same length as `intended`). Read-backs are judged
     * on these bits. Absent on older records, which are judged on the exact bytes.
     */
    ownedMask: HexBytes.optional(),
    /**
     * Coding markers (F199 date, F198 sequence) written while preparing. They are persistent ECU
     * writes: a `refused` setting with an `acked` marker still changed the control unit's records.
     */
    markers: z.array(MarkerWriteSchema).max(4).optional(),
    /**
     * Every CAN frame handed to the adapter during the write sequence, in order (markers and flow
     * control included), so the record never depends on `intended` alone for what was sent (T-1).
     */
    txFrames: z
      .array(z.union([TxFrameSchema, HexBytes]))
      .max(MAX_TX_FRAMES)
      .optional(),
    /** Frames left out of the middle of `txFrames` because the sequence reported more than it holds. */
    txFramesOmitted: z.number().int().positive().optional(),
    /**
     * CAN frames the module sent while the data-write exchange was open (`"<canId> <hex>"`, in
     * order) — the module's actual answer to `2E`: response-pending renewals, a late refusal, or
     * silence made visible. Bounded by the link.
     */
    rxFrames: z.array(z.string().max(64)).max(64).optional(),
    /** Declared sequences: the other mutating steps, in order (see `SequenceStepSchema`). */
    sequenceSteps: z.array(SequenceStepSchema).max(64).optional(),
    /** Declared sequences: the payload was acknowledged, then this step stopped the sequence. */
    sequenceIncomplete: SequenceIncompleteSchema.optional(),
    /** Bytes the module changed outside `ownedMask` at the last read-back. */
    moduleManaged: z.array(ModuleManagedChangeSchema).max(4092).optional(),
    /**
     * Full-module snapshot: DID → bytes read before the write, from the unit's DID inventory (best-effort;
     * DIDs that refused or did not answer are omitted). Taken before readiness was collected.
     */
    moduleSnapshot: z.record(z.string().regex(/^[0-9A-F]{4}$/), HexBytes).optional(),
    /** The snapshot stopped early (time budget, or the module stopped answering): it is not the whole inventory. */
    moduleSnapshotPartial: z.literal(true).optional(),
    /**
     * Append-only: every status change, oldest first. Bounded so an imported file stays small; a record
     * that reaches the bound refuses further updates, which the session reports as `audit-failed` (with an
     * exportable copy) rather than silently dropping history.
     */
    history: z.array(HistoryEntry).max(200),
    /**
     * The build that recorded this operation (stamped when the journal is first saved; absent on older
     * records and on records imported from a file that had none). Diagnostic only.
     */
    build: z
      .strictObject({
        buildId: z.string().min(1).max(64),
        gitSha: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .optional(),
  })
  .superRefine((b, ctx) => {
    // Invariants every reader relies on — checked wherever a record crosses a boundary (save, update,
    // storage read, file import), not only on import.
    if (b.operation === 'restore' && !b.restoreOf)
      ctx.addIssue({
        code: 'custom',
        path: ['restoreOf'],
        message: 'a restore must name the change it restores',
      });
    if (b.operation === 'apply' && b.restoreOf)
      ctx.addIssue({
        code: 'custom',
        path: ['restoreOf'],
        message: 'only a restore restores another change',
      });
    if (b.before.length !== b.intended.length)
      ctx.addIssue({ code: 'custom', path: ['intended'], message: 'before and intended differ in length' });
    if (b.ownedMask && b.ownedMask.length !== b.intended.length)
      ctx.addIssue({ code: 'custom', path: ['ownedMask'], message: 'the mask does not cover the block' });
    if (b.steps && b.stepIndex !== undefined && !b.steps.some((s) => s.index === b.stepIndex))
      ctx.addIssue({ code: 'custom', path: ['stepIndex'], message: 'the mirrored part is not in the group' });
    if (b.steps && new Set(b.steps.map((s) => s.index)).size !== b.steps.length)
      ctx.addIssue({ code: 'custom', path: ['steps'], message: 'a part appears twice' });
  });

const LegacyBackupSchemaV1 = z.strictObject({
  schema: z.literal(LEGACY_BACKUP_SCHEMA_V1),
  ...common,
  car: CarSchema.omit({ period2024: true }),
});

export type BackupRecord = z.infer<typeof BackupSchema>;
export type BackupStatus = z.infer<typeof BackupStatusSchema>;
export type AckEvidence = z.infer<typeof AckEvidenceSchema>;
export type BackupHistoryEntry = z.infer<typeof HistoryEntry>;
type LegacyBackupV1 = z.infer<typeof LegacyBackupSchemaV1>;

/**
 * v1 → v2. A v1 record stored `verified` for any exact read-back, with or without
 * a final ACK, and did not record the link mode or recipe revision. Those facts are
 * migrated as UNKNOWN — never retroactively upgraded to "ACK-confirmed" or "live".
 */
export function migrateV1(v1: LegacyBackupV1): BackupRecord {
  return {
    ...v1,
    schema: BACKUP_SCHEMA,
    operation: 'apply',
    linkMode: 'unknown',
    ack: 'unknown',
    history: [
      {
        at: v1.updatedAt,
        status: v1.status,
        note: 'migrated from obdcraft.backup/1 — ACK, link mode and recipe revision were not recorded',
      },
    ],
  };
}

/** Validate any supported stored/exported shape and return it in the current format. */
export function readBackup(input: unknown): BackupRecord | undefined {
  const current = BackupSchema.safeParse(input);
  if (current.success) return current.data;
  const legacy = LegacyBackupSchemaV1.safeParse(input);
  if (!legacy.success) return undefined;
  // A migrated record must satisfy the same invariants as a current one.
  const migrated = BackupSchema.safeParse(migrateV1(legacy.data));
  return migrated.success ? migrated.data : undefined;
}

/** Record-level evidence is complete only for records written by this format with an ACK fact. */
export const evidenceIncomplete = (b: BackupRecord): boolean =>
  b.ack === 'unknown' || b.linkMode === 'unknown' || !b.recipeDigest;

export class BackupFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFileError';
  }
}

/** Parse a user-supplied backup file. Never trusts its shape, never throws a raw parser error at the UI. */
export function parseBackupFile(text: string): BackupRecord {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupFileError("That file isn't a Vibecode my car backup.");
  }
  const record = readBackup(json);
  if (!record)
    throw new BackupFileError("That file isn't a valid Vibecode my car backup, so it was not loaded.");
  return record;
}

export const serializeBackup = (b: BackupRecord): string => `${JSON.stringify(b, null, 2)}\n`;

/** `vibecode-my-car-backup-<model>-<date>.json`, e.g. vibecode-my-car-backup-kushaq-20261111-134500.json. */
export function backupFileName(b: BackupRecord): string {
  const model =
    b.car.model
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'car';
  const [date = '', time = ''] = b.createdAt.slice(0, 19).split('T');
  return `vibecode-my-car-backup-${model}-${date.replace(/-/g, '')}-${time.replace(/:/g, '')}.json`;
}
