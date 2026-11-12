import {
  CHANNEL_CONFIG_BUDGET_MS,
  CHANNEL_RESTORE_BUDGET_MS,
  CODING_TIMING,
  type ElmLink,
  type UdsChannel,
  type UdsExchange,
  UdsExchangeError,
  type UdsRequestOptions,
  withUdsChannel,
} from '@obdcraft/obd-core';
import type {
  DidWrite,
  MarkerWrite,
  ModuleAddress,
  WriteOptions,
  WriterNote,
  WriterStep,
} from '../../domain/coding/types.ts';
import { txRecorder } from './tx-evidence.ts';

/**
 * The module-side coding sequence, in the order of the native writer that was proven on the car
 * (reference/native/ble-write-coding.swift, `buildSteps`):
 *
 *   module setup → gateway 10 03 (710, reply ignored) → module 10 03 → 22 F199 probe → 22 F1A5 probe
 *   → 10 03 re-arm → [27 03 seed → 27 04 key] → 2E F199 <BCD date> → 2E F198 <F1A5 bytes> → 2E <did> <bytes>
 *   → [proof read 22 <did>] → 10 01 (best effort)
 *
 * What the live adapter taught us (failure analysis of live traces, 2026-10-25…11-01):
 *  A. The clone silently drops a request — the module never sees it: ~20 % sent at once after a reply, ~9 %
 *     right after an ATSP0 re-search, 94–100 % after idle or after other AT commands. So every request goes
 *     out on a fresh re-search (ATSH/ATCRA/ATFCSH/ATSP0) and no sleep comes before it (R1); an idempotent
 *     step that went silent is asked again at once on a new re-search, up to {@link LADDER_SENDS} sends (R2).
 *  B. No frame ever arrives after the adapter's prompt. A 78 or a NO DATA is reported at once
 *     (`pendingListenMs: 0`, R7) and the DID's own memory is read instead of listening while S3 lapses.
 *  C. S3 is ~5 s. Session freshness is tracked from what proves it (`50 03`, `67 04`, or a positive answer
 *     within 4 s of the last proof — never an NRC), with a look-ahead: a step that could not reach the module
 *     inside that budget re-arms first (R3). A silent key is followed by a new seed, not a new session (R4);
 *     a 2E refused with 7F/33/22, or 31 when the session may have lapsed, is retried once after a re-arm
 *     before the refusal is believed (R6).
 *
 * Markers are cosmetic: they never stop the payload. A marker that is refused or stays silent is
 * recorded as such and the sequence moves on. Every permit-covered send is bounded by one permit that
 * lives as long as the write can.
 *
 * It never decides whether the change "worked": the domain reads back.
 */

const GATEWAY: ModuleAddress = { request: '710', response: '77A' };
/** Vendor fallback for F198 when F1A5 is all zero. Six raw bytes; the ASCII form is NRC 13. */
const F198_FALLBACK = [0x01, 0x81, 0xc8, 0xf6, 0x30, 0x39];
/** Tester-present once the session's last proof is this old (S3 is ~5 s). */
const KEEPALIVE_AFTER_MS = 2500;
/**
 * Quiet time before a re-bind. 0: the re-search is the fix; a settle was never measured on the car (BRIEF B1).
 * Kept so a car test can bring it back.
 */
export const SETTLE_MS = 0;
/** Re-bind with a bare ATSP0 instead of ATSH/ATCRA/ATFCSH/ATSP0: cheaper, unproven on the car (BRIEF §6.2). */
const BARE_REBIND = false;
/** Sends per idempotent step on a completed silence, each on its own re-search, no wait (R2: ~0.4 % left). */
const LADDER_SENDS = 4;
/** A session proven this recently is trusted armed (S3 ~5 s, minus a margin). */
const SESSION_FRESH_MS = 4000;
/** Look-ahead: what one more send (re-bind, search, answer) may take before the module has it (R3). */
const EXPECTED_SEND_MS = 1000;
/** A marker answered 78 (never seen live): it is given min(P2*, this) to be stored before the sequence moves on. */
const PROOF_WAIT_CAP_MS = 2000;
/** After a payload's 78, its pre-write bytes prove nothing until 78 + min(P2*, this) has passed (R5). */
const PROOF_WINDOW_MS = 5000;
/**
 * After a complete send met silence, its pre-write bytes prove it was not stored only from a read that left this long
 * after its last frame: past the commit of a write whose 78 was lost (commit U[0.2, 1.5] s assumed, BRIEF §2.4).
 */
const SILENT_PROOF_MS = 1600;
/** Proof reads after one payload send, at most (a back-to-back read takes ≥ ~0.12 s; the window bounds them first). */
const MAX_PROOF_READS = 48;
/**
 * The data write's transmissions handed to the adapter (the permit's bound): a first frame no flow control answered
 * is one, and is sent again at once. A single frame goes out complete at most twice (see `completeSends` in the payload).
 */
const MAX_PAYLOAD_SENDS = 4;
/** Marker transmissions: silent tries plus one session-lost retry. */
const MAX_MARKER_SENDS = 4;
/** Full re-arms (10 03 [+ 27 03/04]) one write may run besides the initial ones. */
const MAX_REARMS = 4;
/** Re-arms the markers may spend in total: at least two always stay for the payload. */
const MAX_MARKER_REARMS = MAX_REARMS - 2;
/** Seed sends per handshake (a ladder) and handshakes per unlock (a silent key asks for the seed again). */
const SEEDS_PER_HANDSHAKE = LADDER_SENDS;
const HANDSHAKES_PER_UNLOCK = 4;
/** Unlocks one write may run: the initial one and one per re-arm. */
const UNLOCKS = 1 + MAX_REARMS;
/** The permit's security budget, derived from the bounds above so the two cannot drift. */
export const SECURITY_BUDGET = {
  seed: SEEDS_PER_HANDSHAKE * HANDSHAKES_PER_UNLOCK * UNLOCKS,
  key: HANDSHAKES_PER_UNLOCK * UNLOCKS,
} as const;

/**
 * NRCs to a 2E that mean "this session cannot write" rather than "this DID refuses this value":
 * 7F serviceNotSupportedInActiveSession, 33 securityAccessDenied, 22 conditionsNotCorrect. Each is
 * retried once after a full re-arm before it is believed. 31 joins them only when the session may
 * have lapsed (or a marker already got 31 in the same burst — the live signature of a lost session).
 */
const SESSION_LOST_NRCS = new Set([0x7f, 0x33, 0x22]);

/**
 * The adapter finished the request cleanly but reported NO DATA — or UNABLE TO CONNECT, which is what
 * the same silence becomes once the request runs an ATSP0 protocol re-search. Both are completed
 * adapter answers, distinct from a dead stream or a lost link.
 */
