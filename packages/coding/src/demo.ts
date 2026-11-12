import { DEMO_VIN, StandardEcu, kushaqLikeSpecs, type EcuModel } from '@obdcraft/obd-core';
import { CATALOGUE } from './catalogue.ts';
import type { CodingRecipe } from './session.ts';
import type { DefinitionPack } from './definitions.ts';

export const DEMO_BLOCK_PACK: DefinitionPack = {
  schema: 'obdcraft.coding-definitions/1', id: 'obdcraft-bench-block', name: 'Fictional 32-byte coding block',
  source: {
    title: 'Vibecode my car generated test fixture', reference: 'local:obdcraft-coding-bench',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    notes: 'No external OEM source: this generated simulator fixture uses the digest of an empty external source. It cannot run through a physical transport.',
  },
  definitions: [{
    id: 'fan-display', featureId: 'display-automatic-climate-control-fan-blower-speed-in-ac-auto-mode',
    target: '7A0', responseId: '7A8', did: 0x0600, demoOnly: true,
    identity: { part: 'OBDCRAFT-DEMO', software: 'SIM-1', hardware: 'DEMO-HW-1', odxFile: 'EV_OBDCraftBench_001', odxVersion: '001001' },
    session: 'extended', authorization: 'none',
    block: { length: 32, field: { byteOffset: 11, bitOffset: 6, bitLength: 1, byteOrder: 'little', choices: [
      { id: 'disabled', label: 'Hidden', value: 0 }, { id: 'enabled', label: 'Shown', value: 1 },
    ] } },
  }],
};

/** Fictional identifiers and settings. These recipes cannot execute through a real transport. */
export const DEMO_RECIPES: readonly CodingRecipe[] = CATALOGUE.features.map((feature, index) => ({
  id: `demo-${feature.id}`, featureId: feature.id, featureName: feature.name,
  target: '7A0', responseId: '7A8', part: 'OBDCRAFT-DEMO', software: 'SIM-1',
  did: 0xf500 + index, enabled: '01', disabled: '00', demoOnly: true,
  evidence: 'Vibecode my car fictional bench control unit. Not a manufacturer coding map.', needsSecurityAccess: false,
}));

export class CodingBenchEcu implements EcuModel {
  readonly id = '7A8';
  readonly requestId = '7A0';
  readonly pad = 0;
  readonly latencyMs = 12;
  readonly values = new Map(DEMO_RECIPES.map(r => [r.did, 0]));
  readonly blocks = new Map<number, number[]>([[0x0600, Array.from({ length: 32 }, (_, i) => i === 11 ? 0 : 0xa5)]]);
  /** VAG coding-marker DIDs: F199 date (3B), F1A5 sequence (6B). */
  readonly markers = new Map<number, number[]>([[0xf199, [0x26, 0x01, 0x15]], [0xf1a5, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]]]);
  /** Optional VAG seed&key bench: set a 4-byte seed + the decimal access code the ECU expects. */
  seed: number[] | null = null;
  expectedKeySum: number | null = null;
  securityRequests = 0;
  markerWrites = 0;
  writes = 0;
  failReadback = false;
  handle(req: number[], _t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    const [service, a = 0, b = 0] = req;
    const did = a * 256 + b;
    if (service === 0x22) {
      const identity = did === 0xf187 ? 'OBDCRAFT-DEMO' : did === 0xf188 ? 'DEMO-SW-1' : did === 0xf189 ? 'SIM-1' : did === 0xf190 ? DEMO_VIN : did === 0xf191 ? 'DEMO-HW-1' : did === 0xf19e ? 'EV_OBDCraftBench_001' : did === 0xf1a2 ? '001001' : null;
      if (identity) return [0x62, a, b, ...Array.from(identity, c => c.charCodeAt(0))];
      if (this.markers.has(did)) return [0x62, a, b, ...this.markers.get(did)!];
      if (this.blocks.has(did)) return [0x62, a, b, ...this.blocks.get(did)!];
      const value = this.values.get(did);
      return value === undefined ? [0x7f, service, 0x31] : [0x62, a, b, value];
    }
    if (service === 0x27 && this.seed) {
      this.securityRequests++;
      if (a === 0x03) return [0x67, 0x03, ...this.seed];
      const seed = this.seed.reduce((v, byte) => (v * 256 + byte) >>> 0, 0);
      const key = req.slice(2).reduce((v, byte) => (v * 256 + byte) >>> 0, 0);
      return a === 0x04 && this.expectedKeySum !== null && key === (seed + this.expectedKeySum) >>> 0
        ? [0x67, 0x04] : [0x7f, 0x27, 0x35];
    }
    if (service === 0x2e && (did === 0xf199 && req.length === 6 || did === 0xf198 && req.length === 9)) {
      this.markerWrites++;
      this.markers.set(did, req.slice(3));
      return [0x6e, a, b];
    }
    if (service === 0x2e && this.blocks.has(did) && req.length === this.blocks.get(did)!.length + 3) {
      this.writes++;
      if (!this.failReadback) this.blocks.set(did, req.slice(3));
      return [0x6e, a, b];
    }
    if (service === 0x2e && req.length === 4 && this.values.has(did) && [0, 1].includes(req[3]!)) {
      this.writes++;
      if (!this.failReadback) this.values.set(did, req[3]!);
      return [0x6e, a, b];
    }
    if (service === 0x10 && (a === 1 || a === 3)) return [0x50, a, 0, 50, 1, 244];
    return [0x7f, service ?? 0, 0x11];
  }
}

export function codingBenchEcus(module = new CodingBenchEcu()): EcuModel[] {
  return [
    ...kushaqLikeSpecs().map(spec => new StandardEcu({ ...spec, pids: { ...spec.pids, 0x0c: () => [0, 0], 0x0d: () => [0], 0x42: () => [0x33, 0x90] } })),
    module,
  ];
}
