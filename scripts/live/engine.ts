/**
 * The app's coding engine over the live kit's TCP bridge: the same link class (WebBluetoothLink, through its
 * transport-injection entry), the same session runner (CodingController → runSession) and the same deps the
 * app's session store builds — the Dexie backup store, the experiment recorder, relink, identity-and-coded-DID
 * only, the paired car's fingerprint. Only the byte pipe differs: TCP to tools/live/elm-bridge instead of Web
 * Bluetooth.
 *
 * Writes are previewed before the run (`planApply` / `planRestore`: harmless reads and the app's own planner) and
 * the link is fenced so the run can only write exactly the previewed (module, DID, bytes): anything else is
 * answered `not-sent` without touching the wire.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_VIN, type WireEvent } from '@obdcraft/obd-core';
import { TcpTransport } from '../../packages/obd-core/src/transport/tcp.ts';
import type { BackupRecord } from '../../src/domain/backups/schema.ts';
import { APP_DATA } from '../../src/domain/catalog/data.ts';
import { featuresFor, findFeature, type CodableItem } from '../../src/domain/catalog/features.ts';
import type { CarSelection } from '../../src/domain/catalog/types.ts';
import { clusterOf, defaultSelection } from '../../src/domain/catalog/vehicles.ts';
import { CodingController } from '../../src/domain/coding/controller.ts';
import {
  buildApplyPlan,
  buildRestorePlan,
  type CodingPlan,
  groupStepsOf,
  isGroupRecipe,
  moduleOf,
  ownedToHex,
  planGroupStep,
  planGroupStepRestore,
  resolveRecipe,
  type VariantPick,
} from '../../src/domain/coding/plan.ts';
import type {
  CarLink,
  CodingEvent,
  CodingRecipe,
  CodingRequest,
  DidRead,
  ModuleAddress,
  WriteFrameMode,
} from '../../src/domain/coding/types.ts';
import { isMib3Identity, selectVariant, variantProbePlan } from '../../src/domain/coding/variant-select.ts';
import type { CarMap } from '../../src/domain/scan/map.ts';
import { carMapMarkdown, carMapSummary } from '../../src/domain/scan/markdown.ts';
import { fingerprintVin } from '../../src/domain/vin.ts';
import { recordDiag } from '../../src/domain/diagnostics.ts';
import { ConnectionLogger } from '../../src/infra/cloud/connection-log.ts';
import { WebBluetoothLink } from '../../src/infra/link/web-bluetooth.ts';
import { SIM_VIN } from '../../src/infra/link/testing/clone-sim.ts';
import { ExperimentRecorder } from '../../src/infra/storage/experiment-store.ts';
import type { LiveLog } from './stream.ts';
import type { LiveStore } from './store.ts';

const BCM: ModuleAddress = { request: '70E', response: '778' };
const CLUSTER: ModuleAddress = { request: '714', response: '77E' };
/** VINs of the kit's own simulators: their sessions are never uploaded to the real log. */
const SYNTHETIC_VINS = new Set([DEMO_VIN, SIM_VIN]);
/** Part numbers only the kit's fake modules answer (scripts/live/fake-car.ts, the clone simulator's default). */
const SYNTHETIC_PART = /^(FAKE|SIM)/;

export const vinHash = (vin: string) => createHash('sha256').update(vin).digest('hex').slice(0, 12);

const asciiOf = (hex: string) =>
  (hex.match(/../g) ?? []).map((b) => String.fromCharCode(Number.parseInt(b, 16))).join('').replace(/\0/g, '').trim();

// ---- connection --------------------------------------------------------------------------------

/** Every record this process made: excluded from upload when the car turns out to be a simulator. */
export const recorded = { experiments: new Set<string>(), journals: new Set<string>(), sessions: new Set<string>() };

/**
 * The connection log of a command that talks to the adapter outside the app's link (status, raw, identify, read):
 * its traffic is recorded and uploaded as the app's own connections are, never left in the local NDJSON only.
 */
