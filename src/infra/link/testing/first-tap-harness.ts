import { OBDCraftEngine } from '@obdcraft/obd-core';
import type { BackupRecord } from '../../../domain/backups/schema.ts';
import { APP_DATA } from '../../../domain/catalog/data.ts';
import { findFeature } from '../../../domain/catalog/features.ts';
import type { CarSelection, FeatureItem } from '../../../domain/catalog/types.ts';
import { runSession } from '../../../domain/coding/run.ts';
import type {
  CodingEvent,
  CodingRecipe,
  DidWrite,
  ModuleAddress,
  SequenceSpec,
} from '../../../domain/coding/types.ts';
import { createDemoCar } from '../demo.ts';
import type { SimOptions } from '../simulator.ts';
import { WebBluetoothLink } from '../web-bluetooth.ts';
import { type FaultModel, kushaqEcus } from './clone-sim.ts';
import { drive, simRig } from './harness.ts';

/**
 * One user tap — `runSession` apply through the real Bluetooth link, ELM session and writer — against the clone
 * simulator, judged by the simulator's ground truth. Used by `first-tap.test.ts`.
 */

export const KUSHAQ: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};

export interface RecipeKind {
  /** Short label for the report. */
  kind: string;
  featureId: string;
  /** The setting the tap applies; absent: the first offered. */
  settingId?: string;
  /** A failure is expected by construction (a quirk): reported, never counted as a writer miss. */
  expectFailure?: string;
}

/** The recipe kinds the first-tap measurement covers (the Kushaq's catalogue entries). */
export const RECIPE_KINDS: readonly RecipeKind[] = [
  { kind: 'field BCM', featureId: 'comfort-lane-change-indicator-5-flashes', settingId: 'value-5' },
  // The proven "before" byte the demo seeds is 0x31 (enabled): the tap turns it off.
  { kind: 'field cluster', featureId: '80kmph-and-120kmph-speed-chime-warning', settingId: 'disabled' },
  {
    kind: 'alt B7',
    featureId: 'engine-start-stop-button-pulsation',
    settingId: 'enabled',
    expectFailure: 'b7_0574_silent: a delivered 2E 05 74 is never answered nor stored (live 3/3)',
  },
  { kind: 'ops', featureId: 'speed-warning', settingId: 'kmh-80' },
  { kind: 'group 2 units', featureId: 'speed-limiter', settingId: 'enabled' },
  { kind: 'scalar', featureId: 'video-in-motion-through-pen-drive', settingId: 'always-on' },
  {
    kind: 'dataset',
    featureId: 'beats-audio',
    settingId: 'variant-002',
    // A link limit, not the writer's: the 2052-byte 7201 backup read needs ~73 RX flow-control rounds through the
    // clone's 4-CF cap and never completes inside the 8 s read budget, so the tap ends not-sent before any write.
    expectFailure:
      'dataset_backup_read: the 7201 backup read cannot pass the 4-CF cap in its budget (never written)',
  },
];

/** One write the session asked the link for, and what came back. */
export interface WriteCall {
  module: ModuleAddress;
  did: string;
  bytes: string;
  result: DidWrite | undefined;
  /** Virtual time the writer took for this call. */
  ms: number;
}

export interface TapResult {
  /** The session's journal, in order. */
  events: CodingEvent[];
  kind: string;
  seed: number;
  outcome: string;
  phase: string;
  writes: WriteCall[];
  /** Every write the session made holds its intended bytes on the module (ground truth). */
  stored: boolean;
  success: boolean;
  /** Keys delivered for a seed whose key had already been delivered (ground truth). */
  duplicateKeys: number;
  /** `2E` frames to a DID put on the wire after the host had seen it stored (6E, or a read of the intended bytes). */
  sendsAfterAck: number;
  /** Data writes delivered while the module already held exactly those bytes (ground truth). */
  redundantDeliveries: number;
  /** NRC 31 shown to the user (a write result or a `not-hosted` marker) whose 31 came from a lapsed session. */
  falseNrc31: number;
  /** `2E` to a payload DID the module received in its default session (ground truth). */
  lapsedPayloadWrites: number;
  /** Requests the adapter dropped, by reason (ground truth). */
  drops: Record<string, number>;
  discipline: { lockedAfterIdle: number; afterAtNoSearch: number; atR0: number; bareCr: number };
  /** Virtual time of the whole tap (connect excluded), and of the writer calls alone. */
  sessionMs: number;
  writerMs: number;
  /** Fresh connections the session took inside this one tap (production reruns a provably-unsent stop). */
  relinks: number;
  hash: string;
}