const isRetriableSilence = (e: unknown): boolean => {
  const last = e instanceof UdsExchangeError ? e.replies.at(-1) : undefined;
  if (!(e instanceof UdsExchangeError) || last?.status !== 'ok') return false;
  if (e.failure === 'timeout' && last.statuses.includes('NO DATA')) return true;
  return e.failure === 'adapter' && last.statuses.includes('UNABLE TO CONNECT');
};
/**
 * A read whose multi-frame answer arrived short: the clone forwards 4 CFs per command, so a DID over 34 bytes
 * needs the host's own flow control in between, which the clone may drop like any send. Reading is
 * idempotent, so it is asked again.
 */
const isTruncatedRead = (e: unknown, payload: readonly number[]): boolean =>
  payload[0] === 0x22 && e instanceof UdsExchangeError && e.detail === 'truncated';
/** The request left and no final answer came back (silence, or a 78 whose final answer is unhearable). */
const isSilentAfterSend = (e: unknown): boolean =>
  e instanceof UdsExchangeError && e.requestStarted && (e.failure === 'timeout' || isRetriableSilence(e));

/** Per-send bounds. No send listens past the prompt (B above); these bound the adapter's own answer. */
const TIMEOUT = {
  session: 6000,
  probe: 6000,
  testerPresent: 6000,
  security: 8000,
  marker: 6000,
  /** Bounds the payload's own frames (a multi-frame write and the first frame's protocol search). */
  dataWrite: 15_000,
  endSession: 6000,
} as const;

/** One re-bind: four adapter commands. */
const REBIND_MS = CHANNEL_CONFIG_BUDGET_MS;
/** One searched send at its bound. */
const sendMs = (timeout: number): number => SETTLE_MS + REBIND_MS + timeout;
/** One ladder step at its bound. */
const ladderMs = (timeout: number): number => LADDER_SENDS * sendMs(timeout);
/** One unlock at its bound: each handshake may re-open the session, then a seed ladder and the key. */
const UNLOCK_MS =
  HANDSHAKES_PER_UNLOCK * (ladderMs(TIMEOUT.session) + ladderMs(TIMEOUT.security) + sendMs(TIMEOUT.security));
/** One full re-arm with security, every step at its bound. */
const REARM_MS = ladderMs(TIMEOUT.session) + UNLOCK_MS;
/**
 * The proof after one payload send: reads (or, for a long DID after silence, tester-present) until its window has
 * passed, then the send and the read still in flight, each at its bound.
 */
const PROOF_MS = PROOF_WINDOW_MS + sendMs(TIMEOUT.testerPresent) + ladderMs(TIMEOUT.probe);

/**
 * Upper bound on one `writeCodingDid` call with every step at its timeout: channel setup and restore,
 * the gateway hop, the opening probes, the initial and every allowed re-arm, the markers, every payload
 * send with its proof reads, and the closing 10 01. The domain's write backstop must exceed this
 * (CarLink.maxWriteMs).
 */
export const MAX_WRITE_MS =
  CHANNEL_CONFIG_BUDGET_MS +
  CHANNEL_RESTORE_BUDGET_MS +
  2 * REBIND_MS +
  sendMs(TIMEOUT.session) +
  3 * ladderMs(TIMEOUT.probe) +
  (2 + MAX_REARMS) * REARM_MS +
  2 * MAX_MARKER_SENDS * (ladderMs(TIMEOUT.testerPresent) + sendMs(TIMEOUT.marker) + PROOF_WAIT_CAP_MS) +
  MAX_PAYLOAD_SENDS * (ladderMs(TIMEOUT.testerPresent) + sendMs(TIMEOUT.dataWrite) + PROOF_MS) +
  sendMs(TIMEOUT.endSession);

export interface BleWriteOptions extends WriteOptions {
  /** Calendar date for the F199 stamp (tests pin it). */
  today?: () => Date;
}