export function recordConnection(store: LiveStore): { wire: (e: WireEvent) => void; stop: (reason: string) => Promise<void> } {
  const logger = new ConnectionLogger(() => store.db);
  recorded.sessions.add(logger.session);
  return {
    // Wire events arrive as they happen: stamped now, with the session clock as the monotonic time.
    wire: (e) => logger.wire({ at: new Date().toISOString(), elapsedMs: e.at, direction: e.dir, text: e.text }),
    stop: (reason) => logger.stop(reason),
  };
}

export interface LiveLink {
  link: WebBluetoothLink;
  /** Fresh connection on the same bridge, as the app's relink (new connection log, native startup again). */
  relink(): Promise<CarLink | undefined>;
  /** Wraps every link this rig hands out (the current one and each relink) — the write fence. */
  fence(wrap: (link: WebBluetoothLink) => void): void;
  close(): Promise<void>;
}

export async function openLink(
  log: LiveLog,
  store: LiveStore,
  bridge: { host: string; port: number },
  frameMode?: WriteFrameMode,
  markers?: boolean,
): Promise<LiveLink> {
  const loggers: ConnectionLogger[] = [];
  let wrap: ((link: WebBluetoothLink) => void) | undefined;
  let current: WebBluetoothLink;
  const connect = async (): Promise<WebBluetoothLink> => {
    // Every adapter command of the connection is recorded as the app does (connection log, uploaded with the rest)
    // — but only once the connection is up: a failed connect leaves no record, so nothing of it is ever uploaded.
    // Traffic of the connect itself is held until then and recorded first.
    const early: Parameters<ConnectionLogger['wire']>[0][] = [];
    let logger: ConnectionLogger | undefined;
    let closed = false;
    const link = await WebBluetoothLink.connectTransport(new TcpTransport(bridge), {
      onWire: (e) => {
        log.trace(e);
        if (logger) logger.wire(e);
        else early.push(e);
      },
      onClosed: () => {
        closed = true;
        void logger?.stop('link closed');
      },
      ...(frameMode ? { frameMode } : {}),
      ...(markers === false ? { markers } : {}),
    });
    logger = new ConnectionLogger(() => store.db);
    loggers.push(logger);
    recorded.sessions.add(logger.session);
    for (const e of early) logger.wire(e);
    if (closed) void logger.stop('link closed');
    wrap?.(link);
    return link;
  };
  try {
    current = await connect();
  } catch (e) {
    throw new Error(`${(e as Error).message} — is the bridge running and the adapter ready? (npm run live:bridge, or npm run live:fake)`);
  }
  log.event('connect', `link up over bridge ${bridge.host}:${bridge.port}`, { canWrite: current.canWrite });
  // What the adapter said about itself (ATI, AT@1, STI, ATPPS): on the stream, and in the uploaded connection log.
  if (current.adapter) {
    log.event('adapter', `${current.adapter.firmware} / ${current.adapter.device || '(no AT@1)'}`, { ...current.adapter, frameMode: frameMode ?? 'full', markers: markers ?? true });
    recordDiag('adapter', 'identity', { ...current.adapter, frameMode: frameMode ?? 'full' });
  }
  return {
    get link() {
      return current;
    },
    async relink() {
      log.event('warn', 'relink: opening a fresh connection on the bridge');
      try {
        current = await connect();
        return current;
      } catch (e) {
        log.event('error', `relink failed: ${(e as Error).message}`);
        return undefined;
      }
    },
    fence(w) {
      wrap = w;
      w(current);
    },
    async close() {
      await current.close();
      await Promise.all(loggers.map((l) => l.stop('command finished')));
    },
  };
}

// ---- the car on the bus ------------------------------------------------------------------------

export interface CarIdentity {
  /** Never printed: only `vinHash` and plausibility leave this module. */
  vin?: string;
  vinHash?: string;
  bcmPart?: string;
  clusterPart?: string;
  sel?: CarSelection;
  /** How `sel` was settled. */
  source: string;
  synthetic: boolean;
}

