import type { z } from 'zod';
import type {
  BackupRecord,
  MarkerWriteSchema,
  ModuleManagedChange,
  SequenceIncompleteSchema,
  SequenceStepSchema,
  TxFrameEntry,
} from '../backups/schema.ts';
import type {
  CarSelection,
  BitOp as CatalogBitOp,
  Recipe as CatalogRecipe,
  FeatureItem,
} from '../catalog/types.ts';
import type { CarMap, ScanDiscovery } from '../scan/map.ts';
import type { WireTrace } from './audit.ts';

/** The four visible stages of one coding session (screen 5). */
export type StepId = 'verify' | 'backup' | 'write' | 'check';

/**
 * What we can honestly say happened. A successful process exit, a transmitted
 * frame, an ECU acknowledgement, a matching read-back and a physically working
 * feature are DIFFERENT facts — only the first two outcomes below are "it worked".
 */
export type Outcome =
  | 'verified' //              ECU acknowledged AND an exact read-back matched
  | 'observed-match' //        exact read-back matched, but no final acknowledgement was captured
  | 'mismatch' //              read-back returned something other than the intended bytes
  | 'pending-uncertain' //     sent, and nothing decisive came back
  | 'rejected' //              the ECU answered with a negative response
  | 'not-sent' //              we stopped before transmitting anything
  | 'cancelled'; //            cancelled before transmitting

export type RefusalReason =
  | 'wrong-car'
  | 'no-vin'
  | 'unknown-module'
  | 'module-silent'
  | 'variant-unsettled'
  | 'already-set'
  | 'backup-failed'
  | 'live-writes-disabled'
  | 'ecu-refused'
  | 'invalid-plan'
  /** The trusted catalogue does not offer this feature/setting for this car (or the request disagrees with it). */
  | 'not-eligible'
  /** The recipe now resolves to a different module/DID/definition than the backup was made with. */
  | 'target-changed'
  /**
   * The backup predates recipe fingerprints, so the definition it was made with can't be
   * established. Automatic restore is blocked until it is requalified.
   */
  | 'needs-requalification'
  /** The car no longer holds what this operation left there; someone changed it since. */
  | 'restore-conflict'
  /** This connection had an ambiguous write and is retired; reconnect before doing anything else. */
  | 'link-quarantined'
  /** Fresh evidence that the car is parked, engine off, ignition on, with a healthy supply is missing or failed. */
  | 'not-ready'
  /** The record's outcome is settled (refused, or already restored): there is nothing to check. */
  | 'not-checkable'
  /** The record disagrees with the trusted definition it names (e.g. an edited ownership mask). */
  | 'backup-inconsistent'
  /** The coded value changed between the read the change was planned from and the write (e.g. during the snapshot). */
  | 'value-changed';

/** `repair`: a byte an earlier write left wrong on this unit was put back as part of this change. */
export type WarningCode = 'readiness' | 'part' | 'other-car' | 'identity' | 'password' | 'group' | 'repair';

