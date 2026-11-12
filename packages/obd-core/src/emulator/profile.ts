import { StandardEcu, type StandardEcuSpec, type ValueSource } from './vehicle.ts';
import { parseHexBytes } from '../util/hex.ts';

/** A recorded vehicle, scrubbed for demo use (see scripts/build-demo-profile.ts). */
export interface VehicleProfile {
  schema: 'obdcraft.vehicle-profile/1';
  name: string;
  demo: boolean;
  note: string;
  vin: string;
  protocol: number;
  adapter: { identity: string; device: string; voltage: number };
  ecus: { id: string; requestId: string; name: string; pad: string; latencyMs: number }[];
  durationSeconds: number;
  /** ecu -> PID -> [seconds, data hex][] */
  series: Record<string, Record<string, [number, string][]>>;
  /** ecu -> command -> full reply payload hex (service byte first) */
  statics: Record<string, Record<string, string>>;
  repaired?: string[];
}

const hexb = (s: string) => parseHexBytes(s) ?? [];

/** Step playback of a recorded series, looping over the profile duration. */
function playback(points: [number, string][], duration: number): ValueSource {
  const pts = points.map(([t, h]) => [t, hexb(h)] as const).sort((a, b) => a[0] - b[0]);
  return (t) => {
    const x = duration > 0 ? ((t % duration) + duration) % duration : t;
    let lo = 0;
    let hi = pts.length - 1;
    if (x <= pts[0]![0]) return [...pts[0]![1]];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid]![0] <= x) lo = mid;
      else hi = mid - 1;
    }
    return [...pts[lo]![1]];
  };
}

function pages(st: Record<string, string>, prefix: string, dataOffset: number): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  for (const [cmd, hex] of Object.entries(st)) {
    if (!cmd.startsWith(prefix) || cmd.length !== prefix.length + 2 + (prefix === '02' ? 2 : 0)) continue;
    const page = parseInt(cmd.slice(prefix.length, prefix.length + 2), 16);
    if (page % 0x20 !== 0) continue;
    out[page] = hexb(hex).slice(dataOffset, dataOffset + 4);
  }
  return out;
}

export function ecusFromProfile(p: VehicleProfile): StandardEcu[] {
  return p.ecus.map((e) => {
    const st = p.statics[e.id] ?? {};
    const ser = p.series[e.id] ?? {};
    const pids: Record<number, ValueSource> = {};
    const support01 = pages(st, '01', 2);
    for (const [cmd, hex] of Object.entries(st)) {
      if (!/^01[0-9A-F]{2}$/.test(cmd)) continue;
      const pid = parseInt(cmd.slice(2), 16);
      if (pid % 0x20 === 0) continue;
      const data = hexb(hex).slice(2);
      pids[pid] = () => [...data];
    }
    for (const [pidHex, points] of Object.entries(ser)) {
      if (points.length) pids[parseInt(pidHex, 16)] = playback(points, p.durationSeconds);
    }
    const dtcList = (cmd: string): string[] | null => {
      const h = st[cmd];
      if (!h) return null;
      const b = hexb(h);
      const codes: string[] = [];
      for (let i = 2; i + 1 < b.length && codes.length < (b[1] ?? 0); i += 2) {
        const hi = b[i]!;
        const lo = b[i + 1]!;
        codes.push(`${'PCBU'[hi >> 6]}${(hi >> 4) & 3}${(hi & 15).toString(16).toUpperCase()}${lo.toString(16).toUpperCase().padStart(2, '0')}`);
      }
      return codes;
    };
    const mode06: Record<number, number[]> = {};
    for (const [cmd, hex] of Object.entries(st)) {
      if (!/^06[0-9A-F]{2}$/.test(cmd)) continue;
      const mid = parseInt(cmd.slice(2), 16);
      if (mid % 0x20 === 0) continue;
      mode06[mid] = hexb(hex).slice(1);
    }
    const mode09: Record<number, number[]> = {};
    for (const [cmd, hex] of Object.entries(st)) {
      if (!/^09[0-9A-F]{2}$/.test(cmd) || cmd === '0900') continue;
      mode09[parseInt(cmd.slice(2), 16)] = hexb(hex).slice(2);
    }
    const spec: StandardEcuSpec = {
      id: e.id, requestId: e.requestId, name: e.name, pad: parseInt(e.pad, 16), latencyMs: e.latencyMs,
      pids, supportOverride: support01,
      dtcs: { stored: dtcList('03') ?? [], pending: dtcList('07') ?? [], permanent: dtcList('0A') },
      freeze: null,
      freezeSupport: pages(st, '02', 3),
      mode06, mode06Support: pages(st, '06', 2),
      ...(st['0900'] ? { mode09Support: hexb(st['0900']).slice(2, 6) } : {}),
      mode09,
      mode08: null,
    };
    return new StandardEcu(spec);
  });
}
