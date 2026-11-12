import type { CodingEvent } from './coding/types.ts';
import { LOCAL_KEYS, SESSION_KEYS } from './storage-keys.ts';

/**
 * Append-only diagnostic log for field debugging. Every stage of a session —
 * Bluetooth discovery, adapter bring-up, identification, the coding ritual —
 * drops a small structured record here so a failed run can be exported and
 * read later without reproducing the fault.
 *
 * Privacy: records carry codes, counts and hex payloads only — never a raw
 * VIN (the stores already mask it before it reaches events). Storage is a
 * bounded ring in localStorage; exporting is a user action.
 */

export type DiagStage = 'app' | 'ble' | 'adapter' | 'identify' | 'coding' | 'journal' | 'link';

export interface DiagEvent {
  at: string;
  /** Boot counter — separates events from different app sessions. */
  session: number;
  stage: DiagStage;
  kind: string;
  detail?: Record<string, unknown>;
}

const STORAGE_KEY = LOCAL_KEYS.diagnostics;
const MAX_EVENTS = 800;

const boot = ((): number => {
  try {
    const n = Number(sessionStorage.getItem(SESSION_KEYS.diagBoot) ?? 0) + 1;
    sessionStorage.setItem(SESSION_KEYS.diagBoot, String(n));
    return n;
  } catch {
    return 1;
  }
})();

let buffer: DiagEvent[] | null = null;

function load(): DiagEvent[] {
  if (buffer) return buffer;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    buffer = raw ? (JSON.parse(raw) as DiagEvent[]) : [];
  } catch {
    buffer = [];
  }
  return buffer;
}

function persist(events: DiagEvent[]): void {
  buffer = events.slice(-MAX_EVENTS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // Storage full or blocked — keep the in-memory ring; the export still works.
  }
}

const diagListeners = new Set<(event: DiagEvent) => void>();

/** Follows every diagnostic event as it is recorded (the connection log uses it). */
export function onDiag(listener: (event: DiagEvent) => void): () => void {
  diagListeners.add(listener);
  return () => diagListeners.delete(listener);
}

export function recordDiag(stage: DiagStage, kind: string, detail?: Record<string, unknown>): void {
  const event = { at: new Date().toISOString(), session: boot, stage, kind, detail };
  persist([...load(), event]);
  for (const listener of diagListeners) {
    try {
      listener(event);
    } catch {
      // A failing listener never affects the app.
    }
  }
}

/** Feeds the coding-run event stream into the log — one call site in run.ts covers every stage. */
export function feedCodingEvent(e: CodingEvent): void {
  // The journal-only events are small and already compact: kept whole, so the connection log shows every
  // writer decision, the readiness values and the variant choice next to the wire lines they explain.
  if (
    e.type === 'writer' ||
    e.type === 'readiness' ||
    e.type === 'variant-selected' ||
    e.type === 'variant-refused'
  ) {
    const whole: Record<string, unknown> = { ...e };
    delete whole.at;
    recordDiag('coding', e.type, whole);
    return;
  }
  const detail: Record<string, unknown> = { type: e.type };
  if ('outcome' in e) detail.outcome = e.outcome;
  if ('reason' in e) detail.reason = e.reason;
  if ('phase' in e) detail.phase = e.phase;
  if ('detail' in e && typeof e.detail === 'string') detail.detail = e.detail;
  if ('backupId' in e) detail.backupId = e.backupId;
  recordDiag('coding', e.type, detail);
}

export function diagnostics(): DiagEvent[] {
  return [...load()];
}

export function clearDiagnostics(): void {
  persist([]);
}

export function exportDiagnostics(): string {
  const payload = {
    app: 'Vibecode my car',
    exportedAt: new Date().toISOString(),
    session: boot,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    events: diagnostics(),
  };
  return JSON.stringify(payload, null, 1);
}

/** Downloads the log as a .json file. No-op outside the browser. */
export function downloadDiagnostics(): void {
  const blob = new Blob([exportDiagnostics()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vibecode-my-car-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  recordDiag('app', 'diagnostics-exported');
}
