import { parseFrameLine, type Frame } from '../can/frames.ts';
import { reassemble } from '../can/isotp.ts';
import { toHex } from '../util/hex.ts';
import { functionalHeader, physicalReplyId, type ElmLink } from './link.ts';
import { normalizeReply } from './normalize.ts';
import type { ElmReply, ElmTransaction } from './session.ts';
import { PolicyError } from '../safety/policy.ts';

/**
 * ISO-TP frame padding.
 *  - `zero`:   every frame padded to 8 bytes with 0x00.
 *  - `native`: single frames unpadded; first/consecutive frames padded with 0xAA. This is the
 *              framing the native writer used on the car (reference/native/elm-transport.swift).
 */
export type FramePadding = 'zero' | 'native';

/**
 * How a channel hands its CAN frames to the adapter. The owner's BLE clone (OBDBLE, "ELM327 v2.1") stores the wrong
 * 8th byte of every full 8-byte frame sent under ATCAF0 (the module held 0x30 or 0xA0; bytes 1–7 right; ATAL changed
 * nothing). A genuine ELM327 sends the 8 bytes unchanged (datasheet: "will not modify your data"). Each mode keeps the
 * frames themselves identical; only what goes to the adapter differs, and the tx log records both.
 *  - `full`       every frame as its 16 hex digits (the proven native framing; the default)
 *  - `trim-zero`  a frame of 8 bytes whose last byte is 0x00 goes as its first 7 bytes and the adapter pads it
 *                 (ATPP26SV00 + ATPP26ON at setup, best effort: a '?' leaves the adapter's default filler, 00) —
 *                 the workaround of Trionic's CANELM327Device and pyren/ddt4all. Frames ending in another byte
 *                 still go whole, so it only helps when the 8th byte is 0x00.
 *  - `fc-alt`     the adapter's flow-control data is 31 00 05 instead of 30 04 05 (ATFCSD310005): diagnoses whether
 *                 the stored 0x30 comes from that buffer (the 8th byte then arrives as 0x31). A diagnostic, not a fix:
 *                 a module's multi-frame answer is first told to WAIT, then granted by this host's own flow control.
 *  - `stpx`       STN adapters only (STI answered "STN…"): the whole PDU in one `STPX h:<hdr>,d:<hex>,r:1` with
 *                 ATCAF1 + STCSEGT1, so the chip builds and paces the ISO-TP frames itself and no 8-byte frame is
 *                 ever handed over. Replies are read as frames, with the adapter's own flow control.
 */
export type FrameMode = 'full' | 'trim-zero' | 'fc-alt' | 'stpx';
export const FRAME_MODES: readonly FrameMode[] = Object.freeze(['full', 'trim-zero', 'fc-alt', 'stpx']);

/** Adapter response timing while a channel is open (ELM `ATAT<n>` and `ATST<hh>`, hh × 4 ms). */
export interface AdapterTiming {
  adaptive: 0 | 1 | 2;
  st: number;
}

/**
 * Reads wait a fixed ~1 s after the last frame (adaptive off): with ATAT1 the adapter's learned
 * window collapsed to ~244 ms after fast replies and declared NO DATA while this car's ECUs still
 * needed ~430 ms (live sessions 2026-10-28, F74). The earlier 200 ms fixed window had the same
 * failure; a fixed ~1 s is patient without being unbounded.
 */
export const READ_TIMING: AdapterTiming = Object.freeze({ adaptive: 0, st: 0xff });
/**
 * The proven coding timing: adaptive on, ~600 ms after the last frame. The native writer moved
 * to this after a write-commit acknowledgement was lost live with the short timing
 * (reference/native/ble-write-coding.swift, adapter setup).
 */
export const CODING_TIMING: AdapterTiming = Object.freeze({ adaptive: 1, st: 0x96 });

export interface UdsChannelOptions {
  target: string;
  responseId: string;
  timing?: AdapterTiming;
  padding?: FramePadding;
  /** How frames reach the adapter; absent: the link's own `frameMode` (default `full`). */
  frameMode?: FrameMode;
}

export interface UdsRequestOptions {
  codingToken?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called immediately before the first CAN frame, never for setup commands. */
  onTransmit?: () => void;
  /** Called once per distinct response-pending (NRC 0x78) message from the ECU. */
  onResponsePending?: () => void;
  /** Called for every CAN frame the addressed module sent after this exchange's request left. */
  onRxFrame?: (frame: Frame) => void;
  /**
   * Called when a CAN frame of this exchange is handed to the adapter (`attempted`) and again when its
   * stage is known (`submitted` / `failed`). `index` counts this exchange's frames from 0.
   */
  onTxFrame?: (index: number, frame: TxFrame) => void;
  /**
   * Bound on the PASSIVE listen after the request's frames are all out and the adapter has
   * prompted without the final answer (a completed NO DATA, or a 78 response-pending). Absent:
   * the historical windows (a write's full deadline, a read's 3 s pending window). `0`: report at
   * once — the live clone never forwards a frame after its prompt (2026-10-31 analysis: zero
   * frames after `>` across every capture), so on it any listen is dead time that lets S3 lapse.
   * The caller then decides what to do (the writer proof-reads the DID instead).
   */
  pendingListenMs?: number;
  /**
   * After a 78 response-pending, keep LISTENING for the final answer for up to this long (from the first 78) by
   * polling: a silent tester present (`3E 80`, which the module does not answer) is sent back to back, so the
   * adapter is always inside a send's response window and prints the final answer when it arrives — the live
   * clone prints nothing after its prompt, so a passive listen hears nothing (2026-11-09: brakes 713 and airbags
   * 715 answered `7F 19 78` to `19 02 2D` and the answer was never heard). The polls also keep any open session
   * alive. A 22/19 read whose module went quiet for longer than P2* (5 s) after its last 78 — so its final answer
   * fell in a gap between two windows — is sent once more. Takes precedence over `pendingListenMs` once a 78 is
   * seen; not used with `stpx`. Absent or 0: no polling.
   */
  pendingPollMs?: number;
}

/**
 * One CAN frame this host handed to the adapter, recorded BEFORE the hand-over so a failure can never lose
 * it. Stages are host-side facts, not bus observations:
 *  - `attempted`  handed to the transport; no answer from the adapter yet
 *  - `submitted`  the adapter took the command and answered without an error. Not proof that the frame
 *                 reached the CAN bus or the module.
 *  - `failed`     the transport threw, or the adapter timed out or reported an error: it may or may not
 *                 have left
 */
