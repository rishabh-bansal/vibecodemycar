import { describe, expect, it } from 'vitest';
import type { BackupRecord } from '../backups/schema.ts';
import { elapsedSeconds, foldEvents, initialProgress, isBusy, reduceProgress } from './progress.ts';
import type { CodingEvent } from './types.ts';

const t = (n: number) => new Date(Date.UTC(2026, 9, 24, 12, 0, n)).toISOString();
const e = (n: number, ev: object): CodingEvent => ({ at: t(n), ...ev }) as CodingEvent;

const happy: CodingEvent[] = [
  e(0, { type: 'verify-started' }),
  e(1, { type: 'car-verified', vinMasked: 'MEXK…1234', part: '2Q0937089D' }),
  e(2, { type: 'backup-saved', backupId: 'b1' }),
  e(3, { type: 'request-sent', did: '0A5E' }),
  e(4, { type: 'write-acked' }),
  e(5, { type: 'check-started' }),
  e(6, { type: 'readback', observed: '3E00000000', matches: true }),
  e(7, { type: 'outcome', outcome: 'verified', phase: 'ok' }),
];

describe('reduceProgress', () => {
  it('walks the four steps in order and ends in success', () => {
    const p = foldEvents(happy);
    expect(p.steps).toEqual({ verify: 'done', backup: 'done', write: 'done', check: 'done' });
    expect(p.result).toEqual({ kind: 'success', acknowledged: true });
    expect(p.vinMasked).toBe('MEXK…1234');
  });

  it('shows the active write step while the car is still saving', () => {
    const p = foldEvents([...happy.slice(0, 4), e(4, { type: 'response-pending' })]);
    expect(p.steps.write).toBe('active');
    expect(p.waitingOnCar).toBe(true);
    expect(p.result).toBeUndefined();
    expect(isBusy(p)).toBe(true);
  });

  it('measures real elapsed time from the moment the request left', () => {
    const p = foldEvents(happy.slice(0, 4));
    expect(elapsedSeconds(p, Date.parse(t(17)))).toBe(14);
    expect(elapsedSeconds(initialProgress, Date.parse(t(17)))).toBe(0);
  });

  it('calls observed-match a success without claiming an acknowledgement', () => {
    const p = foldEvents([
      ...happy.slice(0, 3),
      e(3, { type: 'request-sent', did: '0A5E' }),
      e(4, { type: 'response-pending' }),
      e(5, { type: 'check-started' }),
      e(6, { type: 'readback', observed: '3E00000000', matches: true }),
      e(7, { type: 'outcome', outcome: 'observed-match', phase: '' }),
    ]);
    expect(p.result).toEqual({ kind: 'success', acknowledged: false });
  });

  it('carries what the module changed outside the recipe into the success result', () => {
    const managed = [{ offset: 2, wrote: '00', stored: 'A0' }];
    const p = foldEvents([
      ...happy.slice(0, 6),
      e(6, { type: 'readback', observed: '3E00A00000', matches: true, moduleManaged: managed }),
      e(7, { type: 'outcome', outcome: 'verified', phase: '' }),
    ]);
    expect(p.result).toMatchObject({ kind: 'success', moduleManaged: managed });
  });

  it('drops an earlier module-managed note when a later read-back does not match', () => {
    const p = foldEvents([
      ...happy.slice(0, 6),
      e(6, {
        type: 'readback',
        observed: '3E00A00000',
        matches: true,
        moduleManaged: [{ offset: 2, wrote: '00', stored: 'A0' }],
      }),
      e(7, { type: 'readback', observed: '3C00000000', matches: false }),
    ]);
    expect(p.moduleManaged).toBeUndefined();
  });

  it('keeps stored coding markers on a refusal, so the screen never says "nothing changed"', () => {
    const p = foldEvents([
      ...happy.slice(0, 3),
      e(3, {
        type: 'markers',
        markers: [
          { did: 'F199', outcome: 'acked' },
          { did: 'F198', outcome: 'refused' },
        ],
      }),
      e(4, { type: 'refused', reason: 'ecu-refused', detail: 'stopped' }),
      e(5, { type: 'outcome', outcome: 'not-sent', phase: 'stopped' }),
    ]);
    expect(p.result).toMatchObject({ kind: 'refused', markersStored: [{ did: 'F199', outcome: 'acked' }] });
  });

  it('keeps the exportable record when a later logging failure reports none', () => {
    const record = { id: 'b1' } as unknown as BackupRecord;
    const p = foldEvents([
      ...happy.slice(0, 3),
      e(3, { type: 'audit-failed', backupId: 'b1', detail: 'backup not saved', record }),
      e(4, { type: 'audit-failed', backupId: 'experiment', detail: 'experiment log failed' }),
    ]);
    expect(p.auditFailure).toMatchObject({ backupId: 'b1', detail: 'backup not saved', record });
  });

  it('NEVER shows success on an outcome label alone — the read-back must have matched', () => {
    const forged = foldEvents([
      ...happy.slice(0, 6),
      e(6, { type: 'readback', observed: '3C00000000', matches: false }),
      e(7, { type: 'outcome', outcome: 'verified', phase: 'claimed' }),
    ]);
    expect(forged.result?.kind).toBe('unconfirmed');

    const noReadback = foldEvents([
      ...happy.slice(0, 6),
      e(7, { type: 'outcome', outcome: 'verified', phase: 'claimed' }),
    ]);
    expect(noReadback.result?.kind).toBe('unconfirmed');
  });

  it('uses the LATEST read-back, so a later mismatch cannot hide behind an earlier match', () => {
    const p = foldEvents([
      ...happy.slice(0, 6),
      e(6, { type: 'readback', observed: '3E00000000', matches: true }),
      e(7, { type: 'readback', observed: '3C00000000', matches: false }),
      e(8, { type: 'outcome', outcome: 'observed-match', phase: '' }),
    ]);
    expect(p.result?.kind).toBe('unconfirmed');
  });

  it('maps a mismatch to "can’t confirm"', () => {
    const p = foldEvents([
      ...happy.slice(0, 6),
      e(6, { type: 'readback', observed: '3C00000000', matches: false }),
      e(7, { type: 'outcome', outcome: 'mismatch', phase: 'differs' }),
    ]);
    expect(p.result).toMatchObject({ kind: 'unconfirmed', why: 'mismatch' });
    expect(p.steps.check).toBe('failed');
  });

  it('maps a dropped link after send to "can’t confirm", flagged as link-lost', () => {
    const p = foldEvents([
      ...happy.slice(0, 4),
      e(4, { type: 'link-lost' }),
      e(5, { type: 'outcome', outcome: 'pending-uncertain', phase: 'dropped' }),
    ]);
    expect(p.result).toMatchObject({ kind: 'unconfirmed', why: 'link-lost' });
  });

  it('maps an ECU refusal to "nothing changed"', () => {
    const p = foldEvents([
      ...happy.slice(0, 4),
      e(4, { type: 'refused', reason: 'ecu-refused', detail: 'code 88' }),
      e(5, { type: 'outcome', outcome: 'rejected', phase: 'refused' }),
    ]);
    expect(p.result).toEqual({ kind: 'refused', reason: 'ecu-refused', detail: 'code 88' });
    expect(p.steps.write).toBe('failed');
  });

  it('distinguishes wrong car, already-set and generic refusals when nothing was sent', () => {
    const base = [e(0, { type: 'verify-started' })];
    const refusal = (reason: string, outcome = 'not-sent') =>
      foldEvents([
        ...base,
        e(1, { type: 'refused', reason, detail: 'd' }),
        e(2, { type: 'outcome', outcome, phase: 'p' }),
      ]).result;
    expect(refusal('wrong-car')).toMatchObject({ kind: 'wrong-car' });
    expect(refusal('already-set')).toEqual({ kind: 'unchanged' });
    expect(refusal('unknown-module')).toMatchObject({ kind: 'refused', reason: 'unknown-module' });
  });

  it('marks the verify step failed when it stops there', () => {
    const p = foldEvents([
      e(0, { type: 'verify-started' }),
      e(1, { type: 'refused', reason: 'wrong-car', detail: 'x' }),
      e(2, { type: 'outcome', outcome: 'not-sent', phase: '' }),
    ]);
    expect(p.steps.verify).toBe('failed');
    expect(p.steps.write).toBe('pending');
  });

  it('records a cancel and ends cancelled when nothing was sent', () => {
    const p = foldEvents([
      e(0, { type: 'verify-started' }),
      e(1, { type: 'cancel-requested', afterSend: false }),
      e(2, { type: 'outcome', outcome: 'cancelled', phase: '' }),
    ]);
    expect(p.result).toEqual({ kind: 'cancelled' });
  });

  it('ignores anything after the final result', () => {
    const done = foldEvents(happy);
    expect(reduceProgress(done, e(9, { type: 'link-lost' }))).toBe(done);
  });

  it('is not busy before it starts or after it ends', () => {
    expect(isBusy(initialProgress)).toBe(false);
    expect(isBusy(foldEvents(happy))).toBe(false);
  });

  it('collects warnings, SecurityAccess and the current group part without failing a step', () => {
    const p = foldEvents([
      e(0, { type: 'verify-started' }),
      e(1, { type: 'car-verified', vinMasked: 'MEXS…0001', part: 'unknown' }),
      e(2, { type: 'warning', code: 'identity', detail: 'no part' }),
      e(3, { type: 'warning', code: 'readiness', detail: 'engine running' }),
      e(4, { type: 'backup-saved', backupId: 'b' }),
      e(5, { type: 'group-step', index: 1, of: 2, module: { request: '714', response: '77E' }, did: '6001' }),
      e(6, { type: 'security-access' }),
    ]);
    expect(p.warnings?.map((w) => w.code)).toEqual(['identity', 'readiness']);
    expect(p.securitySent).toBe(true);
    expect(p.group).toEqual({ index: 1, of: 2, did: '6001' });
    expect(p.steps.verify).toBe('done');
    expect(p.result).toBeUndefined();
  });
});
