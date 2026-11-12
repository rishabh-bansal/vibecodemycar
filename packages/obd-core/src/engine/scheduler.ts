import { pidDef, pidDefOrRaw } from '@obdcraft/definitions';
import type { EcuInfo } from '../obd/context.ts';
import { knownLength } from '../obd/services/service01.ts';

export type Tier = 'fast' | 'medium' | 'slow' | 'rare';

/** Target refresh interval per tier (ms). Fast items are polled as often as the link allows. */
export const TIER_INTERVAL: Record<Tier, number> = { fast: 0, medium: 2000, slow: 10_000, rare: 60_000 };

export const DEFAULT_TIERS: Record<number, Tier> = {
  0x0c: 'fast', 0x0d: 'fast', 0x04: 'fast', 0x11: 'fast', 0x0b: 'fast', 0x0e: 'fast', 0x49: 'fast', 0x06: 'fast',
  0x34: 'fast', 0x44: 'fast', 0x10: 'fast', 0x5e: 'fast', 0x24: 'fast',
  0x05: 'medium', 0x0f: 'medium', 0x07: 'medium', 0x42: 'medium', 0x45: 'medium', 0x47: 'medium', 0x4a: 'medium',
  0x4c: 'medium', 0x2e: 'medium', 0x15: 'medium', 0x43: 'medium', 0x0a: 'medium', 0x23: 'medium', 0x5c: 'medium',
  0x70: 'medium', 0x6d: 'medium', 0x14: 'medium', 0x22: 'medium', 0x59: 'medium', 0x2c: 'medium', 0x62: 'medium', 0x61: 'medium',
  0x2f: 'slow', 0x46: 'slow', 0x1f: 'slow', 0x3c: 'slow', 0x3e: 'slow', 0x68: 'slow', 0x67: 'slow', 0x56: 'slow', 0x33: 'slow',
  0x03: 'slow', 0x55: 'slow', 0x57: 'slow', 0x58: 'slow', 0x08: 'slow', 0x09: 'slow', 0x32: 'slow', 0xa6: 'slow',
  0x01: 'rare', 0x41: 'rare', 0x21: 'rare', 0x30: 'rare', 0x31: 'rare', 0x4d: 'rare', 0x4e: 'rare', 0x1c: 'rare', 0x51: 'rare', 0x13: 'rare',
};

/** Fast items share this fraction of requests even when slower ones are overdue. */
const TIER_WEIGHT: Record<Tier, number> = { fast: 0.55, medium: 0.3, slow: 0.12, rare: 0.03 };

interface Item {
  ecu: string;
  pid: number;
  tier: Tier;
  lastAt: number;
  lastOkAt: number;
  misses: number;
  /** Silenced after repeated no-answers; re-probed occasionally. */
  backoffUntil: number;
  count: number;
}

export interface GroupLimits {
  /** Max PIDs per request (1 = no multi-PID). */
  maxPids: number;
  /** Max reply payload bytes; 7 keeps the reply in one CAN frame. */
  maxReplyBytes: number;
}

export interface Batch {
  ecu: string;
  pids: number[];
}

/**
 * Picks what to poll next. Weighted by tier with deficit counters, so fast items
 * get most of the bandwidth without starving slow ones; groups compatible PIDs
 * of one ECU into a multi-PID request within the tuner's limits.
 */
export class LiveScheduler {
  private items: Item[] = [];
  private credits: Record<Tier, number> = { fast: 0, medium: 0, slow: 0, rare: 0 };
  private rr = 0;

  private readonly ecus: Map<string, EcuInfo>;
  private readonly now: () => number;

  constructor(ecus: Map<string, EcuInfo>, now: () => number) {
    this.ecus = ecus;
    this.now = now;
  }