/** Typed, append-only facts about a session. The reducer and the UI consume only these. */
export type CodingEvent =
  | { at: string; type: 'verify-started' }
  /** `vin`: the full, normalised VIN (logs and diagnostics; absent when a scan could not read it). `vinMasked`: for screens. */
  | { at: string; type: 'car-verified'; vin?: string; vinMasked: string; part: string }
  | { at: string; type: 'backup-saved'; backupId: string }
  | { at: string; type: 'request-sent'; did: string }
  | { at: string; type: 'response-pending' }
  | { at: string; type: 'write-acked' }
  | { at: string; type: 'check-started' }
  /** `moduleManaged`: bytes the module changed outside the recipe's bits (only when `matches`). */
  | {
      at: string;
      type: 'readback';
      observed: string;
      matches: boolean;
      moduleManaged?: readonly ModuleManagedChange[];
    }
  /**
   * `detail` is plain words for the owner. `code`: the car's negative-response code, when it gave one.
   * `technical`: the engineering detail behind it (logs and diagnostics only, never shown).
   */
  | { at: string; type: 'refused'; reason: RefusalReason; detail: string; code?: string; technical?: string }
  /**
   * An advisory fact measured before the write — never a refusal: readiness out of the usual band or
   * unreadable, a part number nobody has recorded, another car than the one paired, an unreadable identity.
   * `detail` is plain words; `technical` keeps the engineering detail for logs (never shown).
   */
  | { at: string; type: 'warning'; code: WarningCode; detail: string; technical?: string }
  /** The link sent a SecurityAccess request (0x27) to the module: from here the run is never replayed. */
  | { at: string; type: 'security-access' }
  /** A multi-part change moved on to part `index` (0-based) of `of`, on that module and DID. */
  | { at: string; type: 'group-step'; index: number; of: number; module: ModuleAddress; did: string }
  | { at: string; type: 'link-lost' }
  /**
   * The engine speed, road speed and supply voltage measured over this connection right before the record
   * was made (`null` = unreadable), how old that reading was when journaled, and whether it was in the usual
   * band (`ok`). Diagnostic only: readiness is a warning, never a gate.
   */
  | {
      at: string;
      type: 'readiness';
      ok: boolean;
      rpm: number | null;
      speedKmh: number | null;
      voltage: number | null;
      measuredAt: string;
      ageMs: number;
    }
  /**
   * Which version of an `alt` recipe the module's own answers chose, and why (`reason`); `probe` is what the
   * harmless reads returned (see {@link VariantProbeSummary}).
   */
  | {
      at: string;
      type: 'variant-selected';
      recipeId: string;
      selector: string;
      did: string;
      reason: string;
      probe: VariantProbeSummary;
    }
  /** No version of an `alt` recipe matched the module's answers; nothing was written for it. */
  | { at: string; type: 'variant-refused'; recipeId: string; reason: string; probe: VariantProbeSummary }
  /** One decision the link's writer made on the wire (see {@link WriterNote}). Diagnostic only. */
  | ({ at: string; type: 'writer' } & WriterNote)
  /**
   * The adapter dropped, the session re-established it on the device already granted (no chooser),
   * and continues. `attempt` counts resumes (1 = first relink). Emitted only where nothing that
   * could have mutated the car was sent before the drop.
   */
  | { at: string; type: 'relink'; attempt: number }
  /**
   * An inspect run's identifier map: `answered` carries DID → bytes; `refused` DID → the NRC code the
   * unit answered (e.g. `31` = not hosted); `silent` names DIDs that never answered. `complete` is
   * false when the scan stopped early (budget, silence streak, link) — the map is then partial.
   */
  | {
      at: string;
      type: 'module-scan';
      unit: string;
      part: string;
      odx?: string;
      answered: Record<string, string>;
      refused: Record<string, string>;
      silent: readonly string[];
      complete: boolean;
    }
  /** What the scan says about every recipe on this unit — decoded current state where a field spec exists. */
  | { at: string; type: 'feature-report'; unit: string; entries: readonly FeatureReportEntry[] }
  /**
   * A full car scan's progress: `discover` probes one unit address for presence (`fitted` once known), `read`
   * walks a fitted unit's read plan (`done` of `total` identifiers). Diagnostic and for the live stream only.
   */
  | {
      at: string;
      type: 'scan-progress';
      phase: 'discover' | 'read';
      unit: string;
      done: number;
      total: number;
      fitted?: boolean;
    }
  /** Which unit addresses a full car scan probed, and what each answered (see {@link ScanDiscovery}). */
  | { at: string; type: 'scan-discovery'; units: readonly ScanDiscovery[] }
  /** The full car scan's result: every unit, value, feature state and lamp record (`src/domain/scan/map.ts`). */
  | { at: string; type: 'car-map'; map: CarMap }
  /** Coding markers the link wrote (or attempted) while preparing the data write. */
  | { at: string; type: 'markers'; markers: readonly MarkerWrite[] }
  /** A declared sequence's other mutating steps, and the step that stopped it after the payload (if any). */
  | { at: string; type: 'sequence'; steps: readonly SequenceStep[]; incomplete?: SequenceIncomplete }
  | { at: string; type: 'cancel-requested'; afterSend: boolean }
  /**
   * The car-side outcome stands, but recording it durably failed. `record` is our best in-memory
   * copy of the operation's journal so the UI can offer it for export.
   */
  | { at: string; type: 'audit-failed'; backupId: string; detail: string; record?: BackupRecord }
  | { at: string; type: 'outcome'; outcome: Outcome; phase: string };