export type TxStage = 'attempted' | 'submitted' | 'failed';
export interface TxFrame {
  /** The CAN identifier the adapter was addressing (`ATSH`). */
  can: string;
  bytes: number[];
  /** Connection clock (ms) when the frame was handed to the adapter. */
  at: number;
  stage: TxStage;
  /**
   * What was actually handed to the adapter for this frame, when it was not the frame's own hex: the 7 bytes of a
   * trimmed frame (`trim-zero`), or the `STPX …` command that carried the whole PDU (`stpx`: on the PDU's first
   * frame; the later ones say `STPX`). `bytes` is always the frame as intended.
   */
  sent?: string;
}

export type UdsExchangeOptions = Pick<UdsChannelOptions, 'target' | 'responseId' | 'padding' | 'frameMode'> & UdsRequestOptions;

export interface UdsExchange {
  request: number[];
  response: number[];
  replies: ElmReply[];
  startedAt: number;
  endedAt: number;
  framesSent: number;
  /** Every CAN frame this exchange handed to the adapter, in order — request frames and any flow-control
   *  frames sent while receiving — each with its address and stage. */
  txFrames: TxFrame[];
  /** The request's first frame left on a protocol search (a pending ATSP0, or the channel's own re-search). */
  searched?: boolean;
}

/**
 * A sequence of physically addressed requests under ONE adapter configuration. The adapter is set
 * up once, before the first request, and restored once, after the last — so the bus sees the
 * module's requests back to back instead of separated by ~20 AT round trips each.
 */
export interface UdsChannel {
  readonly target: string;
  readonly responseId: string;
  exchange(payload: readonly number[], opts?: UdsRequestOptions): Promise<UdsExchange>;
  /** Address another module: ATSH/ATCRA/ATFCSH, then ATSP0 (the native writer's proven rebind). */
  retarget(target: string, responseId: string): Promise<void>;
  /**
   * Re-search on the current module so its next request leaves on a fresh protocol search. `full` (default) is the
   * proven ATSH/ATCRA/ATFCSH/ATSP0 re-bind; `full: false` is a bare ATSP0 (cheaper, not yet proven on the car).
   */
  rebind(options?: { full?: boolean }): Promise<void>;
}

/**
 * Why an exchange failed. A caller may tolerate a module that refused (`nrc`) or did not answer in time
 * (`timeout`); the others mean the link itself can no longer be trusted for this sequence:
 *  - `closed`     the adapter or transport disconnected
 *  - `cancelled`  the caller's signal aborted it
 *  - `policy`     the safety policy refused the request (never sent)
 *  - `adapter`    the adapter reported an error or did not confirm a command
 *  - `protocol`   malformed or inconsistent ISO-TP / UDS traffic (the channel may be desynchronised)
 */
export type UdsFailure = 'nrc' | 'timeout' | 'closed' | 'cancelled' | 'policy' | 'adapter' | 'protocol';

export class UdsExchangeError extends Error {
  readonly requestStarted: boolean;
  readonly replies: ElmReply[];
  readonly nrc?: number;
  readonly failure: UdsFailure;
  /**
   * What kind of completed-but-unusable answer this was, when known — both leave the adapter at a
   * normal prompt, so the stream is still in a known state and a sweep may move on:
   *  - `pending`    the module answered 78 response-pending and its final answer never arrived
   *  - `truncated`  a multi-frame reply arrived shorter than it declared (missing consecutive frames)
   */
  detail?: 'pending' | 'truncated';
  /**
   * For a `truncated` answer: the response bytes known in order (service byte first, up to the first missing frame).
   * Never a complete answer — a caller may only compare the bytes it holds.
   */
  partial?: number[];
  /** For a `truncated` answer: the length the module's ISO-TP first frame declared (bytes, service byte included). */
  declaredLength?: number;
  /** The frames handed to the adapter before the failure, including the one that failed. */
  txFrames: TxFrame[];
  /** As {@link UdsExchange.searched}, when the request reached its first frame. */
  searched?: boolean;
  constructor(message: string, requestStarted: boolean, replies: ElmReply[], nrc?: number, failure?: UdsFailure) {
    super(message);
    this.name = 'UdsExchangeError';
    this.requestStarted = requestStarted;
    this.replies = replies;
    this.nrc = nrc;
    this.failure = failure ?? (nrc !== undefined ? 'nrc' : 'protocol');
    this.txFrames = [];
  }
}

/** The ISO-TP sequence count rolls through 0 after 15; the length covers the logical PDU, never padding. */
export function segmentDiagnosticPdu(payload: readonly number[], padding: FramePadding = 'zero'): number[][] {
  if (!payload.length || payload.length > 4095 || payload.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('A diagnostic PDU must contain 1–4095 bytes.');
  }
  const fill = padding === 'native' ? 0xaa : 0;
  const pad = (bytes: number[]) => [...bytes, ...Array<number>(8 - bytes.length).fill(fill)];
  if (payload.length <= 7) return [padding === 'native' ? [payload.length, ...payload] : pad([payload.length, ...payload])];
  const frames = [pad([0x10 | (payload.length >> 8), payload.length & 255, ...payload.slice(0, 6)])];
  for (let pos = 6, seq = 1; pos < payload.length; pos += 7, seq++) frames.push(pad([0x20 | (seq & 15), ...payload.slice(pos, pos + 7)]));
  return frames;
}

/**
 * The bytes a frame is handed to the adapter as. `trim-zero`: an 8-byte frame ending in 0x00 loses that byte (the
 * adapter's filler, 00, puts it back on the bus); every other frame, and every other mode, goes as it is.
 */
export function transmittedFrame(bytes: readonly number[], mode: FrameMode): number[] {
  return mode === 'trim-zero' && bytes.length === 8 && bytes[7] === 0 ? bytes.slice(0, 7) : [...bytes];
}

/** One STN `STPX` command carrying a whole PDU to `target`, expecting `responses` answers (STN1100 FRPM). */
export function stpxCommand(target: string, payload: readonly number[], responses = 1): string {
  if (!/^[0-7][0-9A-F]{2}$/i.test(target)) throw new Error('STPX needs a physical CAN 11-bit header.');
  if (!payload.length || payload.length > 4095 || payload.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error('A diagnostic PDU must contain 1–4095 bytes.');
  }
  if (!Number.isInteger(responses) || responses < 1 || responses > 9) throw new Error('STPX expects 1–9 responses.');
  return `STPX h:${target.toUpperCase()},d:${toHex([...payload], '')},r:${responses}`;
}

