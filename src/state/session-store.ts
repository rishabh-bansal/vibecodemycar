import { create } from 'zustand';
import { BusyError, CodingController, type SessionHandle } from '../domain/coding/controller.ts';
import { type CodingProgress, initialProgress } from '../domain/coding/progress.ts';
import { isQuarantined } from '../domain/coding/run.ts';
import type { CodingEvent, CodingRequest } from '../domain/coding/types.ts';
import { DexieBackupStore } from '../infra/storage/backup-store.ts';
import { requestPersistentStorage } from '../infra/storage/db.ts';
import { ExperimentRecorder } from '../infra/storage/experiment-store.ts';
import { useCarStore } from './car-store.ts';
import { useConnection } from './connection-store.ts';

export const backupStore = new DexieBackupStore();

const controller = new CodingController((signal) => {
  const conn = useConnection.getState();
  if (conn.status !== 'connected') throw new Error('Not connected to a car.');
  const link = conn.link;
  return {
    link,
    audit: new ExperimentRecorder(link),
    backups: backupStore,
    signal,
    // A dropped adapter can be re-established without the picker — the session uses it for
    // read-only scan resumes and provably-unsent coding reruns. Only a Bluetooth link can be re-established.
    ...(link.mode === 'live' ? { relink: () => useConnection.getState().relink() } : {}),
    // Functional, not policy: read identity and the coded DID only. The 301-DID inventory scan silenced
    // the BCM on a live car (F73).
    moduleSnapshot: false,
    // Only a Bluetooth link reads a VIN worth pairing.
    expectedVinFingerprint: link.mode === 'live' ? useCarStore.getState().pairing?.fingerprint : undefined,
  };
});

interface SessionState {
  /** Set by the Connect screen; consumed (once) by the Coding screen. Back-navigation can never re-run a write. */
  armed?: CodingRequest;
  request?: CodingRequest;
  progress: CodingProgress;
  events: readonly CodingEvent[];
  running: boolean;
  /** False (and nothing armed) while a previous session is still finishing. */
  arm(request: CodingRequest): boolean;
  /** Starts the armed request, if any. Safe to call repeatedly: it does nothing once consumed. */
  begin(): void;
  cancel(): void;
  reset(): void;
}

let handle: SessionHandle | undefined;
/** `reset` was asked for while a run was still recording: it happens when the run is done. */
let resetWhenDone = false;

export const useSession = create<SessionState>()((set) => ({
  progress: initialProgress,
  events: [],
  running: false,

  arm(request) {
    if (controller.running) return false;
    set({ armed: request, request: undefined, progress: initialProgress, events: [], running: false });
    return true;
  },

  begin() {
    const request = useSession.getState().armed;
    if (!request || controller.running) return; // a duplicate tap or StrictMode re-run is ignored, not queued
    set({ armed: undefined, request, progress: initialProgress, events: [], running: true });
    resetWhenDone = false;
    void requestPersistentStorage();
    try {
      handle = controller.start(request);
    } catch (e) {
      if (e instanceof BusyError) return;
      throw e;
    }
    void handle.done.then(() => {
      set({ running: false });
      // A reset asked for while the run was still recording its last steps happens now.
      if (resetWhenDone) {
        resetWhenDone = false;
        set({ armed: undefined, request: undefined, progress: initialProgress, events: [] });
      }
      // The run is saved locally; offer it to the private log outbox (a no-op unless this browser is enrolled).
      // Uploading never touches the car.
      void import('../infra/cloud/outbox.ts').then((m) => m.kickCloudSync()).catch(() => {});
      // A link retired after an ambiguous write is never reused: drop it, so the next step reconnects.
      const conn = useConnection.getState();
      if (conn.status === 'connected' && isQuarantined(conn.link)) void conn.disconnect();
    });
  },

  cancel() {
    handle?.cancel();
  },

  reset() {
    if (controller.running) {
      resetWhenDone = true;
      return;
    }
    set({ armed: undefined, request: undefined, progress: initialProgress, events: [], running: false });
  },
}));

controller.subscribe((progress, events) => useSession.setState({ progress, events: [...events] }));
