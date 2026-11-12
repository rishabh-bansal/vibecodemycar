import type { BackupRecord, ModuleManagedChange } from '../backups/schema.ts';
import type {
  CodingEvent,
  FeatureReportEntry,
  MarkerWrite,
  Outcome,
  RefusalReason,
  SequenceIncomplete,
  StepId,
  WarningCode,
} from './types.ts';

export type StepStatus = 'pending' | 'active' | 'done' | 'failed';

/** What the final screen shows. Exactly one of these ends every session. */
export type CodingResult =
  /** `moduleManaged`: bits outside the recipe the control unit changed itself (shown, never hidden). */
  /** `sequenceIncomplete`: the payload was acknowledged and read back, but a later sequence step stopped (named). */
  | {
      kind: 'success';
      acknowledged: boolean;
      moduleManaged?: readonly ModuleManagedChange[];
      sequenceIncomplete?: SequenceIncomplete;
      /** An inspect run's map shape, when the request was a module scan. */
      scan?: { answered: number; refused: number; silent: number; complete: boolean };
      /** An inspect run's per-recipe verdicts, when the request was a module scan. */
      report?: readonly FeatureReportEntry[];
    }
  /** The car already held the requested value. */
  | { kind: 'unchanged' }
  /**
   * Definite refusal before or at the wire — the setting was not changed. `markersStored`: coding
   * markers the control unit did store (or may have) while the change was being prepared.
   */
  | { kind: 'refused'; reason: RefusalReason; detail: string; markersStored?: readonly MarkerWrite[] }
  | { kind: 'wrong-car'; detail: string }
  /** We cannot honestly say what state the car is in. */
  | { kind: 'unconfirmed'; why: 'mismatch' | 'no-readback' | 'link-lost'; detail: string }
  | { kind: 'cancelled'; markersStored?: readonly MarkerWrite[] };

export interface CodingProgress {
  steps: Record<StepId, StepStatus>;
  vinMasked?: string;
  part?: string;
  backupId?: string;
  /** An inspect run's map shape (counts only — the DID map itself lives in the event record). */
  scan?: { answered: number; refused: number; silent: number; complete: boolean };
  /** An inspect run's per-recipe verdicts, decoded from the scan where a field spec exists. */
  report?: readonly FeatureReportEntry[];
  /** The request is on the wire. Beyond this point nothing can be "un-sent". */
  sent: boolean;
  writeStartedAt?: string;
  /** The car asked us to wait (response-pending) and has not finished — "still saving". */
  waitingOnCar: boolean;
  acknowledged: boolean;
  /** Latest read-back holds every bit the recipe owns as intended. The ONLY evidence success may rest on. */
  readbackMatched: boolean;
  /** The latest read-back, as read (upper-case hex). */
  observed?: string;
  /** From the latest matching read-back: bytes the control unit changed outside the recipe's bits. */
  moduleManaged?: readonly ModuleManagedChange[];
  linkLost: boolean;
  /** Resumes on a re-established adapter so far (each one reconnects the device already granted). */
  relinked: number;
  cancelRequested: boolean;
  refusal?: { reason: RefusalReason; detail: string };
  /** Coding markers the link reported for this session's write. */
  markers?: readonly MarkerWrite[];
  /** The result stands, but saving it to the backups failed. Shown, never hidden; `record` can be exported. */
  auditFailure?: { backupId: string; detail: string; record?: BackupRecord };
  /** A declared sequence stopped after its payload was acknowledged, at this step. */
  sequenceIncomplete?: SequenceIncomplete;
  /** Advisory facts measured before the write (readiness, part number, other car). Shown, never a refusal. */
  warnings?: readonly { code: WarningCode; detail: string }[];
  /** The link sent SecurityAccess to the module during this run. */
  securitySent?: boolean;
  /** A multi-part change: the part being written now (0-based) and how many there are. */
  group?: { index: number; of: number; did: string };
  result?: CodingResult;
}

export const initialProgress: CodingProgress = Object.freeze<CodingProgress>({
  steps: { verify: 'pending', backup: 'pending', write: 'pending', check: 'pending' },
  sent: false,
  waitingOnCar: false,
  acknowledged: false,
  readbackMatched: false,
  linkLost: false,
  relinked: 0,
  cancelRequested: false,
});

const STEP_ORDER: readonly StepId[] = ['verify', 'backup', 'write', 'check'];

function activeStep(steps: CodingProgress['steps']): StepId | undefined {
  return STEP_ORDER.find((s) => steps[s] === 'active') ?? STEP_ORDER.find((s) => steps[s] === 'pending');
}

function withStep(p: CodingProgress, step: StepId, status: StepStatus): CodingProgress {
  return { ...p, steps: { ...p.steps, [step]: status } };
}

function failActive(p: CodingProgress): CodingProgress {
  const step = activeStep(p.steps);
  return step ? withStep(p, step, 'failed') : p;
}

/** Markers the control unit stored, or may have stored. */
const storedMarkers = (p: CodingProgress): { markersStored?: readonly MarkerWrite[] } => {
  const stored = (p.markers ?? []).filter((m) => m.outcome === 'acked' || m.outcome === 'no-answer');
  return stored.length ? { markersStored: stored } : {};
};