/** Year implied by a proof's build period (the selection only needs the right side of April 2024). */
const YEAR_OF_BUILD: Record<string, number> = { 'pre-2024-04': 2023, 'post-2024-04': 2025 };

/** `kushaq`, `skoda/kushaq`, `kushaq/monte-carlo` or `skoda/kushaq/monte-carlo`. */
export function selectionFromFlag(spec: string, year?: number): CarSelection {
  const parts = spec.toLowerCase().split('/').filter(Boolean);
  const brands = new Set<string>(APP_DATA.vehicles.map((v) => v.brand));
  const brand = parts[0] && brands.has(parts[0]) ? parts.shift() : undefined;
  const [model, variant] = parts;
  const vehicles = APP_DATA.vehicles.filter((v) => v.model === model && (!brand || v.brand === brand));
  const first = vehicles[0];
  if (!model || !first) throw new Error(`--model ${spec}: unknown model (known: ${[...new Set(APP_DATA.vehicles.map((v) => v.model))].join(', ')})`);
  const base = defaultSelection(first.brand as CarSelection['brand'], model);
  const chosen = variant ? vehicles.find((v) => v.variant === variant) : undefined;
  if (variant && !chosen) throw new Error(`--model ${spec}: unknown variant (known: ${vehicles.map((v) => v.variant).join(', ')})`);
  return {
    ...base,
    ...(chosen ? { variant: chosen.variant, cluster: clusterOf(chosen.mid) ?? base.cluster } : {}),
    ...(year ? { year } : {}),
  };
}

/** The car a live proof was recorded on, when one of the modules answers with that proof's part number. */
function selectionFromParts(parts: string[]): { sel: CarSelection; part: string } | undefined {
  for (const feature of Object.values(APP_DATA.features))
    for (const proof of feature.liveProof) {
      if (!parts.includes(proof.module.part)) continue;
      const v = proof.vehicle;
      return {
        part: proof.module.part,
        sel: {
          brand: v.brand as CarSelection['brand'],
          model: v.model,
          variant: v.variant,
          year: YEAR_OF_BUILD[v.build ?? ''] ?? 2023,
          cluster: (v.mid && clusterOf(v.mid as Parameters<typeof clusterOf>[0])) || 'analogue',
        },
      };
    }
  return undefined;
}

/** Identity reads through the link (VIN, BCM and cluster F187), then the car: `--model` wins over evidence. */
export async function identifyCar(link: CarLink, log: LiveLog, flags: { model?: string; year?: number }): Promise<CarIdentity> {
  const ident = await link.identify();
  const part = async (m: ModuleAddress) => {
    const r: DidRead = await link.readDid(m, 'F187').catch(() => ({ kind: 'link-lost' }) as DidRead);
    return r.kind === 'ok' ? asciiOf(r.bytes) : undefined;
  };
  const bcmPart = await part(BCM);
  const clusterPart = await part(CLUSTER);
  const vin = ident.kind === 'ok' ? ident.vin : undefined;
  const id: CarIdentity = {
    ...(vin ? { vin, vinHash: vinHash(vin) } : {}),
    ...(bcmPart ? { bcmPart } : {}),
    ...(clusterPart ? { clusterPart } : {}),
    source: 'unresolved',
    // The kit's own simulators: their VINs, or the fake modules' part numbers when no VIN was read.
    synthetic: (!!vin && SYNTHETIC_VINS.has(vin)) || [bcmPart, clusterPart].some((p) => !!p && SYNTHETIC_PART.test(p)),
  };
  log.event(vin ? 'result' : 'warn', 'car on the bus (VIN never shown)', {
    vin: vin ? { length: vin.length, hash: id.vinHash, synthetic: id.synthetic } : ident.kind === 'no-vin' ? { why: ident.why } : ident.kind,
    bcmPart: bcmPart ?? null,
    clusterPart: clusterPart ?? null,
  });
  if (flags.model) {
    id.sel = selectionFromFlag(flags.model, flags.year);
    id.source = `--model ${flags.model}`;
  } else {
    const found = selectionFromParts([bcmPart, clusterPart].filter((p): p is string => !!p));
    if (found) {
      id.sel = flags.year ? { ...found.sel, year: flags.year } : found.sel;
      id.source = `live proof on part ${found.part}`;
    }
  }
  if (id.sel) log.event('result', `car: ${id.sel.brand} ${id.sel.model} ${id.sel.variant} ${id.sel.year} (${id.sel.cluster} cluster)`, { from: id.source });
  return id;
}