/**
 * What the variant probe read, compactly: per DID the answer's length in bytes (0 = no answer), the unit-09
 * generation rule's verdict, the infotainment generation, and the identity numbers a device pattern matched on.
 */
export interface VariantProbeSummary {
  reads: Record<string, number>;
  unit09NewGen?: boolean;
  isMib3?: boolean;
  part?: string;
  hardware?: string;
}

/**
 * The writer's decision points, as short codes: a re-bind, a settle wait, a session (re-)opened or found
 * stale, a security seed/key (or a key not re-sent for the same seed, or the unit-default code refused), a
 * marker's answer (or giving up on it), the payload send and its answer, a session-lost retry, a proof read
 * and what it showed, a proved-safe re-send, a pending answer, the closing session, a re-target.
 */
export type WriterStep =
  | 'retarget'
  | 'rebind'
  | 'settle'
  | 'session-open'
  | 'session-stale-rearm'
  | 'rearm'
  | 'probe'
  | 'seed'
  | 'key'
  | 'key-reused-same-seed'
  | 'security-refused-unit-default'
  | 'marker'
  | 'marker-gave-up'
  | 'step'
  | 'payload'
  | 'pending'
  | 'nrc-session-lost-retry'
  | 'nrc'
  | 'proof-read'
  | 'resend'
  | 'not-ready'
  | 'end-session'
  /** The write stopped; `detail` is the technical reason behind the plain words the owner reads. */
  | 'stopped';

/**
 * One writer decision. Compact by design: DIDs and NRC codes only, never payload bytes, seeds or keys (the
 * wire trace has the bytes). `passwordSource` says where a security code came from, never the code.
 */
export interface WriterNote {
  step: WriterStep;
  detail?: string;
  /** CAN request id, when the step addressed a module other than the one being written. */
  module?: string;
  did?: string;
  passwordSource?: 'recipe' | 'unit-default';
}

export type CodingRequest =
  | { kind: 'apply'; car: CarSelection; feature: FeatureItem; settingId: string }
  | { kind: 'restore'; backup: BackupRecord }
  /** Read-only: re-read a change we could not confirm and compare it with what was intended. */
  | { kind: 'recheck'; backup: BackupRecord }
  /**
   * Read-only: inventory the identifiers a control unit hosts (the CarScanner backup list for its unit).
   * Any module may be scanned — identifying an unknown unit is the point — so nothing here gates on
   * part numbers. The map is journaled (`module-scan`) and uploaded like every session record.
   */
  | {
      kind: 'inspect';
      car: CarSelection;
      /** The control unit to address (request/response CAN ids) and its diagnostic unit key ('09'…). */
      module: ModuleAddress;
      unit: string;
      label: string;
      /** `unit: 'all'` only: the full car scan's options (deep identifier sweep, a subset of units). */
      scan?: ScanOptions;
    };

/** Options of a full car scan (`inspect` with `unit: 'all'`). */
export interface ScanOptions {
  /** Also sweep identifier ranges on units 09 and 17 (slow: up to an hour more). */
  deep?: boolean;
  /** Probe and read only these diagnostic units ('09', '17'…); absent: every known unit address. */
  units?: readonly string[];
}

// ---- ports ---------------------------------------------------------------------------------

export interface ModuleAddress {
  /** 11-bit CAN request id, e.g. `714`. */
  request: string;
  /** 11-bit CAN response id, e.g. `77E`. */
  response: string;
}

/**
 * Why no VIN was read:
 *  - `bus-silent`  nothing on the car answered at all: the adapter reported that it could not reach the bus
 *                  (UNABLE TO CONNECT / CAN ERROR) for every module asked
 *  - `no-answer`   the bus was reached but the modules asked stayed silent
 *  - `no-vin`      a module answered, but none gave a valid VIN
 */
export type VinFailure = 'bus-silent' | 'no-answer' | 'no-vin';