const passwordsOf = (recipe: CodingRecipe): Record<string, number[]> => {
  const out: Record<string, number[]> = {};
  const add = (request: string | null | undefined, password: string | null | undefined) => {
    if (!request || !password || !/^\d+$/.test(password)) return;
    const list = out[request.toUpperCase()] ?? [];
    list.push(Number(password));
    out[request.toUpperCase()] = list;
  };
  const visit = (r: CodingRecipe, request?: string | null) => {
    const req = r.requestId ?? request;
    add(req, r.password);
    for (const v of r.variants ?? []) add(req, v.password ?? r.password);
    for (const s of (r as { steps?: CodingRecipe[] }).steps ?? []) visit(s, req);
  };
  visit(recipe);
  return out;
};

const modulesOf = (recipe: CodingRecipe): { request: string; response: string }[] => {
  const out: { request: string; response: string }[] = [];
  const visit = (r: CodingRecipe) => {
    if (r.requestId && r.responseId) out.push({ request: r.requestId, response: r.responseId });
    for (const s of (r as { steps?: CodingRecipe[] }).steps ?? []) visit(s);
  };
  visit(recipe);
  return out;
};

const didOf = (bytes: readonly number[]): string | undefined => {
  const pci = (bytes[0] ?? 0) >> 4;
  const body = pci === 0 ? bytes.slice(1) : pci === 1 ? bytes.slice(2) : [];
  if (body[0] !== 0x2e) return undefined;
  return [body[1] ?? 0, body[2] ?? 0].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
};
const hex = (bytes: readonly number[]) =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

/** The feature and the car the demo would seed for it: DID contents and F187 parts, holding another value. */
export function fixtureFor(k: RecipeKind): {
  feature: FeatureItem;
  settingId: string;
  recipe: CodingRecipe;
  values: Record<string, string>;
  parts: Record<string, string>;
} {
  const feature = findFeature(KUSHAQ, k.featureId);
  if (!feature?.recipeId) throw new Error(`fixture: ${k.featureId} is not offered on the Kushaq`);
  const recipe = APP_DATA.recipes[feature.recipeId] as CodingRecipe | undefined;
  if (!recipe) throw new Error(`fixture: recipe ${feature.recipeId} is missing`);
  const settingId = k.settingId ?? feature.settings[0]?.id ?? '';
  const demo = createDemoCar(feature, settingId, { latencyMs: 0, pendingMs: 0, sleep: async () => {} });
  const values = Object.fromEntries(demo.values);
  const parts = (demo as unknown as { opts: SimOptions }).opts.parts ?? {};
  return { feature, settingId, recipe, values, parts };
}