/** The adapter's flow-control data for a mode (sent with ATFCSD; `fc-alt` is the buffer diagnostic). */
const fcAltOverride = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OBDCRAFT_FC_ALT;
/** `OBDCRAFT_FC_ALT=000005` (live kit only) replaces the diagnostic 31 00 05, e.g. to make the clone's stray 8th byte 00. */
export const FC_ALT_DATA = Object.freeze(
  fcAltOverride && /^[0-9A-Fa-f]{6}$/.test(fcAltOverride)
    ? (fcAltOverride.match(/../g) ?? []).map((b) => Number.parseInt(b, 16))
    : [0x31, 0x00, 0x05],
);

export function separationTimeMs(byte: number): number {
  if (byte >= 0 && byte <= 0x7f) return byte;
  // A browser cannot promise sub-millisecond dispatch. Waiting longer is valid.
  if (byte >= 0xf1 && byte <= 0xf9) return 1;
  throw new Error('The ECU requested a reserved ISO-TP separation time.');
}

function framesIn(raw: string, responseId: string): Frame[] {
  return normalizeReply(raw, '').lines.flatMap(line => {
    const frame = parseFrameLine(line.replace(/^FC:\s*/i, ''), { family: 'can11', headers: true });
    return frame?.ecu === responseId && frame.bytes.length > 0 && frame.bytes.length <= 8 ? [frame] : [];
  });
}

const PHYSICAL = /^[0-7][0-9A-F]{2}$/;
/** Adapters that answered ATMA with '?': continuations are heard passively instead. */
const LISTEN_ONLY = new WeakSet<ElmLink>();
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
/** Setup and each rebind get their own bounded budget, separate from any request deadline. */
export const CHANNEL_CONFIG_BUDGET_MS = 10_000;
/**
 * Flow control this host answers a module's multi-frame reply with: continue, block size 4, 5 ms between frames.
 * The live clone forwards at most 4 consecutive frames per command (2026-10-31: every reply needing 5 or 6 CFs
 * arrived with exactly 4, so any DID over 34 bytes was unreadable with the native block size 0). With block size 4
 * the module pauses after each 4 CFs and waits for another flow control, which this host sends as its own frame
 * (the adapter answers only the first frame automatically); each such send returns the next block before its prompt.
 * A reply of up to 4 CFs is unaffected.
 */
export const RX_FLOW_CONTROL = Object.freeze([0x30, 0x04, 0x05]);
/** Block size of {@link RX_FLOW_CONTROL}: after this many CFs of one block the host grants the next. */
const RX_BLOCK_SIZE = RX_FLOW_CONTROL[1]!;
/**
 * Time allowed for the adapter's answer to a request's first frame. On automatic protocol (ATSP0) the adapter first
 * searches the bus with that very request: "SEARCHING..." and the module's reply, or "UNABLE TO CONNECT" when nothing
 * answers — about 4.2 s on the live adapter (2026-10-25). The native tools allowed 8 s per request.
 */
export const FIRST_FRAME_REPLY_MS = 8000;
/** Time allowed for the adapter's answer to any later frame of a request. */
export const FRAME_REPLY_MS = 3000;
/** Bound on restoring the adapter configuration when a channel closes. */
export const CHANNEL_RESTORE_BUDGET_MS = 6000;
const CONFIG_BUDGET_MS = CHANNEL_CONFIG_BUDGET_MS;

function checkAddresses(target: string, responseId: string): void {
  if (!PHYSICAL.test(target) || target === '7DF' || !PHYSICAL.test(responseId) || target === responseId) {
    throw new Error('UDS requires distinct physical CAN 11-bit addresses.');
  }
}

/** Mutable state of one open channel, shared by its exchanges. */
interface ChannelState {
  link: ElmLink;
  tx: ElmTransaction;
  target: string;
  responseId: string;
  padding: FramePadding;
  frameMode: FrameMode;
  /** Adapter responses on (ATR1) or off (ATR0). */
  responses: boolean;
  /** Any request of this channel reached the wire. */
  requestStarted: boolean;
  replies: ElmReply[];
  /** Every frame any exchange of this channel handed to the adapter; carried by the channel's own errors. */
  txFrames: TxFrame[];
  /** An ATSP0 was sent since the last request: the next request runs the adapter's protocol search. */
  searchPending: boolean;
  /** An AT command other than ATSP0 was sent since the last request. */
  atSinceRequest: boolean;
  /** Connection clock when the adapter's last prompt arrived. */
  lastPromptAt: number;
}

/**
 * On a native-bind (clone) link a request's first frame never leaves locked after other AT commands, nor longer
 * than this after the last prompt: the clone dropped 94 % of the former and every measured one of the latter
 * (2026-11-02 analysis, BRIEF R1/U3). Such a request is re-searched first; CFs and the host's RX flow control
 * belong to an open transfer and are exempt.
 */
export const LOCKED_IDLE_MAX_MS = 20;

/** Bookkeeping for the guard above, after any command the adapter answered. */
function noteCommand(ch: ChannelState, cmd: string): void {
  ch.lastPromptAt = ch.link.clock.now();
  if (cmd === 'ATSP0') ch.searchPending = true;
  else ch.atSinceRequest = true;
}

const toUdsError = (failure: unknown, requestStarted: boolean, replies: ElmReply[]): UdsExchangeError => {
  if (failure instanceof UdsExchangeError) return failure;
  if (failure instanceof PolicyError) return new UdsExchangeError(failure.message.replace(`${failure.command}: `, ''), requestStarted, replies, undefined, 'policy');
  return new UdsExchangeError(failure instanceof Error ? failure.message : String(failure), requestStarted, replies);
};