/** The paired car (the app keeps it in its car store): its fingerprint, set on the first identified VIN. */
export async function pairedFingerprint(logDir: string, vin: string | undefined): Promise<string | undefined> {
  const file = join(logDir, 'pairing.json');
  const saved = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { fingerprint?: string }).fingerprint : undefined;
  if (saved || !vin) return saved;
  const fingerprint = await fingerprintVin(vin);
  writeFileSync(file, JSON.stringify({ fingerprint, pairedAt: new Date().toISOString() }), { mode: 0o600 });
  return fingerprint;
}

// ---- features ----------------------------------------------------------------------------------

/** Where a catalogue item writes: module and DID, or how it is settled on the car. */
export function targetOf(item: CodableItem): string {
  const recipe = item.recipeId ? (APP_DATA.recipes[item.recipeId] as CodingRecipe | undefined) : undefined;
  if (!recipe) return '-';
  try {
    if (isGroupRecipe(recipe)) return groupStepsOf(recipe).map((s) => `${moduleOf(s).request}:${s.did ?? s.variants?.[0]?.did ?? '?'}`).join(' + ');
    const m = moduleOf(recipe);
    if (recipe.variants?.length) return `${m.request}:{${[...new Set(recipe.variants.map((v) => v.did))].join('|')}} (variant read on the car)`;
    return `${m.request}:${resolveRecipe(recipe).did}`;
  } catch (e) {
    return `(${(e as Error).message})`;
  }
}

export { featuresFor, findFeature };

// ---- write preview -----------------------------------------------------------------------------

export interface PlannedWrite {
  label: string;
  module: ModuleAddress;
  did: string;
  before: string;
  after: string;
  owned: string;
  noop: boolean;
  variant?: string;
  action: 'apply' | 'restore';
  /**
   * The recipe's mutating sequence steps besides the payload (identity restore 2E, routine 31, DTC clear 14, reset 11,
   * markers 2EF198/2EF199), as `phase token`. Absent: the standard writer, which also stamps the F199/F198 markers.
   */
  steps?: string[];
}

/** A sequence token that changes the car (a `hdr:` prefix names another module). */
const MUTATING_TOKEN = /^(?:[0-7][0-9A-F]{2}:)?(?:2E|11|14|31)/;
const mutatingSteps = (pre: readonly string[] = [], post: readonly string[] = []): string[] => [
  ...pre.filter((t) => MUTATING_TOKEN.test(t.toUpperCase())).map((t) => `before ${t.toUpperCase()}`),
  ...post.filter((t) => MUTATING_TOKEN.test(t.toUpperCase())).map((t) => `after ${t.toUpperCase()}`),
];

