import { describe, expect, it } from 'vitest';
import { findFeature } from '../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../domain/catalog/types.ts';
import type { CodingEvent, CodingRequest } from '../domain/coding/types.ts';
import {
  buildTimeline,
  formatSeconds,
  moduleName,
  stepSeconds,
  type TimelineStep,
} from './coding-timeline.ts';

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const blinks = findFeature(CAR, 'comfort-lane-change-indicator-5-flashes');
if (!blinks) throw new Error('fixture');
const apply: CodingRequest = { kind: 'apply', car: CAR, feature: blinks, settingId: 'value-5' };

let tick = 0;
/** Events one second apart, from a fixed start. */
const at = () => new Date(Date.UTC(2026, 10, 2, 10, 0, tick++)).toISOString();
const ev = (e: Record<string, unknown>): CodingEvent => ({ at: at(), ...e }) as CodingEvent;

const byKey = (steps: readonly TimelineStep[]) => Object.fromEntries(steps.map((s) => [s.key, s]));
/** Technical words that must never reach the step list. */
const INTERNAL = /\b(did|nrc|0x|f1[89][0-9a-f]|seed|ecu|uds|can id|byte|hex|0A5E|70E)\b/i;

function happyPath(): CodingEvent[] {
  tick = 0;
  return [
    ev({ type: 'verify-started' }),
    ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: '2Q0937089D' }),
    ev({
      type: 'readiness',
      ok: true,
      rpm: 0,
      speedKmh: 0,
      voltage: 12.6,
      measuredAt: '2026-11-02T10:00:02Z',
      ageMs: 5,
    }),
    ev({ type: 'backup-saved', backupId: 'b1' }),
    ev({ type: 'writer', step: 'session-open', did: '0A5E' }),
    ev({ type: 'writer', step: 'seed', detail: '27 03' }),
    ev({ type: 'security-access' }),
    ev({ type: 'writer', step: 'key' }),
    ev({ type: 'request-sent', did: '0A5E' }),
    ev({ type: 'response-pending' }),
    ev({ type: 'write-acked' }),
    ev({ type: 'check-started' }),
    ev({ type: 'readback', observed: '3E00000000', matches: true }),
    ev({ type: 'outcome', outcome: 'verified', phase: 'done' }),
  ];
}

