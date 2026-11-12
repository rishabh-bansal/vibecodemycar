import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { appFeatureIds } from '../catalogue/status.ts';
import {
  BCM_MODULE,
  CLUSTER_MODULE,
  CLUSTER_REQUIREMENTS,
  classifyCluster,
  clusterRequirement,
  detectCar,
  modelYearOfVin,
} from './cluster.ts';
import type { Cluster } from './types.ts';

interface RawFeature {
  slug: string;
  intro?: string;
  Requirements?: string[];
  Attention?: string[];
  Notes?: string[];
}
const catalogue = JSON.parse(readFileSync(new URL('../../data/catalogue.json', import.meta.url), 'utf8')) as {
  models: { make: string; model: string; features: RawFeature[] }[];
};

/** The catalogue's own wording for "needs a digital cluster" / "not on a digital cluster". */
const DIGITAL = /(equip+ed with|must have)[^.]*\b(digital (cockpit|dashboard)|virtual cockpit)/i;
const ANALOGUE = /not compatible with (a |the )?digital (dashboard|cockpit|instrument)/i;

function derived(): Record<string, Record<string, Cluster>> {
  const out: Record<string, Record<string, Cluster>> = {};
  for (const m of catalogue.models) {
    for (const f of m.features) {
      const text = [
        ...(f.Requirements ?? []),
        ...(f.Attention ?? []),
        ...(f.Notes ?? []),
        f.intro ?? '',
      ].join(' | ');
      const needs: Cluster | undefined = ANALOGUE.test(text)
        ? 'analogue'
        : DIGITAL.test(text)
          ? 'digital'
          : undefined;
      if (!needs) continue;
      const key = `${m.make}-${m.model}`;
      out[key] ??= {};
      for (const id of appFeatureIds(f.slug)) out[key][id] = needs;
    }
  }
  return out;
}

describe('cluster requirements', () => {
  it("match exactly what each model's catalogue says about the cluster", () => {
    expect(CLUSTER_REQUIREMENTS).toEqual(derived());
  });

  it('are per model: a feature only depends on the cluster where that model says so', () => {
    expect(clusterRequirement('skoda', 'slavia', 'instrument-cluster-needle-sweep')).toBe('analogue');
    expect(clusterRequirement('skoda', 'kushaq', 'instrument-cluster-needle-sweep')).toBeUndefined();
    expect(clusterRequirement('volkswagen', 'virtus', 'efficiency-assist-display')).toBe('digital');
  });

  it('carry to sister models that do not list the feature themselves, per family', () => {
    // Only the Kylaq lists the startup logo, and only on a digital cluster: its sisters inherit that.
    expect(clusterRequirement('skoda', 'kushaq', 'dashboard-startup-logo')).toBe('digital');
    expect(clusterRequirement('volkswagen', 'taigun', 'dashboard-startup-logo')).toBe('digital');
    expect(clusterRequirement('volkswagen', 'taigun', 'efficiency-assist-display')).toBe('digital');
    // Superb's requirement reaches the other MQB cars, never the India 2.0 ones.
    expect(clusterRequirement('volkswagen', 'tiguan', 'transmission-temperature')).toBe('digital');
    expect(clusterRequirement('skoda', 'kushaq', 'transmission-temperature')).toBeUndefined();
    // An "Other model" takes the family it is given.
    expect(clusterRequirement('skoda', 'other', 'dashboard-startup-logo', 'MQB-A0-IN')).toBe('digital');
  });

  it("let a model's own listing win, and leave it open when sisters disagree", () => {
    // The Kushaq lists the needle sweep with no requirement; the Slavia's "analogue only" stays the Slavia's.
    expect(clusterRequirement('skoda', 'kushaq', 'gauge-test-needle-sweep')).toBeUndefined();
    // The Taigun does not list it: its sisters disagree (Slavia analogue, Kushaq/Kylaq/Virtus either) → open.
    expect(clusterRequirement('volkswagen', 'taigun', 'gauge-test-needle-sweep')).toBeUndefined();
  });
});

describe('cluster identity', () => {
  it('knows the cluster read on a real car', () => {
    expect(classifyCluster({ part: '6JM920310' })).toBe('digital');
    expect(classifyCluster({ part: '6JM 920 310 A' })).toBe('digital');
  });

  it('does not guess for an identity it has not seen', () => {
    expect(classifyCluster({ part: '2GM920740' })).toBeUndefined();
    expect(classifyCluster({ dataset: 'EV_DashBoardJCIMQBAB' })).toBeUndefined();
    expect(classifyCluster({})).toBeUndefined();
  });
});

describe('model year from the VIN', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  it('reads position 10', () => {
    expect(modelYearOfVin('TMBJJ7NW1P3012345', now)).toBe(2023);
    expect(modelYearOfVin('TMBJJ7NW1R3012345', now)).toBe(2024);
    expect(modelYearOfVin('TMBJJ7NW1T3012345', now)).toBe(2026);
  });
  it('gives nothing for a malformed or future VIN', () => {
    expect(modelYearOfVin(undefined, now)).toBeUndefined();
    expect(modelYearOfVin('TMB123', now)).toBeUndefined();
    expect(modelYearOfVin('TMBJJ7NW1Z3012345', now)).toBeUndefined();
    expect(modelYearOfVin('TMBJJ7NW1X3012345', now)).toBeUndefined(); // 2029
  });
});

describe('detectCar', () => {
  it('reads the cluster identity and the model year, and writes nothing', async () => {
    const link = new SimulatedCar({
      mode: 'live',
      parts: { [CLUSTER_MODULE.request]: '6JM920310' },
      values: { [`${CLUSTER_MODULE.request}:F19E`]: '45565F44617368426F6172644A43494D51424142' },
    });
    const detected = await detectCar(link, 'TMBJJ7NW1P3012345');
    expect(detected).toEqual({
      cluster: 'digital',
      clusterPart: '6JM920310',
      clusterDataset: 'EV_DashBoardJCIMQBAB',
      modelYear: 2023,
    });
    expect(link.writes).toEqual([]);
  });

  it("reads the body computer's part number and the platform family it names", async () => {
    const a0 = new SimulatedCar({ mode: 'live', parts: { [BCM_MODULE.request]: '2Q0937089D' } });
    expect(await detectCar(a0, undefined)).toEqual({ bcmPart: '2Q0937089D', platform: 'MQB-A0-IN' });
    const mqb = new SimulatedCar({ mode: 'live', parts: { [BCM_MODULE.request]: '5Q0937084AF' } });
    expect(await detectCar(mqb, undefined)).toEqual({ bcmPart: '5Q0937084AF', platform: 'MQB' });
    const unknown = new SimulatedCar({ mode: 'live', parts: { [BCM_MODULE.request]: '6R0937087' } });
    expect(await detectCar(unknown, undefined)).toEqual({ bcmPart: '6R0937087' });
    expect(a0.writes).toEqual([]);
  });

  it('leaves out what the car did not answer, and never throws', async () => {
    const link = new SimulatedCar({ mode: 'live' });
    link.readDid = async () => {
      throw new Error('GATT operation failed');
    };
    expect(await detectCar(link, undefined)).toEqual({});
  });
});