  /** Polls each PID from one ECU: the engine where it supports it, otherwise the first ECU that does. */
  setPids(pids: number[], tiers: Record<number, Tier> = DEFAULT_TIERS): void {
    const engine = [...this.ecus.values()].find((e) => e.role === 'engine');
    const others = [...this.ecus.values()].filter((e) => e !== engine);
    this.items = [];
    for (const pid of pids) {
      if (pid % 0x20 === 0 || !pidDefOrRaw(pid)) continue;
      const ecu = engine?.pids.has(pid) ? engine : others.find((e) => e.pids.has(pid));
      if (!ecu) continue;
      this.items.push({ ecu: ecu.id, pid, tier: tiers[pid] ?? 'medium', lastAt: -Infinity, lastOkAt: -Infinity, misses: 0, backoffUntil: 0, count: 0 });
    }
  }

  get size(): number {
    return this.items.length;
  }

  pidsFor(ecu: string): number[] {
    return this.items.filter((i) => i.ecu === ecu).map((i) => i.pid);
  }

  private due(i: Item, t: number): boolean {
    if (t < i.backoffUntil) return false;
    return t - i.lastAt >= TIER_INTERVAL[i.tier];
  }

  private overdue(i: Item, t: number): number {
    const iv = TIER_INTERVAL[i.tier];
    const age = t - i.lastAt;
    return iv === 0 ? age / 500 : age / iv;
  }

  private groupable(i: Item): boolean {
    const def = pidDefOrRaw(i.pid)!;
    return def.multi_pid && knownLength(def, this.ecus.get(i.ecu)) !== null;
  }

  next(limits: GroupLimits, restrictEcu?: string): Batch | null {
    const t = this.now();
    const pool = this.items.filter((i) => (!restrictEcu || i.ecu === restrictEcu) && this.due(i, t));
    if (pool.length === 0) {
      // nothing due: poll the most overdue fast item anyway (the link is never idle while live)
      const fast = this.items.filter((i) => (!restrictEcu || i.ecu === restrictEcu) && t >= i.backoffUntil).sort((a, b) => a.lastAt - b.lastAt);
      if (fast.length === 0) return null;
      pool.push(fast[0]!);
    }
    // choose a tier by deficit round robin among tiers that have due items
    const tiers = [...new Set(pool.map((i) => i.tier))];
    for (const tr of tiers) this.credits[tr] += TIER_WEIGHT[tr];
    const tier = tiers.sort((a, b) => this.credits[b] - this.credits[a])[0]!;
    this.credits[tier] -= 1;
    const inTier = pool.filter((i) => i.tier === tier).sort((a, b) => this.overdue(b, t) - this.overdue(a, t) || a.pid - b.pid);
    const lead = inTier[this.rr++ % Math.max(1, Math.min(inTier.length, 2))] ?? inTier[0]!;
    const batch: Item[] = [lead];
    if (limits.maxPids > 1 && this.groupable(lead)) {
      let bytes = 1 + 1 + knownLength(pidDef(lead.pid)!, this.ecus.get(lead.ecu))!;
      const candidates = pool
        .filter((i) => i !== lead && i.ecu === lead.ecu && this.groupable(i))
        .sort((a, b) => this.overdue(b, t) - this.overdue(a, t));
      for (const c of candidates) {
        if (batch.length >= limits.maxPids) break;
        const add = 1 + knownLength(pidDef(c.pid)!, this.ecus.get(c.ecu))!;
        if (bytes + add > limits.maxReplyBytes) continue;
        bytes += add;
        batch.push(c);
      }
    }
    for (const b of batch) b.lastAt = t;
    return { ecu: lead.ecu, pids: batch.map((b) => b.pid) };
  }

  report(ecu: string, pid: number, ok: boolean): void {
    const it = this.items.find((i) => i.ecu === ecu && i.pid === pid);
    if (!it) return;
    const t = this.now();
    if (ok) {
      it.lastOkAt = t;
      it.misses = 0;
      it.count++;
      it.backoffUntil = 0;
    } else {
      it.misses++;
      // an item that keeps failing stops eating bandwidth; re-probe later
      if (it.misses >= 4) it.backoffUntil = t + Math.min(60_000, 2000 * 2 ** (it.misses - 4));
    }
  }

  stats(): { ecu: string; pid: number; tier: Tier; count: number; lastOkAt: number; misses: number }[] {
    return this.items.map(({ ecu, pid, tier, count, lastOkAt, misses }) => ({ ecu, pid, tier, count, lastOkAt, misses }));
  }
}
