import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { settingsOf } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { type CodingDeps, isQuarantined, runSession } from './run.ts';
import type { BackupStore, CodingEvent, DidWrite, SequenceSpec, WriteOptions } from './types.ts';

/**
 * C2 through the session: what the writer reports after (or before) a declared sequence's payload becomes
 * the outcome, the phase the user reads, and the journal — never "not sent" or "rejected" once the payload was
 * acknowledged, and never "nothing changed" when a step before it changed the control unit.
 */

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const recipe = {
  ...(APP_DATA.recipes['csmqb-mib3-sound-signature'] as Recipe),
  choices: [{ id: 'variant-001', label: 'Small preset', value: 0, payload: 'CCDD' }],
} as Recipe;
const feature: FeatureItem = {
  id: 'beats-audio',
  name: recipe.name,
  tier: 'experimental',
  statusLabel: 'EXPERIMENTAL',
  recipeId: recipe.id,
  settings: settingsOf(recipe),
};

class Memory implements BackupStore {
  records = new Map<string, BackupRecord>();
  async save(b: BackupRecord) {
    this.records.set(b.id, structuredClone(b));
  }
  async update(id: string, patch: Parameters<BackupStore['update']>[1]) {
    const cur = this.records.get(id);
    if (cur) this.records.set(id, { ...cur, ...patch });
  }
}

/** A simulated MIB3 whose sequence writer returns `result`, applying the payload first when `applies`. */
async function session(result: DidWrite, applies: boolean) {
  let t = 0;
  const now = () => new Date(Date.UTC(2026, 9, 25, 12, 0, 0, t++));
  const car = new SimulatedCar({ parts: { '773': '3G5035816A' }, values: { '773:7201': 'AABB' }, now });
  car.sequence = async (_m, spec: SequenceSpec, options: WriteOptions) => {
    options.onSend?.();
    if (applies && spec.write.kind === 'did') car.values.set('773:7201', spec.write.bytes);
    return result;
  };
  const backups = new Memory();
  const deps: CodingDeps = {
    link: car,
    backups,
    signal: new AbortController().signal,
    now,
    newId: () => 'seq-0001',
    sleep: async () => {},
    readbackDelayMs: 0,
    recipeFor: (id) => (id === recipe.id ? recipe : APP_DATA.recipes[id]),
    featureFor: () => feature,
  };
  const events: CodingEvent[] = [];
  for await (const e of runSession({ kind: 'apply', car: CAR, feature, settingId: 'variant-001' }, deps))
    events.push(e);
  return { events, record: backups.records.get('seq-0001'), car };
}
const outcomeOf = (events: CodingEvent[]) => events.find((e) => e.type === 'outcome');
const RESTORES = [
  { cmd: '2EF1A0AA11', outcome: 'acked' as const },
  { cmd: '2EF1A1BB22', outcome: 'acked' as const },
];

describe('after an acknowledged payload (C2)', () => {
  it('a refused reset: verified on the read-back, the refusal named, and recorded', async () => {
    const steps = [...RESTORES, { cmd: '1102', outcome: 'refused' as const, nrc: '22' }];
    const { events, record } = await session(
      { kind: 'acked', steps, incomplete: { step: '1102', reason: 'refused', nrc: '22' } },
      true,
    );
    expect(outcomeOf(events)).toMatchObject({
      outcome: 'verified',
      phase: expect.stringMatching(
        /didn't accept the restart of that part of the car, so we stopped there and repeated nothing/,
      ),
    });
    expect(record).toMatchObject({
      status: 'verified',
      ack: 'received',
      sequenceSteps: steps,
      sequenceIncomplete: { step: '1102', reason: 'refused', nrc: '22' },
    });
  });

  it('expired readiness before the reset: verified, and it says the reset was not sent', async () => {
    const { events, record } = await session(
      { kind: 'acked', steps: RESTORES, incomplete: { step: '1102', reason: 'not-ready' } },
      true,
    );
    expect(outcomeOf(events)).toMatchObject({
      outcome: 'verified',
      phase: expect.stringMatching(
        /car check ran out of time before the restart of that part of the car, so it was not sent/,
      ),
    });
    expect(record?.sequenceIncomplete).toEqual({ step: '1102', reason: 'not-ready' });
  });

  it('a link lost during the reset: uncertain, the ACK kept, the link retired, no read-back', async () => {
    const { events, record, car } = await session(
      { kind: 'acked', steps: RESTORES, incomplete: { step: '1102', reason: 'link-lost' } },
      true,
    );
    expect(outcomeOf(events)).toMatchObject({
      outcome: 'pending-uncertain',
      phase: expect.stringMatching(/accepted the change.*lost during the restart of that part of the car/),
    });
    expect(events.map((e) => e.type)).toContain('write-acked');
    expect(events.map((e) => e.type)).not.toContain('check-started');
    expect(record).toMatchObject({ status: 'unconfirmed', outcome: 'pending-uncertain', ack: 'received' });
    expect(isQuarantined(car)).toBe(true);
  });
});

describe('a download that stopped part-way (C2/C4)', () => {
  it('is uncertain — never "rejected" or "nothing changed" — and the link is retired', async () => {
    const { events, record, car } = await session(
      {
        kind: 'partial',
        detail: 'The control unit refused data block 2 of 3 (code 72).',
        steps: [{ cmd: '3400441234', outcome: 'acked' }],
      },
      false,
    );
    const outcome = outcomeOf(events);
    expect(outcome).toMatchObject({
      outcome: 'pending-uncertain',
      phase: expect.stringMatching(/block 2 of 3.*Part of the change may already be stored/),
    });
    expect(JSON.stringify(outcome)).not.toMatch(/nothing was changed/i);
    expect(record).toMatchObject({ status: 'unconfirmed', outcome: 'pending-uncertain' });
    expect(isQuarantined(car)).toBe(true);
  });
});

describe('stopped before the payload, after changing the control unit (C2)', () => {
  it('says what the sequence did change', async () => {
    const { events, record } = await session(
      {
        kind: 'not-sent',
        detail: 'The control unit refused step 31010300 (code 22).',
        steps: [
          { cmd: '2EF1A0AA11', outcome: 'acked' },
          { cmd: '31010300', outcome: 'refused', nrc: '22' },
        ],
        markers: [{ did: 'F198', outcome: 'acked' }],
      },
      false,
    );
    expect(outcomeOf(events)).toMatchObject({
      outcome: 'not-sent',
      phase: expect.stringMatching(
        /setting itself was not sent.*note the date of this change attempt.*accepted the restore of the part's identity details/,
      ),
    });
    expect(record).toMatchObject({
      status: 'refused',
      sequenceSteps: [
        { cmd: '2EF1A0AA11', outcome: 'acked' },
        { cmd: '31010300', outcome: 'refused', nrc: '22' },
      ],
    });
  });

  it('a cancel after a mutation says so, and names it', async () => {
    const { events } = await session(
      {
        kind: 'cancelled',
        steps: [{ cmd: '2EF1A0AA11', outcome: 'acked' }],
        markers: [{ did: 'F199', outcome: 'acked' }],
      },
      false,
    );
    expect(outcomeOf(events)).toMatchObject({
      outcome: 'cancelled',
      phase: expect.stringMatching(
        /before the setting was sent.*note the date of this change attempt.*restore of the part's identity details/,
      ),
    });
  });
});
