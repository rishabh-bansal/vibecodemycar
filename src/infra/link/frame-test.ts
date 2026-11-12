import type {
  CarLink,
  DidRead,
  DidWrite,
  ModuleAddress,
  TxFrameRecord,
  WriteFrameMode,
} from '../../domain/coding/types.ts';
import { recordDiag } from '../../domain/diagnostics.ts';
import type { AdapterSummary } from './web-bluetooth.ts';

/**
 * The live kit's frame test: which way of handing CAN frames to the adapter makes the 8th byte of a full frame
 * arrive as sent. It writes ONLY the BCM's F198 workshop-code marker, through the real writer (gateway hop,
 * extended session, security access with the unit's default code, proof reads), with the coding markers off — the
 * payload is the marker.
 *
 * `2E F1 98` + six bytes is nine bytes, so the request is always a first frame plus one consecutive frame:
 *   FF `10 09 2E F1 98 d0 d1 d2` — d2 (F198 data byte 2) is the 8th byte under test
 *   CF `21 d3 d4 d5 …`
 * Each trial writes the original bytes with d1 set to a value unique to that trial (proof the write landed; the 7th
 * byte is known good) and d2 set to the value under test (0x00, which `trim-zero` can trim, and 0x5A, which it
 * cannot). It then reads F198 back and compares. The original goes back at the end with the best mode found.
 *
 * It needs F198 readable first. The owner's Kushaq BCM keeps F198 and F199 write-only (`22 F198` → `7F 22 31`, live
 * 2026-11-09): there the test stops at once, writes nothing, and says to use `repair` on a known stray DID instead.
 */

export const FRAME_TEST_MODULE: ModuleAddress = Object.freeze({ request: '70E', response: '778' });
export const FRAME_TEST_DID = 'F198';
/** The BCM's (unit 09) default security code. */
export const FRAME_TEST_PASSWORD = '31347';
/** The 8th-byte values tried in every mode. */
export const FRAME_TEST_VALUES: readonly number[] = Object.freeze([0x00, 0x5a]);
/** Modes in the order tried; `stpx` only when the adapter is a confirmed STN chip. */
export const FRAME_TEST_MODES: readonly WriteFrameMode[] = Object.freeze([
  'full',
  'trim-zero',
  'fc-alt',
  'stpx',
]);
/** Which mode restores, best first: the proven framing, the chip doing ISO-TP itself, the trim, the diagnostic. */
const RESTORE_PREFERENCE: readonly WriteFrameMode[] = ['full', 'stpx', 'trim-zero', 'fc-alt'];

export type FrameTestLink = Pick<CarLink, 'readDid' | 'writeDid'> & { adapter?: AdapterSummary };

export interface FrameTestTrial {
  mode: WriteFrameMode;
  /** The 8th frame byte under test (F198 data byte 2), hex. */
  value: string;
  /** F198 bytes written. */
  sent: string;
  /** The writer's result. */
  write: DidWrite['kind'];
  writeDetail?: string;
  /** F198 as read back afterwards (absent when the read failed: see `read`). */
  stored?: string;
  read: DidRead['kind'];
  /** The trial's own 7th byte arrived: the write landed. */
  landed: boolean;
  /** The 8th frame byte as stored (hex), when read back. */
  byte8?: string;
  /** Everything stored as sent. */
  match: boolean;
  /** The data write's own frames (2E F1 98 …): the intended bytes and, when different, what the adapter was given. */
  frames: TxFrameRecord[];
}

export interface FrameTestReport {
  schema: 'obdcraft.frame-test/1';
  startedAt: string;
  endedAt?: string;
  module: ModuleAddress;
  did: string;
  adapter?: AdapterSummary;
  original?: string;
  modes: WriteFrameMode[];
  trials: FrameTestTrial[];
  /** The best mode for a frame whose 8th byte is 0x00 / anything else, when one stored it right. */
  best?: { zero?: WriteFrameMode; nonZero?: WriteFrameMode };
  restore?: { mode: WriteFrameMode; write: DidWrite['kind']; stored?: string; exact: boolean };
  /** Why the test stopped early, if it did. */
  stopped?: string;
  /** One line per finding, for the table's footer. */
  findings: string[];
}