/** The variant (and MIB generation) the session will settle on, from the same harmless reads. */
async function settlePick(link: CarLink, module: ModuleAddress, recipe: CodingRecipe): Promise<{ pick?: VariantPick; selector?: string }> {
  const dependsOnMib3 = [recipe, ...(recipe.variants ?? [])].some((r) => r.choices?.some((c) => c.when?.mib3 !== undefined));
  if (!recipe.variants?.length && !dependsOnMib3) return {};
  const read = async (m: ModuleAddress, did: string) => {
    const r = await link.readDid(m, did);
    if (r.kind === 'link-lost') throw new Error('the adapter disconnected during the preview reads');
    return r.kind === 'ok' && r.bytes ? r.bytes.toUpperCase() : undefined;
  };
  const plan = variantProbePlan(recipe);
  const reads: Record<string, string | undefined> = {};
  for (const did of plan.dids) reads[did] = await read(module, did);
  const probe: Parameters<typeof selectVariant>[1] = { reads };
  if (plan.needsPart) {
    const p = await read(module, 'F187');
    if (p) probe.part = asciiOf(p);
    const h = await read(module, 'F191');
    if (h) probe.hardware = asciiOf(h);
  }
  if (plan.needs0600Unit09) {
    const bcm = recipe.unit === '09' || module.request === BCM.request ? module : BCM;
    const r = (bcm === module ? reads['0600'] : undefined) ?? (await read(bcm, '0600'));
    if (r) probe.read0600Unit09 = r;
  }
  if (plan.needsIdentity || dependsOnMib3) {
    const mib3 = isMib3Identity(await read(module, 'F19E'));
    if (mib3 !== undefined) probe.isMib3 = mib3;
  }
  const mib = probe.isMib3 !== undefined ? { isMib3: probe.isMib3 } : {};
  if (!recipe.variants?.length) return { pick: mib };
  const chosen = selectVariant(recipe, probe);
  if (!chosen.ok) throw new Error(`no version of this recipe matches the module: ${chosen.detail}`);
  return { pick: { index: chosen.index, ...mib }, selector: chosen.variant.selector };
}

async function readCurrent(link: CarLink, module: ModuleAddress, did: string): Promise<string> {
  const r = await link.readDid(module, did);
  if (r.kind === 'ok') return r.bytes.toUpperCase();
  throw new Error(`could not read ${module.request} ${did}: ${r.kind === 'nrc' ? `NRC ${r.code}` : r.kind === 'no-reply' ? `no reply${r.adapter ? ` (${r.adapter})` : ''}` : r.kind}`);
}

const planned = (label: string, plan: CodingPlan, action: 'apply' | 'restore', selector?: string): PlannedWrite => ({
  label,
  module: plan.module,
  did: plan.did.toUpperCase(),
  before: plan.before,
  after: plan.after.toUpperCase(),
  owned: ownedToHex(plan.owned),
  noop: plan.noop,
  action,
  ...(selector ? { variant: selector } : {}),
  ...(plan.sequence ? { steps: mutatingSteps(plan.sequence.pre, plan.sequence.post) } : {}),
});

/** Statuses of a group part that may have left bytes on the car (as the session's own rule). */
const LANDED = new Set(['prepared', 'verified', 'unconfirmed']);

/** What an apply will write, read and planned exactly as the session will (harmless reads only). */
export async function planApply(
  link: CarLink,
  item: CodableItem,
  settingId: string,
  ctx: { backups: BackupRecord[]; fingerprint?: string },
): Promise<PlannedWrite[]> {
  const recipe = item.recipeId ? (APP_DATA.recipes[item.recipeId] as CodingRecipe | undefined) : undefined;
  if (!recipe) throw new Error('this feature has no recipe to write');
  if (!isGroupRecipe(recipe)) {
    const module = moduleOf(recipe);
    const { pick, selector } = await settlePick(link, module, recipe);
    const did = resolveRecipe(recipe, pick).did;
    const before = await readCurrent(link, module, did);
    return [planned(item.name, buildApplyPlan(recipe, settingId, before, pick), 'apply', selector)];
  }
  const out: PlannedWrite[] = [];
  for (const [index, step] of groupStepsOf(recipe).entries()) {
    const module = moduleOf(step);
    const { pick, selector } = await settlePick(link, module, step);
    const did = resolveRecipe(step, pick).did;
    const before = await readCurrent(link, module, did);
    // An "off" choice puts a single-choice part back to what this group's latest landed change found there.
    const prior = ctx.backups
      .filter((b) => b.operation === 'apply' && b.groupId === recipe.id && b.vin.fingerprint === ctx.fingerprint && b.status !== 'restored' && b.status !== 'refused')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .flatMap((b) => b.steps?.filter((s) => s.index === index && s.action === 'apply' && LANDED.has(s.status)) ?? [])[0]?.before;
    const plan = planGroupStep(step, settingId, before, pick, prior);
    out.push(planned(`${item.name} — part ${index + 1}`, plan, plan.action, selector));
  }
  return out;
}