/** One first tap on a fresh connection, seeded. */
export async function firstTap(
  k: RecipeKind,
  seed: number,
  model: Partial<FaultModel> = {},
): Promise<TapResult> {
  const fx = fixtureFor(k);
  const rig = await simRig({
    seed,
    model,
    ecus: kushaqEcus({
      values: fx.values,
      parts: fx.parts,
      logins: passwordsOf(fx.recipe),
      modules: modulesOf(fx.recipe),
      model,
    }),
  });
  const { clock, sim } = rig;
  const writes: WriteCall[] = [];
  let writerMs = 0;
  let relinks = 0;
  const watch = (link: WebBluetoothLink): WebBluetoothLink => {
    const writeDid = link.writeDid.bind(link);
    link.writeDid = async (module, did, bytes, options) => {
      const call: WriteCall = {
        module,
        did: did.toUpperCase(),
        bytes: bytes.toUpperCase(),
        result: undefined,
        ms: 0,
      };
      writes.push(call);
      const t = clock.now();
      call.result = await writeDid(module, did, bytes, options);
      call.ms = clock.now() - t;
      writerMs += call.ms;
      return call.result;
    };
    const sequence = link.sequence.bind(link);
    link.sequence = async (module: ModuleAddress, spec: SequenceSpec, options) => {
      const target = spec.write.kind === 'did' ? spec.write.did : spec.write.address;
      const call: WriteCall = {
        module,
        did: target.toUpperCase(),
        bytes: spec.write.bytes.toUpperCase(),
        result: undefined,
        ms: 0,
      };
      writes.push(call);
      const t = clock.now();
      call.result = await sequence(module, spec, options);
      call.ms = clock.now() - t;
      writerMs += call.ms;
      return call.result;
    };
    return link;
  };
  const link = watch(rig.link);
  /** As production's relink: a fresh connection to the same adapter (and car), native startup again. */
  const relink = async () => {
    relinks++;
    const engine = new OBDCraftEngine({ clock, startup: 'diagnostic-can' });
    await engine.connect(sim);
    return watch(WebBluetoothLink.adopt(engine));
  };

  const saved: BackupRecord[] = [];
  const events: CodingEvent[] = [];
  const BASE = Date.UTC(2026, 10, 2, 9, 0, 0);
  let ids = 0;
  const t0 = clock.now();
  await drive(clock, async () => {
    for await (const e of runSession(
      { kind: 'apply', car: KUSHAQ, feature: fx.feature, settingId: fx.settingId },
      {
        link,
        signal: new AbortController().signal,
        sleep: (ms) => clock.sleep(ms),
        now: () => new Date(BASE + clock.now()),
        newId: () => `tap-${seed}-${ids++}`,
        featureFor: () => fx.feature,
        // As the app runs a session (state/session-store.ts): identity and the coded DID only, relink on a drop.
        moduleSnapshot: false,
        relink,
        backups: {
          save: async (b) => void saved.push(structuredClone(b)),
          update: async (id, patch) => {
            const i = saved.findIndex((b) => b.id === id);
            if (i >= 0) saved[i] = { ...(saved[i] as BackupRecord), ...patch };
          },
        },
      },
    ))
      events.push(e);
  });
  const sessionMs = clock.now() - t0;
  const last = events.findLast((e) => e.type === 'outcome');
  const outcome = last?.type === 'outcome' ? last.outcome : 'none';
  const phase = last?.type === 'outcome' ? last.phase : '';

  // ---- ground truth ----
  const stored = writes.length > 0 && writes.every((w) => sim.stored(w.module.request, w.did) === w.bytes);
  const success = (outcome === 'verified' || outcome === 'observed-match') && stored;
  const duplicateKeys = sim.truth.filter((e) => e.type === 'key' && e.duplicate).length;
  let sendsAfterAck = 0;
  for (const w of writes) {
    const req = w.module.request.toUpperCase();
    const seen = sim.hostSaw.find(
      (s) =>
        s.ecu === req &&
        ((s.pdu[0] === 0x6e && hex(s.pdu.slice(1, 3)) === w.did) ||
          (s.pdu[0] === 0x62 && hex(s.pdu.slice(1, 3)) === w.did && hex(s.pdu.slice(3)) === w.bytes)),
    );
    if (!seen) continue;
    sendsAfterAck += sim.txLog.filter(
      (tx) => tx.t > seen.t && tx.header === req && tx.topLevel && didOf(tx.bytes) === w.did,
    ).length;
  }
  const redundantDeliveries = sim.truth.filter(
    (e) => e.type === 'writeDelivered' && e.held === e.bytes,
  ).length;
  const lapsed31 = sim.truth.filter(
    (e) => e.type === 'nrc' && e.service === 0x2e && e.nrc === 0x31 && e.cause === 'default-session',
  );
  let falseNrc31 = 0;
  for (const w of writes) {
    const r = w.result;
    if (r?.kind === 'nrc' && r.code === '31' && lapsed31.some((e) => e.type === 'nrc' && e.did === w.did))
      falseNrc31++;
    for (const m of r?.markers ?? [])
      if (m.outcome === 'not-hosted' && lapsed31.some((e) => e.type === 'nrc' && e.did === m.did))
        falseNrc31++;
  }
  const payloadDids = new Set(writes.map((w) => `${w.module.request.toUpperCase()}:${w.did}`));
  const lapsedPayloadWrites = lapsed31.filter(
    (e) => e.type === 'nrc' && payloadDids.has(`${e.ecu}:${e.did ?? ''}`),
  ).length;
  const drops: Record<string, number> = {};
  for (const e of sim.truth) if (e.type === 'dropped') drops[e.reason] = (drops[e.reason] ?? 0) + 1;

  await drive(clock, () => WebBluetoothLink.retireCurrent());
  return {
    events,
    kind: k.kind,
    seed,
    outcome,
    phase,
    writes,
    stored,
    success,
    duplicateKeys,
    sendsAfterAck,
    redundantDeliveries,
    falseNrc31,
    lapsedPayloadWrites,
    drops,
    discipline: { ...sim.discipline },
    sessionMs,
    writerMs,
    relinks,
    hash: sim.transcriptHash(),
  };
}