/** One configuration command; it must answer OK. */
async function configure(ch: ChannelState, cmd: string, deadline: number): Promise<void> {
  const { link, tx } = ch;
  const ms = deadline - link.clock.now();
  if (link.session.isClosed) throw new UdsExchangeError('The adapter disconnected.', ch.requestStarted, ch.replies, undefined, 'closed');
  if (ms <= 0) throw new UdsExchangeError(`The adapter did not confirm ${cmd} in time.`, ch.requestStarted, ch.replies, undefined, 'adapter');
  link.policy.check(cmd, { family: 'can11', target: ch.target });
  const reply = await tx.send(cmd, Math.min(ms, 1500));
  ch.replies.push(reply);
  noteCommand(ch, cmd);
  if (reply.status !== 'ok') throw new UdsExchangeError(`The adapter ${reply.status === 'closed' ? 'disconnected' : 'timed out'}; the request was not retried.`, ch.requestStarted, ch.replies, undefined, reply.status === 'closed' ? 'closed' : 'adapter');
  const error = reply.statuses.find(status => status !== 'NO DATA');
  if (error) throw new UdsExchangeError(`Adapter reported ${error}.`, ch.requestStarted, ch.replies, undefined, 'adapter');
  if (!reply.lines.some(line => line.trim() === 'OK')) throw new UdsExchangeError(`The adapter did not confirm ${cmd}.`, ch.requestStarted, ch.replies, undefined, 'adapter');
}

/**
 * A best-effort configuration command: true when it answered OK, false when the adapter does not know it ('?').
 * Anything else (a lost link, a timeout, an error) fails as {@link configure} does.
 */
async function configureOptional(ch: ChannelState, cmd: string, deadline: number): Promise<boolean> {
  try {
    await configure(ch, cmd, deadline);
    return true;
  } catch (error) {
    const last = ch.replies.at(-1);
    if (error instanceof UdsExchangeError && error.failure === 'adapter' && last?.status === 'ok'
      && (last.statuses.includes('?') || last.lines.some(line => line.trim() === '?'))) return false;
    throw error;
  }
}

/** The re-bind: the module's addresses again and ATSP0 (`full`), or a bare ATSP0. Nothing after it: an ATST
 *  there was ignored by the clone and only cost a round trip; the search survives it anyway (21/21). */
async function research(ch: ChannelState, full: boolean): Promise<void> {
  const deadline = ch.link.clock.now() + CONFIG_BUDGET_MS;
  const cmds = full ? [`ATSH${ch.target}`, `ATCRA${ch.responseId}`, `ATFCSH${ch.target}`, 'ATSP0'] : ['ATSP0'];
  for (const cmd of cmds) await configure(ch, cmd, deadline);
  ch.link.searchTarget = ch.target;
}

/** Copies of a multi-frame request's final CF after it met NO DATA (see `runExchange`), and the time after the
 *  module's flow control within which a copy may still complete the transfer (N_Cr is 1000 ms, ISO 15765-2). */
const LAST_CF_RETRIES = 2;
const LAST_CF_WINDOW_MS = 700;

/** How long a read waits on a 78 response-pending before the DID counts as unanswered. */
const READ_PENDING_WINDOW_MS = 3000;
/** A write that saw a response-pending may legitimately take this long in total (P2* cap). */
const PENDING_TOTAL_CAP_MS = 60_000;
/** Only a caller that already budgeted a real pending wait earns the cap: a 3 s marker or an 8 s
 *  security send must never stretch into a 60 s stall. */
const PENDING_CAP_MIN_BUDGET_MS = 10_000;
/** ISO 14229-2 P2*server max: a module still working must renew its 78 within this long. */
const P2_STAR_MS = 5000;
/** Silence after the last 78 beyond P2* (plus this margin) means its final answer was missed. */
const P2_STAR_MARGIN_MS = 500;
/** The poll that keeps the adapter listening after a 78: tester present, positive response suppressed. */
const SILENT_TESTER_PRESENT: readonly number[] = Object.freeze([0x3e, 0x80]);

