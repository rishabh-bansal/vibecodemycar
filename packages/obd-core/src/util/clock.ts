/**
 * Time source. Deadlines are always checked against now(), never trusted to a
 * timer firing on time: Chrome on Android throttles timers when the screen is off
 * or the tab is hidden, which is how a 2 s timeout became 143 s in v1.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

/**
 * Deterministic clock for tests and the emulator. Time only moves when advanced;
 * sleepers wake in deadline order. advanceUntilIdle() drains every pending timer.
 */
export class VirtualClock implements Clock {
  private t = 0;
  private seq = 0;
  private timers: { at: number; seq: number; fire: () => void }[] = [];

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.schedule(ms, resolve));
  }

  schedule(ms: number, fire: () => void): void {
    this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire });
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  pending(): number {
    return this.timers.length;
  }

  /** Fires the next timer (jumping time to it); false when none is pending. */
  step(): boolean {
    const next = this.timers.shift();
    if (!next) return false;
    this.t = Math.max(this.t, next.at);
    next.fire();
    return true;
  }
}

/**
 * Runs an async task to completion on a virtual clock: lets microtasks settle,
 * then advances to the next timer, until the task resolves.
 */
export async function runVirtual<T>(clock: VirtualClock, task: Promise<T>, maxSteps = 5_000_000): Promise<T> {
  let done = false;
  let failed = false;
  let value: T | undefined;
  let error: unknown;
  task.then(
    (v) => { done = true; value = v; },
    (e) => { done = true; failed = true; error = e; },
  );
  for (let i = 0; i < maxSteps; i++) {
    await flushMicrotasks();
    if (done) break;
    if (!clock.step()) {
      await flushMicrotasks();
      if (done) break;
      throw new Error('runVirtual: task is waiting but no timer is pending (deadlock)');
    }
  }
  if (!done) throw new Error('runVirtual: step limit reached');
  if (failed) throw error; // even a rejection with `undefined` is a failure
  return value as T;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
