import type { BackupRecord } from '../backups/schema.ts';
import type { CarLink, CodingEvent, CodingRequest } from './types.ts';

export interface WireTrace {
  at: string;
  elapsedMs: number;
  direction: 'tx' | 'rx' | 'stale';
  text: string;
}

export interface SessionAudit {
  readonly id: string;
  start(request: CodingRequest): Promise<void>;
  append(event: CodingEvent): Promise<void>;
  /** The session re-established its adapter on a fresh link — wire capture moves with it. */
  relink?(link: CarLink): void;
  close(): Promise<void>;
}

export interface ExperimentRecord {
  schema: 'obdcraft.experiment/1';
  id: string;
  startedAt: string;
  updatedAt: string;
  buildId: string;
  /** The commit (`-dirty` when uncommitted changes were built) and package version; absent on old records. */
  gitSha?: string;
  version?: string;
  featureId: string;
  featureName: string;
  recipeId?: string;
  recipeDigest?: string;
  settingId?: string;
  /** Snapshot of the operation journal, with the car's full VIN (`vin.full`), its masked form and fingerprint. */
  backup?: BackupRecord;
  operation: CodingRequest['kind'] | 'investigate';
  mode: 'demo' | 'live' | 'offline';
  /** Open records after a reload are inconclusive, never assumed not sent. */
  state: 'in-progress' | 'complete';
  needsAttention: boolean;
  summary: string;
  events: CodingEvent[];
  wire: WireTrace[];
  traceTruncated: boolean;
  /**
   * What the owner saw on the car after the operation, recorded by hand. Separate from the ACK and the
   * read-back: neither proves the feature behaves as intended.
   */
  observations?: PhysicalObservation[];
}

export interface PhysicalObservation {
  at: string;
  /** What the test plan said to look for. */
  expected: string;
  verdict: 'as-expected' | 'different' | 'unsure';
  note?: string;
}