const bytesOf = (hex: string): number[] => (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
const hexOf = (bytes: readonly number[]): string =>
  bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
const bcd = (n: number): number => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const nrcHex = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');
/** A request's service and (for 22/2E/10/27) its sub-function or DID: what a note may name, never data. */
const requestHead = (payload: readonly number[]): string =>
  hexOf(payload.slice(0, payload[0] === 0x22 || payload[0] === 0x2e ? 3 : 2));

/**
 * What the owner reads when a write stops. Plain words only: codes, identifiers and the access code itself are
 * never put here (the technical reason goes in a writer note).
 */
const PLAIN = {
  malformed: "This change couldn't be prepared for your car.",
  badCode: "We don't have a valid access code for this setting.",
  access: "Your car didn't accept the access code.",
  prep: "Your car didn't get ready for the change.",
  prepRefused: "Your car didn't accept a step needed to get ready for the change.",
  policy: 'A safety check in the app stopped a step.',
  silent: 'Your car stopped answering before the change was sent.',
  notReady: 'The car check ran out of time before the change was sent.',
  noCode: "Your car asked for an access code before this change, and we don't have one for this setting.",
  defaultCode:
    "Your car didn't accept the usual access code for this part, then refused the change without one. This setting needs its own access code.",
} as const;

/**
 * The write stopped before the change was sent. `message` is the technical reason (journaled as a writer note);
 * `plain` is what the owner reads.
 */
class NotSent extends Error {
  readonly plain: string;
  constructor(message: string, plain: string = PLAIN.prep) {
    super(message);
    this.plain = plain;
  }
}
class Cancelled extends Error {}
class NotReady extends Error {}
/** The session could have lapsed before the next send reaches the module: re-open it first. */
class SessionStale extends Error {}

/** What a read probe learned: data, a refusal, or nothing at all. */
type Probe = { kind: 'data'; bytes: number[] } | { kind: 'refused'; nrc: number } | { kind: 'silent' };

export async function writeCodingDid(
  link: ElmLink,
  module: ModuleAddress,
  did: string,
  bytes: string,
  options: BleWriteOptions,
): Promise<DidWrite> {
  if (!/^[0-9A-F]{4}$/.test(did) || !/^(?:[0-9A-F]{2})+$/.test(bytes))
    return { kind: 'not-sent', detail: PLAIN.malformed };
  if (options.securityPassword !== null && !/^\d{1,10}$/.test(options.securityPassword))
    return { kind: 'not-sent', detail: PLAIN.badCode };

  const clock = link.clock;
  const password = options.securityPassword;
  const unitDefault = options.passwordSource === 'unit-default';
  const passwordSource = options.passwordSource ?? 'recipe';
  /** One decision on the wire, for the journal. Never throws into the write. */
  const note = (step: WriterStep, extra: Omit<WriterNote, 'step'> = {}) => {
    try {
      options.onNote?.({ step, ...extra });
    } catch {
      // journal only
    }
  };
  const didBytes = bytesOf(did);
  const intended = bytes.toUpperCase();
  const original = options.originalBytes?.toUpperCase();
  const dataWrite = [0x2e, ...didBytes, ...bytesOf(bytes)];
  const permit = link.policy.issueCodingPermit(module.request, {
    writes: [hexOf(dataWrite)],
    // Spent only on sends the ECU provably did not store (a session-lost refusal, a proof read that
    // still shows the pre-write bytes) — see the payload below.
    writeRetries: MAX_PAYLOAD_SENDS - 1,
    // No marker prefixes when markers are off: the permit then covers the exact payload alone.
    writePrefixes: options.markers === false ? [] : ['2EF199', '2EF198'],
    // A marker re-send always carries identical bytes, so it is safe against an answer that never came.
    writePrefixRetries: MAX_MARKER_SENDS - 1,
    // Asked for even without a password: a re-arm never sends a key it has no code for, but the
    // permit then never stands between a recipe and its unit's default.
    securityAccess: true,
    securityBudget: SECURITY_BUDGET,
    // The permit lives as long as the write can (live F1: a 60 s permit expired inside a long write).
    ttlMs: MAX_WRITE_MS,
  });
  /**
   * Marker lifecycle, in transmission order: `no-answer` the moment a marker's frame goes on the wire
   * (it may be stored from then on), replaced by `acked` / `refused` / `not-hosted` when the module
   * answers. Reported to the caller as it changes, and attached to every result — including a lost
   * link, cancellation or error — so a marker in flight is never forgotten (independent review R3).
   */
  const markers = new Map<MarkerWrite['did'], MarkerWrite>();
  const setMarker = (name: MarkerWrite['did'], outcome: MarkerWrite['outcome']) => {
    markers.set(name, { did: name, outcome });
    options.onMarker?.({ did: name, outcome });
  };
  /** When the extended session (and any unlock inside it) was last PROVEN alive. */
  let sessionConfirmedAt = Number.NEGATIVE_INFINITY;
  let pendingSeen = false;
  let mainStarted = false;
  let acked = false;
  /** Set when the readiness evidence expired; survives the transport wrapping a callback's error. */
  let notReady = false;
  /** The module's P2* (ms), from its session answer. */
  let p2star = PROOF_WAIT_CAP_MS;
  const checkpoint = () => {
    if (!mainStarted && options.signal?.aborted) throw new Cancelled();
    // The caller's readiness check (if any) applies until the payload is on the wire; afterwards a
    // proof read or a proved-safe re-send is part of the same write.
    if (!mainStarted) {
      try {
        options.assertReady?.();
      } catch {
        if (!notReady) note('not-ready', { detail: 'readiness expired before the payload was sent' });
        notReady = true;
        throw new NotReady();
      }
    }
  };
  /** Every frame handed to the adapter during the sequence, reported to the session as it happens. */
  const tx = txRecorder(options);
  /** CAN frames the module sent while a payload exchange was open, in order. */
  const payloadRx: string[] = [];
  const done = (result: DidWrite): DidWrite => {
    const withWire = tx.frames.length ? { ...result, txFrames: [...tx.frames] } : result;
    const withRx = payloadRx.length ? { ...withWire, rxFrames: [...payloadRx] } : withWire;
    return markers.size ? { ...withRx, markers: [...markers.values()] } : withRx;
  };

  const sequence = async (ch: UdsChannel): Promise<DidWrite> => {
    const sessionAge = () => clock.now() - sessionConfirmedAt;
    /** Fresh enough that one more send still reaches the module inside the S3 budget (R3 look-ahead). */
    const freshAhead = () => sessionAge() + EXPECTED_SEND_MS <= SESSION_FRESH_MS;
    const confirmSession = (at = clock.now()) => {
      sessionConfirmedAt = at;
    };
    /**
     * A re-search is armed: the next request runs the adapter's protocol search. On a native-bind link the
     * channel setup ends with ATSP0 (on the gateway: see the channel below), so the first request uses it.
     */
    let searchArmed = link.nativeBind;
    const retarget = async (to: ModuleAddress) => {
      await ch.retarget(to.request, to.response);
      searchArmed = true;
    };
    /** Re-bind with a protocol re-search: the clone's cheapest reliable request path (R1). No settle by default. */
    const rebind = async () => {
      if (searchArmed) return;
      if (SETTLE_MS > 0) await clock.sleep(SETTLE_MS);
      await ch.rebind({ full: !BARE_REBIND });
      searchArmed = true;
    };
    /** The previous request just ended at the adapter's prompt (an answer, a refusal or NO DATA), nothing since. */
    let atPrompt = false;
    /** The module whose last re-searched request went unanswered: the clone then lost its next search 36 % of the time. */
    let searchSilentOn: string | undefined;
    /**
     * One request, never listening past the prompt (R7). On a fresh re-search (R1) — except an idempotent try
     * (`locked`) that follows the previous request's prompt at once. There the clone dropped 0–26 % after an
     * answer (0 % for a seed after 50 03) and 19 % on an immediate retry after NO DATA (7/37), and a drop costs
     * one ~210 ms NO DATA. A re-search costs ~0.8 s on this adapter, and a lost one ~4.4 s (UNABLE TO CONNECT)
     * that lets S3 lapse — so the ladder re-searches only from its third send. Key and payload re-search
     * (R1), unless the last search went unanswered: a search right after a silent one was lost 36 % of the
     * time, a send at the prompt ~20 %. The channel itself re-searches anything sent after idle or AT (U3).
     */
    const exchange = async (
      payload: number[],
      timeoutMs: number,
      extra: UdsRequestOptions = {},
      locked = false,
    ) => {
      const research = searchArmed || !(atPrompt && (locked || searchSilentOn === ch.target));
      if (research) await rebind();
      searchArmed = false;
      atPrompt = false;
      try {
        const r = await ch.exchange(payload, { timeoutMs, pendingListenMs: 0, ...extra, ...tx.exchange() });
        atPrompt = true;
        // The channel says whether the request searched: its idle guard may have re-searched a locked send.
        if (r.searched ?? research) searchSilentOn = undefined;
        return r;
      } catch (e) {
        // Only a first frame that got nothing back is a lost search; a CF lost after the module's flow control is not.
        if ((e instanceof UdsExchangeError ? e.searched : undefined) ?? research)
          searchSilentOn =
            isRetriableSilence(e) && e instanceof UdsExchangeError && e.txFrames.length <= 1
              ? ch.target
              : undefined;
        // UNABLE TO CONNECT: the search found no protocol, so the adapter searches again on the next request by
        // itself — a re-bind first would only cost four more commands.
        if (e instanceof UdsExchangeError && e.failure === 'adapter' && isRetriableSilence(e))
          searchArmed = true;
        // At a prompt after an answer, a refusal, NO DATA or a 78 (whose final answer is never printed after the
        // prompt); not after UNABLE TO CONNECT (the search is still running) nor a short multi-frame read.
        atPrompt =
          e instanceof UdsExchangeError &&
          ((e.nrc !== undefined && e.nrc !== 0x78) ||
            (e.failure === 'timeout' && e.detail === 'pending') ||
            (e.failure === 'timeout' && e.detail === undefined && isRetriableSilence(e)));
        throw e;
      }
    };
    const send = async (
      payload: number[],
      timeoutMs: number,
      extra: UdsRequestOptions = {},
      mutating = true,
      locked = false,
    ) => {
      if (mutating) checkpoint();
      else if (!mainStarted && options.signal?.aborted) throw new Cancelled();
      const r = await exchange(payload, timeoutMs, extra, locked);
      // A positive answer inside a proven-fresh session keeps it proven; an answer after a gap does not
      // (a default-session module answers reads too — live 2026-10-30).
      if (r.endedAt - sessionConfirmedAt <= SESSION_FRESH_MS) confirmSession(r.endedAt);
      return r.response;
    };
    /** Errors that end the sequence whatever step they hit. */
    const fatal = (e: unknown) =>
      notReady ||
      e instanceof Cancelled ||
      link.session.isClosed ||
      options.signal?.aborted ||
      (e instanceof UdsExchangeError && (e.failure === 'policy' || e.failure === 'closed'));
    /**
     * Idempotent steps only — session opens, tester-present, probes, proof reads and the seed request: a
     * completed silence is asked again at once on a new re-search, up to {@link LADDER_SENDS} sends (R2).
     * `inSession`: the step needs the extended session, so a retry that could no longer reach the module
     * inside S3 stops with {@link SessionStale} instead.
     */
    const ladder = async (
      payload: number[],
      timeoutMs: number,
      extra: UdsRequestOptions = {},
      inSession = false,
      /** A failure that already answers the caller's question (a proof read's conclusive prefix): not asked again. */
      enough: (e: unknown) => boolean = () => false,
    ) => {
      for (let attempt = 0; ; attempt++) {
        if (inSession && attempt > 0 && !freshAhead()) throw new SessionStale();
        try {
          return await send(payload, timeoutMs, extra, false, attempt < 2);
        } catch (e) {
          if (
            attempt === LADDER_SENDS - 1 ||
            fatal(e) ||
            enough(e) ||
            !(isRetriableSilence(e) || isTruncatedRead(e, payload))
          )
            throw e;
          note('retarget', {
            detail: `empty answer to ${requestHead(payload)}; send ${attempt + 2}/${LADDER_SENDS}`,
          });
        }
      }
    };
    /** Physical tester-present; its answer is not required (native: reply ignored). */
    const testerPresent = async () => {
      try {
        await ladder([0x3e, 0x00], TIMEOUT.testerPresent);
      } catch (e) {
        if (fatal(e)) throw e;
      }
    };
    /** Keeps S3 alive before a step that may need retries: on the age of the session's proof (B3). */
    const keepalive = async () => {
      if (sessionAge() >= KEEPALIVE_AFTER_MS && freshAhead()) await testerPresent();
    };
    const probe = async (id: number): Promise<Probe> => {
      const name = hexOf([id >> 8, id & 255]);
      let result: Probe;
      try {
        result = { kind: 'data', bytes: (await ladder([0x22, id >> 8, id & 255], TIMEOUT.probe)).slice(3) };
      } catch (e) {
        if (fatal(e)) throw e;
        result =
          e instanceof UdsExchangeError && e.nrc !== undefined
            ? { kind: 'refused', nrc: e.nrc }
            : { kind: 'silent' };
      }
      note('probe', {
        did: name,
        detail:
          result.kind === 'data'
            ? `${result.bytes.length} bytes`
            : result.kind === 'refused'
              ? `NRC ${nrcHex(result.nrc)}`
              : 'no answer',
      });
      return result;
    };
    const openSession = async (what: string) => {
      const r = await ladder([0x10, 0x03], TIMEOUT.session);
      if (r[0] !== 0x50 || r[1] !== 0x03) {
        note('session-open', { detail: `could not ${what}: unexpected answer` });
        throw new NotSent(`The control unit did not ${what}.`);
      }
      // Any 10 03 voids the security grant: the next challenge always gets its key.
      lastKeyAcked = false;
      confirmSession();
      if (r.length >= 6) p2star = ((r[4] ?? 0) * 256 + (r[5] ?? 0)) * 10 || p2star;
      note('session-open', { detail: `${what}: 50 03, P2* ${p2star} ms` });
    };

    // ---- security access ----
    /** The last challenge answered, and whether its key was acknowledged. */
    let lastSeed: number | undefined;
    let lastKeyAcked = false;
    /** A key of this write went unanswered. */
    let keyWentSilent = false;
    /** The NRC the module gave the unit-default code; set once, after which no key is sent again. */
    let defaultCodeRefused: string | undefined;
    /** The plain refusal after the unit-default code was refused (its code is in the `key` writer note). */
    const defaultCodeDetail = () => PLAIN.defaultCode;
    /**
     * One seed → key exchange. `silent`: the key got no answer (it may never have arrived). A seed refused with
     * 7F/22 means the session is gone: {@link SessionStale}, and the unlock re-opens it.
     */
    const handshake = async (force: boolean): Promise<'done' | 'silent'> => {
      let seedReply: number[];
      try {
        seedReply = await ladder([0x27, 0x03], TIMEOUT.security, { codingToken: permit }, true);
      } catch (e) {
        if (e instanceof UdsExchangeError && (e.nrc === 0x7f || e.nrc === 0x22)) throw new SessionStale();
        throw e;
      }
      if (seedReply[0] !== 0x67 || seedReply[1] !== 0x03 || seedReply.length < 6) {
        note('seed', { detail: 'no seed offered (unexpected answer)', passwordSource });
        throw new NotSent('The control unit did not offer a security seed.', PLAIN.access);
      }
      const seed = seedReply.slice(2, 6).reduce((v, b) => (v * 256 + b) >>> 0, 0);
      if (seed === 0) {
        note('seed', { detail: 'zero seed: already unlocked', passwordSource });
        confirmSession(); // already unlocked
        return 'done';
      }
      // The same challenge again after an ACKNOWLEDGED key: the module still holds that grant —
      // sending the identical key would only replay an exchange it already accepted (live 10-31:
      // 544DB28B came back twice). A refusal on the next write forces a fresh key (`force`).
      if (!force && seed === lastSeed && lastKeyAcked) {
        note('key-reused-same-seed', { detail: 'same challenge after an accepted key: key not re-sent' });
        return 'done';
      }
      // The same challenge after an UNACKNOWLEDGED key proves that key never arrived: a module consumes its
      // seed on any delivered key (live 3/3), so sending it again is its first delivery, not a replay (R4).
      note('seed', {
        detail: `${force ? 'challenge received (key forced)' : 'challenge received'}${seed === lastSeed ? ', same as the unanswered key' : ''}`,
        passwordSource,
      });
      // The key must reach a live session: one that could lapse before it arrives is re-opened first.
      if (!freshAhead()) throw new SessionStale();
      const key = (seed + (Number.parseInt(password as string, 10) >>> 0)) >>> 0;
      lastSeed = seed;
      lastKeyAcked = false;
      let keyReply: number[];
      try {
        // At the seed's prompt, locked: the clone dropped 4/22 keys sent so (18 %), and a dropped key is never
        // consumed — the seed asked again at once gets it re-sent (R4) for ~0.5 s. A re-search instead costs
        // ~0.6 s every time and loses ~1.5 % of its sends to a 4.4 s UNABLE TO CONNECT (simulator, 500 seeds:
        // same first-tap success, writer p95 ~1 s shorter). Departs from BRIEF B4, which predates that cost.
        keyReply = await send(
          [0x27, 0x04, (key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255],
          TIMEOUT.security,
          { codingToken: permit },
          true,
          !keyWentSilent, // after a silent key, the next one re-searches
        );
      } catch (e) {
        if (e instanceof UdsExchangeError && (e.nrc === 0x35 || e.nrc === 0x33) && unitDefault) {
          // The vendor never logs in for a recipe without its own code (MQBAdaptationTemplate: 27 only
          // when the password is non-empty): a refused unit-default key is not the end — carry on without
          // security access, and report the code only if the write itself is then refused with 33.
          defaultCodeRefused = nrcHex(e.nrc);
          note('security-refused-unit-default', {
            detail: `NRC ${defaultCodeRefused}; continuing without security access`,
            passwordSource,
          });
          return 'done';
        }
        if (e instanceof UdsExchangeError && e.nrc !== undefined) {
          note('key', { detail: `refused NRC ${nrcHex(e.nrc)}`, passwordSource });
          throw new NotSent(`The security unlock was refused (code ${nrcHex(e.nrc)}).`, PLAIN.access);
        }
        if (!fatal(e) && isSilentAfterSend(e)) {
          keyWentSilent = true;
          return 'silent';
        }
        throw e;
      }
      if (keyReply[0] !== 0x67 || keyReply[1] !== 0x04) {
        note('key', { detail: 'unexpected answer', passwordSource });
        throw new NotSent('The security unlock was refused.', PLAIN.access);
      }
      note('key', { detail: 'accepted (67 04)', passwordSource });
      lastKeyAcked = true;
      confirmSession();
      return 'done';
    };
    /**
     * Unlock (R4). A silent key is followed at once by a new seed request inside the same session — no 10 03:
     * the same challenge means the key never arrived and it is sent again; a new one gets its own key. The
     * session is re-opened only when it could have lapsed.
     */
    const unlock = async (force = false): Promise<void> => {
      if (password === null || defaultCodeRefused) return;
      await keepalive();
      for (let h = 0; h < HANDSHAKES_PER_UNLOCK; h++) {
        if (h > 0 && !freshAhead()) await openSession('re-open the coding session');
        try {
          if ((await handshake(force)) === 'done') return;
          note('key', { detail: 'no answer to the key: asking for the seed again', passwordSource });
        } catch (e) {
          if (!(e instanceof SessionStale) && (fatal(e) || !isSilentAfterSend(e))) throw e;
          note('key', {
            detail:
              e instanceof SessionStale
                ? 'session may have lapsed: re-opening for the seed'
                : 'no answer to the seed: asking again',
            passwordSource,
          });
          // A seed that never came back (four silent sends) or a lapse: re-open before the next handshake.
          sessionConfirmedAt = Number.NEGATIVE_INFINITY;
        }
      }
      note('key', { detail: `no unlock after ${HANDSHAKES_PER_UNLOCK} handshakes`, passwordSource });
      throw new NotSent('The control unit did not answer the security unlock.', PLAIN.access);
    };
    let rearms = 0;
    /**
     * Full re-arm: 10 03, then the unlock. `forceKey` after a 33 (securityAccessDenied): the module said the
     * grant is gone, so even a repeated challenge gets its key sent.
     */
    const rearm = async (forceKey: boolean, why: string): Promise<void> => {
      if (++rearms > MAX_REARMS) {
        note('rearm', { detail: `${why}: re-arm budget (${MAX_REARMS}) spent, stopping` });
        throw new NotSent('The coding session kept lapsing, so we stopped.');
      }
      note('rearm', { detail: `${why} (${rearms}/${MAX_REARMS}${forceKey ? ', key forced' : ''})` });
      await openSession('re-open the coding session');
      await unlock(forceKey);
    };
    const staleFor = () =>
      Number.isFinite(sessionConfirmedAt) ? `last proven ${Math.round(sessionAge())} ms ago` : 'never proven';
    /** Before any 2E: a session that could lapse before the write reaches the module is re-armed (R3). */
    const ensureSession = async () => {
      if (freshAhead()) return;
      note('session-stale-rearm', { detail: staleFor() });
      await rearm(false, 'stale session');
    };
    /** Did a marker in this burst already come back 31 — the live signature of a lapsed session? */
    let marker31 = false;

    // ---- markers: cosmetic, never block the payload ----
    let markerRearms = 0;
    /**
     * A marker's own re-arm: at most one per marker and {@link MAX_MARKER_REARMS} in all, so the payload
     * always keeps re-arms of its own. False when the budget is spent or the re-arm failed — the marker
     * then gives up and the payload re-arms for itself (markers never stop the payload).
     */
    const markerRearm = async (forceKey: boolean, used: { n: number }): Promise<boolean> => {
      if (used.n >= 1 || markerRearms >= MAX_MARKER_REARMS) return false;
      used.n++;
      markerRearms++;
      try {
        await rearm(forceKey, 'marker');
        return true;
      } catch (e) {
        if (fatal(e)) throw e;
        return false;
      }
    };
    const marker = async (id: 0xf199 | 0xf198, data: number[]) => {
      const name = id === 0xf199 ? 'F199' : 'F198';
      let sessionRetried = false;
      const used = { n: 0 };
      for (let attempt = 0; attempt < MAX_MARKER_SENDS; attempt++) {
        // Checked before every send, not only the first: a silent try costs S3 too (B6).
        await keepalive();
        if (!freshAhead()) {
          note('session-stale-rearm', { did: name, detail: staleFor() });
          if (!(await markerRearm(false, used))) {
            note('marker-gave-up', { did: name, detail: 'session stale and no marker re-arm left' });
            return;
          }
        }
        const sentAt = clock.now();
        const freshAtSend = sessionConfirmedAt;
        const state = { pending: false };
        try {
          // A marker is idempotent (identical bytes): its first tries may follow the last prompt locked.
          const r = await send(
            [0x2e, id >> 8, id & 255, ...data],
            TIMEOUT.marker,
            {
              codingToken: permit,
              onTransmit: () => setMarker(name, 'no-answer'), // on the wire: possibly stored from here on
              onResponsePending: () => {
                state.pending = true;
              },
            },
            true,
            attempt < 2,
          );
          // A reply that is not ours leaves the marker `no-answer`.
          const ours = r[0] === 0x6e && r[1] === id >> 8 && r[2] === (id & 255);
          if (ours) setMarker(name, 'acked');
          note('marker', { did: name, detail: ours ? 'acked' : 'answer not ours: no-answer' });
          return;
        } catch (e) {
          if (fatal(e)) throw e;
          if (e instanceof UdsExchangeError && e.nrc !== undefined) {
            const lapsed = sentAt - freshAtSend > SESSION_FRESH_MS || marker31;
            const lost = SESSION_LOST_NRCS.has(e.nrc) || (e.nrc === 0x31 && lapsed);
            if (!sessionRetried && lost) {
              sessionRetried = true;
              note('nrc-session-lost-retry', { did: name, detail: `NRC ${nrcHex(e.nrc)}` });
              if (await markerRearm(e.nrc === 0x33, used)) continue;
            }
            // A 31 is "not hosted" only from a session that was proven alive; otherwise it is only a refusal
            // (R6: a lapsed session's 31 never reads as a missing setting).
            const notHosted = e.nrc === 0x31 && !lapsed;
            if (e.nrc === 0x31) marker31 = true;
            setMarker(name, notHosted ? 'not-hosted' : 'refused');
            note('marker', {
              did: name,
              detail: `NRC ${nrcHex(e.nrc)}: ${notHosted ? 'not-hosted' : 'refused'}`,
            });
            return;
          }
          // Busy with it (78): it is being stored; give it time and move on rather than re-send.
          if (state.pending) {
            const wait = Math.min(p2star, PROOF_WAIT_CAP_MS);
            note('marker', { did: name, detail: `pending (78): not re-sent, waiting ${wait} ms` });
            await clock.sleep(wait);
            return;
          }
          // Silence: the identical bytes are safe to re-send, at once on a new re-search (R2).
          note('marker', { did: name, detail: `no answer to send ${attempt + 1}/${MAX_MARKER_SENDS}` });
        }
      }
      // Still no answer: it stays `no-answer` (it may be stored) and the payload goes ahead.
      note('marker-gave-up', { did: name, detail: `no answer after ${MAX_MARKER_SENDS} sends` });
    };

    // ---- the data write ----
    const payload = async (): Promise<DidWrite> => {
      let sends = 0;
      let sessionRetried = false;
      /** A send was refused with 33 (securityAccessDenied). */
      let refused33 = false;
      /**
       * Sends that went out complete — a single frame, or a first frame the module took plus its CFs. A single frame
       * gets at most two (BRIEF §5.8/§5.9): a module may take one and stay silent (B7 0574, 3/3 live), so a third would
       * be a third delivery. A multi-frame write whose proof read still shows the pre-write bytes past the silent
       * window never completed reception (a lost CF makes the module discard it), so it may use every permitted send.
       * A first frame no flow control answered, and a refused send, are not counted: nothing of either is stored.
       */
      let completeSends = 0;
      const completeCap = dataWrite.length > 7 ? MAX_PAYLOAD_SENDS : 2;
      /** The last send was a first frame no flow control answered. */
      let ffUnanswered = false;
      /** No code was sent (the recipe has none, e.g. HVAC 0600, live W11): a 33 says the unit wants one. */
      const noCode: DidWrite = {
        kind: 'nrc',
        code: '33',
        detail: PLAIN.noCode,
      };
      /** This send's 78 arrived (the write was delivered and is being committed). */
      let pendingAt: number | undefined;
      const writeOnce = async (): Promise<UdsExchange> => {
        sends++;
        note('payload', { did, detail: `send ${sends}/${MAX_PAYLOAD_SENDS}` });
        return exchange(
          dataWrite,
          TIMEOUT.dataWrite,
          {
            codingToken: permit,
            onTransmit: () => {
              checkpoint();
              mainStarted = true;
              options.onSend?.();
            },
            onResponsePending: () => {
              if (!pendingSeen) note('pending', { did, detail: '78 responsePending' });
              pendingSeen = true;
              pendingAt ??= clock.now();
              options.onPending();
            },
            onRxFrame: (frame) => {
              // Keep the head and a rolling tail: a renewal storm must not evict the final answer.
              if (payloadRx.length < 64) payloadRx.push(`${frame.ecu} ${hexOf(frame.bytes)}`);
              else {
                payloadRx.splice(32, 1);
                payloadRx.push(`${frame.ecu} ${hexOf(frame.bytes)}`);
              }
            },
            // A multi-frame write's first frame may follow the last prompt locked: a dropped one costs one ~0.2 s NO
            // DATA and is told apart for free (no flow control: nothing can be stored), while a re-search costs ~0.6 s
            // and loses ~1.5 % of its sends to a 4.4 s UNABLE TO CONNECT. A single frame always re-searches (R1): its
            // silence must be resolved by a proof read. A first frame sent again after one that got no flow control
            // re-searches: an immediate locked retry was lost 19 % of the time live, a search 6 %.
          },
          dataWrite.length > 7 && !ffUnanswered,
        );
      };
      const describe = (stored: string | undefined) =>
        stored === undefined
          ? 'unreadable'
          : stored === intended
            ? 'intended bytes'
            : stored === original
              ? 'pre-write bytes'
              : 'other bytes';
      /**
       * The write changes only bytes that sit where the clone's byte-8 stray lands (live 2026-11-09: the OBDBLE clone
       * replaces the 8th byte of every full CAN frame it sends — a 7-byte single frame's last data byte, a first frame's
       * 6th payload byte, every full consecutive frame's last). Such a write reaches the module with the stray in
       * place of the changed byte, every time: a re-send can only deliver the same bytes again.
       */
      const strayOnly = (() => {
        if (original === undefined || original.length !== intended.length || original === intended)
          return false;
        const total = dataWrite.length;
        const stray = new Set<number>();
        if (total === 7) stray.add(6);
        // First frame: payload byte 5; then the last byte of each full consecutive frame (12, 19, …).
        if (total > 7) for (let i = 5; i < total; i += 7) stray.add(i);
        for (let j = 0; j * 2 < intended.length; j++)
          if (intended.slice(j * 2, j * 2 + 2) !== original.slice(j * 2, j * 2 + 2) && !stray.has(j + 3))
            return false;
        return true;
      })();
      /** Hex position just past the first byte the write changes (undefined: the two values cannot be compared). */
      const firstChangeEnd = (() => {
        if (original === undefined || original.length !== intended.length || original === intended)
          return undefined;
        let i = 0;
        while (intended.slice(i, i + 2) === original.slice(i, i + 2)) i += 2;
        return i + 2;
      })();
      /**
       * A long DID's read arrives in blocks of 4 CFs (the clone's cap), the rest after our own flow control, which the
       * clone may drop like any send. A module stores a write whole — its memory holds the old value or ours, never a
       * mix — so first blocks that already contain a byte the write changes decide it: every byte so far is ours, or
       * every byte so far is the pre-write value. Anything else is reported as it is. No re-read needed.
       */
      const fromPrefix = (e: unknown): string | undefined => {
        if (!(e instanceof UdsExchangeError) || e.detail !== 'truncated' || !e.partial) return undefined;
        const p = e.partial;
        if (firstChangeEnd === undefined || original === undefined) return undefined;
        if (p[0] !== 0x62 || p[1] !== didBytes[0] || p[2] !== didBytes[1]) return undefined;
        const known = hexOf(p.slice(3));
        if (known.length < firstChangeEnd) return undefined;
        if (known === intended.slice(0, known.length)) return intended;
        if (known === original.slice(0, known.length)) return original;
        return known;
      };
      /** The DID's read answer needs more than the 4 CFs the clone forwards per command (~1 s per read). */
      const longRead = 3 + intended.length / 2 > 34;
      /** Tester-present at each prompt until `at` (keeps the adapter from idling into a re-search, and S3 alive). */
      const bridge = async (at: number) => {
        for (let n = 0; clock.now() < at && n < 64; n++) {
          try {
            await send([0x3e, 0x00], TIMEOUT.testerPresent, {}, false, true);
          } catch (e) {
            if (fatal(e)) throw e;
          }
        }
      };
      /** The last proof read was answered busy (21) or pending (78): the module is still at work. */
      let readBusy = false;
      /** The DID's stored bytes right now (a ladder of re-searched reads); undefined when the module won't say. */
      const proofRead = async (): Promise<string | undefined> => {
        try {
          const proof = await ladder(
            [0x22, didBytes[0] ?? 0, didBytes[1] ?? 0],
            TIMEOUT.probe,
            {},
            false,
            (e) => fromPrefix(e) !== undefined,
          );
          return proof[0] === 0x62 && proof[1] === didBytes[0] && proof[2] === didBytes[1]
            ? hexOf(proof.slice(3))
            : undefined;
        } catch (e) {
          if (fatal(e)) throw e;
          readBusy =
            e instanceof UdsExchangeError && (e.nrc === 0x21 || e.nrc === 0x78 || e.detail === 'pending');
          const known = fromPrefix(e);
          if (known !== undefined) {
            note('proof-read', { did, detail: 'decided by the first blocks of the answer' });
            // A positive answer, if a short one: it keeps a proven session proven, as any answer does (send()).
            if (clock.now() - sessionConfirmedAt <= SESSION_FRESH_MS) confirmSession();
          }
          return known;
        }
      };
      /**
       * The module's own memory decides a write without its final answer (R5). After a 78 the write was delivered and
       * is being committed: its bytes are polled from the 78 on, each read at the previous one's prompt — no idle wait,
       * so no read needs a re-search (each re-search risks a 4.4 s UNABLE TO CONNECT) — until ours show, or until a read
       * that left after 78 + P2*: only then do the pre-write bytes prove it was not stored. A read refused busy (21/78)
       * is asked again. After plain silence the write most likely never arrived and is read at once; but a module that
       * took it and whose 78 was lost would still show the old bytes while it commits, so the old bytes count only from
       * a read that left {@link SILENT_PROOF_MS} after the write's last frame (no re-send could then land twice).
       */
      const proof = async (silentSince: number | undefined): Promise<string | undefined> => {
        const until =
          pendingAt !== undefined
            ? pendingAt + Math.min(p2star, PROOF_WINDOW_MS)
            : silentSince !== undefined
              ? silentSince + SILENT_PROOF_MS
              : 0;
        for (let i = 1; i <= MAX_PROOF_READS; i++) {
          readBusy = false;
          const askedAt = clock.now();
          const stored = await proofRead();
          note('proof-read', { did, detail: `${i}: ${readBusy ? 'busy' : describe(stored)}` });
          if (stored === intended) return stored;
          if (askedAt >= until) return readBusy ? undefined : stored;
          // Inside the window the old bytes (or a busy answer) are what a module shows until it is done.
          if (!readBusy && stored !== original) return stored;
          // A long DID's read takes ~1 s (the clone prompts a 4-CF answer late): after silence, the window is bridged
          // with tester-present at each prompt instead (~0.15 s each, never idle), so the deciding read leaves at its end.
          if (pendingAt === undefined && longRead) await bridge(until);
        }
        // The commit window never closed on a read: undecided, so no re-send (it could land twice).
        return undefined;
      };
      const isOurAck = (r: UdsExchange) =>
        r.response[0] === 0x6e && r.response[1] === didBytes[0] && r.response[2] === didBytes[1];

      for (;;) {
        await keepalive();
        await ensureSession();
        const sentAt = clock.now();
        const freshAtSend = sessionConfirmedAt;
        pendingAt = undefined;
        let reply: UdsExchange | undefined;
        /** When the last frame of a send that met silence was handed to the adapter. */
        let silentSince: number | undefined;
        completeSends++;
        try {
          reply = await writeOnce();
        } catch (e) {
          if (fatal(e)) throw e;
          if (e instanceof UdsExchangeError) silentSince = e.txFrames.at(-1)?.at;
          if (e instanceof UdsExchangeError && e.nrc !== undefined && e.nrc !== 0x78) {
            if (e.nrc === 0x33) refused33 = true;
            // Written without security access because the unit-default code was refused: a 33 now is
            // the module saying it needs a code after all.
            if (e.nrc === 0x33 && defaultCodeRefused) {
              note('nrc', { did, detail: 'NRC 33 after the unit-default code was refused' });
              return { kind: 'nrc', code: '33', detail: defaultCodeDetail() };
            }
            // A refusal stores nothing, so one retry in a re-armed session is safe — and it is the only
            // way to tell a lapsed session from a real "no" (live 10-30/10-31 false "code 31"). A 31 is
            // believed only after that retry (R6).
            const lapsed = sentAt - freshAtSend > SESSION_FRESH_MS || marker31;
            if (
              !sessionRetried &&
              sends < MAX_PAYLOAD_SENDS &&
              (SESSION_LOST_NRCS.has(e.nrc) || e.nrc === 0x31)
            ) {
              sessionRetried = true;
              note('nrc-session-lost-retry', {
                did,
                detail: `NRC ${nrcHex(e.nrc)}; session ${lapsed ? 'may have lapsed' : staleFor()}`,
              });
              // A refusal stored nothing: it does not spend one of the complete sends.
              completeSends--;
              await rearm(e.nrc === 0x33, `payload NRC ${nrcHex(e.nrc)}`);
              continue;
            }
            note('nrc', {
              did,
              detail: `NRC ${nrcHex(e.nrc)}${sessionRetried ? ' (after a re-armed retry)' : ''}`,
            });
            if (e.nrc === 0x33 && password === null) return noCode;
            return { kind: 'nrc', code: nrcHex(e.nrc) };
          }
          if (!isSilentAfterSend(e)) throw e;
          // A multi-frame write whose first frame got no flow control never reached the module as a request:
          // without its CFs there is nothing to store. Sent again at once — no proof read is needed.
          if (
            e instanceof UdsExchangeError &&
            dataWrite.length > 7 &&
            e.txFrames.length <= 1 &&
            pendingAt === undefined &&
            sends < MAX_PAYLOAD_SENDS
          ) {
            note('resend', { did, detail: 'no flow control to the first frame: the write never left' });
            completeSends--;
            ffUnanswered = true;
            continue;
          }
        }
        ffUnanswered = false;
        note('payload', {
          did,
          detail: !reply
            ? pendingAt !== undefined
              ? 'pending, no final answer'
              : 'no answer'
            : isOurAck(reply)
              ? 'acked (6E)'
              : 'answer not ours',
        });
        if (reply && isOurAck(reply)) {
          // The ACK stands from here on, whatever a later step does. Never re-sent after an ACK: a module
          // may apply only after commit or a session change, so a stale read here proves nothing
          // (native: live == before after an ACK means "did not take; state intact"). The domain reads back.
          acked = true;
          return { kind: 'acked' };
        }
        // Silent, pending, or an answer that was not ours: the module's memory decides.
        // The silent window guards a re-send; with none left, one read at once tells what the domain will read back.
        const stored = await proof(
          reply || completeSends >= completeCap || sends >= MAX_PAYLOAD_SENDS ? undefined : silentSince,
        );
        if (stored === intended) return { kind: 'pending-no-final' };
        // Answered 78 (delivered, committed) and the module answers reads again: what it shows is the outcome. When
        // the change sits only where the clone's stray lands, the pre-write bytes are the module holding what it
        // received, not a lost request: re-arming and re-sending would deliver the same stray again (live: three
        // writes, same readback). Reported as stored; genuinely lost requests (no 78) keep their re-send below.
        if (pendingAt !== undefined && stored !== undefined && strayOnly) {
          // Notes carry no payload bytes: the stored bytes go in the result.
          note('proof-read', {
            did,
            detail: `outcome: ${describe(stored)} after 78, not re-sent (the change sits where the adapter's byte-8 stray lands)`,
          });
          return { kind: 'pending-no-final', stored };
        }
        // A silent multi-frame write almost always lost its first CF (17 %, the module then discards it) and is sent
        // again while the permit allows; a silent single frame may have been delivered and ignored (B7 0574: 3/3) and
        // gets one re-send, never more.
        if (
          original !== undefined &&
          stored === original &&
          sends < MAX_PAYLOAD_SENDS &&
          completeSends < completeCap
        ) {
          // Provably not stored: one identical re-send — in the same session when it is still fresh (the
          // grant holds), otherwise after a re-arm (ensureSession at the top of the loop).
          note('resend', { did, detail: 'proof read shows the pre-write bytes: not stored' });
          continue;
        }
        // The retry of a 33 went unheard and the memory is unchanged: the unit's last word on it was the 33.
        if (refused33 && password === null && !pendingSeen && stored === original) return noCode;
        return pendingSeen ? { kind: 'pending-no-final' } : { kind: 'no-reply' };
      }
    };

    checkpoint();
    if (password === null) note('seed', { detail: 'no security code: SecurityAccess skipped' });
    // Gateway session on 710, reply ignored (native: `sendOn("710","77A","021003")`). The channel is opened
    // on the gateway, so this first request uses the setup's own protocol search.
    note('retarget', { module: GATEWAY.request, detail: 'gateway 10 03, answer ignored' });
    if (!link.nativeBind) await retarget(GATEWAY);
    try {
      await exchange([0x10, 0x03], TIMEOUT.session);
    } catch (e) {
      if (fatal(e)) throw e;
    }
    await retarget(module);

    let opened = false;
    try {
      await openSession('open a coding session');
      opened = true;

      // Each probe re-searches and an answer proves the module is listening: no tester-present between them
      // (B10). F199 is refused (7F 22 31) everywhere, which proves nothing about the session.
      const f199 = await probe(0xf199);
      const f1a5 = await probe(0xf1a5);

      // S3 is ~5 s and the probes used part of it: the native order re-opened right before security. Only
      // needed when the session could lapse before the key lands — a re-open costs a request.
      if (!freshAhead()) await openSession('re-open the coding session');
      await unlock();

      if (options.markers === false) {
        note('marker', { detail: 'skipped: markers off for this write' });
      } else {
        // F199: written whenever the DID answered at all — a module may refuse to READ it and still
        // accept the write (live-proven; native: any probe reply of 3+ bytes, NRC included).
        if (f199.kind !== 'silent') {
          const d = (options.today ?? (() => new Date()))();
          await marker(0xf199, [bcd(d.getFullYear() % 100), bcd(d.getMonth() + 1), bcd(d.getDate())]);
        } else note('marker', { did: 'F199', detail: 'skipped: F199 probe got no answer' });
        // F198: only when F1A5 returned data (native: `62 F1 A5` + at least one byte); all zero → vendor fallback.
        if (f1a5.kind === 'data' && f1a5.bytes.length > 0)
          await marker(0xf198, f1a5.bytes.some((b) => b !== 0) ? f1a5.bytes : F198_FALLBACK);
        else note('marker', { did: 'F198', detail: 'skipped: F1A5 returned no data' });
      }

      return await payload();
    } finally {
      // Back to the default session deterministically instead of waiting out S3 (native: `02 10 01`).
      // Best effort, one re-searched send: its answer, or its absence, changes nothing (B12).
      if (opened && !link.session.isClosed && !options.signal?.aborted) {
        try {
          await exchange([0x10, 0x01], TIMEOUT.endSession, {}, true);
          note('end-session', { detail: '10 01 answered' });
        } catch {
          note('end-session', { detail: '10 01 not answered (ignored)' });
        }
      }
    }
  };

  try {
    return done(
      await withUdsChannel(
        link,
        {
          target: GATEWAY.request,
          responseId: GATEWAY.response,
          timing: CODING_TIMING,
          padding: 'native',
          ...(options.frameMode ? { frameMode: options.frameMode } : {}),
        },
        sequence,
      ),
    );
  } catch (e) {
    // The data write was acknowledged and only something after it failed: the ACK stands; the
    // domain's read-back reports what it can.
    if (acked) return done({ kind: 'acked' });
    if (!mainStarted) {
      if (e instanceof Cancelled || options.signal?.aborted) return done({ kind: 'cancelled' });
      if (notReady)
        return done({
          kind: 'not-sent',
          reason: 'not-ready',
          detail: PLAIN.notReady,
        });
      if (link.session.isClosed) return done({ kind: 'link-lost' });
      if (e instanceof NotSent) {
        note('stopped', { detail: e.message });
        return done({ kind: 'not-sent', detail: e.plain });
      }
      if (e instanceof UdsExchangeError && e.nrc !== undefined) {
        note('stopped', { detail: `preparation step refused, NRC ${nrcHex(e.nrc)}` });
        return done({ kind: 'not-sent', detail: PLAIN.prepRefused });
      }
      if (e instanceof UdsExchangeError && e.failure === 'policy') {
        note('stopped', { detail: `safety policy: ${e.message}` });
        return done({ kind: 'not-sent', detail: PLAIN.policy });
      }
      note('stopped', { detail: e instanceof Error ? e.message : 'no answer before the payload' });
      return done({
        kind: 'not-sent',
        detail: PLAIN.silent,
      });
    }
    if (link.session.isClosed) return done({ kind: 'link-lost' });
    // A refusal that escapes here came from a re-arm step after the payload left, never from the write itself
    // (whose NRCs the payload loop reports): it says nothing about the DID, so it is no NRC result (R6).
    return done(pendingSeen ? { kind: 'pending-no-final' } : { kind: 'no-reply' });
  }
}
