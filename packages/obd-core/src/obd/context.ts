import type { ElmLink } from '../elm/link.ts';
import type { RequestRunner } from './request.ts';
import { OBD, type DecodedPid, type ObdDefinitions } from '@obdcraft/definitions';

export interface EcuInfo {
  id: string;
  /** Physical request id (7E0 for 7E8); null when unknown (legacy protocols). */
  requestId: string | null;
  /** Service 01 PIDs this ECU advertises (support pages included). */
  pids: Set<number>;
  freezePids: Set<number>;
  mids: Set<number>;
  infoPids: Set<number>;
  /** Learned reply length per variable-length PID, from a single-PID answer. */
  learnedLengths: Map<number, number>;
  name?: string;
  role: 'engine' | 'transmission' | 'other';
}

export interface Reading {
  ecu: string;
  service: number;
  pid: string;
  key: string;
  name: string;
  short: string;
  value: number | null;
  unit: string | null;
  text?: string;
  setBits?: string[];
  state: 'ok' | 'absent' | 'not_available' | 'out_of_range';
  /** Clock time the reply arrived (ms). */
  t: number;
  recordId: number;
}

export interface ObdContext {
  link: ElmLink;
  runner: RequestRunner;
  defs: ObdDefinitions;
  ecus: Map<string, EcuInfo>;
}

export function makeContext(link: ElmLink, runner: RequestRunner): ObdContext {
  return { link, runner, defs: OBD, ecus: new Map() };
}

export function newEcu(id: string, requestId: string | null): EcuInfo {
  return { id, requestId, pids: new Set(), freezePids: new Set(), mids: new Set(), infoPids: new Set(), learnedLengths: new Map(), role: 'other' };
}

export function readingsFrom(decoded: DecodedPid, ecu: string, service: number, t: number, recordId: number): Reading[] {
  return decoded.fields.map((f) => ({
    ecu, service, pid: decoded.pid, key: f.key, name: f.name, short: f.short, value: f.value, unit: f.unit,
    ...(f.text !== undefined ? { text: f.text } : {}),
    ...(f.setBits ? { setBits: f.setBits } : {}),
    state: f.state, t, recordId,
  }));
}

/** Parses a 4-byte support bitmap into PID numbers base+1 .. base+32. */
export function bitmapPids(base: number, bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const byte = bytes[i >> 3] ?? 0;
    if ((byte >> (7 - (i & 7))) & 1) out.push(base + i + 1);
  }
  return out;
}