export interface KindSummary {
  kind: string;
  runs: number;
  success: number;
  successRate: number;
  duplicateKeys: number;
  sendsAfterAck: number;
  redundantDeliveries: number;
  falseNrc31: number;
  lapsedPayloadWrites: number;
  sessionP50: number;
  sessionP95: number;
  writerP50: number;
  writerP95: number;
  writerP99: number;
  writerMax: number;
  relinks: number;
  outcomes: Record<string, number>;
  writeResults: Record<string, number>;
  discipline: { lockedAfterIdle: number; afterAtNoSearch: number; atR0: number; bareCr: number };
}

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

export function summarise(kind: string, runs: readonly TapResult[]): KindSummary {
  const outcomes: Record<string, number> = {};
  const writeResults: Record<string, number> = {};
  const discipline = { lockedAfterIdle: 0, afterAtNoSearch: 0, atR0: 0, bareCr: 0 };
  for (const r of runs) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    for (const w of r.writes) {
      const k = w.result ? (w.result.kind === 'nrc' ? `nrc ${w.result.code}` : w.result.kind) : 'none';
      writeResults[k] = (writeResults[k] ?? 0) + 1;
    }
    for (const key of Object.keys(discipline) as (keyof typeof discipline)[])
      discipline[key] += r.discipline[key];
  }
  const sum = (f: (r: TapResult) => number) => runs.reduce((a, r) => a + f(r), 0);
  /** Writer time per write call (a group tap makes one per part), as BRIEF §5 measures it. */
  const calls = runs.flatMap((r) => r.writes.map((w) => w.ms));
  const success = runs.filter((r) => r.success).length;
  return {
    kind,
    runs: runs.length,
    success,
    successRate: runs.length ? success / runs.length : 0,
    duplicateKeys: sum((r) => r.duplicateKeys),
    sendsAfterAck: sum((r) => r.sendsAfterAck),
    redundantDeliveries: sum((r) => r.redundantDeliveries),
    falseNrc31: sum((r) => r.falseNrc31),
    lapsedPayloadWrites: sum((r) => r.lapsedPayloadWrites),
    sessionP50: quantile(
      runs.map((r) => r.sessionMs),
      0.5,
    ),
    sessionP95: quantile(
      runs.map((r) => r.sessionMs),
      0.95,
    ),
    writerP50: quantile(calls, 0.5),
    writerP95: quantile(calls, 0.95),
    writerP99: quantile(calls, 0.99),
    writerMax: Math.max(0, ...calls),
    relinks: sum((r) => r.relinks),
    outcomes,
    writeResults,
    discipline,
  };
}

export function formatSummary(s: KindSummary): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const map = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
  return [
    `${s.kind.padEnd(14)} success ${String(s.success).padStart(3)}/${s.runs} ${pct(s.successRate).padStart(6)}`,
    `dupKeys ${s.duplicateKeys} afterAck ${s.sendsAfterAck} redundant ${s.redundantDeliveries} false31 ${s.falseNrc31} lapsed2E ${s.lapsedPayloadWrites}`,
    `session p50 ${sec(s.sessionP50)} p95 ${sec(s.sessionP95)} | writer p50 ${sec(s.writerP50)} p95 ${sec(s.writerP95)} p99 ${sec(s.writerP99)} max ${sec(s.writerMax)} | relinks ${s.relinks}`,
    `discipline idle ${s.discipline.lockedAfterIdle} afterAT ${s.discipline.afterAtNoSearch} R0 ${s.discipline.atR0} CR ${s.discipline.bareCr}`,
    `outcomes ${map(s.outcomes)} | writes ${map(s.writeResults)}`,
  ].join('\n    ');
}