/** One logical request on an open channel; never retried. The policy approves the WHOLE PDU before framing. */
async function runExchange(ch: ChannelState, payload: readonly number[], opts: UdsRequestOptions): Promise<UdsExchange> {
  payload = Object.freeze([...payload]);
  const { link, tx } = ch;
  const target = ch.target, responseId = ch.responseId;
  const frames = segmentDiagnosticPdu(payload, ch.padding);
  const command = toHex([...payload], '');
  const service = payload[0]!;
  const timeout = opts.timeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) throw new Error('Invalid diagnostic deadline.');
  const pollMs = opts.pendingPollMs ?? 0;
  if (!Number.isFinite(pollMs) || pollMs < 0 || pollMs > 30000) throw new Error('Invalid response-pending poll window.');
  const clock = link.clock, startedAt = clock.now();
  // Mutable: the first response-pending on a mutating request extends the budget to the cap —
  // the module declared it needs time, so it gets the full P2* window while it keeps renewing.
  let deadline = startedAt + timeout;
  const replies: ElmReply[] = [];
  const txFrames: TxFrame[] = [];
  let framesSent = 0, requestStarted = false, result: UdsExchange | undefined;
  const fail = (message: string, nrc?: number, failure?: UdsFailure, detail?: UdsExchangeError['detail'], partial?: number[], declared?: number): never => {
    const error = new UdsExchangeError(message, requestStarted, replies, nrc, failure);
    if (detail) error.detail = detail;
    if (partial?.length) error.partial = [...partial];
    if (declared) error.declaredLength = declared;
    throw error;
  };
  // Response-pending messages seen, keyed by their first frame (one per distinct 78).
  const pending = new Set<Frame>();
  /** When the latest 78 was heard, and whether a read was already sent once more after its final answer was missed. */
  let lastPendingAt = startedAt, resent = false;
  const remaining = () => {
    if (opts.signal?.aborted) fail('The diagnostic operation was cancelled.', undefined, 'cancelled');
    if (link.session.isClosed) fail('The adapter disconnected.', undefined, 'closed');
    const ms = deadline - clock.now();
    if (ms <= 0) fail('The diagnostic deadline expired; the request was not retried.', undefined, 'timeout');
    return ms;
  };
  const checkReply = (reply: ElmReply, monitoring = false) => {
    replies.push(reply);
    ch.replies.push(reply);
    // An adapter that times out on a request that was sent is an unanswered request; a closed one is a lost link.
    if (reply.status !== 'ok') fail(`The adapter ${reply.status === 'closed' ? 'disconnected' : 'timed out'}; the request was not retried.`, undefined, reply.status === 'closed' ? 'closed' : 'timeout');
    const error = reply.statuses.find(status => status !== 'NO DATA' && !(monitoring && status === 'STOPPED'));
    if (error) fail(`Adapter reported ${error}.`, undefined, 'adapter');
  };
  const reportRx = (frames: Frame[]): Frame[] => {
    if (opts.onRxFrame) for (const frame of frames) opts.onRxFrame(frame);
    return frames;
  };
  const at = async (cmd: string) => {
    link.policy.check(cmd, { family: 'can11', target });
    const reply = await tx.send(cmd, Math.min(remaining(), 1500));
    noteCommand(ch, cmd);
    checkReply(reply);
    if (!reply.lines.some(line => line.trim() === 'OK')) fail(`The adapter did not confirm ${cmd}.`, undefined, 'adapter');
  };
  const monitor = async (accept: (frames: Frame[]) => boolean, windowMs = remaining()): Promise<Frame[]> => {
    // Continuation of this already-approved PDU only. Unbounded ATMA remains refused by the public policy.
    if (!requestStarted) fail('A passive continuation requires an active approved diagnostic request.');
    const until = (raw: string) => accept(framesIn(raw, responseId));
    // Native diagnostic sessions wait passively. Sending ATMA here changes the adapter's state while
    // the ECU still owns the pending request; the live OBDBLE also explicitly rejects ATMA with '?'.
    if (!link.nativeBind && !LISTEN_ONLY.has(link)) {
      const reply = await tx.monitor(until, Math.min(remaining(), windowMs));
      // Some ELM327 clones do not implement ATMA ('?'): from then on, listen for what the adapter prints by itself
      // (the native writer's method, which received final replies after a response-pending on the car).
      if (reply.status === 'ok' && (reply.statuses.includes('?') || reply.lines.some(line => line.trim() === '?'))) {
        LISTEN_ONLY.add(link);
        replies.push(reply);
        ch.replies.push(reply);
      } else {
        // These bytes arrived AFTER the active request, unlike any bytes discarded before its first frame.
        const frames = reportRx(framesIn(reply.staleBefore + reply.rxRaw, responseId));
        checkReply(reply, true);
        if (!frames.length) fail('Monitoring ended without a matching CAN frame.', undefined, 'timeout');
        return frames;
      }
    }
    const heard = await tx.listen(until, Math.min(remaining(), windowMs));
    replies.push(heard);
    ch.replies.push(heard);
    if (heard.status === 'closed') fail('The adapter disconnected.', undefined, 'closed');
    const frames = framesIn(heard.rxRaw, responseId);
    if (!frames.length) fail('No further reply arrived from the module.', undefined, 'timeout');
    return reportRx(frames);
  };
  const stpx = ch.frameMode === 'stpx';
  /** The command the policy approves for this request: the PDU itself, or the STPX command that carries it. */
  const approved = stpx ? stpxCommand(target, payload) : command;
  /**
   * Hands one adapter command to the adapter. `intended` are the CAN frames it stands for (one frame, or every frame
   * of the PDU for STPX) and `text` what is actually sent; both are recorded.
   */
  const transmit = async (intended: readonly number[][], text: string): Promise<Frame[]> => {
    remaining();
    // Every frame goes out with adapter responses on, as the native writer sent them: toggling ATR0 before the
    // middle CFs and ATR1 before the last made the final CF an "after-AT" send — the pattern that came back
    // NO DATA 16 of 17 times live (2026-10-31, HVAC 0600: last CF cut at 120 ms).
    if (!ch.responses) {
      await at('ATR1');
      ch.responses = true;
    }
    if (!requestStarted) {
      link.policy.check(approved, { family: 'can11', target }, undefined, opts.codingToken);
      opts.onTransmit?.();
      requestStarted = true;
      ch.requestStarted = true;
    }
    // Recorded before the hand-over: if the transport throws, the frame may already have left.
    const base = txFrames.length;
    const records = intended.map((bytes, i): TxFrame => {
      const sent = stpx ? (i === 0 ? text : 'STPX') : text === toHex([...bytes], '') ? undefined : text;
      return { can: target, bytes: [...bytes], at: clock.now(), stage: 'attempted', ...(sent ? { sent } : {}) };
    });
    for (const frame of records) {
      txFrames.push(frame);
      ch.txFrames.push(frame);
    }
    const report = () => records.forEach((frame, i) => opts.onTxFrame?.(base + i, { ...frame, bytes: [...frame.bytes] }));
    report();
    let reply: ElmReply;
    try {
      reply = await tx.send(text, Math.min(remaining(), base === 0 ? FIRST_FRAME_REPLY_MS : FRAME_REPLY_MS));
    } catch (error) {
      for (const frame of records) frame.stage = 'failed';
      report();
      throw error;
    }
    for (const frame of records) frame.stage = reply.status === 'ok' && !reply.statuses.some(s => s !== 'NO DATA') ? 'submitted' : 'failed';
    report();
    // A request consumes a pending search — except one that ended UNABLE TO CONNECT: no protocol was found, so the
    // adapter searches again on its next request without being told (ELM327 automatic protocol).
    ch.lastPromptAt = clock.now();
    ch.searchPending = reply.status === 'ok' && reply.statuses.includes('UNABLE TO CONNECT');
    ch.atSinceRequest = false;
    framesSent += records.length;
    const frames = reportRx(framesIn(reply.rxRaw, responseId));
    checkReply(reply);
    return frames;
  };
  const sendFrame = (bytes: number[]): Promise<Frame[]> => transmit([bytes], toHex(transmittedFrame(bytes, ch.frameMode), ''));
  const flow = async (received: Frame[]): Promise<{ block: number; separation: number }> => {
    let waitCount = 0;
    for (;;) {
      for (const frame of received) {
        const b = frame.bytes;
        if ((b[0]! >> 4) !== 3) continue;
        if (b.length < 3) fail('Truncated ISO-TP flow-control frame.');
        const status = b[0]! & 15;
        if (status === 2) fail('The ECU refused the ISO-TP transfer (overflow).');
        if (status === 1) { if (++waitCount > 3) fail('The ECU exceeded the ISO-TP WAIT limit.'); continue; }
        if (status !== 0) fail('Reserved ISO-TP flow-control status.');
        return { block: b[1]!, separation: separationTimeMs(b[2]!) };
      }
      received = await monitor(fs => fs.some(f => (f.bytes[0]! >> 4) === 3), 1000);
    }
  };
  const polling = pollMs > 0 && !stpx;
  /**
   * One response window after a 78 (see `pendingPollMs`): a silent tester present, or — once, for a single-frame read
   * whose module stayed quiet past P2* — the request itself again.
   */
  const pollPending = async (): Promise<Frame[]> => {
    remaining();
    if (!resent && frames.length === 1 && (service === 0x19 || service === 0x22) && !opts.codingToken
      && clock.now() - lastPendingAt > P2_STAR_MS + P2_STAR_MARGIN_MS) {
      resent = true;
      link.policy.check(approved, { family: 'can11', target });
      deadline = Math.max(deadline, clock.now() + P2_STAR_MS + P2_STAR_MARGIN_MS);
      lastPendingAt = clock.now();
      return sendFrame(frames[0]!);
    }
    link.policy.check(toHex([...SILENT_TESTER_PRESENT], ''), { family: 'can11', target });
    return sendFrame(segmentDiagnosticPdu(SILENT_TESTER_PRESENT, ch.padding)[0]!);
  };
  /** Whether the first frame leaves on a protocol search: the caller's own record can miss the guard below. */
  let searched: boolean | undefined;
  try {
    // R1 made structural: a request that would leave locked after AT commands or after idle is re-searched.
    if (link.nativeBind && !ch.searchPending && (ch.atSinceRequest || clock.now() - ch.lastPromptAt > LOCKED_IDLE_MAX_MS)) {
      await research(ch, true);
    }
    searched = ch.searchPending;
    // STPX: the adapter segments the whole PDU and paces it by the module's flow control itself.
    let received = stpx ? await transmit(frames, approved) : await sendFrame(frames[0]!);
    // A completed empty read is not a pending response. The native reader ends it at this prompt.
    // Waiting with ATMA after NO DATA added ~7.5 s to each failed F187 in the 2026-10-26 capture,
    // and could accept a later unrelated reply as identity evidence. No retry; writes retain their
    // full uncertainty window, and an actual pending/partial read still takes the continuation path.
    // Native gateway/session and tester-present requests also finish at an empty prompt. This is
    // still a failure; only their callers decide whether a missing reply is acceptable for that step.
    // A caller that will not listen past the prompt (`pendingListenMs: 0`) gets its empty answer at once too,
    // including a first frame no flow control answered (otherwise a 1 s listen for it).
    const quick = opts.pendingListenMs === 0;
    const finishesEmpty = service === 0x22 || ((link.nativeBind || quick) && (service === 0x10 || service === 0x3e))
      || (quick && (service === 0x27 || service === 0x2e));
    if ((finishesEmpty && frames.length === 1 || quick && frames.length > 1) && !received.length && replies.at(-1)?.statuses.includes('NO DATA'))
      fail('The adapter returned NO DATA for this request.', undefined, 'timeout');
    if (frames.length > 1 && !stpx) {
      let fc = await flow(received), inBlock = 0, fcAt = clock.now();
      for (let i = 1; i < frames.length; i++) {
        if (fc.separation) { remaining(); await clock.sleep(fc.separation); }
        const final = i === frames.length - 1;
        const boundary = fc.block !== 0 && ++inBlock === fc.block;
        received = await sendFrame(frames[i]!);
        if (boundary && !final) { fc = await flow(received); inBlock = 0; fcAt = clock.now(); }
      }
      // The final CF met a completed NO DATA. If it was the one frame lost (the clone drops the first CF after a flow
      // control ~17 % of the time live), the module is still waiting for it and takes it again inside N_Cr. If it
      // arrived, the module's reception is over and a CF outside a reception is ignored (ISO 15765-2), so the copy can
      // never make a second request — only a new first frame can. Sent at once, while the module still waits.
      for (let retry = 0; quick && link.nativeBind && retry < LAST_CF_RETRIES && !received.length
        && replies.at(-1)?.statuses.includes('NO DATA') && clock.now() - fcAt < LAST_CF_WINDOW_MS; retry++) {
        try {
          received = await sendFrame(frames.at(-1)!);
        } catch (error) {
          // An adapter error to a copy (no module took it) ends the copies: the request's own silence stands.
          if (!(error instanceof UdsExchangeError) || error.failure !== 'adapter') throw error;
          fail('The module did not answer before the adapter prompt.', undefined, 'timeout');
        }
      }
    }
    let accumulated = received, requestedRxFlow = false, rxGrants = 0;
    for (;;) {
      remaining();
      const messages = reassemble(accumulated, 'can11');
      for (const message of messages) {
        if (!message.complete) continue;
        const b = message.bytes;
        if (b[0] === 0x7f && b[1] === service) {
          if (b[2] === 0x78) {
            const first = message.frames[0];
            if (first && !pending.has(first)) {
              pending.add(first);
              lastPendingAt = clock.now();
              // A poll budget runs from the first 78: the module declared it needs time, up to P2* per renewal.
              if (polling && pending.size === 1) deadline = Math.max(deadline, clock.now() + pollMs);
              // A write that got a 78 may need the whole P2* window: this car's modules can
              // answer with a quiet gap then a final reply well past the first deadline. Only
              // a caller that already budgeted a real pending wait earns the extension — a
              // 3 s marker or an 8 s security send must never stretch into a 60 s stall.
              if (service !== 0x22 && timeout >= PENDING_CAP_MIN_BUDGET_MS && opts.pendingListenMs === undefined)
                deadline = Math.max(deadline, startedAt + PENDING_TOTAL_CAP_MS);
              opts.onResponsePending?.();
            }
            continue;
          }
          fail(`The ECU refused service ${service.toString(16).toUpperCase()} (NRC ${b[2]?.toString(16).toUpperCase()}).`, b[2]);
        }
        const echo = service === 0x22 || service === 0x2e ? 2 : service === 0x10 ? 1 : 0;
        if (b[0] === service + 0x40 && Array.from({ length: echo }, (_, i) => b[i + 1] === payload[i + 1]).every(Boolean)) {
          result = { request: [...payload], response: b, replies, startedAt, endedAt: clock.now(), framesSent, txFrames, searched };
          break;
        }
      }
      if (result) break;
      if (pending.size > 40) fail('Too many response-pending messages.');
      const incomplete = messages.find(m => m.multiFrame && !m.complete);
      if (incomplete?.problem === 'missing_cf') fail('The ECU response contains missing or restarted ISO-TP frames.', undefined, 'protocol', 'truncated', incomplete.bytes, incomplete.declaredLength);
      if (incomplete?.problem === 'restarted' || incomplete?.problem === 'orphan_cf') fail('The ECU response contains missing or restarted ISO-TP frames.');
      if (incomplete?.problem === 'conflicting_cf') fail('The ECU response contains two different copies of one ISO-TP frame.');
      if (incomplete?.problem === 'bad_length') fail('The ECU response has an invalid ISO-TP first frame.');
      if (incomplete?.problem === 'truncated' && incomplete.frames.length > 1 && !stpx) {
        // A whole block arrived and the module is waiting for the next flow control: grant it.
        const cfs = incomplete.frames.length - 1;
        if (RX_BLOCK_SIZE > 0 && cfs % RX_BLOCK_SIZE === 0 && cfs / RX_BLOCK_SIZE > rxGrants && rxGrants < 600) {
          rxGrants++;
          accumulated = [...accumulated, ...await sendFrame([...RX_FLOW_CONTROL, 0, 0, 0, 0, 0])];
          continue;
        }
        fail('The ECU response is shorter than its declared length.', undefined, 'protocol', 'truncated', incomplete?.bytes, incomplete?.declaredLength);
      }
      // With STPX the adapter answers the module's first frame with its own flow control (ATCAF1).
      if (incomplete && incomplete.frames.length === 1 && !requestedRxFlow && !stpx) {
        requestedRxFlow = true;
        accumulated = [...accumulated, ...await sendFrame([...RX_FLOW_CONTROL, 0, 0, 0, 0, 0])];
      } else if (link.nativeBind && incomplete?.multiFrame && !pending.size) {
        // Our flow control came back NO DATA (the clone dropped it, or the module's CF was lost before the prompt):
        // nothing arrives after a prompt on this adapter, so the read is short now — not after a passive listen
        // that outlives the read's budget (simulator: an 8 s stall that closed the read group).
        fail('The ECU response is shorter than its declared length.', undefined, 'protocol', 'truncated', incomplete?.bytes, incomplete?.declaredLength);
      } else if (pending.size && polling) {
        accumulated = [...accumulated, ...await pollPending()];
        if (accumulated.length > 1200) fail('Too many frames in a diagnostic response.');
      } else {
        // A read's response-pending (78) can mean "the real answer never arrives" — live
        // 2026-10-30: unit-09 DID 0560 answered 7F 22 78 then went quiet; waiting the full window
        // outlasted the BLE idle timeout and every sweep died at that DID. Bounded, so an
        // unanswered pending read classifies unanswered and the sweep moves on. Writes keep
        // their full pending window: this car answers a 2E pend with a quiet gap then a final
        // reply 12+ s later (live 0E46 capture), so silence after 78 is not evidence of a drop.
        let window = pending.size && service === 0x22 ? READ_PENDING_WINDOW_MS : remaining();
        if (opts.pendingListenMs !== undefined) {
          if (opts.pendingListenMs <= 0) {
            fail(pending.size
              ? 'The module answered response-pending; its final answer cannot be heard after the adapter prompt.'
              : 'The module did not answer before the adapter prompt.', undefined, 'timeout');
          }
          window = Math.min(window, opts.pendingListenMs);
        }
        const fresh = await monitor(fs => fs.some(f => (f.bytes[0]! >> 4) <= 2), window);
        accumulated = [...accumulated, ...fresh];
        if (accumulated.length > 1200) fail('Too many frames in a diagnostic response.');
      }
    }
  } catch (error) {
    const err = toUdsError(error, requestStarted, replies);
    err.txFrames = txFrames;
    err.searched = searched;
    if (pending.size && err.failure === 'timeout' && !err.detail) err.detail = 'pending';
    throw err;
  }
  return result!;
}