export type IdentifyResult =
  | { kind: 'ok'; vin: string }
  /** `adapter`: what the adapter reported instead of an answer, when it could not reach the bus. */
  | { kind: 'no-vin'; why?: VinFailure; adapter?: string }
  | { kind: 'link-lost' };

/**
 * Payload is the DID data only (service and DID echo stripped), upper-case hex. A `no-reply` may carry what the
 * adapter itself said instead of a module answer (`UNABLE TO CONNECT`, `CAN ERROR`, `NO DATA`).
 */
export type DidRead =
  | { kind: 'ok'; bytes: string }
  | { kind: 'nrc'; code: string }
  /**
   * `detail`: the module did answer, unusably — `pending` (78 response-pending whose final answer never came) or
   * `truncated` (a multi-frame reply that arrived short; `partial` holds the DID data bytes received in order).
   */
  | { kind: 'no-reply'; adapter?: string; detail?: 'pending' | 'truncated'; partial?: string }
  | { kind: 'link-lost' };

/**
 * One recipe's verdict from a module scan, in a `feature-report` event:
 *  - `value`     the hosted variant's DID answered and its field decoded to this wire value
 *                (`choiceId` when it matches a declared option — the feature's CURRENT setting)
 *  - `unsettled` more than one variant's DID answered — the recipe can't be pinned to one layout
 *  - `not-hosted` every variant DID was probed and none answered — the feature is not on this unit
 *  - `unprobed`  at least one variant DID went unanswered or was never reached — absence is unknown
 *  - `unmapped`  the recipe declares no field/scalar — nothing to decode
 */
export interface FeatureReportEntry {
  /** Diagnostic unit this verdict belongs to (a sweep reports several units in one run). */
  unit: string;
  recipeId: string;
  name: string;
  featureIds: readonly string[];
  state:
    | { kind: 'value'; did: string; selector: string; value: number; choiceId?: string }
    | { kind: 'unsettled'; hosted: readonly string[] }
    | { kind: 'not-hosted' }
    | { kind: 'unprobed'; dids: readonly string[] }
    | { kind: 'unmapped' };
}

/**
 * A coding-marker write made while preparing the data write (F199 coding date, F198 coding
 * sequence). These are persistent ECU writes, so every write result reports them.
 *  - `acked`      stored by the control unit
 *  - `not-hosted` refused with NRC 31: the DID does not exist on this variant (nothing stored)
 *  - `refused`    refused with another NRC (nothing stored; the payload write still goes ahead)
 *  - `no-answer`  sent, but no clear answer: it MAY have been stored
 */
export type MarkerWrite = z.infer<typeof MarkerWriteSchema>;

/** A CAN frame a link handed to its adapter during a write (the journal adds when it was learned of). */
export type TxFrameRecord = Omit<TxFrameEntry, 'at'>;

export type DidWrite = (
  | { kind: 'acked' }
  /**
   * The sequence stopped before the data write itself was transmitted (session or security step
   * failed; a refused or silent marker never stops it). `reason: 'not-ready'` — the readiness evidence expired during preparation.
   */
  | { kind: 'not-sent'; detail: string; reason?: 'not-ready' }
  /** Cancelled while the car was still being prepared — the data write was never transmitted. */
  | { kind: 'cancelled' }
  /** `detail`: the writer's own explanation when it knows more than the code (a refused unit-default code). */
  | { kind: 'nrc'; code: string; detail?: string }
  /**
   * Response-pending (0x78) was seen but no final answer arrived. Never retransmitted. `stored`: the bytes the
   * module showed when it answered a read again after the 78 — the write's outcome as the module holds it, when the
   * write was not re-sent because a re-send could only repeat it (the clone's byte-8 stray, live 2026-11-09).
   */
  | { kind: 'pending-no-final'; stored?: string }
  | { kind: 'no-reply' }
  | { kind: 'link-lost' }
  /**
   * Part of a multi-request payload (a 34/36/37 download) was accepted and the transfer then stopped: the
   * control unit may hold some of it. Never "nothing changed", never "rejected".
   */
  | { kind: 'partial'; detail: string }
) & {
  /** Coding markers written (or attempted) while preparing; absent when none were attempted. */
  markers?: readonly MarkerWrite[];
  /** Every CAN frame handed to the adapter during the write sequence, in order (also reported as it
   *  happens through `WriteOptions.onTxFrame`). */
  txFrames?: readonly TxFrameRecord[];
  /**
   * CAN frames the module sent while the data-write exchange was open (`"<canId> <hex>"`), in order —
   * the answer side of a pending or silent write. Without it a journal can record "no final answer"
   * but never whether the module kept renewing 78 or dropped the request outright.
   */
  rxFrames?: readonly string[];
  /**
   * Declared sequences: every step that can change the control unit's state besides the payload (identity
   * restores, routines, DTC clears, resets, the download request and exit), in order, with what is known.
   */
  steps?: readonly SequenceStep[];
  /**
   * With `acked`: the payload was acknowledged, then a later step stopped the sequence (refused, unanswered,
   * readiness expired, link lost). The payload's acknowledgement stands; the step is not repeated.
   */
  incomplete?: SequenceIncomplete;
};

