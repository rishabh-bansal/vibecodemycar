import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { DexieBackupStore } from '../../infra/storage/backup-store.ts';
import { ObdcraftDb } from '../../infra/storage/db.ts';
import type { BackupRecord } from '../backups/schema.ts';
import { APP_DATA } from '../catalog/data.ts';
import { settingsOf } from '../catalog/features.ts';
import type { Recipe } from '../catalog/schema.ts';
import type { CarSelection, FeatureItem } from '../catalog/types.ts';
import { crc32Trailer } from './plan.ts';
import { type CodingDeps, runSession } from './run.ts';
import type { CodingEvent, CodingRequest } from './types.ts';

/**
 * Scalar/CRC and dataset recipes through the whole session — the bundled recipe, the domain, the real
 * (schema-validating) backup store and a simulated link: apply, durable record, restore (C3.2–3).
 */

const CAR: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const MIB3 = { '773': '3G5035816A' };

const bundled = (id: string): Recipe => {
  const r = APP_DATA.recipes[id];
  if (!r) throw new Error(`fixture: bundled recipe ${id} is missing`);
  return r;
};
/** The trusted catalogue offering this recipe for the car (the bundled catalogue decides eligibility elsewhere). */
const offer = (recipe: Recipe, id: string): FeatureItem => ({
  id,
  name: recipe.name,
  tier: 'experimental',
  statusLabel: 'EXPERIMENTAL',
  recipeId: recipe.id,
  settings: settingsOf(recipe),
});

let counter = 0;
let store: DexieBackupStore;
beforeEach(() => {
  const db = new ObdcraftDb(`kinds-${counter++}`);
  store = new DexieBackupStore(() => db);
});

/** One clock for the session and the simulated car (the car stamps its readiness evidence with it). */
let ticks = 0;
const now = () => new Date(Date.UTC(2026, 9, 25, 12, 0, 0, ticks++));

function deps(link: SimulatedCar, feature: FeatureItem, extra: Partial<CodingDeps> = {}): CodingDeps {
  let ids = 0;
  return {
    link,
    backups: store,
    signal: new AbortController().signal,
    now,
    newId: () => `kinds-backup-${ids++}`,
    sleep: async () => {},
    readbackDelayMs: 0,
    featureFor: () => feature,
    ...extra,
  };
}

async function run(req: CodingRequest, d: CodingDeps): Promise<CodingEvent[]> {
  const out: CodingEvent[] = [];
  for await (const e of runSession(req, d)) out.push(e);
  return out;
}
const outcome = (events: CodingEvent[]) => events.find((e) => e.type === 'outcome');

describe('CRC-trailer scalar recipe (VIM MIB3): apply → durable record → restore', () => {
  const recipe = bundled('csmqb-vim-mib3-speed-threshold');
  const feature = offer(recipe, 'video-in-motion-through-pen-drive');
  const payload = `0000000050${'11'.repeat(25)}`; // byte 4 = 80 km/h
  const original = `${payload}${crc32Trailer(payload)}`;

  it('restores the field and recomputes the trailer, keeping a byte something else changed since', async () => {
    const car = new SimulatedCar({ parts: MIB3, values: { '773:720D': original }, now });
    const applied = await run(
      { kind: 'apply', car: CAR, feature, settingId: 'always-on' },
      deps(car, feature),
    );
    expect(outcome(applied)).toMatchObject({ outcome: 'verified' });
    const record = (await store.get('kinds-backup-0')) as BackupRecord;
    expect(record.ownedMask).toBe(`00000000FF${'00'.repeat(25)}FFFFFFFF`);

    // Another tool changes byte 10 (valid trailer) after our change.
    const held = car.values.get('773:720D') as string;
    const changed = `${held.slice(0, 20)}77${held.slice(22, 60)}`;
    car.values.set('773:720D', `${changed}${crc32Trailer(changed)}`);

    const restored = await run(
      { kind: 'restore', backup: record },
      deps(car, feature, { newId: () => 'kinds-restore-0' }),
    );
    expect(outcome(restored)).toMatchObject({ outcome: 'verified' });
    const block = car.values.get('773:720D') as string;
    expect(block.slice(8, 10)).toBe('50'); // ours back to the original
    expect(block.slice(20, 22)).toBe('77'); // theirs kept
    expect(block.slice(60)).toBe(crc32Trailer(block.slice(0, 60)));
    expect(await store.get('kinds-backup-0')).toMatchObject({
      status: 'restored',
      restoredBy: 'kinds-restore-0',
    });
  });

  it('still refuses a restore when the field itself has changed since', async () => {
    const car = new SimulatedCar({ parts: MIB3, values: { '773:720D': original }, now });
    await run({ kind: 'apply', car: CAR, feature, settingId: 'always-on' }, deps(car, feature));
    const record = (await store.get('kinds-backup-0')) as BackupRecord;
    const later = `00000000B4${'11'.repeat(25)}`; // someone set 180 km/h
    car.values.set('773:720D', `${later}${crc32Trailer(later)}`);
    const restored = await run(
      { kind: 'restore', backup: record },
      deps(car, feature, { newId: () => 'kinds-restore-0' }),
    );
    expect(restored.find((e) => e.type === 'refused')).toMatchObject({ reason: 'restore-conflict' });
  });
});

describe('dataset recipe (MIB3 sound preset): apply → durable record → restore', () => {
  const recipe = bundled('csmqb-mib3-sound-signature');
  const feature = offer(recipe, 'beats-audio');
  const preset = recipe.choices?.[0];
  const payload = preset?.payload;
  if (!preset || !payload) throw new Error('fixture: the bundled preset has no payload');
  const original = 'AB'.repeat(payload.length / 2);

  it('records the whole-block mask and restores the original block through the same session', async () => {
    const car = new SimulatedCar({ parts: MIB3, values: { '773:7201': original }, now });
    const applied = await run({ kind: 'apply', car: CAR, feature, settingId: preset.id }, deps(car, feature));
    expect(outcome(applied)).toMatchObject({ outcome: 'verified' });
    expect(car.values.get('773:7201')).toBe(payload);
    const record = (await store.get('kinds-backup-0')) as BackupRecord;
    expect(record.ownedMask).toBe('FF'.repeat(payload.length / 2));

    const restored = await run(
      { kind: 'restore', backup: record },
      deps(car, feature, { newId: () => 'kinds-restore-0' }),
    );
    expect(outcome(restored)).toMatchObject({ outcome: 'verified' });
    expect(car.values.get('773:7201')).toBe(original);
  });
});
