import { describe, expect, it } from 'vitest';
import type { ElmLink } from '../src/elm/link.ts';
import { ThroughputTuner } from '../src/engine/tuner.ts';

/** A link that accepts every setting instantly, on a frozen clock. */
function fakeLink(): ElmLink {
  const link = {
    clock: { now: () => 0 },
    protocol: { family: 'can11', number: 6 },
    config: { spaces: true, headers: true, adaptiveTiming: 1, st: null, target: 'functional' },
    async apply(next: Record<string, unknown>) {
      Object.assign(link.config, next);
      return { applied: [], failed: [] };
    },
  };
  return link as unknown as ElmLink;
}
const sample = (good: number) => ({ durationMs: 10, expected: 1, good });

describe('throughput tuner', () => {
  it('never judges an experiment on data measured before its settings were applied', async () => {
    const tuner = new ThroughputTuner(fakeLink(), { windowRequests: 2, windowMs: 0 });
    tuner.start('adapter');
    await tuner.beforeRequest();
    tuner.observe(sample(1));
    tuner.observe(sample(1)); // baseline measured → "count" is next
    for (const _rejected of ['count', 'ats0']) {
      await tuner.beforeRequest();
      tuner.observe(sample(1));
      tuner.observe(sample(1)); // no gain → rejected
    }
    await tuner.beforeRequest(); // "multi2" applied
    tuner.observe(sample(1));
    // The engine reports a failed multi-PID reply, then observes that same request.
    tuner.multiPidFailed(); // multi2 rejected; "multi3" decided but not yet applied
    tuner.observe(sample(100));
    const s = tuner.summary();
    expect(s.rejected).toContain('multi2');
    expect(s.accepted).not.toContain('multi3');
    expect(s.rejected).not.toContain('multi3');
  });
});