/**
 * Opens a channel, runs `work`, then restores the adapter configuration — all under one session
 * transaction, so nothing else can interleave. Requests are never retried. Requires ELM raw-CAN
 * and response-control facilities; a rejected setup command aborts before anything is transmitted.
 * If the configuration cannot be restored the transport is closed and the channel throws, even
 * when `work` finished: the adapter state is unknown after that. Errors thrown by `work` itself
 * propagate unchanged (a failed restore replaces them).
 */
export async function withUdsChannel<T>(link: ElmLink, opts: UdsChannelOptions, work: (channel: UdsChannel) => Promise<T>): Promise<T> {
  const first = { target: opts.target.toUpperCase(), responseId: opts.responseId.toUpperCase() };
  if (link.protocol.family !== 'can11') throw new Error('UDS requires distinct physical CAN 11-bit addresses.');
  checkAddresses(first.target, first.responseId);
  const timing = opts.timing ?? READ_TIMING;
  if (!Number.isInteger(timing.st) || timing.st < 1 || timing.st > 0xff) throw new Error('Invalid adapter timing.');
  const frameMode = opts.frameMode ?? link.frameMode;
  if (!FRAME_MODES.includes(frameMode)) throw new Error(`Unknown frame mode "${frameMode}".`);
  // STPX exists only on STN chips; a plain ELM answers '?' — refused before the adapter is touched.
  if (frameMode === 'stpx' && !link.info.profile?.caps.stCommands) {
    throw new UdsExchangeError('STPX framing needs an STN adapter (STI did not identify one); nothing was sent.', false, [], undefined, 'adapter');
  }
  return link.session.transaction(async tx => {
    const ch: ChannelState = { link, tx, ...first, padding: opts.padding ?? 'zero', frameMode, responses: true, requestStarted: false, replies: [], txFrames: [],
      searchPending: false, atSinceRequest: true, lastPromptAt: link.clock.now() };
    const previous = { ...link.config };
    /** The setup commands (by their first four characters) that were sent, so the restore undoes only those. */
    const sent = new Set<string>();
    /** `trim-zero`: the adapter took ATPP26ON, so the restore turns the filler setting off again. */
    let fillerOn = false;
    let configured = false, inWork = false, value: T | undefined, failure: unknown;
    const channel: UdsChannel = {
      get target() { return ch.target; },
      get responseId() { return ch.responseId; },
      exchange: (payload, requestOpts = {}) => runExchange(ch, payload, requestOpts),
      async retarget(target, responseId) {
        target = target.toUpperCase(); responseId = responseId.toUpperCase();
        checkAddresses(target, responseId);
        // Already addressed and a search pending (later AT commands keep it, 21/21): the same commands again change nothing.
        if (ch.searchPending && ch.target === target && ch.responseId === responseId) return;
        ch.target = target; ch.responseId = responseId;
        await research(ch, true);
      },
      rebind: (options = {}) => research(ch, options.full ?? true),
    };
    try {
      if (link.session.isClosed) throw new UdsExchangeError('The adapter disconnected.', false, ch.replies, undefined, 'closed');
      // Configuration must be completely restored even when setup is only partially accepted.
      configured = true;
      const deadline = link.clock.now() + CONFIG_BUDGET_MS;
      // The native tools' module setup, command for command. With native binding the addresses are followed by ATSP0,
      // as the native rebind did ("re-search on each switch"): the module's first request then runs the protocol
      // search itself. It is sent even for the module the adapter last searched for: after the 14 setup commands a
      // locked first request was dropped 94 % of the time live (BRIEF R8); the later setup commands keep the search.
      const search = link.nativeBind;
      // A timing setting the adapter already holds (the link tracks it) is not sent again: each AT round trip is
      // ~0.1 s on BLE, and the restore below then has nothing of it to undo. Headers and spaces always are: an adapter
      // that reset without the link closing (a voltage dip) is back at its defaults, and every frame parse needs them.
      // ATAL: without "allow long" the ELM limits a CAN send to 7 data bytes, so a full 8-byte ISO-TP frame (every
      // first frame, every full consecutive frame) loses its last byte and the module stores whatever its buffer held
      // there — observed live as 0x30/0xA0 in the byte at offset 7 of the first frame and offset 14 of the second.
      // STPX: the adapter formats (ATCAF1) and segments (STCSEGT1) the PDU and answers the module's first frame with
      // its own default flow control, so none of the raw-frame flow-control settings apply.
      const stpx = frameMode === 'stpx';
      const fcData = frameMode === 'fc-alt' ? FC_ALT_DATA : RX_FLOW_CONTROL;
      for (const cmd of ['ATH1', 'ATS1', 'ATD0', stpx ? 'ATCAF1' : 'ATCAF0', stpx ? null : 'ATAL', 'ATCFC1',
        `ATSH${ch.target}`, `ATCRA${ch.responseId}`, `ATFCSH${ch.target}`, ...(search ? ['ATSP0'] : []),
        stpx ? null : `ATFCSD${toHex([...fcData], '')}`, stpx ? null : 'ATFCSM1', stpx ? 'STCSEGT1' : null,
        previous.adaptiveTiming === timing.adaptive ? null : `ATAT${timing.adaptive}`,
        previous.st === timing.st ? null : `ATST${hex2(timing.st)}`, 'ATR1']) {
        if (!cmd) continue;
        sent.add(cmd.slice(0, 4));
        await configure(ch, cmd, deadline);
      }
      // The filler byte the adapter pads a trimmed frame with: 00 (also the ELM default). Many clones refuse PP
      // commands ('?'); their own padding then decides, which is what the frame test measures.
      if (frameMode === 'trim-zero' && await configureOptional(ch, 'ATPP26SV00', deadline)) {
        fillerOn = await configureOptional(ch, 'ATPP26ON', deadline);
      }
      if (link.nativeBind) link.searchTarget = ch.target;
      inWork = true;
      value = await work(channel);
      inWork = false;
    } catch (error) { failure = error; }
    finally {
      if (configured && !link.session.isClosed) {
        const oldHeader = previous.target === 'functional' ? functionalHeader(link.protocol.number) : previous.target;
        const oldRx = previous.target === 'functional' ? null : physicalReplyId(previous.target);
        // Only what this channel changed is put back: responses stay on (no frame is sent with ATR0), ATCFC1 is what
        // setup left, headers and spaces the link already had on stay on, and a timing setting setup did not send
        // still holds its old value.
        const commands = [ch.responses ? null : 'ATR1', 'ATCAF1', 'ATNL', 'ATFCSM0', `ATSH${oldHeader}`, oldRx ? `ATCRA${oldRx}` : 'ATCRA',
          previous.spaces ? null : 'ATS0', previous.headers ? null : 'ATH0',
          sent.has('ATAT') ? `ATAT${previous.adaptiveTiming}` : null, sent.has('ATST') ? `ATST${hex2(previous.st ?? 0x32)}` : null]
          .filter((cmd): cmd is string => cmd !== null);
        if (sent.has('STCS')) commands.unshift('STCSEGT0');
        let restored = true;
        const restoreDeadline = link.clock.now() + CHANNEL_RESTORE_BUDGET_MS;
        for (const cmd of commands) {
          try {
            if (link.clock.now() >= restoreDeadline) { restored = false; break; }
            link.policy.check(cmd, { family: 'can11', target: ch.target });
            const reply = await tx.send(cmd, Math.min(1500, restoreDeadline - link.clock.now()));
            ch.replies.push(reply);
            if (reply.status !== 'ok' || reply.statuses.length || !reply.lines.includes('OK')) { restored = false; break; }
          } catch { restored = false; break; }
        }
        // Best effort: the filler byte is 00 either way, so a refusal here leaves nothing the adapter did not have.
        if (restored && fillerOn && link.clock.now() < restoreDeadline) {
          try {
            link.policy.check('ATPP26OFF', { family: 'can11', target: ch.target });
            ch.replies.push(await tx.send('ATPP26OFF', Math.min(1500, restoreDeadline - link.clock.now())));
          } catch {
            // nothing to undo
          }
        }
        if (!restored) {
          await link.session.transport.close();
          failure = new UdsExchangeError('Adapter configuration could not be restored. The connection was closed.', ch.requestStarted, ch.replies, undefined, 'closed');
          // The frames sent before the restore failed stay with the error that replaced the original one.
          (failure as UdsExchangeError).txFrames = [...ch.txFrames];
        }
      }
    }
    // The caller's own errors pass through unchanged; setup/restore failures become UdsExchangeError.
    if (failure) throw inWork && !(failure instanceof PolicyError) ? failure : toUdsError(failure, ch.requestStarted, ch.replies);
    return value as T;
  });
}

/** One physically addressed logical request on its own channel (setup, request, restore); never retried. */
export async function exchangeUds(link: ElmLink, payload: readonly number[], opts: UdsExchangeOptions): Promise<UdsExchange> {
  const { target, responseId, padding, frameMode, ...request } = opts;
  if (link.protocol.family !== 'can11') throw new Error('UDS requires distinct physical CAN 11-bit addresses.');
  checkAddresses(target.toUpperCase(), responseId.toUpperCase());
  // Reject a malformed request before the adapter is touched.
  segmentDiagnosticPdu(payload, padding);
  const timeout = request.timeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) throw new Error('Invalid diagnostic deadline.');
  return withUdsChannel(link, { target, responseId, ...(padding ? { padding } : {}), ...(frameMode ? { frameMode } : {}) },
    channel => channel.exchange(payload, request));
}