export interface FrameTestOptions {
  modes?: readonly WriteFrameMode[];
  password?: string;
  /** Called after every step with the report so far (the CLI saves it as it grows). */
  onProgress?: (report: FrameTestReport) => void;
  /** Writer notes, for the live stream. */
  onNote?: (text: string) => void;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const bytesOf = (hex: string) => (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
const hexOf = (bytes: readonly number[]) => bytes.map(hex2).join('');

/** The trial's bytes: the original with a unique 7th frame byte (index 1) and the 8th under test (index 2). */
export function trialBytes(original: string, index: number, value: number): string {
  const bytes = bytesOf(original);
  let tag = (0x41 + index * 3) & 0xff;
  if (tag === bytes[1]) tag = (tag + 0x10) & 0xff;
  bytes[1] = tag;
  bytes[2] = value;
  return hexOf(bytes);
}

/** The frames a write's payload went out as: from its first frame `10 xx 2E F1 98`, through the next first frame. */
function payloadFrames(frames: readonly TxFrameRecord[]): TxFrameRecord[] {
  const isPayloadFf = (f: TxFrameRecord) => /^1[0-9A-F]{3}2EF198/.test(f.data);
  const last = frames.findLastIndex(isPayloadFf);
  const ff = frames[last];
  if (!ff) return [];
  // The first frame and the consecutive frames after it (the module's flow control is never ours).
  const out = [ff];
  for (const f of frames.slice(last + 1)) {
    if (!/^2/.test(f.data)) break;
    out.push(f);
  }
  return out;
}

export async function runFrameTest(
  link: FrameTestLink,
  options: FrameTestOptions = {},
): Promise<FrameTestReport> {
  const modes = [...(options.modes ?? FRAME_TEST_MODES)].filter((m) => m !== 'stpx' || link.adapter?.stpx);
  const report: FrameTestReport = {
    schema: 'obdcraft.frame-test/1',
    startedAt: new Date().toISOString(),
    module: FRAME_TEST_MODULE,
    did: FRAME_TEST_DID,
    ...(link.adapter ? { adapter: link.adapter } : {}),
    modes,
    trials: [],
    findings: [],
  };
  const progress = () => {
    try {
      options.onProgress?.(report);
    } catch {
      // the test never stops for its record
    }
  };
  const finish = (stopped?: string): FrameTestReport => {
    if (stopped) report.stopped = stopped;
    report.endedAt = new Date().toISOString();
    report.findings = findings(report);
    recordDiag('coding', 'frame-test-result', {
      adapter: report.adapter,
      original: report.original,
      best: report.best,
      restore: report.restore,
      stopped: report.stopped,
      trials: report.trials.map((t) => ({
        mode: t.mode,
        value: t.value,
        sent: t.sent,
        write: t.write,
        stored: t.stored,
        byte8: t.byte8,
        match: t.match,
        frames: t.frames.map((f) => `${f.data}${f.sent ? ` (sent ${f.sent.slice(0, 40)})` : ''}`),
      })),
      findings: report.findings,
    });
    progress();
    return report;
  };

  const first = await link.readDid(FRAME_TEST_MODULE, FRAME_TEST_DID);
  // The owner's BCM (2Q0937089D) keeps F198 / F199 write-only: 22 F198 → 7F 22 31 (live 2026-11-09). Without the
  // original the test cannot compare nor restore, so it does not start.
  if (first.kind === 'nrc' && first.code === '31')
    return finish(
      'F198 is not readable on this module (22 F198 → 7F 22 31: write-only): frame test not possible; use `repair` on a known stray DID instead. Nothing was written',
    );
  if (first.kind !== 'ok') return finish(`F198 could not be read first (${first.kind}): nothing was written`);
  if (first.bytes.length < 10)
    return finish(
      `F198 holds ${first.bytes.length / 2} bytes: under 5, its write is a single frame with no 8th byte to test`,
    );
  const original = first.bytes.toUpperCase();
  report.original = original;
  progress();

  let current = original;
  const write = async (mode: WriteFrameMode, bytes: string) => {
    const frames: TxFrameRecord[] = [];
    const result = await link.writeDid(FRAME_TEST_MODULE, FRAME_TEST_DID, bytes, {
      securityPassword: options.password ?? FRAME_TEST_PASSWORD,
      passwordSource: 'unit-default',
      originalBytes: current,
      onPending: () => {},
      markers: false,
      frameMode: mode,
      onTxFrame: (n, f) => {
        frames[n] = f;
      },
      onNote: (n) =>
        options.onNote?.(`${mode}: ${n.step}${n.did ? ` ${n.did}` : ''}${n.detail ? `: ${n.detail}` : ''}`),
    });
    const read = await link.readDid(FRAME_TEST_MODULE, FRAME_TEST_DID);
    if (read.kind === 'ok') current = read.bytes.toUpperCase();
    return { result, read, frames: payloadFrames(frames.filter(Boolean)) };
  };

  let index = 0;
  for (const mode of modes) {
    for (const value of FRAME_TEST_VALUES) {
      const sent = trialBytes(original, index++, value);
      const { result, read, frames } = await write(mode, sent);
      const stored = read.kind === 'ok' ? read.bytes.toUpperCase() : undefined;
      const trial: FrameTestTrial = {
        mode,
        value: hex2(value),
        sent,
        write: result.kind,
        ...('detail' in result && result.detail ? { writeDetail: result.detail } : {}),
        ...(stored ? { stored, byte8: stored.slice(4, 6) } : {}),
        read: read.kind,
        landed: !!stored && stored.slice(2, 4) === sent.slice(2, 4),
        match: stored === sent,
        frames,
      };
      report.trials.push(trial);
      recordDiag('coding', 'frame-test-trial', {
        mode,
        value: trial.value,
        sent,
        write: trial.write,
        stored: trial.stored,
        match: trial.match,
        frames: frames.map((f) => `${f.data}${f.sent ? ` (sent ${f.sent.slice(0, 40)})` : ''}`),
      });
      progress();
      if (result.kind === 'link-lost' || read.kind === 'link-lost')
        return finish(
          `the link was lost during ${mode} / ${trial.value}: F198 may hold ${sent}; original ${original}`,
        );
    }
  }

  const works = (value: 'zero' | 'nonZero') =>
    RESTORE_PREFERENCE.find((m) =>
      report.trials.some((t) => t.mode === m && t.match && (value === 'zero') === (t.value === '00')),
    );
  const zero = works('zero');
  const nonZero = works('nonZero');
  report.best = { ...(zero ? { zero } : {}), ...(nonZero ? { nonZero } : {}) };

  // The original back, with the mode that stored its kind of 8th byte right (best effort when none did).
  const originalByte8 = bytesOf(original)[2] ?? 0;
  const mode = (originalByte8 === 0 ? zero : nonZero) ?? (originalByte8 === 0 ? 'trim-zero' : 'full');
  if (current === original) {
    report.restore = { mode, write: 'acked', stored: current, exact: true };
    return finish();
  }
  const { result, read } = await write(mode, original);
  report.restore = {
    mode,
    write: result.kind,
    ...(read.kind === 'ok' ? { stored: read.bytes.toUpperCase() } : {}),
    exact: read.kind === 'ok' && read.bytes.toUpperCase() === original,
  };
  return finish();
}

/** Plain findings from the trials: what each mode did to the 8th byte, and what to use. */
export function findings(report: FrameTestReport): string[] {
  const out: string[] = [];
  for (const mode of report.modes) {
    const trials = report.trials.filter((t) => t.mode === mode);
    if (!trials.length) continue;
    const said = trials.map((t) => {
      if (!t.stored) return `${t.value}: not read back (${t.write}, read ${t.read})`;
      if (!t.landed) return `${t.value}: write did not land (${t.write}; F198 ${t.stored})`;
      return t.match ? `${t.value}: stored as sent` : `${t.value}: 8th byte stored as ${t.byte8}`;
    });
    out.push(`${mode}: ${said.join('; ')}`);
  }
  const fcAlt = report.trials.filter((t) => t.mode === 'fc-alt' && t.landed && !t.match);
  if (fcAlt.some((t) => t.byte8 === '31'))
    out.push('fc-alt stored 0x31: the 8th byte comes from the adapter flow-control buffer');
  else if (fcAlt.length)
    out.push(
      `fc-alt stored ${[...new Set(fcAlt.map((t) => `0x${t.byte8}`))].join('/')}: not the flow-control buffer`,
    );
  if (report.best?.zero || report.best?.nonZero)
    out.push(
      `use: 8th byte 0x00 → ${report.best.zero ?? 'none'}; other 8th bytes → ${report.best.nonZero ?? 'none'}`,
    );
  if (!report.best?.nonZero && report.trials.some((t) => t.value !== '00' && t.landed))
    out.push(
      'no mode stored a non-zero 8th byte: a frame whose 8th byte is not 00 cannot be sent whole by this adapter',
    );
  if (report.restore)
    out.push(
      report.restore.exact
        ? `F198 restored to ${report.original} (${report.restore.mode})`
        : `F198 NOT restored: holds ${report.restore.stored ?? 'unknown'}, original ${report.original}`,
    );
  if (report.stopped) out.push(`stopped: ${report.stopped}`);
  return out;
}
