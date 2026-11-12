import { createHash } from 'node:crypto';
import { OBDCraftEngine, VirtualClock } from '@obdcraft/obd-core';
import { vi } from 'vitest';
import { WebBluetoothLink } from '../web-bluetooth.ts';
import { CloneElmSim, type CloneSimOptions, type EcuSpec, type FaultModel } from './clone-sim.ts';

/**
 * Test plumbing for the clone simulator: the real engine, ELM session and Bluetooth link over a
 * {@link CloneElmSim}, all on one virtual clock.
 *
 * Two things outside the stack would otherwise break determinism:
 *  - code that uses the global `setTimeout` (the domain's write backstop, the link's read retry and close wait):
 *    while {@link drive} runs, `setTimeout`/`clearTimeout` schedule on the virtual clock;
 *  - `crypto.subtle.digest`, which resolves on the thread pool: {@link installDeterministicDigest} answers it
 *    synchronously, so the clock never steps while real work is in flight.
 */

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

interface VirtualTimer {
  cancelled: boolean;
  unref(): VirtualTimer;
  ref(): VirtualTimer;
  hasRef(): boolean;
}

/** Runs `task` to completion with the virtual clock as the only notion of time. */
export async function drive<T>(
  clock: VirtualClock,
  task: () => Promise<T>,
  maxSteps = 5_000_000,
): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout };
  g.setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer: VirtualTimer = {
      cancelled: false,
      unref: () => timer,
      ref: () => timer,
      hasRef: () => true,
    };
    clock.schedule(Number(ms) || 0, () => {
      if (!timer.cancelled) fn(...args);
    });
    return timer;
  };
  g.clearTimeout = (timer: unknown) => {
    if (timer && typeof timer === 'object' && 'cancelled' in timer) (timer as VirtualTimer).cancelled = true;
    else realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  };
  let done = false;
  let failed = false;
  let value: T | undefined;
  let error: unknown;
  try {
    task().then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        failed = true;
        error = e;
      },
    );
    let idle = 0;
    for (let i = 0; i < maxSteps && !done; i++) {
      await new Promise<void>((r) => realSetImmediate(r));
      if (done) break;
      if (clock.step()) {
        idle = 0;
        continue;
      }
      // Nothing scheduled: real I/O may still be settling. Bounded, so a true deadlock fails loudly.
      if (++idle > 200) throw new Error('drive: the task is waiting but nothing is scheduled (deadlock)');
      await new Promise<void>((r) => realSetTimeout(r, 1));
    }
    if (!done) throw new Error('drive: step limit reached');
  } finally {
    g.setTimeout = saved.setTimeout;
    g.clearTimeout = saved.clearTimeout;
  }
  if (failed) throw error;
  return value as T;
}

/** `crypto.subtle.digest` answered synchronously (same bytes), so no step of a run depends on thread timing. */
export function installDeterministicDigest(): () => void {
  const subtle = globalThis.crypto.subtle;
  const spy = vi.spyOn(subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).replace('-', '').toLowerCase();
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
    const out = createHash(name).update(view).digest();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  });
  return () => spy.mockRestore();
}

export interface SimRig {
  clock: VirtualClock;
  sim: CloneElmSim;
  engine: OBDCraftEngine;
  link: WebBluetoothLink;
}

/** Connects the production engine (native coding startup) and Bluetooth link to a fresh simulator. */
export async function simRig(opts: {
  seed: number;
  ecus: readonly EcuSpec[];
  model?: Partial<FaultModel>;
  extra?: Partial<CloneSimOptions>;
}): Promise<SimRig> {
  const clock = new VirtualClock();
  const sim = new CloneElmSim({ clock, seed: opts.seed, ecus: opts.ecus, model: opts.model, ...opts.extra });
  const engine = new OBDCraftEngine({ clock, startup: 'diagnostic-can' });
  await drive(clock, () => engine.connect(sim));
  const link = WebBluetoothLink.adopt(engine);
  return { clock, sim, engine, link };
}