/** What a restore will write: each landed part's original under its own mask (groups in reverse). */
export async function planRestore(link: CarLink, backup: BackupRecord): Promise<PlannedWrite[]> {
  const recipe = APP_DATA.recipes[backup.recipeId] as CodingRecipe | undefined;
  if (!recipe) throw new Error(`recipe ${backup.recipeId} is no longer in the catalogue`);
  if (!isGroupRecipe(recipe)) {
    const pick = backup.variant !== undefined ? { index: backup.variant } : undefined;
    const current = await readCurrent(link, backup.module, backup.did);
    return [planned(backup.featureName, buildRestorePlan(recipe, current, backup.before, pick), 'restore')];
  }
  const steps = groupStepsOf(recipe);
  const out: PlannedWrite[] = [];
  for (const entry of [...(backup.steps ?? [])].reverse()) {
    const step = steps[entry.index];
    if (!step || !LANDED.has(entry.status)) continue;
    const current = await readCurrent(link, entry.module, entry.did);
    const pick = entry.variant !== undefined ? { index: entry.variant } : undefined;
    out.push(planned(`${backup.featureName} — part ${entry.index + 1}`, planGroupStepRestore(step, current, entry.before, pick), 'restore'));
  }
  return out;
}

export function printPlan(log: LiveLog, writes: PlannedWrite[], markers = true): void {
  for (const w of writes) {
    const diff = (w.before.match(/../g) ?? []).flatMap((b, i) => (b === w.after.slice(i * 2, i * 2 + 2) ? [] : [`byte ${i}: ${b}→${w.after.slice(i * 2, i * 2 + 2)}`]));
    log.event('plan', `${w.label}: ${w.action} ${w.module.request}:${w.module.response} DID ${w.did}${w.noop ? ' (already set — nothing to write)' : ''}`, {
      before: w.before,
      after: w.after,
      owned: w.owned,
      changes: diff,
      ...(w.variant ? { variant: w.variant } : {}),
      // What else the run writes to the car: never only the payload.
      ...(w.noop
        ? {}
        : w.steps
          ? { alsoSends: w.steps }
          : markers
            ? { alsoWrites: 'F199 (coding date) and F198 (workshop code) markers, as dealer tools do' }
            : { alsoWrites: 'nothing else (--no-markers: no F199/F198 stamps)' }),
    });
  }
}

/**
 * Lets the run write only what was previewed: a payload whose module, DID and bytes are not in `writes` — or a
 * sequence carrying a mutating step the plan did not show — is answered `not-sent` before anything reaches the wire.
 */
export function writeFence(writes: PlannedWrite[], log: LiveLog): (link: WebBluetoothLink) => void {
  const allowed = (request: string, did: string, bytes: string) =>
    writes.some((w) => w.module.request === request.toUpperCase() && w.did === did.toUpperCase() && w.after === bytes.toUpperCase());
  const refuse = (request: string, did: string) => {
    const detail = `the run asked to write ${request} ${did} with bytes that differ from the confirmed plan; nothing was sent`;
    log.event('error', `write fence: ${detail}`);
    return { kind: 'not-sent' as const, detail: `Live kit: ${detail}.` };
  };
  return (link) => {
    const writeDid = link.writeDid.bind(link);
    link.writeDid = async (module, did, bytes, options) =>
      allowed(module.request, did, bytes) ? writeDid(module, did, bytes, options) : refuse(module.request, did);
    const sequence = link.sequence.bind(link);
    link.sequence = async (module, spec, options) => {
      const target = spec.write.kind === 'did' ? spec.write.did : spec.write.address;
      const shown = (w: PlannedWrite) =>
        w.module.request === module.request.toUpperCase() && w.did === target.toUpperCase() && w.after === spec.write.bytes.toUpperCase();
      const planned = writes.find(shown)?.steps ?? [];
      const unshown = mutatingSteps(spec.pre, spec.post).filter((t) => !planned.includes(t));
      if (unshown.length) log.event('error', `write fence: steps not in the confirmed plan: ${unshown.join(', ')}`);
      return allowed(module.request, target, spec.write.bytes) && !unshown.length ? sequence(module, spec, options) : refuse(module.request, target);
    };
  };
}

