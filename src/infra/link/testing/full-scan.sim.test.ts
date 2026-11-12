/**
 * The full car scan on the clone simulator: the production engine, ELM session, Bluetooth link and the domain's
 * scan runner, against the live clone's drops, re-searches and truncation, on one virtual clock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APP_DATA } from '../../../domain/catalog/data.ts';
import type { CodingDeps } from '../../../domain/coding/run.ts';
import { runSession } from '../../../domain/coding/run.ts';
import type { BackupStore, CodingEvent, CodingRequest } from '../../../domain/coding/types.ts';
import type { CarMap } from '../../../domain/scan/map.ts';
import { carMapSummary } from '../../../domain/scan/markdown.ts';
import { recipeDids } from '../../../domain/scan/plan.ts';
import { WebBluetoothLink } from '../web-bluetooth.ts';
import { type FaultModel, kushaqEcus, SIM_VIN } from './clone-sim.ts';
import { drive, installDeterministicDigest, simRig } from './harness.ts';

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());
afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

/** The Kushaq BCM lamp records as read live (docs/research/REMAINING_FEATURES.md §A.0). */
const LAMPS: Record<string, string> = {
  '0550': '0C340014020064000000000000000000',
  '0552': '0448004A14006408091C06009C000000',
  '0554': '0144004B14007F080A7F000000000000',
  '0567': '2D0A002908097F000000000000000000',
};

/** A manifest identifier of the BCM no recipe reads: it carries the over-long answer. */
const LONG_DID =
  (APP_DATA.backupDids?.['09'] ?? []).find((d) => !recipeDids('70E').includes(d) && !d.startsWith('F')) ?? '';

const BCM_0600 = '0000000000000000000000000000000000000000000000000000000000';

function kushaq() {
  return kushaqEcus({
    parts: { '70E': '2Q0937089D', '714': '6JM920310' },
    values: {
      ...Object.fromEntries(Object.entries(LAMPS).map(([did, hex]) => [`70E:${did}`, hex])),
      '70E:0600': BCM_0600,
      // Lane-change flashes (5) as the owner coded it.
      '70E:0A5E': '3E00A00000',
      // A 60-byte answer: longer than the four consecutive frames the clone forwards — always truncated.
      [`70E:${LONG_DID}`]: '11'.repeat(60),
      '714:F19E': '45565F4B6F6D6269',
    },
  });
}

class MemoryBackups implements BackupStore {
  async save() {}
  async update() {}
}

async function scan(
  units?: string[],
  model?: Partial<FaultModel>,
): Promise<{
  events: CodingEvent[];
  map: CarMap;
  sentHex: string[];
  lockedDuring: boolean;
  lockedAfter: boolean;
}> {
  const rig = await simRig({ seed: 7, ecus: kushaq(), ...(model ? { model } : {}) });
  const epoch = Date.UTC(2026, 10, 3, 10, 0, 0);
  const deps: CodingDeps = {
    link: rig.link,
    backups: new MemoryBackups(),
    signal: new AbortController().signal,
    now: () => new Date(epoch + rig.clock.now()),
    sleep: (ms) => rig.clock.sleep(ms),
  };
  const req: Extract<CodingRequest, { kind: 'inspect' }> = {
    kind: 'inspect',
    car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
    module: { request: '70E', response: '778' },
    unit: 'all',
    label: 'Full car scan',
    ...(units ? { scan: { units } } : {}),
  };
  const events: CodingEvent[] = [];
  let lockedDuring = false;
  await drive(rig.clock, async () => {
    for await (const e of runSession(req, deps)) {
      events.push(e);
      if (e.type === 'check-started') lockedDuring = rig.engine.link?.policy.readOnly === true;
    }
  });
  const lockedAfter = rig.engine.link?.policy.readOnly === true;
  const mapEvent = events.find((e) => e.type === 'car-map');
  if (mapEvent?.type !== 'car-map') throw new Error('no car map');
  // Every top-level request the modules received (the simulator's ground truth).
  const sentHex = rig.sim.truth.flatMap((t) => (t.type === 'ecuRx' ? [t.bytes] : []));
  return { events, map: mapEvent.map, sentHex, lockedDuring, lockedAfter };
}

describe('full car scan on the clone simulator', () => {
  it('finds the fitted units and nothing else', async () => {
    const { map } = await scan();
    const fitted = map.discovery.filter((d) => d.fitted).map((d) => d.unit);
    // The simulated Kushaq: BCM, cluster, B7, HVAC, gateway, ABS, MIB, engine, transmission.
    expect(fitted.sort()).toEqual(['01', '02', '03', '08', '09', '17', '19', '5F', 'B7'].sort());
    expect(map.discovery.every((d) => d.answer !== 'not-probed')).toBe(true);
    for (const d of map.discovery.filter((x) => !x.fitted))
      expect(['silent', 'unreachable']).toContain(d.answer);
  }, 120_000);

  it('maps the car: identity, values, feature states, lamp records, truncation — and sends only reads', async () => {
    // The host's own flow control for a fifth consecutive frame is always lost: a long answer stays truncated.
    const { events, map, sentHex, lockedDuring, lockedAfter } = await scan(['09', '17'], { pRxFc: 1 });
    // The adapter's send policy was locked to reads for the run, and given back at the end.
    expect(lockedDuring).toBe(true);
    expect(lockedAfter).toBe(false);
    expect(map.vin).toBe(SIM_VIN);
    const bcm = map.units.find((u) => u.unit === '09');
    expect(bcm?.identity.part).toBe('2Q0937089D');
    expect(bcm?.values['0A5E']?.hex).toBe('3E00A00000');
    // The long answer is kept as far as it arrived, and marked.
    expect(bcm?.values[LONG_DID]).toMatchObject({ truncated: true });
    expect((bcm?.values[LONG_DID]?.length ?? 0) > 0 && (bcm?.values[LONG_DID]?.length ?? 0) < 60).toBe(true);
    // The lamp records decode with their lamp and functions.
    const front = map.lamps.find((l) => l.did === '0550');
    expect(front).toMatchObject({ lamp: 'front turn signal, left', type: { code: 0x0c } });
    expect(front?.functions[0]).toMatchObject({ slot: 'A', code: 0x02 });
    // Feature states come out of the bytes (lane-change flashes on the BCM).
    const flashes = map.features.find((f) => f.recipeId === 'live-bcm-polite-blinks');
    expect(flashes?.state.kind).toBe('set');
    expect(map.totals.features.on + map.totals.features.off + map.totals.features.other).toBeGreaterThan(0);
    // Read-only on the wire: every request any module received was a 22 read (or a presence/flow frame).
    expect(sentHex.length).toBeGreaterThan(0);
    for (const hex of sentHex) expect(hex.slice(0, 2)).toBe('22');
    expect(events.at(-1)).toMatchObject({ type: 'outcome' });
    expect(carMapSummary(map).join('\n')).toMatch(/2 of 2 units answered/);
  }, 120_000);
});