/** A mutating step of a declared sequence (other than the payload), as it was sent and answered. */
export type SequenceStep = z.infer<typeof SequenceStepSchema>;
export type SequenceIncomplete = z.infer<typeof SequenceIncompleteSchema>;

/**
 * A declared command ritual around the payload step (dataset flashes). Commands are the
 * recipe's verbatim strings: `hex` runs on the module's channel, `HHH:hex` on that CAN
 * header. `write` is either a DID write (`2E <did> <bytes>`) or a `34`/`36`/`37` download.
 */
export interface SequenceSpec {
  pre: readonly string[];
  write:
    | { kind: 'did'; did: string; bytes: string }
    | { kind: 'download'; address: string; addressFormat: number; lengthFormat: number; bytes: string };
  post: readonly string[];
  password: string | null;
}

/**
 * How a live link hands a write's CAN frames to its adapter (obd-core `FrameMode`): `full` (proven), `trim-zero`,
 * `fc-alt` (a diagnostic) or `stpx` (STN adapters only). Chosen by the live kit's frame test, never by a recipe.
 */
export type WriteFrameMode = 'full' | 'trim-zero' | 'fc-alt' | 'stpx';

export interface WriteOptions {
  /** Decimal security-access code for the module, when its DID is gated. */
  securityPassword: string | null;
  /**
   * Where `securityPassword` came from: the recipe itself, or the unit's default code backfilled by the
   * pipeline. A refusal under a unit default is reported as such, never looped.
   */
  passwordSource?: 'recipe' | 'unit-default';
  /**
   * The DID's bytes as read just before this write was planned. When the payload's reply is
   * lost the link reads the DID back in-session: matching these bytes proves the write never
   * landed (one identical re-send is then safe); matching the intended bytes proves it landed
   * (no re-send); anything else is unclear and is never re-sent.
   */
  originalBytes?: string;
  onPending: () => void;
  /**
   * Called immediately before the DATA write itself goes on the wire — not for preparation steps
   * (sessions, security, markers). Until it is called nothing has been sent, so a failure is `not-sent`
   * and Cancel still works. Links that never call it are assumed to have sent as soon as they answer.
   */
  onSend?: () => void;
  /** Honoured at every preparation step; ignored once the data write is on the wire. */
  signal?: AbortSignal;
  /**
   * Throws if the connection-bound readiness evidence expired before a frame is sent.
   * Honoured at every preparation step; ignored once the data write is on the wire — a
   * proved-safe identical re-send is the same write the evidence authorized.
   */
  assertReady?: () => void;
  /**
   * Called whenever a coding marker's state changes (on the wire → answered). Lets the session keep the
   * marker even if the write never returns (domain deadline).
   */
  onMarker?: (marker: MarkerWrite) => void;
  /**
   * Called when the n-th frame of the write sequence is handed to the adapter (`attempted`), and again
   * with the same `n` when its stage is known. Lets the session keep every frame even if the write
   * throws or never returns.
   */
  onTxFrame?: (n: number, frame: TxFrameRecord) => void;
  /** Called at every decision the writer makes (diagnostic journal). Never throws into the writer. */
  onNote?: (note: WriterNote) => void;
  /** Frame mode for this write; absent: the link's own (see {@link WriteFrameMode}). */
  frameMode?: WriteFrameMode;
  /**
   * False: the F199/F198 coding markers are not stamped before the payload. Only for the live kit's frame test,
   * whose payload IS the F198 marker; every coding session stamps them.
   */
  markers?: boolean;
}

