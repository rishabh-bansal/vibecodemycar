/**
 * The clone simulator (src/infra/link/testing/clone-sim.ts) as a car behind the fake bridge (`--sim`): the
 * live clone ELM327's measured drops, re-searches, 78-pending writes and S3 lapses, in front of the Kushaq's
 * modules — in real time instead of on the tests' virtual clock.
 *
 * The modules hold what the app's demo car seeds for every codable Kushaq feature (the proven "before" bytes
 * and part numbers from app-data, first feature wins per DID), plus each recipe's login. The VIN is the
 * simulator's synthetic sample; nothing here came from a real car's coding.
 *
 * For `live health` the engine answers generic OBD-II from the synthetic faulty engine (parked: 0 rpm, 0 km/h) and
 * the BCM and cluster hold UDS fault memories (src/infra/link/testing/health-car.ts). The cluster's list is longer
 * than the four consecutive frames the clone forwards, so it arrives truncated, as on the live adapter. Brakes (713)
 * and airbags (715) answer `19 02` with `7F 19 78` and their (empty) list seconds later, as live on 2026-11-09.
 */
import type { VirtualClock } from '@obdcraft/obd-core';
import { APP_DATA } from '../../src/domain/catalog/data.ts';
import { featuresFor } from '../../src/domain/catalog/features.ts';
import type { CarSelection } from '../../src/domain/catalog/types.ts';
import type { CodingRecipe } from '../../src/domain/coding/types.ts';
import { createDemoCar } from '../../src/infra/link/demo.ts';
import type { SimOptions } from '../../src/infra/link/simulator.ts';
import { StandardEcu } from '@obdcraft/obd-core';
import { CloneElmSim, type EcuSpec, type FaultModel, kushaqEcus } from '../../src/infra/link/testing/clone-sim.ts';
import { BCM_FAULTS, CLUSTER_FAULTS, faultyEngineSpec } from '../../src/infra/link/testing/health-car.ts';

const KUSHAQ: CarSelection = { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' };

/** The first-tap measurement's features first, so their fixtures win a shared DID. */
const FIRST: readonly [string, string][] = [
  ['comfort-lane-change-indicator-5-flashes', 'value-5'],
  ['80kmph-and-120kmph-speed-chime-warning', 'disabled'],
  ['engine-start-stop-button-pulsation', 'enabled'],
  ['speed-warning', 'kmh-80'],
  ['speed-limiter', 'enabled'],
  ['video-in-motion-through-pen-drive', 'always-on'],
];

/** The tests' VirtualClock contract (now / sleep / schedule) on wall-clock time. */
export function wallClock(): VirtualClock {
  const t0 = performance.now();
  const clock = {
    now: () => performance.now() - t0,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms))),
    schedule: (ms: number, fire: () => void) => void setTimeout(fire, Math.max(0, ms)),
  };
  return clock as unknown as VirtualClock;
}

function seedCar(): { values: Record<string, string>; parts: Record<string, string>; logins: Record<string, number[]>; modules: { request: string; response: string }[] } {
  const values: Record<string, string> = {};
  const parts: Record<string, string> = {};
  const logins: Record<string, number[]> = {};
  const modules: { request: string; response: string }[] = [];
  const items = featuresFor(KUSHAQ).filter((f) => f.tier !== 'unavailable' && f.recipeId);
  const ordered = [
    ...FIRST.flatMap(([id, setting]) => items.filter((f) => f.id === id).map((f) => [f, setting] as const)),
    ...items.filter((f) => !FIRST.some(([id]) => id === f.id)).map((f) => [f, f.settings[0]?.id ?? ''] as const),
  ];
  const visit = (r: CodingRecipe, request?: string | null) => {
    const req = (r.requestId ?? request)?.toUpperCase();
    if (r.requestId && r.responseId && !modules.some((m) => m.request === req))
      modules.push({ request: r.requestId.toUpperCase(), response: r.responseId.toUpperCase() });
    for (const p of [r.password, ...(r.variants ?? []).map((v) => v.password ?? r.password)]) {
      if (!req || !p || !/^\d+$/.test(p)) continue;
      const list = (logins[req] ??= []);
      if (!list.includes(Number(p))) list.push(Number(p));
    }
    for (const s of (r as { steps?: CodingRecipe[] }).steps ?? []) visit(s, req);
  };
  for (const [feature, setting] of ordered) {
    let demo: ReturnType<typeof createDemoCar>;
    try {
      demo = createDemoCar(feature, setting, { latencyMs: 0, pendingMs: 0, sleep: async () => {} });
    } catch {
      continue;
    }
    for (const [k, v] of demo.values) values[k] ??= v;
    for (const [k, v] of Object.entries((demo as unknown as { opts: SimOptions }).opts.parts ?? {})) parts[k] ??= v;
    const recipe = APP_DATA.recipes[feature.recipeId as string] as CodingRecipe | undefined;
    if (recipe) visit(recipe);
  }
  // The BCM's workshop code (the writer's vendor default): what `live frametest` writes and restores.
  values['70E:F198'] ??= '0181C8F63039';
  return { values, parts, logins, modules };
}

export function simCar(seed: number, model: Partial<FaultModel> = {}): { sim: CloneElmSim; modules: string[] } {
  const car = seedCar();
  const parked = new StandardEcu(faultyEngineSpec({ pids: { 0x0c: () => [0, 0], 0x0d: () => [0] } }));
  const health: Record<string, Partial<EcuSpec>> = {
    ENG: { obdAnswer: (req, t, physical) => parked.handle([...req], t, physical) },
    BCM: { faults: BCM_FAULTS },
    CLU: { faults: CLUSTER_FAULTS },
    // Brakes and airbags answer 19 02 with 7F 19 78 and send the list seconds later (live 2026-11-09).
    ABS: { faults: [], slowDtcListMs: 3000 },
    '715': { faults: [], slowDtcListMs: 2500 },
  };
  const modules = [...car.modules, { request: '715', response: '77F' }];
  const ecus = kushaqEcus({ ...car, modules, model }).map((e) => ({ ...e, ...(health[e.name] ?? {}) }));
  const sim = new CloneElmSim({ clock: wallClock(), seed, ecus, model });
  return { sim, modules: ecus.map((e) => `${e.request}:${e.response} ${e.name}`) };
}