function resolve(p: CodingProgress, outcome: Outcome, phase: string): CodingResult {
  switch (outcome) {
    case 'verified':
    case 'observed-match':
      // Defence in depth: never trust an outcome label over the evidence.
      if (!p.readbackMatched) {
        return { kind: 'unconfirmed', why: 'no-readback', detail: "We couldn't confirm the result." };
      }
      return {
        kind: 'success',
        acknowledged: outcome === 'verified' && p.acknowledged,
        ...(p.moduleManaged?.length ? { moduleManaged: p.moduleManaged } : {}),
        ...(p.sequenceIncomplete ? { sequenceIncomplete: p.sequenceIncomplete } : {}),
        ...(p.scan ? { scan: p.scan } : {}),
        ...(p.report ? { report: p.report } : {}),
      };
    case 'mismatch':
      return { kind: 'unconfirmed', why: 'mismatch', detail: phase };
    case 'pending-uncertain':
      return { kind: 'unconfirmed', why: p.linkLost ? 'link-lost' : 'no-readback', detail: phase };
    case 'rejected':
      return {
        kind: 'refused',
        reason: p.refusal?.reason ?? 'ecu-refused',
        detail: p.refusal?.detail ?? phase,
        ...storedMarkers(p),
      };
    case 'cancelled':
      return { kind: 'cancelled', ...storedMarkers(p) };
    case 'not-sent':
      if (p.refusal?.reason === 'already-set') return { kind: 'unchanged' };
      if (p.refusal?.reason === 'wrong-car') return { kind: 'wrong-car', detail: p.refusal.detail };
      return {
        kind: 'refused',
        reason: p.refusal?.reason ?? 'module-silent',
        detail: p.refusal?.detail ?? phase,
        ...storedMarkers(p),
      };
  }
}

/** Pure fold of the event stream. Events after the final result are ignored. */
export function reduceProgress(p: CodingProgress, e: CodingEvent): CodingProgress {
  if (p.result) return p;
  switch (e.type) {
    case 'verify-started':
      return withStep(p, 'verify', 'active');
    case 'car-verified':
      return { ...withStep(p, 'verify', 'done'), vinMasked: e.vinMasked, part: e.part };
    case 'backup-saved':
      return { ...withStep(withStep(p, 'backup', 'done'), 'write', 'active'), backupId: e.backupId };
    case 'request-sent':
      return { ...withStep(p, 'write', 'active'), sent: true, writeStartedAt: e.at };
    case 'response-pending':
      return { ...p, waitingOnCar: true };
    case 'sequence':
      return e.incomplete ? { ...p, sequenceIncomplete: e.incomplete } : p;
    case 'write-acked':
      return { ...p, acknowledged: true, waitingOnCar: false };
    case 'check-started':
      return { ...withStep(withStep(p, 'write', 'done'), 'check', 'active'), waitingOnCar: false };
    case 'readback': {
      const { moduleManaged: _previous, ...rest } = p;
      return {
        ...rest,
        observed: e.observed,
        readbackMatched: e.matches,
        ...(e.matches && e.moduleManaged?.length ? { moduleManaged: e.moduleManaged } : {}),
      };
    }
    case 'module-scan': {
      // A sweep emits one event per unit: counts accumulate, `complete` stays true only while every
      // unit scanned so far finished its whole list.
      const prev = p.scan ?? { answered: 0, refused: 0, silent: 0, complete: true };
      return {
        ...p,
        scan: {
          answered: prev.answered + Object.keys(e.answered).length,
          refused: prev.refused + Object.keys(e.refused).length,
          silent: prev.silent + e.silent.length,
          complete: prev.complete && e.complete,
        },
      };
    }
    case 'feature-report':
      return { ...p, report: [...(p.report ?? []), ...e.entries] };
    // A full scan's progress, presence probes and map: journal and live stream only.
    case 'scan-progress':
    case 'scan-discovery':
    case 'car-map':
      return p;
    case 'refused':
      return { ...p, refusal: { reason: e.reason, detail: e.detail } };
    case 'warning':
      return { ...p, warnings: [...(p.warnings ?? []), { code: e.code, detail: e.detail }] };
    case 'security-access':
      return { ...p, securitySent: true };
    // Diagnostic journal only: what was measured, chosen and decided on the wire. Nothing to show.
    case 'readiness':
    case 'variant-selected':
    case 'variant-refused':
    case 'writer':
      return p;
    case 'group-step':
      return { ...p, group: { index: e.index, of: e.of, did: e.did } };
    case 'link-lost':
      return { ...p, linkLost: true, waitingOnCar: false };
    case 'relink':
      return { ...p, linkLost: false, relinked: e.attempt };
    case 'markers':
      return { ...p, markers: e.markers };
    case 'cancel-requested':
      return { ...p, cancelRequested: true };
    case 'audit-failed':
      // A failure that carries an exportable record is never displaced by a later one without it
      // (when storage fails, the experiment log usually fails right after the backup did).
      if (p.auditFailure?.record && !e.record) return p;
      return {
        ...p,
        auditFailure: { backupId: e.backupId, detail: e.detail, ...(e.record ? { record: e.record } : {}) },
      };
    case 'outcome': {
      const result = resolve(p, e.outcome, e.phase);
      const done: CodingProgress = { ...p, waitingOnCar: false, result };
      if (result.kind === 'success') {
        return { ...done, steps: { verify: 'done', backup: 'done', write: 'done', check: 'done' } };
      }
      return failActive(done);
    }
  }
}

export function foldEvents(events: readonly CodingEvent[]): CodingProgress {
  return events.reduce(reduceProgress, initialProgress);
}

/** Whole seconds since the write left, for "car is saving the change · 14 s". */
export function elapsedSeconds(p: CodingProgress, nowMs: number): number {
  if (!p.writeStartedAt) return 0;
  return Math.max(0, Math.floor((nowMs - Date.parse(p.writeStartedAt)) / 1000));
}

/** While a write may still be landing the user must not wander off. */
export const isBusy = (p: CodingProgress): boolean => !p.result && p.steps.verify !== 'pending';
