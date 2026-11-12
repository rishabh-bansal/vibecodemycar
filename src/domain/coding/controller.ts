import { type CodingProgress, initialProgress, reduceProgress } from './progress.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { CodingEvent, CodingRequest } from './types.ts';

export class BusyError extends Error {
  constructor() {
    super('A coding session is already running. Wait for it to finish.');
    this.name = 'BusyError';
  }
}

export interface SessionHandle {
  /** Resolves with the final progress once the session has truly ended. */
  readonly done: Promise<CodingProgress>;
  /** Honoured only until the request is on the wire; afterwards it is recorded and the session still runs to its honest end. */
  cancel(): void;
}

export type Listener = (progress: CodingProgress, events: readonly CodingEvent[]) => void;

/**
 * One coding session at a time. Duplicate submissions are refused, not queued.
 * The event stream is ALWAYS drained to its end — abandoning it mid-write would
 * leave a possibly-applied change with no record of what happened.
 */
export class CodingController {
  private readonly makeDeps: (signal: AbortSignal) => CodingDeps;
  private readonly listeners = new Set<Listener>();
  private current: { abort: AbortController; progress: CodingProgress; events: CodingEvent[] } | undefined;

  constructor(makeDeps: (signal: AbortSignal) => CodingDeps) {
    this.makeDeps = makeDeps;
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(req: CodingRequest): SessionHandle {
    if (this.current) throw new BusyError();
    const abort = new AbortController();
    const state = { abort, progress: initialProgress, events: [] as CodingEvent[] };
    this.current = state;

    const apply = (e: CodingEvent) => {
      state.events.push(e);
      state.progress = reduceProgress(state.progress, e);
      for (const l of this.listeners) {
        // A broken subscriber (a UI bug) must never abandon the event stream of a write in progress.
        try {
          l(state.progress, state.events);
        } catch (error) {
          console.error('A coding-session listener failed; the session continues.', error);
        }
      }
    };

    let audit: CodingDeps['audit'];
    const reportAuditFailure = () =>
      apply({
        at: new Date().toISOString(),
        type: 'audit-failed',
        backupId: audit?.id ?? 'experiment',
        detail: 'Experiment logging failed. Export the available log from Experiment history.',
      });

    const done = (async () => {
      try {
        const deps = this.makeDeps(abort.signal);
        audit = deps.audit;
        await audit?.start(req);
        for await (const e of runSession(req, deps)) {
          apply(e);
          try {
            await audit?.append(e);
          } catch {
            reportAuditFailure();
          }
        }
      } catch (err) {
        // The orchestrator reports its own failures as events; an escape means a bug.
        // After the request may have left, "unknown" is the only honest answer.
        const outcome: CodingEvent = {
          at: new Date().toISOString(),
          type: 'outcome',
          outcome: state.progress.sent ? 'pending-uncertain' : 'not-sent',
          phase: err instanceof Error ? err.message : 'Unexpected error.',
        };
        apply(outcome);
        try {
          await audit?.append(outcome);
        } catch {
          reportAuditFailure();
        }
      } finally {
        try {
          await audit?.close();
        } catch {
          reportAuditFailure();
        }
        this.current = undefined;
      }
      return state.progress;
    })();

    return {
      done,
      cancel: () => {
        if (state.progress.result) return;
        abort.abort();
        const event: CodingEvent = {
          at: new Date().toISOString(),
          type: 'cancel-requested',
          afterSend: state.progress.sent,
        };
        apply(event);
        // The experiment log keeps the request too; a failure here is reported like any other.
        void Promise.resolve(audit?.append(event)).catch(reportAuditFailure);
      },
    };
  }
}