// ---- running a session -------------------------------------------------------------------------

/** One coding event on the live stream (`note`, `variant-selected`, `readiness`, `outcome`, …). */
export function streamEvent(log: LiveLog, e: CodingEvent): void {
  const { at: _at, type, ...rest } = e as CodingEvent & Record<string, unknown>;
  switch (e.type) {
    case 'writer':
      log.event('note', `${e.step}${e.did ? ` ${e.did}` : ''}${e.module ? ` @${e.module}` : ''}${e.detail ? `: ${e.detail}` : ''}`, e.passwordSource ? { passwordSource: e.passwordSource } : {});
      return;
    case 'variant-selected':
      log.event('variant-selected', `${e.recipeId}: ${e.selector} on ${e.did} — ${e.reason}`, { probe: e.probe });
      return;
    case 'variant-refused':
      log.event('variant-selected', `${e.recipeId}: no variant — ${e.reason}`, { probe: e.probe });
      return;
    case 'readiness':
      log.event('readiness', e.ok ? 'in the usual band' : 'outside the usual band or unreadable (a warning, never a gate)', {
        rpm: e.rpm, speedKmh: e.speedKmh, voltage: e.voltage, ageMs: e.ageMs,
      });
      return;
    case 'outcome':
      log.event('outcome', `${e.outcome}: ${e.phase}`);
      return;
    case 'backup-saved':
      recorded.journals.add(e.backupId);
      log.event('backup', `backup saved before the write: ${e.backupId}`);
      return;
    case 'car-verified':
      log.event('coding', 'car verified (VIN never shown)', { part: e.part });
      return;
    case 'refused':
    case 'link-lost':
    case 'audit-failed':
      log.event('error', `${type}${'detail' in e ? `: ${e.detail}` : ''}`, 'reason' in e ? { reason: e.reason } : {});
      return;
    case 'warning':
      log.event('warn', `${e.code}: ${e.detail}`);
      return;
    case 'module-scan': {
      // A unit that hosts F190 answers it in the map: shown as its length only.
      const answered = Object.fromEntries(Object.entries(e.answered).map(([did, hex]) => [did, did === 'F190' ? `[VIN, ${hex.length / 2} bytes]` : hex]));
      log.event('result', `unit ${e.unit} ${e.part || ''}: ${Object.keys(e.answered).length} answered, ${Object.keys(e.refused).length} refused, ${e.silent.length} silent${e.complete ? '' : ' (partial)'}`, {
        ...(e.odx ? { odx: e.odx } : {}), answered, refused: e.refused, silent: e.silent,
      });
      return;
    }
    case 'scan-progress':
      log.event(
        'scan',
        e.phase === 'discover'
          ? `presence ${e.done}/${e.total}: unit ${e.unit} ${e.fitted ? 'answered' : 'no answer'}`
          : `unit ${e.unit}: ${e.done} of ${e.total} identifiers answered so far`,
      );
      return;
    case 'scan-discovery': {
      const fitted = e.units.filter((u) => u.fitted);
      log.event('scan', `${fitted.length} of ${e.units.length} unit addresses answered`, {
        fitted: fitted.map((u) => `${u.unit} ${u.request} ${u.part ?? (u.nrc ? `NRC ${u.nrc}` : '')}`.trim()),
        absent: e.units.filter((u) => !u.fitted).map((u) => `${u.unit} ${u.request} ${u.answer}`),
      });
      return;
    }
    case 'car-map':
      log.event('scan', `car map built: ${e.map.units.length} units, ${e.map.totals.values} values, ${e.map.features.length} features, ${e.map.lamps.length} lamp records${e.map.complete ? '' : ' (incomplete)'}`);
      return;
    case 'feature-report':
      for (const entry of e.entries) {
        const st = entry.state;
        const said = st.kind === 'value' ? `${st.did} = ${st.value}${st.choiceId ? ` (${st.choiceId})` : ''}` : st.kind;
        log.event('result', `unit ${e.unit} ${entry.name}: ${said}`, { recipeId: entry.recipeId, features: entry.featureIds });
      }
      return;
    default:
      log.event('coding', type, rest as Record<string, unknown>);
  }
}