/**
 * Raw readiness evidence, read fresh from the car over THIS connection. The link only reports
 * what it read (`null` = could not read); the domain decides whether that is safe to write.
 */
export type ReadinessRead =
  | { kind: 'ok'; at: string; rpm: number | null; speedKmh: number | null; voltage: number | null }
  | { kind: 'link-lost' };

/**
 * The car, as seen by the domain. Implementations are dumb I/O: they never decide
 * whether a change "worked". `writeDid` owns the module-specific wire sequence
 * (diagnostic session, security access, coding markers, then the write itself).
 */
export interface CarLink {
  readonly mode: 'demo' | 'live';
  /** False for links that can only read. The domain refuses to plan a write over such a link. */
  readonly canWrite: boolean;
  /**
   * The longest one `writeDid` can take with every step at its own timeout. The domain's backstop
   * waits at least this long before treating the link as wedged. Absent: 60 s.
   */
  readonly maxWriteMs?: number;
  /** Honest provenance banner shown on every screen that uses this link. */
  readonly banner: string;
  /**
   * Reads the VIN. `bound`: the control unit about to be read or coded, asked first (the native tool's order: the
   * bound module, then the instrument cluster, which serves the VIN on this platform).
   */
  identify(bound?: ModuleAddress): Promise<IdentifyResult>;
  readDid(module: ModuleAddress, did: string): Promise<DidRead>;
  /**
   * Locks this connection's wire to read-only requests (22 reads, 3E tester present, 10 01/03) until the
   * returned release is called. Absent on links with no wire of their own (demo, simulators).
   */
  lockReadOnly?(): () => void;
  /** Related reads under one adapter configuration. Returned values stay fresh; nothing is cached. */
  withReads?<T>(module: ModuleAddress, work: (reader: CarReader) => Promise<T>): Promise<T>;
  /** Engine speed, road speed and supply voltage, read now. Required before every write. */
  readiness(): Promise<ReadinessRead>;
  writeDid(module: ModuleAddress, did: string, bytes: string, options: WriteOptions): Promise<DidWrite>;
  /**
   * Runs a recipe-declared command ritual around the payload step (dataset flashes). Absent on
   * links that cannot run raw commands — the domain refuses sequence recipes over such links.
   */
  sequence?(module: ModuleAddress, spec: SequenceSpec, options: WriteOptions): Promise<DidWrite>;
  /** The longest one `sequence(spec)` can take with every step at its own timeout (the domain's backstop). */
  maxSequenceMs?(spec: SequenceSpec): number;
  observeWire?(listener: (entry: WireTrace) => void): () => void;
  close(): Promise<void>;
}

export type CarReader = Pick<CarLink, 'identify' | 'readDid'>;

export type BackupPatch = Pick<BackupRecord, 'status' | 'updatedAt'> &
  Partial<
    Pick<
      BackupRecord,
      | 'observed'
      | 'outcome'
      | 'ack'
      | 'readbackAt'
      | 'restoredBy'
      | 'moduleManaged'
      | 'markers'
      | 'txFrames'
      | 'txFramesOmitted'
      | 'rxFrames'
      | 'sequenceSteps'
      | 'sequenceIncomplete'
      | 'moduleSnapshot'
      | 'steps'
    >
  >;

export interface BackupStore {
  /** Resolves only once the record is durable. */
  save(backup: BackupRecord): Promise<void>;
  /**
   * Record a status change. Resolves only once durable; rejects if the record is missing.
   * Implementations append `{ at: updatedAt, status, outcome }` to the record's history —
   * history is never rewritten.
   */
  update(id: string, patch: BackupPatch): Promise<void>;
  /** Every stored record (a group's "off" puts single-choice parts back from the latest change's bytes). */
  list?(): Promise<BackupRecord[]>;
}