describe('the writing screen step list', () => {
  it('lists every stage of a change, in order, all waiting before anything happens', () => {
    const { steps } = buildTimeline(apply, []);
    expect(steps.map((s) => s.key)).toEqual([
      'connect',
      'ready',
      'backup',
      'unlock',
      'write',
      'confirm',
      'outcome',
    ]);
    expect(steps.every((s) => s.state === 'pending')).toBe(true);
    expect(byKey(steps).unlock?.title).toBe('Unlocking the central electrics');
  });

  it('moves one step at a time on real events, with the active step saying what is happening', () => {
    const events = happyPath();
    const upTo = (n: number) => byKey(buildTimeline(apply, events.slice(0, n)).steps);

    expect(upTo(1).connect).toMatchObject({ state: 'active', detail: 'Connecting to your car' });
    expect(upTo(2).connect).toMatchObject({ state: 'done', detail: "It's your car · MEXK…1234" });
    expect(upTo(2).ready?.state).toBe('active');
    expect(upTo(3).ready).toMatchObject({ state: 'done', detail: 'Parked, engine off · battery 12.6 V' });
    expect(upTo(4).backup).toMatchObject({ state: 'done', detail: 'Saved. You can undo this anytime' });
    expect(upTo(4).unlock?.state).toBe('active');
    expect(upTo(6).unlock?.detail).toBe('Asking the central electrics for access');
    expect(upTo(8).unlock?.detail).toBe('Sending the access code');
    expect(upTo(9).unlock?.state).toBe('done');
    expect(upTo(9).write).toMatchObject({ state: 'active', detail: 'Sending the new setting' });
    expect(upTo(10).write?.detail).toBe('Your car is saving the change');
    expect(upTo(12).write?.state).toBe('done');
    expect(upTo(12).confirm).toMatchObject({ state: 'active', detail: 'Reading the setting back' });
    expect(upTo(13).confirm).toMatchObject({ state: 'done', detail: 'Your car has the new setting' });

    const final = buildTimeline(apply, events).steps;
    expect(final.every((s) => s.state === 'done')).toBe(true);
    expect(byKey(final).outcome?.detail).toBe('All done');
  });

  it('never shows identifiers, codes or bytes', () => {
    const events = happyPath();
    for (let n = 0; n <= events.length; n++) {
      for (const s of buildTimeline(apply, events.slice(0, n)).steps) {
        expect(s.title).not.toMatch(INTERNAL);
        expect(s.detail ?? '').not.toMatch(INTERNAL);
      }
    }
  });

  it('times each step: finished steps keep their time, the active one counts up', () => {
    const events = happyPath();
    const steps = byKey(buildTimeline(apply, events.slice(0, 10)).steps);
    const connect = steps.connect as TimelineStep;
    expect(stepSeconds(connect, 0)).toBe(1);
    const write = steps.write as TimelineStep;
    expect(stepSeconds(write, Date.parse(write.startedAt ?? '') + 7_400)).toBe(7);
    expect(stepSeconds(steps.outcome as TimelineStep, 0)).toBeUndefined();
    expect(formatSeconds(8)).toBe('8 s');
    expect(formatSeconds(65)).toBe('1 min 05 s');
  });

  it('ignores writer steps it does not know, and ones with nothing to say', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'backup-saved', backupId: 'b1' }),
      ev({ type: 'writer', step: 'something-new', detail: '7F 2E 33' }),
      ev({ type: 'writer', step: 'nrc', detail: '33' }),
    ];
    const steps = byKey(buildTimeline(apply, events).steps);
    expect(steps.unlock).toMatchObject({ state: 'active', detail: 'Getting the central electrics ready' });
  });

  it('shows a readiness problem as a warning and carries on', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'readiness', ok: false, rpm: 820, speedKmh: 0, voltage: 14.1, measuredAt: '', ageMs: 0 }),
      ev({ type: 'warning', code: 'readiness', detail: 'engine running' }),
    ];
    const steps = byKey(buildTimeline(apply, events).steps);
    expect(steps.ready).toMatchObject({ state: 'warning' });
    expect(steps.ready?.detail).toMatch(/engine is running/i);
    expect(steps.backup?.state).toBe('active');
  });

  it('marks the step that stopped as failed, and an unconfirmed result as a warning', () => {
    const events = happyPath();
    const refused = [...events.slice(0, 9), ev({ type: 'outcome', outcome: 'rejected', phase: 'NRC 22' })];
    const r = byKey(buildTimeline(apply, refused).steps);
    expect(r.write?.state).toBe('failed');
    expect(r.outcome).toMatchObject({ state: 'failed', detail: "Your car didn't accept the change" });
    expect(r.confirm?.state).toBe('pending');

    const unsure = [
      ...events.slice(0, 12),
      ev({ type: 'readback', observed: '3C00000000', matches: false }),
      ev({ type: 'outcome', outcome: 'mismatch', phase: 'x' }),
    ];
    const u = byKey(buildTimeline(apply, unsure).steps);
    expect(u.confirm).toMatchObject({ state: 'warning', detail: 'Your car shows a different value' });
    expect(u.outcome).toMatchObject({ state: 'warning', detail: "We couldn't confirm it" });

    const cancelled = [...events.slice(0, 2), ev({ type: 'outcome', outcome: 'cancelled', phase: 'x' })];
    expect(byKey(buildTimeline(apply, cancelled).steps).outcome).toMatchObject({
      state: 'failed',
      detail: 'Cancelled',
    });
  });

  it('says plainly when the car already had the setting', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'refused', reason: 'already-set', detail: 'x' }),
      ev({ type: 'outcome', outcome: 'not-sent', phase: 'x' }),
    ];
    const steps = buildTimeline(apply, events).steps;
    expect(byKey(steps).outcome).toMatchObject({ state: 'done', detail: 'It was already set that way' });
  });

  it('says in one plain line why a change stopped before anything was sent', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'refused', reason: 'restore-conflict', detail: 'x' }),
      ev({ type: 'outcome', outcome: 'not-sent', phase: 'x' }),
    ];
    const outcome = byKey(buildTimeline(apply, events).steps).outcome;
    expect(outcome).toMatchObject({
      state: 'failed',
      detail: 'The setting was changed since, so we left it. Nothing was changed',
    });
    expect(outcome?.detail).not.toMatch(INTERNAL);
  });

  it('says the original setting is being read while the readiness check is pending, and drops it if none came', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'backup-saved', backupId: 'b1' }),
    ];
    expect(byKey(buildTimeline(apply, events.slice(0, 2)).steps).ready).toMatchObject({
      state: 'active',
      detail: 'Reading your current setting',
    });
    const ready = byKey(buildTimeline(apply, events).steps).ready;
    expect(ready?.state).toBe('done');
    expect(ready?.detail).toBeUndefined();
  });

  it('names modules the scan does not cover', () => {
    expect(moduleName('74F')).toBe('front camera');
    expect(moduleName('757')).toBe('cruise control');
    expect(moduleName('7FF')).toBe('module');
  });

  it('shows "Part n of m" for a multi-part change and starts each part afresh on its own module', () => {
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({ type: 'backup-saved', backupId: 'b1' }),
      ev({ type: 'group-step', index: 0, of: 2, module: { request: '70E', response: '778' }, did: '0600' }),
      ev({ type: 'request-sent', did: '0600' }),
      ev({ type: 'check-started' }),
      ev({ type: 'readback', observed: '00', matches: true }),
      ev({ type: 'group-step', index: 1, of: 2, module: { request: '714', response: '77E' }, did: '0600' }),
    ];
    const first = buildTimeline(apply, events.slice(0, 7));
    expect(first.part).toEqual({ n: 1, of: 2, module: 'central electrics' });
    expect(byKey(first.steps).confirm).toMatchObject({ state: 'done', detail: 'Part 1 confirmed' });
    const second = buildTimeline(apply, events);
    expect(second.part).toEqual({ n: 2, of: 2, module: 'instrument cluster' });
    const s = byKey(second.steps);
    expect(s.unlock).toMatchObject({
      state: 'active',
      title: 'Unlocking the instrument cluster',
      detail: 'Part 2 of 2',
    });
    expect(s.write?.state).toBe('pending');
    expect(s.confirm?.state).toBe('pending');
  });

  it('adds a "choosing the right version" step for a feature that picks one, and fills it in', () => {
    const alt: FeatureItem = { ...blinks, recipeId: 'assist:lane-assist-save-state' };
    const request: CodingRequest = { kind: 'apply', car: CAR, feature: alt, settingId: 'enabled' };
    tick = 0;
    const events = [
      ev({ type: 'verify-started' }),
      ev({ type: 'car-verified', vinMasked: 'MEXK…1234', part: 'x' }),
      ev({
        type: 'variant-selected',
        recipeId: 'x',
        selector: 'mib3',
        did: '0600',
        reason: 'F19E',
        probe: { reads: {} },
      }),
    ];
    const steps = byKey(buildTimeline(request, events).steps);
    expect(steps.variant).toMatchObject({
      title: 'Choosing the right version for your car',
      state: 'done',
      detail: 'Found the right version for your car',
    });
    expect(steps.ready?.state).toBe('active');
    expect(buildTimeline(apply, []).steps.some((x) => x.key === 'variant')).toBe(false);
  });

  it('a check or a scan shows only connecting, reading and the result', () => {
    const inspect: CodingRequest = {
      kind: 'inspect',
      car: CAR,
      module: { request: '70E', response: '778' },
      unit: '09',
      label: 'central electrics',
    };
    expect(buildTimeline(inspect, []).steps.map((s) => s.title)).toEqual([
      "Checking it's your car",
      "Reading your car's settings",
      'Done',
    ]);
  });

  it('names modules in everyday words', () => {
    expect(moduleName('70E')).toBe('central electrics');
    expect(moduleName('714')).toBe('instrument cluster');
    expect(moduleName('7FF')).toBe('module');
    expect(moduleName(null)).toBe('module');
  });
});