/**
 * Writes a full scan's car map next to the session logs: `<log-dir>/scans/<started>-<VIN>.json` (the whole map) and
 * `.md` (the readable report). The file names carry the full VIN, as the app's own records do.
 */
export function saveCarMap(logDir: string, map: CarMap): { json: string; md: string } {
  const dir = join(logDir, 'scans');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, `${map.startedAt.replace(/[:.]/g, '-')}-${map.vin ?? 'no-vin'}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(md, carMapMarkdown(map), { mode: 0o600 });
  return { json, md };
}

export { carMapSummary };

/**
 * Keeps a simulator run's records out of every later upload: each gets an outbox entry the outbox treats as
 * deleted from the cloud (never re-uploaded automatically) — so a rehearsal on the fake bridge can share the
 * store with real sessions.
 */
export async function excludeFromUpload(store: LiveStore): Promise<number> {
  const at = new Date().toISOString();
  const sessions = await store.db.connectionLogs.filter((l) => recorded.sessions.has(l.session)).primaryKeys();
  const rows = [
    ...[...recorded.experiments].map((id) => ['experiment', id] as const),
    ...[...recorded.journals].map((id) => ['journal', id] as const),
    ...sessions.map((id) => ['session', String(id)] as const),
  ];
  await store.db.outbox.bulkPut(
    rows.map(([kind, id]) => ({
      key: `${kind}:${id}`,
      kind,
      id,
      status: 'failed' as const,
      deleted: true as const,
      contentHash: 'synthetic',
      attempts: 0,
      nextAttemptAt: at,
      updatedAt: at,
      lastError: 'Synthetic VIN (live kit simulator): a rehearsal record, never uploaded.',
    })),
  );
  return rows.length;
}

/** Runs one request through the app's CodingController with the app's deps; resolves with every event. */
export async function runCodingSession(
  rig: LiveLink,
  store: LiveStore,
  log: LiveLog,
  request: CodingRequest,
  expectedVinFingerprint: string | undefined,
): Promise<CodingEvent[]> {
  const controller = new CodingController((signal) => {
    const audit = new ExperimentRecorder(rig.link, () => store.db);
    recorded.experiments.add(audit.id);
    return {
    link: rig.link,
    audit,
    backups: store.backups,
    signal,
    relink: () => rig.relink(),
    // As the app: identity and the coded DID only (the 301-DID inventory scan silenced the BCM, F73).
    moduleSnapshot: false,
    expectedVinFingerprint,
    };
  });
  let shown = 0;
  controller.subscribe((_progress, events) => {
    for (; shown < events.length; shown++) streamEvent(log, events[shown] as CodingEvent);
  });
  let all: CodingEvent[] = [];
  controller.subscribe((_p, events) => {
    all = [...events];
  });
  const handle = controller.start(request);
  const cancel = () => {
    log.event('warn', 'Ctrl-C: cancel requested (honoured only until the write is on the wire; the run finishes honestly)');
    handle.cancel();
  };
  process.on('SIGINT', cancel);
  try {
    await handle.done;
  } finally {
    process.off('SIGINT', cancel);
  }
  return all;
}
