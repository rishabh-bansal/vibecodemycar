import { BUILD_INFO } from '../../config/build.ts';
import { readBackup } from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import type { ExperimentRecord, PhysicalObservation, SessionAudit } from '../../domain/coding/audit.ts';
import { recipeDigest } from '../../domain/coding/plan.ts';
import type { CarLink, CodingEvent, CodingRequest } from '../../domain/coding/types.ts';
import { db, type ObdcraftDb } from './db.ts';
import { unsavedExperiments } from './unsaved.ts';

export { unsavedExperiments } from './unsaved.ts';

export class ExperimentRecorder implements SessionAudit {
  readonly id = crypto.randomUUID();
  private record?: ExperimentRecord;
  private unlisten?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private traceError = false;
  private backupUnsaved = false;
  private link: CarLink;
  private readonly database: () => ObdcraftDb;

  constructor(link: CarLink, database: () => ObdcraftDb = db) {
    this.link = link;
    this.database = database;
  }

  async start(request: CodingRequest): Promise<void> {
    const feature = request.kind === 'apply' ? request.feature : undefined;
    const backup = request.kind === 'restore' || request.kind === 'recheck' ? request.backup : undefined;
    const recipeId = feature?.recipeId ?? backup?.recipeId;
    const recipe = recipeId ? APP_DATA.recipes[recipeId] : undefined;
    const at = new Date().toISOString();
    this.record = {
      schema: 'obdcraft.experiment/1',
      id: this.id,
      startedAt: at,
      updatedAt: at,
      buildId: import.meta.env?.VITE_BUILD_ID ?? 'development',
      ...BUILD_INFO,
      featureId:
        feature?.id ??
        backup?.featureId ??
        (request.kind === 'inspect' ? `inspect-${request.unit}` : 'unknown'),
      featureName:
        feature?.name ??
        backup?.featureName ??
        (request.kind === 'inspect' ? request.label : 'Unknown feature'),
      ...(recipeId ? { recipeId } : {}),
      ...(recipe ? { recipeDigest: await recipeDigest(recipe) } : {}),
      settingId:
        request.kind === 'apply'
          ? request.settingId
          : request.kind === 'inspect'
            ? undefined
            : request.backup.settingId,
      ...(backup ? { backup: structuredClone(backup) } : {}),
      operation: request.kind,
      mode: this.link.mode,
      state: 'in-progress',
      needsAttention: true,
      summary: 'Attempt started; final result not recorded.',
      events: [],
      wire: [],
      traceTruncated: false,
    };
    // If this fails, the controller must refuse before contacting the vehicle.
    await this.database().experiments.add(structuredClone(this.record));
    // The whole exchange is logged, the car's identification (its VIN read) included.
    this.captureWire();
  }

  private flush(): Promise<void> {
    if (!this.record) return Promise.resolve();
    const snapshot = structuredClone(this.record);
    const work = this.queue
      .catch(() => {})
      .then(async () => {
        try {
          await this.database().experiments.put(snapshot);
          unsavedExperiments.delete(this.id);
        } catch (error) {
          unsavedExperiments.set(this.id, snapshot);
          throw error;
        }
      });
    this.queue = work;
    return work;
  }

  async append(event: CodingEvent): Promise<void> {
    const record = this.record;
    if (!record) return;
    record.events.push(structuredClone(event));
    record.updatedAt = event.at;
    // The writer's decision notes come in bursts while the write runs: saved with the next batched flush
    // (as wire lines are), not one database write each. The outcome's flush always includes them.
    if (event.type === 'writer') {
      this.scheduleFlush();
      return;
    }
    const backupId =
      event.type === 'backup-saved'
        ? event.backupId
        : event.type === 'outcome'
          ? record.backup?.id
          : undefined;
    if (backupId && !this.backupUnsaved) {
      try {
        const backup = readBackup(await this.database().backups.get(backupId));
        if (backup) record.backup = backup;
      } catch {
        this.traceError = true;
      }
    }
    if (event.type === 'audit-failed' && event.record) {
      record.backup = structuredClone(event.record);
      this.backupUnsaved = true;
    }
    if (event.type === 'outcome') {
      record.state = 'complete';
      record.summary = `${event.outcome}: ${event.phase}`;
      // A change outside the setting stays flagged even when it is a recognised observation: recognising
      // a pattern does not explain it (brief C5).
      const outsideSetting = record.events.some(
        (e) => e.type === 'readback' && e.matches && (e.moduleManaged?.length ?? 0) > 0,
      );
      // So does a declared sequence that stopped after its payload, or had a step refused or unanswered.
      const sequenceIssue = record.events.some(
        (e) => e.type === 'sequence' && (!!e.incomplete || e.steps.some((step) => step.outcome !== 'acked')),
      );
      record.needsAttention =
        outsideSetting || sequenceIssue || !['verified', 'cancelled'].includes(event.outcome);
      this.unlisten?.();
      this.unlisten = undefined;
    }
    await this.flush();
    if (this.traceError) {
      this.traceError = false;
      throw Error('Some wire log updates failed; export the available record.');
    }
  }

  /** The session re-established its adapter: wire capture moves to the fresh link. */
  relink(link: CarLink): void {
    this.link = link;
    if (!this.unlisten) return;
    this.unlisten();
    this.captureWire();
  }

  private captureWire(): void {
    this.unlisten = this.link.observeWire?.((entry) => {
      const record = this.record;
      if (!record) return;
      if (record.wire.length >= 4000) {
        record.traceTruncated = true;
        return;
      }
      record.wire.push({ ...entry, text: entry.text.slice(0, 4096) });
      if (entry.text.length > 4096) record.traceTruncated = true;
      this.scheduleFlush();
    });
  }

  /** One coalesced save within 200 ms; a failure is reported by the next `append`. */
  private scheduleFlush(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {
        this.traceError = true;
      });
    }, 200);
  }

  async close(): Promise<void> {
    this.unlisten?.();
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }
}

export async function logInvestigation(
  featureId: string,
  featureName: string,
  reason: string,
): Promise<void> {
  const at = new Date().toISOString();
  await db().experiments.add({
    schema: 'obdcraft.experiment/1',
    id: crypto.randomUUID(),
    startedAt: at,
    updatedAt: at,
    buildId: import.meta.env?.VITE_BUILD_ID ?? 'development',
    ...BUILD_INFO,
    featureId,
    featureName,
    operation: 'investigate',
    mode: 'offline',
    state: 'complete',
    needsAttention: true,
    summary: `Blocked before execution: ${reason}. No vehicle commands sent.`,
    events: [],
    wire: [],
    traceTruncated: false,
  });
}

/**
 * Records what the owner saw on the car for the operation journaled as `backupId`, on that operation's
 * experiment record. Anything but "as expected" leaves the record flagged for review. Nothing is sent anywhere.
 */
export async function recordObservation(
  backupId: string,
  observation: Omit<PhysicalObservation, 'at'>,
  database: () => ObdcraftDb = db,
): Promise<void> {
  const rows = await database().experiments.toArray();
  const record = rows
    .filter((r) => r.backup?.id === backupId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!record) throw new Error('No experiment record for this operation.');
  const at = new Date().toISOString();
  const observations = [...(record.observations ?? []), { at, ...observation }];
  await database().experiments.put({
    ...record,
    observations,
    updatedAt: at,
    needsAttention: record.needsAttention || observation.verdict !== 'as-expected',
  });
}