// ---- recipe shapes the engine executes ---------------------------------------------------------
// A structural VIEW of the catalogue's `Recipe` (catalog/types.ts, the data contract): every key optional,
// so code can read any key on any kind. Every catalogue `Recipe` is assignable to `CodingRecipe` (checked
// below); the engine accepts either.

/** One declared bit operation (see `BitOp` in @obdcraft/coding/blocks): big-endian span, `bit` = LSB index. */
export type RecipeBitOp = CatalogBitOp;

export interface RecipeChoiceSpec {
  id: string;
  label: string;
  /** field: the wire value; scalar: the physical preset; dataset: unused. */
  value?: number;
  /** dataset: the complete block written verbatim. */
  payload?: string;
  /** field: this choice's own constant writes (any width/position). */
  aux?: readonly RecipeBitOp[];
  /** ops: the bit operations this choice applies, in order. */
  ops?: readonly RecipeBitOp[];
  /**
   * ops: this choice only applies when the condition holds — the infotainment generation (`IsMIB3()`
   * branches) and/or bit fields of the block as read (`bytes`: each value `in` the listed set).
   */
  when?: RecipeChoiceWhen;
}

/** A bit field of the block as read (same addressing as a BitOp) whose value must be one of `in`. */
export interface RecipeByteTest {
  byte: number;
  bit: number;
  len: number;
  in: readonly number[];
}

export interface RecipeChoiceWhen {
  mib3?: boolean;
  bytes?: readonly RecipeByteTest[];
}

export interface RecipeFieldSpec {
  byteOffset: number;
  bitOffset: number;
  bitLength: number;
  byteOrder: 'big' | 'little';
}

export interface RecipeAuxWriteSpec {
  byteOffset: number;
  bitOffset: number;
  bitLength: number;
  value: number;
}

export interface RecipeScalarSpec {
  byteOffset: number;
  dataLength: 1 | 2 | 3 | 4;
  multiplier: number;
  offset: number;
  signed?: boolean;
  reverseOrder?: boolean;
  min?: number;
  max?: number;
  unit?: string;
}

export interface RecipeSequenceSpec {
  pre?: readonly string[];
  post?: readonly string[];
  download?: { address: string; addressFormat: number; lengthFormat: number };
}

/** The encoding keys a single-DID recipe or an alt variant carries. */
export interface RecipeEncoding {
  kind?: string;
  did?: string;
  password?: string | null;
  passwordSource?: 'recipe' | 'unit-default';
  field?: RecipeFieldSpec;
  scalar?: RecipeScalarSpec;
  choices?: readonly RecipeChoiceSpec[];
  auxWrites?: readonly RecipeAuxWriteSpec[];
  stateBits?: readonly (readonly [number, number] | readonly number[])[];
  sequence?: RecipeSequenceSpec;
  checksum?: 'crc32-trailer';
  readBytes?: number;
}

export interface RecipeVariantSpec extends RecipeEncoding {
  selector: string;
  requiresNewBcm?: boolean;
  /** F187 part pattern (`*`, `?` wildcards) this variant is for. */
  devicePattern?: string;
  did: string;
}

/**
 * A recipe as the engine executes it. kinds: field | scalar | ops | dataset | alt (variants) | group (steps).
 * Each group step is itself a full recipe (its own unit, CAN ids, password and DID).
 */
export interface CodingRecipe extends RecipeEncoding {
  id: string;
  name: string;
  kind: string;
  unit?: string | null;
  requestId?: string | null;
  responseId?: string | null;
  variants?: readonly RecipeVariantSpec[];
  steps?: readonly CodingRecipe[];
  protectedSafety?: boolean;
  executable?: boolean;
  /**
   * Digests of earlier definitions of this recipe that write exactly the same bytes (only provenance, labels
   * or the password backfill changed). A backup made with one of them still restores.
   */
  legacyDigests?: readonly string[];
}

/** Compile-time: the catalogue's recipes are accepted wherever the engine takes a `CodingRecipe`. */
type AssertTrue<T extends true> = T;
export type _CatalogRecipeIsCodingRecipe = AssertTrue<[CatalogRecipe] extends [CodingRecipe] ? true : false>;
