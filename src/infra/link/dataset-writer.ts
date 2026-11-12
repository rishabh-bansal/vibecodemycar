import {
  CHANNEL_CONFIG_BUDGET_MS,
  CHANNEL_RESTORE_BUDGET_MS,
  CODING_TIMING,
  type ElmLink,
  type UdsChannel,
  UdsExchangeError,
  type UdsRequestOptions,
  withUdsChannel,
} from '@obdcraft/obd-core';
import { MAX_TX_FRAMES } from '../../domain/backups/schema.ts';
import type {
  DidWrite,
  MarkerWrite,
  ModuleAddress,
  SequenceIncomplete,
  SequenceSpec,
  SequenceStep,
  WriteOptions,
  WriterNote,
  WriterStep,
} from '../../domain/coding/types.ts';
import { txRecorder } from './tx-evidence.ts';

/**
 * The declared-command writer for dataset recipes. The recipe's verbatim token lists (after the native
 * `GetRequestsFromStringCommands` grammar) are COMPILED into a typed plan before anything is sent; a token
 * the writer does not understand, a write-back without its read, or a download without its exit refuses
 * up front. Tokens:
 *
 *   "HHH:hex"   tester-present (`3E…`) or session (`10…`) on CAN header HHH; any answer, or none, is fine
 *   "2704"      `27 03` seed → `27 04 <seed + password>`; a zero seed sends `3E` instead (unverified, below);
 *               without any password (recipe or unit default) the step is skipped and the unit's answer to
 *               the payload says whether it needed one (NRC 33)
 *   "2EF198"    reads `22 F1A5`, writes those bytes (all-zero/absent → vendor fallback)
 *   "2EF199"    reads `22 F199`, reuses a stored 3-byte date, else writes today (BCD)
 *   "22XXXX"    read; a later "2EXXXX" in the lists writes the read value back (identity restore)
 *   "10xx"      session control (required)
 *   "11xx" / "14xxxxxx" / "31xxxx…"   reset / DTC clear / routine: mutating, permit-covered, required
 *   "19xxxx"    DTC read (optional)
 *   "37"        transfer exit: only with a download payload, and then it must be the first post step
 *   "ATSTDEF"   adapter timing — the channel owns timing; ignored
 *
 * The live clone silently drops a request — ~20 % sent at once after a reply, ~9 % right after an ATSP0
 * re-search, 94–100 % after idle or after other AT commands (BRIEF §0–§3). So every request goes out on a fresh
 * re-search (ATSH/ATCRA/ATFCSH/ATSP0) with no settle before it (R1), except an idempotent try or the key at the
 * prompt the previous request just ended at; an idempotent step that went silent is asked again at once, up
 * to {@link LADDER_SENDS} sends (R2). Nothing ever arrives after the adapter's prompt, so no request listens
 * past it (R7). The session is trusted only while proven within ~4 s (S3 is ~5 s): a marker or the payload
 * that could reach the module after that re-runs the ritual's sessions and security first (R3), and a silent
 * key is followed by a new seed in the same session, not a new session (R4). Markers are cosmetic: a refused
 * or silent marker is recorded and the sequence goes on, and a 31 from a session that may have lapsed is never
 * recorded as "not hosted" (R6). A DID payload's silent or pending answer is resolved by reading the DID back,
 * and a payload the read proves was not stored is sent again (R5); a refusal is retried once after a re-arm
 * before it is believed (R6). The module is returned to the default session (10 01, best effort) unless the
 * ritual ends with its own session change or reset.
 *
 * Phases and what each failure means (brief C2):
 *   prepare   nothing that changes the control unit has been sent. Readiness and cancellation are checked
 *             before every step; any failure is `not-sent` / `cancelled`.
 *   mutating  a marker or identity restore was sent; the payload was not. Readiness and cancellation are
 *             still checked before every step; failure is `not-sent` / `cancelled` WITH `steps`/`markers`
 *             saying what was changed.
 *   payload   the payload is on the wire: no check interrupts it. A single 2E is acked / nrc / no-reply /
 *             pending-no-final; a download that stops after its 34 was accepted is `partial`.
 *   post      the payload was acknowledged. Readiness is checked before each further MUTATING step; a
 *             refusal, silence, expired readiness or a lost link stops the sequence and the result is `acked`
 *             with `incomplete` — the acknowledgement is never erased, the step is never repeated.
 *
 * Only a module that refused (NRC) or did not answer in time is tolerated on an optional step; a closed,
 * desynchronised or policy-refused link stops every later mutation.
 *
 * NOT VERIFIED against the vendor delegate (its source is not in this repository; brief C4): whether F198
 * echoes F1A5 or F1A9, F199's reuse-or-today rule, and sending `3E` on a zero seed.
 */

const bytesOf = (hex: string): number[] => (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');
const hexOf = (bytes: readonly number[]): string => bytes.map(hex2).join('');
/**
 * What a note may name of a request: a 2E/22 only up to its DID (a write-back may carry identity bytes), any
 * other command whole up to 8 bytes (recipe tokens: sessions, routines, resets).
 */
const requestHead = (bytes: readonly number[]): string =>
  hexOf(bytes.slice(0, bytes[0] === 0x2e || bytes[0] === 0x22 ? 3 : 8));
const bcd = (n: number): number => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const F198_FALLBACK = [0x01, 0x81, 0xc8, 0xf6, 0x30, 0x39];

const TIMEOUT = {
  step: 6000,
  security: 8000,
  marker: 12_000,
  /** A single-request payload: the P2* ceiling the native writer allows. */
  payload: 60_000,
  download: 10_000,
  block: 10_000,
  exit: 10_000,
} as const;
/** Native waits ~20 s after an ECU reset for the module to come back (5 s on unit A5). */
const RESET_SETTLE_MS = 20_000;
/** Tester-present once the session's last proof is this old (S3 is ~5 s). */
const KEEPALIVE_AFTER_MS = 2500;
/** Sends per idempotent step (sessions, reads, probes, the seed) on a completed silence, no wait between (R2). */
const LADDER_SENDS = 4;
/** Marker transmissions: silent tries plus one session-lost retry (identical bytes). */
const MARKER_SENDS = 4;
/** A session proven this recently is trusted armed (S3 ~5 s, minus a margin). */
const SESSION_FRESH_MS = 4000;
/** Look-ahead: what one more send (re-bind, search, answer) may take before the module has it (R3). */
const EXPECTED_SEND_MS = 1000;
/** The module's P2* until its session answer says otherwise. */
const PROOF_WAIT_CAP_MS = 2000;
/** After a payload's 78, its pre-write bytes prove nothing until 78 + min(P2*, this) has passed (R5). */
const PROOF_WINDOW_MS = 5000;
/** Proof reads (each a ladder) after one payload send, at most: back to back, the window bounds them first. */
const MAX_PROOF_READS = 24;
/** DID payload transmissions: the first, one session-lost retry, and one re-send its memory proved unstored. */
const MAX_PAYLOAD_SENDS = 3;
/**
 * After a complete send met silence, its pre-write bytes prove it was not stored only from a read that left this long
 * after its last frame: past the commit of a write whose 78 was lost (as ble-writer.ts).
 */
const SILENT_PROOF_MS = 1600;
/** Handshakes per unlock (a silent key asks for the seed again) and full re-arms per sequence. */
const HANDSHAKES_PER_UNLOCK = 4;
const MAX_REARMS = 3;
/** Times the ritual's sessions may run: the first, every re-arm, and every handshake of each unlock. */
const SESSION_RUNS = (1 + MAX_REARMS) * HANDSHAKES_PER_UNLOCK;
/** One searched send at its bound: a re-bind (four adapter commands) and the request. */
const sendMs = (t: number): number => CHANNEL_CONFIG_BUDGET_MS + t;
/** One ladder step at its bound. */
const ladderMs = (t: number): number => LADDER_SENDS * sendMs(t);
/** One handshake: a seed ladder and the key. */
const HANDSHAKE_MS = ladderMs(TIMEOUT.security) + sendMs(TIMEOUT.security);
/** One unlock when every handshake re-runs `sessions` session steps first. */
const unlockMs = (sessions: number): number =>
  HANDSHAKES_PER_UNLOCK * (HANDSHAKE_MS + sessions * ladderMs(TIMEOUT.step));
/** Largest TransferData data size (one 4095-byte PDU minus service and counter). */
const MAX_BLOCK_DATA = 4093;
/** Bytes a download may carry: bounded by the journal (one request frame per 7 bytes at most). */
const MAX_DOWNLOAD_BYTES = 4096;

type Step =
  | { kind: 'session'; cmd: string }
  | { kind: 'read'; did: string; paired: boolean }
  | { kind: 'security' }
  | { kind: 'marker'; did: 'F198' | 'F199' }
  | { kind: 'restore'; did: string }
  | { kind: 'mutating'; cmd: string }
  | { kind: 'optional'; cmd: string }
  | { kind: 'broadcast'; header: string; cmd: string }
  | { kind: 'exit' }
  | { kind: 'adapter' };

export interface CompiledSequence {
  pre: Step[];
  post: Step[];
  /** Every permit-covered command besides the payload and the security pair. */
  commands: string[];
  markers: ('F198' | 'F199')[];
  restores: string[];
  /** The `34` request, for a download payload. */
  downloadRequest?: string;
  /** Transmissions a DID payload may take (1 for a download, whose request is sent once). */
  payloadSends: number;
  /** Longest the whole sequence can take with every step at its own timeout. */
  budgetMs: number;
}

/** Frames a request of `n` bytes needs on classic CAN ISO-TP. */
const framesFor = (n: number): number => (n <= 7 ? 1 : 1 + Math.ceil((n - 6) / 7));

/** Compiles a spec into a plan, or says why it refuses. Pure: nothing is sent. */
export function compileSequence(spec: SequenceSpec): CompiledSequence | { error: string } {
  const fail = (error: string) => ({ error });
  const markers: ('F198' | 'F199')[] = [];
  const restores: string[] = [];
  const commands: string[] = [];
  const read = new Map<string, Extract<Step, { kind: 'read' }>>();
  let security = false;
  let exits = 0;
  let frames = 0;
  let budget = CHANNEL_CONFIG_BUDGET_MS + CHANNEL_RESTORE_BUDGET_MS;
  const download = spec.write.kind === 'download';

  const compile = (list: readonly string[], phase: 'pre' | 'post'): Step[] | { error: string } => {
    const out: Step[] = [];
    for (const [i, raw] of list.entries()) {
      const token = raw.toUpperCase();
      const colon = token.indexOf(':');
      if (colon >= 0) {
        const header = token.slice(0, colon);
        const cmd = token.slice(colon + 1);
        if (!/^[0-7][0-9A-F]{2}$/.test(header) || !/^(3E[0-9A-F]{0,2}|10[0-9A-F]{2})$/.test(cmd))
          return fail(`The recipe's command "${raw}" is not understood.`);
        out.push({ kind: 'broadcast', header, cmd });
        budget += 2 * CHANNEL_CONFIG_BUDGET_MS + TIMEOUT.step;
        frames += 1;
        continue;
      }
      if (token === 'ATSTDEF') {
        out.push({ kind: 'adapter' });
        continue;
      }
      if (token === '2704') {
        if (security || phase === 'post') return fail(`The recipe's command "${raw}" is not allowed there.`);
        security = true;
        out.push({ kind: 'security' });
        // Every handshake may re-run the sessions before it; a keepalive, a zero-seed 3E.
        const sessions = out.filter((s) => s.kind === 'session').length;
        budget += unlockMs(sessions) + 2 * ladderMs(TIMEOUT.step);
        frames += HANDSHAKES_PER_UNLOCK * (LADDER_SENDS + 1 + sessions * LADDER_SENDS) + 2 * LADDER_SENDS;
        continue;
      }
      if (token === '2EF198' || token === '2EF199') {
        const did = token.slice(2) as 'F198' | 'F199';
        if (markers.includes(did) || phase === 'post')
          return fail(`The recipe's command "${raw}" is not allowed there.`);
        markers.push(did);
        out.push({ kind: 'marker', did });
        budget += ladderMs(TIMEOUT.step) + MARKER_SENDS * (ladderMs(TIMEOUT.step) + sendMs(TIMEOUT.marker));
        frames += LADDER_SENDS + MARKER_SENDS * (LADDER_SENDS + 2);
        continue;
      }
      if (/^22[0-9A-F]{4}$/.test(token)) {
        const step = { kind: 'read' as const, did: token.slice(2), paired: false };
        read.set(step.did, step);
        out.push(step);
        budget += ladderMs(TIMEOUT.step);
        frames += 2 * LADDER_SENDS;
        continue;
      }
      if (/^2E[0-9A-F]{4}$/.test(token)) {
        const did = token.slice(2);
        // A write-back is only ever the value this sequence read: without that read it would write nothing
        // known, so the recipe refuses rather than skip it silently (C4).
        const source = read.get(did);
        if (!source) return fail(`The recipe writes ${did} back without reading it first.`);
        source.paired = true;
        restores.push(did);
        out.push({ kind: 'restore', did });
        budget += sendMs(TIMEOUT.step);
        frames += 3;
        continue;
      }
      if (/^10[0-9A-F]{2}$/.test(token)) {
        // Programming and adjustment sessions are never part of a coding sequence (the policy refuses them too).
        if (/^10(02|82|85|86|87)$/.test(token))
          return fail(`The recipe's session ${token.slice(2)} is not allowed.`);
        if (!/^10(01|03|81|83)$/.test(token)) commands.push(token);
        out.push({ kind: 'session', cmd: token });
        budget += ladderMs(TIMEOUT.step);
        frames += LADDER_SENDS;
        continue;
      }
      if (/^(11[0-9A-F]{2}|14[0-9A-F]{6}|31[0-9A-F]{4}(?:[0-9A-F]{2}){0,8})$/.test(token)) {
        commands.push(token);
        out.push({ kind: 'mutating', cmd: token });
        budget += sendMs(TIMEOUT.step) + (token.startsWith('11') ? RESET_SETTLE_MS : 0);
        frames += framesFor(token.length / 2) + 1;
        continue;
      }
      if (/^(3E[0-9A-F]{0,2}|19[0-9A-F]{4})$/.test(token)) {
        out.push({ kind: 'optional', cmd: token });
        budget += TIMEOUT.step;
        frames += 2;
        continue;
      }
      if (token === '37') {
        if (!download || phase !== 'post' || i !== 0)
          return fail('A transfer exit belongs only right after a download payload.');
        exits++;
        out.push({ kind: 'exit' });
        budget += TIMEOUT.exit;
        frames += 1;
        continue;
      }
      return fail(`The recipe's command "${raw}" is not understood.`);
    }
    return out;
  };

  const pre = compile(spec.pre, 'pre');
  if ('error' in pre) return pre;
  const post = compile(spec.post, 'post');
  if ('error' in post) return post;

  let downloadRequest: string | undefined;
  let payloadSends = 1;
  if (spec.write.kind === 'did') {
    const { did, bytes } = spec.write;
    if (!/^[0-9A-F]{4}$/.test(did) || !/^(?:[0-9A-F]{2}){1,4092}$/.test(bytes))
      return fail('The change was malformed.');
    // A payload too large for its record to hold a third transmission keeps two (the first, one retry).
    const perSend = framesFor(3 + bytes.length / 2) + 2 + MAX_PROOF_READS;
    payloadSends =
      frames + MAX_PAYLOAD_SENDS * perSend + pre.length * 4 <= MAX_TX_FRAMES ? MAX_PAYLOAD_SENDS : 2;
    // Every send with its keepalive and proof reads, and every re-arm (the ritual's sessions, then the unlock).
    const sessions = pre.filter((s) => s.kind === 'session').length;
    const proofMs = PROOF_WINDOW_MS + ladderMs(TIMEOUT.step);
    budget +=
      payloadSends * (ladderMs(TIMEOUT.step) + sendMs(TIMEOUT.payload) + proofMs) +
      MAX_REARMS * (sessions * ladderMs(TIMEOUT.step) + unlockMs(sessions));
    frames += payloadSends * perSend + pre.length * 4;
  } else {
    const d = spec.write;
    if (exits !== 1)
      return fail('A download must end with its transfer exit (37) as the first step after it.');
    const size = d.bytes.length / 2;
    if (
      !/^(?:[0-9A-F]{2})+$/.test(d.bytes) ||
      size > MAX_DOWNLOAD_BYTES ||
      !/^[0-9A-F]+$/.test(d.address) ||
      d.address.length > d.addressFormat * 2 ||
      size >= 2 ** (8 * d.lengthFormat)
    )
      return fail('The download was malformed.');
    downloadRequest = `3400${d.lengthFormat}${d.addressFormat}${d.address.padStart(d.addressFormat * 2, '0')}${size
      .toString(16)
      .toUpperCase()
      .padStart(d.lengthFormat * 2, '0')}`;
    // Worst case before the block size is known: single-frame blocks (5 data bytes) with a keepalive each.
    const blocks = Math.ceil(size / 5);
    budget += sendMs(TIMEOUT.download) + blocks * (TIMEOUT.block + ladderMs(TIMEOUT.step));
    frames += framesFor(downloadRequest.length / 2) + 1;
  }
  // The journal must be able to hold every frame: refuse before sending a sequence that might not fit.
  if (frames > MAX_TX_FRAMES) return fail('This sequence would send more frames than its record can hold.');
  if (markers.length || security) budget += 2 * ladderMs(TIMEOUT.step); // keepalives
  budget += sendMs(TIMEOUT.step); // the closing 10 01
  frames += 1;
  return {
    pre,
    post,
    commands,
    markers,
    restores,
    ...(downloadRequest ? { downloadRequest } : {}),
    payloadSends,
    budgetMs: budget,
  };
}

/** Longest `writeCodingSequence(spec)` can take; the domain's backstop waits at least this long. */
export function sequenceBudgetMs(spec: SequenceSpec): number {
  const compiled = compileSequence(spec);
  return 'error' in compiled ? CHANNEL_CONFIG_BUDGET_MS : compiled.budgetMs;
}

/**
 * What the owner reads when a write stops. Plain words only: codes, identifiers and the access code itself are
 * never put here (the technical reason goes in a writer note).
 */
const PLAIN = {
  partial: 'The update stopped partway.',
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
/** The download stopped after its request was accepted: the module may hold part of it. */
class Partial extends Error {}

/**
 * Answer of an exchange the writer may tolerate: the module refused, or did not answer in time — including a
 * completed UNABLE TO CONNECT, which is what a silent module looks like right after an ATSP0 re-bind.
 */
const tolerable = (e: unknown): e is UdsExchangeError =>
  e instanceof UdsExchangeError &&
  (e.failure === 'nrc' ||
    e.failure === 'timeout' ||
    (e.failure === 'adapter' &&
      e.requestStarted &&
      e.replies.at(-1)?.status === 'ok' &&
      (e.replies.at(-1)?.statuses as readonly string[] | undefined)?.includes('UNABLE TO CONNECT') === true));
/** NRCs to a 2E that mean the session (or its unlock) is gone, not that the value is refused. */
const SESSION_LOST_NRCS = new Set([0x7f, 0x33, 0x22]);
/**
 * The adapter finished the request cleanly but reported NO DATA — or UNABLE TO CONNECT, which is what the same
 * silence becomes once the request runs an ATSP0 re-search. An idempotent step may be re-sent after it.
 */
const isRetriableSilence = (e: unknown): e is UdsExchangeError => {
  const last = e instanceof UdsExchangeError ? e.replies.at(-1) : undefined;
  if (!(e instanceof UdsExchangeError) || last?.status !== 'ok') return false;
  const statuses = last.statuses as readonly string[];
  if (e.failure === 'timeout' && statuses.includes('NO DATA')) return true;
  return e.failure === 'adapter' && statuses.includes('UNABLE TO CONNECT');
};
/** The request left and no answer came back (silence, or a 78 whose final answer is unhearable). */
const isSilentAfterSend = (e: unknown): boolean =>
  e instanceof UdsExchangeError && e.requestStarted && e.nrc === undefined && tolerable(e);

export async function writeCodingSequence(
  link: ElmLink,
  module: ModuleAddress,
  spec: SequenceSpec,
  options: WriteOptions & { resetSettleMs?: number; today?: () => Date },
): Promise<DidWrite> {
  const settle = options.resetSettleMs ?? RESET_SETTLE_MS;
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
  const clock = link.clock;
  const tx = txRecorder(options);
  const markers = new Map<MarkerWrite['did'], MarkerWrite>();
  const steps: SequenceStep[] = [];
  let incomplete: SequenceIncomplete | undefined;
  const done = (r: DidWrite): DidWrite => ({
    ...r,
    ...(tx.frames.length ? { txFrames: [...tx.frames] } : {}),
    ...(markers.size ? { markers: [...markers.values()] } : {}),
    ...(steps.length ? { steps: [...steps] } : {}),
    ...(incomplete && r.kind === 'acked' ? { incomplete } : {}),
  });

  const compiled = compileSequence(spec);
  if ('error' in compiled) {
    note('stopped', { detail: compiled.error });
    return done({ kind: 'not-sent', detail: PLAIN.malformed });
  }
  const password = options.securityPassword ?? spec.password;
  // No code at all: the key step is skipped and the payload's answer tells (NRC 33). A code that is
  // present but malformed is a data error, refused before anything is sent.
  if (password !== null && !/^\d{1,10}$/.test(password))
    return done({ kind: 'not-sent', detail: PLAIN.badCode });

  const permit = link.policy.issueCodingPermit(module.request, {
    ...(spec.write.kind === 'did' ? { writes: [`2E${spec.write.did}${spec.write.bytes}`] } : {}),
    // Spent only on sends the module provably did not store: a refusal (retried once after a re-arm), a proof
    // read that still shows the pre-write bytes, a first frame no flow control answered.
    writeRetries: compiled.payloadSends - 1,
    writePrefixes: [...compiled.markers.map((m) => `2E${m}`), ...compiled.restores.map((d) => `2E${d}`)],
    // Silent markers are re-sent with identical bytes.
    writePrefixRetries: MARKER_SENDS - 1,
    // A declared session command is re-run (as a ladder) by every re-arm and by an unlock whose session lapsed.
    commands: [
      ...compiled.commands.filter((c) => !c.startsWith('10')),
      ...compiled.commands
        .filter((c) => c.startsWith('10'))
        .flatMap((c) => Array<string>(SESSION_RUNS * LADDER_SENDS).fill(c)),
    ],
    ...(compiled.downloadRequest && spec.write.kind === 'download'
      ? {
          download: {
            request: compiled.downloadRequest,
            payload: spec.write.bytes,
            maxBlock: MAX_BLOCK_DATA,
          },
        }
      : {}),
    securityAccess: compiled.pre.some((s) => s.kind === 'security') && password !== null,
    securityBudget: {
      seed: LADDER_SENDS * HANDSHAKES_PER_UNLOCK * (1 + MAX_REARMS),
      key: HANDSHAKES_PER_UNLOCK * (1 + MAX_REARMS),
    },
    ttlMs: compiled.budgetMs,
  });

  type Phase = 'prepare' | 'mutating' | 'payload' | 'post';
  let phase: Phase = 'prepare';
  /** Read through a function: the phase is advanced inside callbacks, which flow analysis cannot see. */
  const current = (): Phase => phase;
  let pendingSeen = false;

  const setMarker = (did: MarkerWrite['did'], outcome: MarkerWrite['outcome']) => {
    markers.set(did, { did, outcome });
    options.onMarker?.({ did, outcome });
  };
  /** Records a mutating step the moment it is on the wire (it may take effect from then on). */
  const begin = (cmd: string): number => {
    phase = phase === 'prepare' ? 'mutating' : phase;
    return steps.push({ cmd, outcome: 'no-answer' }) - 1;
  };
  const settleStep = (i: number, outcome: SequenceStep['outcome'], nrc?: number) => {
    const s = steps[i];
    if (s) steps[i] = { cmd: s.cmd, outcome, ...(nrc !== undefined ? { nrc: hex2(nrc) } : {}) };
  };
  /** Before a step: cancellation and readiness until the payload is on the wire. */
  const checkpoint = () => {
    if (phase === 'payload' || phase === 'post') return;
    if (options.signal?.aborted) throw new Cancelled();
    try {
      options.assertReady?.();
    } catch {
      note('not-ready', { detail: `readiness expired during ${phase}` });
      throw new NotReady();
    }
  };

  /** When the ritual's session (and any unlock inside it) was last PROVEN alive. */
  let sessionConfirmedAt = Number.NEGATIVE_INFINITY;
  const confirmSession = (at = clock.now()) => {
    sessionConfirmedAt = at;
  };
  /** A marker in this ritual came back 31 — the live signature of a lapsed session. */
  let marker31 = false;
  /** The module's P2* (ms), from its session answer. */
  let p2star = PROOF_WAIT_CAP_MS;
  /** Session freshness is tracked only for a ritual that opens a session itself. */
  const tracksSession = compiled.pre.some((s) => s.kind === 'session');
  /** The NRC the module gave the unit-default code: the ritual then goes on without security access. */
  let defaultCodeRefused: string | undefined;

  const sequence = async (ch: UdsChannel): Promise<DidWrite> => {
    const sessionAge = () => clock.now() - sessionConfirmedAt;
    /** Fresh enough that one more send still reaches the module inside the S3 budget (R3 look-ahead). */
    const freshAhead = () => !tracksSession || sessionAge() + EXPECTED_SEND_MS <= SESSION_FRESH_MS;
    /** The next request runs the adapter's protocol search (the channel setup ends with ATSP0 on a clone link). */
    let searchArmed = link.nativeBind;
    /** The previous request just ended at the adapter's prompt (an answer, a refusal or NO DATA), nothing since. */
    let atPrompt = false;
    /** The module whose last re-searched request went unanswered: its next search is lost ~36 % of the time. */
    let searchSilentOn: string | undefined;
    /**
     * One request (R1/R7, as the single-DID writer): on a fresh re-search — except `locked`, an idempotent try or
     * the key, at the prompt the previous request just ended at (a drop there costs one ~210 ms NO DATA; a
     * re-search ~0.6 s and, now and then, a 4.4 s UNABLE TO CONNECT) — and never listening past the prompt.
     */
    const exchange = async (
      bytes: number[],
      opts: { header?: string; timeoutMs?: number; extra?: UdsRequestOptions; locked?: boolean } = {},
    ): Promise<number[]> => {
      const target = opts.header ?? module.request;
      if (ch.target !== target) {
        await ch.retarget(target, module.response);
        searchArmed = true;
        note('retarget', target !== module.request ? { module: target } : {});
      }
      const searched = searchArmed || !(atPrompt && (opts.locked || searchSilentOn === ch.target));
      if (searched && !searchArmed) await ch.rebind();
      searchArmed = false;
      atPrompt = false;
      try {
        const r = await ch.exchange(bytes, {
          timeoutMs: opts.timeoutMs ?? TIMEOUT.step,
          codingToken: permit,
          pendingListenMs: 0,
          ...opts.extra,
          ...tx.exchange(),
        });
        atPrompt = true;
        // The channel says whether the request searched: its idle guard may have re-searched a locked send.
        if (r.searched ?? searched) searchSilentOn = undefined;
        // A positive answer inside a proven-fresh session keeps it proven; one after a gap does not.
        if (r.endedAt - sessionConfirmedAt <= SESSION_FRESH_MS) confirmSession(r.endedAt);
        return r.response;
      } catch (e) {
        if ((e instanceof UdsExchangeError ? e.searched : undefined) ?? searched)
          searchSilentOn =
            isRetriableSilence(e) && e instanceof UdsExchangeError && e.txFrames.length <= 1
              ? ch.target
              : undefined;
        // UNABLE TO CONNECT: the adapter searches again on the next request by itself.
        if (e instanceof UdsExchangeError && e.failure === 'adapter' && isRetriableSilence(e))
          searchArmed = true;
        atPrompt =
          e instanceof UdsExchangeError &&
          ((e.nrc !== undefined && e.nrc !== 0x78) ||
            (e.failure === 'timeout' && e.detail === undefined && isRetriableSilence(e)));
        throw e;
      }
    };
    /**
     * Idempotent steps only (sessions, reads, probes, the seed): a completed silence (or a multi-frame answer cut
     * short) is asked again at once, up to {@link LADDER_SENDS} sends — the first two at the prompt, later ones on
     * a new re-search (R2).
     */
    const ladder = async (
      bytes: number[],
      opts: { header?: string; timeoutMs?: number; extra?: UdsRequestOptions } = {},
    ): Promise<number[]> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await exchange(bytes, { ...opts, locked: attempt < 2 });
        } catch (e) {
          const truncated = bytes[0] === 0x22 && e instanceof UdsExchangeError && e.detail === 'truncated';
          if (attempt === LADDER_SENDS - 1 || !(isRetriableSilence(e) || truncated)) throw e;
          note('retarget', {
            detail: `empty answer to ${requestHead(bytes)}; send ${attempt + 2}/${LADDER_SENDS}`,
          });
        }
      }
    };
    /** Keeps S3 alive before a step that may need retries: on the age of the session's proof. */
    const keepalive = async () => {
      if (!tracksSession || sessionAge() < KEEPALIVE_AFTER_MS || !freshAhead()) return;
      try {
        await ladder([0x3e, 0x00]);
      } catch (e) {
        if (!tolerable(e)) throw e;
      }
    };
    const positive = (r: number[], sent: number[], echo: number) =>
      r[0] === (sent[0] ?? 0) + 0x40 &&
      Array.from({ length: echo }, (_, i) => r[i + 1] === sent[i + 1]).every(Boolean);

    /** A mutating step (identity restore, routine, DTC clear, reset). Refusal/silence stop the sequence. */
    const mutate = async (bytes: number[], echo: number): Promise<void> => {
      checkpoint();
      if (phase === 'post') {
        try {
          options.assertReady?.();
        } catch {
          incomplete = { step: hexOf(bytes), reason: 'not-ready' };
          note('not-ready', { detail: `readiness expired before ${requestHead(bytes)} (after the payload)` });
          throw new NotReady();
        }
      }
      await keepalive();
      let index = -1;
      try {
        const r = await exchange(bytes, { extra: { onTransmit: () => (index = begin(hexOf(bytes))) } });
        if (!positive(r, bytes, echo))
          throw new UdsExchangeError('The answer was not for this step.', true, [], undefined, 'protocol');
        settleStep(index, 'acked');
        note('step', { detail: `${requestHead(bytes)} acked` });
      } catch (e) {
        const nrc = e instanceof UdsExchangeError ? e.nrc : undefined;
        if (index >= 0) settleStep(index, nrc !== undefined ? 'refused' : 'no-answer', nrc);
        note('step', {
          detail: `${requestHead(bytes)} ${nrc !== undefined ? `NRC ${hex2(nrc)}` : tolerable(e) ? 'no answer' : 'link failure'}`,
        });
        if (phase === 'post') {
          incomplete = {
            step: hexOf(bytes),
            reason: nrc !== undefined ? 'refused' : tolerable(e) ? 'no-answer' : 'link-lost',
            ...(nrc !== undefined ? { nrc: hex2(nrc) } : {}),
          };
          throw e;
        }
        if (!tolerable(e)) throw e;
        throw new NotSent(
          nrc !== undefined
            ? `The control unit refused step ${hexOf(bytes)} (code ${hex2(nrc)}).`
            : `Step ${hexOf(bytes)} got no clear answer, so we stopped.`,
        );
      }
    };

    const scratch = new Map<string, number[]>();
    const stepCmd = (step: Step): string =>
      step.kind === 'session' ||
      step.kind === 'mutating' ||
      step.kind === 'optional' ||
      step.kind === 'broadcast'
        ? step.cmd
        : step.kind === 'read' || step.kind === 'restore'
          ? `${step.kind === 'read' ? '22' : '2E'}${step.did}`
          : step.kind === 'marker'
            ? `2E${step.did}`
            : step.kind === 'exit'
              ? '37'
              : step.kind === 'security'
                ? '2704'
                : 'adapter';
    /** The last challenge answered, and whether its key was acknowledged (any 10 xx voids the grant). */
    let lastSeed: number | undefined;
    let lastKeyAcked = false;
    let keyWentSilent = false;
    /** The session may have lapsed before the next send reaches the module: re-run the sessions first. */
    class SessionStale extends Error {}
    /**
     * One seed → key exchange. `silent`: the key got no answer (it may never have arrived). A seed refused with
     * 7F/22 means the session is gone: {@link SessionStale}.
     */
    const handshake = async (): Promise<'done' | 'silent'> => {
      let seedReply: number[];
      try {
        seedReply = await ladder([0x27, 0x03], { timeoutMs: TIMEOUT.security });
      } catch (e) {
        if (e instanceof UdsExchangeError && (e.nrc === 0x7f || e.nrc === 0x22)) throw new SessionStale();
        throw e;
      }
      const seed = seedReply.slice(2, 6);
      if (seedReply[0] !== 0x67 || seedReply[1] !== 0x03 || seed.length !== 4) {
        note('seed', { detail: 'no seed offered (unexpected answer)', passwordSource });
        throw new NotSent('The control unit did not offer a security seed.', PLAIN.access);
      }
      const seedNum = seed.reduce((v, b) => (v * 256 + b) >>> 0, 0);
      if (seedNum === 0) {
        note('seed', { detail: 'zero seed: already unlocked', passwordSource });
        // Already unlocked. The 3E is a courtesy: its answer, or its absence, changes nothing.
        confirmSession();
        try {
          await exchange([0x3e, 0x00], { locked: true });
        } catch (e) {
          if (!tolerable(e)) throw e;
        }
        return 'done';
      }
      // The same challenge after an ACKNOWLEDGED key: the module still holds that grant — never replay the key.
      if (seedNum === lastSeed && lastKeyAcked) {
        note('key-reused-same-seed', { detail: 'same challenge after an accepted key: key not re-sent' });
        return 'done';
      }
      // The same challenge after an UNACKNOWLEDGED key proves that key never arrived (a module consumes its seed
      // on any delivered key): sending it again is its first delivery (R4).
      note('seed', {
        detail: `challenge received${seedNum === lastSeed ? ', same as the unanswered key' : ''}`,
        passwordSource,
      });
      if (!freshAhead()) throw new SessionStale();
      const key = (seedNum + (Number.parseInt(password ?? '0', 10) >>> 0)) >>> 0;
      lastSeed = seedNum;
      lastKeyAcked = false;
      let keyReply: number[];
      try {
        // At the seed's prompt: a dropped key is never consumed and costs one seed request (see ble-writer).
        keyReply = await exchange(
          [0x27, 0x04, (key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255],
          { timeoutMs: TIMEOUT.security, locked: !keyWentSilent },
        );
      } catch (e) {
        if (e instanceof UdsExchangeError && e.nrc !== undefined) {
          if (unitDefault && (e.nrc === 0x35 || e.nrc === 0x33)) {
            // The vendor never logs in for a recipe without its own code: go on without security access
            // and report the code only if the payload itself is then refused with 33.
            defaultCodeRefused = hex2(e.nrc);
            note('security-refused-unit-default', {
              detail: `NRC ${defaultCodeRefused}; continuing without security access`,
              passwordSource,
            });
            return 'done';
          }
          note('key', { detail: `refused NRC ${hex2(e.nrc)}`, passwordSource });
          throw new NotSent(`The security unlock was refused (code ${hex2(e.nrc)}).`, PLAIN.access);
        }
        if (isSilentAfterSend(e)) {
          keyWentSilent = true; // the next key re-searches
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
    /** The ritual's sessions that come before its security step (re-run when the unlock is redone). */
    const sessionsBeforeSecurity = (): Step[] => {
      const at = compiled.pre.findIndex((s) => s.kind === 'security');
      return compiled.pre.slice(0, at < 0 ? compiled.pre.length : at).filter((s) => s.kind === 'session');
    };
    /**
     * Unlock (R4): a silent key is followed at once by a new seed request inside the same session — the same
     * challenge means the key never arrived and it is sent again. The sessions are re-run only when it could
     * have lapsed.
     */
    const unlock = async (): Promise<void> => {
      if (password === null || defaultCodeRefused) {
        note('seed', {
          detail: defaultCodeRefused
            ? 'skipped: the unit-default code was refused earlier'
            : 'no security code: SecurityAccess skipped',
        });
        return; // no code: the payload's answer says (NRC 33)
      }
      await keepalive();
      for (let h = 0; h < HANDSHAKES_PER_UNLOCK; h++) {
        if (h > 0 && !freshAhead()) for (const st of sessionsBeforeSecurity()) await runStep(st);
        try {
          if ((await handshake()) === 'done') return;
          note('key', { detail: 'no answer to the key: asking for the seed again', passwordSource });
        } catch (e) {
          if (!(e instanceof SessionStale) && !isSilentAfterSend(e)) throw e;
          note('key', {
            detail:
              e instanceof SessionStale
                ? 'session may have lapsed: re-running the sessions for the seed'
                : 'no answer to the seed: asking again',
            passwordSource,
          });
          sessionConfirmedAt = Number.NEGATIVE_INFINITY;
        }
      }
      note('key', { detail: `no unlock after ${HANDSHAKES_PER_UNLOCK} handshakes`, passwordSource });
      throw new NotSent('The control unit did not answer the security unlock.', PLAIN.access);
    };
    let rearms = 0;
    /** Full re-arm: the ritual's sessions (all of them, as declared before the payload), then the unlock. */
    const rearm = async (why: string): Promise<void> => {
      if (++rearms > MAX_REARMS) {
        note('rearm', { detail: `${why}: re-arm budget (${MAX_REARMS}) spent, stopping` });
        throw new NotSent('The coding session kept lapsing, so we stopped.');
      }
      note('rearm', { detail: `${why} (${rearms}/${MAX_REARMS})` });
      for (const step of compiled.pre)
        if (step.kind === 'session' || step.kind === 'security') await runStep(step);
    };
    /** Before a marker or the payload: a session that could lapse before the write reaches the module (R3). */
    const ensureSession = async () => {
      if (freshAhead()) return;
      note('session-stale-rearm', {
        detail: Number.isFinite(sessionConfirmedAt)
          ? `last proven ${Math.round(sessionAge())} ms ago`
          : 'never proven',
      });
      await rearm('stale session');
    };

    const run = async (list: readonly Step[]) => {
      for (const step of list) {
        try {
          await runStep(step);
        } catch (e) {
          // After the payload, whatever stops the sequence is named, with why (a lost or desynchronised link
          // when nothing more specific was recorded).
          if (current() === 'post' && !(e instanceof Partial))
            incomplete ??= {
              step: stepCmd(step),
              reason: e instanceof NotReady ? 'not-ready' : tolerable(e) ? 'no-answer' : 'link-lost',
            };
          throw e;
        }
      }
    };
    const runStep = async (step: Step) => {
      if (phase !== 'post') checkpoint();
      switch (step.kind) {
        case 'adapter':
          break;
        case 'broadcast':
          try {
            await exchange(bytesOf(step.cmd), { header: step.header });
          } catch (e) {
            if (!tolerable(e)) throw e;
          }
          break;
        case 'optional':
          try {
            await exchange(bytesOf(step.cmd));
          } catch (e) {
            if (!tolerable(e)) throw e;
          }
          break;
        case 'session': {
          const cmd = bytesOf(step.cmd);
          await keepalive();
          let r: number[];
          try {
            r = await ladder(cmd);
          } catch (e) {
            const nrc = e instanceof UdsExchangeError ? e.nrc : undefined;
            note('session-open', {
              detail: `${step.cmd} ${nrc !== undefined ? `NRC ${hex2(nrc)}` : tolerable(e) ? 'no answer' : 'link failure'}`,
            });
            if (phase === 'post') {
              incomplete = {
                step: step.cmd,
                reason: nrc !== undefined ? 'refused' : tolerable(e) ? 'no-answer' : 'link-lost',
                ...(nrc !== undefined ? { nrc: hex2(nrc) } : {}),
              };
              throw e;
            }
            if (!tolerable(e)) throw e;
            throw new NotSent(`The control unit refused step ${step.cmd}.`);
          }
          if (!positive(r, cmd, 1)) {
            note('session-open', { detail: `${step.cmd}: unexpected answer` });
            throw new NotSent(`The control unit refused step ${step.cmd}.`);
          }
          if (cmd[0] === 0x10) {
            confirmSession();
            // Any session change voids the security grant: the next challenge always gets its key.
            lastKeyAcked = false;
            if (r.length >= 6) p2star = ((r[4] ?? 0) * 256 + (r[5] ?? 0)) * 10 || p2star;
          }
          note('session-open', { detail: `${step.cmd} answered` });
          break;
        }
        case 'read': {
          try {
            const r = await ladder([0x22, ...bytesOf(step.did)]);
            scratch.set(step.did, r.slice(3));
            note('probe', { did: step.did, detail: `${r.length - 3} bytes` });
          } catch (e) {
            if (!tolerable(e)) throw e;
            note('probe', {
              did: step.did,
              detail: e.nrc !== undefined ? `NRC ${hex2(e.nrc)}` : 'no answer',
            });
            // Its value is written back later: without it the restore cannot happen, so stop now (C4).
            if (step.paired)
              throw new NotSent(
                `The control unit did not return ${step.did}, which this sequence must write back.`,
              );
          }
          break;
        }
        case 'security': {
          await unlock();
          break;
        }
        case 'marker': {
          const probeDid = step.did === 'F198' ? 'F1A5' : 'F199';
          let probe: number[] | null = null;
          let probeNrc: number | undefined;
          try {
            probe = await ladder([0x22, ...bytesOf(probeDid)]);
          } catch (e) {
            if (!tolerable(e)) throw e;
            if (e instanceof UdsExchangeError) probeNrc = e.nrc;
          }
          const got = probe ? probe.slice(3) : [];
          note('probe', {
            did: probeDid,
            detail: probe
              ? `${got.length} bytes`
              : probeNrc !== undefined
                ? `NRC ${hex2(probeNrc)}`
                : 'no answer',
          });
          const data =
            step.did === 'F198'
              ? got.some((b) => b !== 0)
                ? got
                : F198_FALLBACK
              : got.length >= 3
                ? got.slice(0, 3)
                : (() => {
                    const d = (options.today ?? (() => new Date()))();
                    return [bcd(d.getFullYear() % 100), bcd(d.getMonth() + 1), bcd(d.getDate())];
                  })();
          const bytes = [0x2e, ...bytesOf(step.did), ...data];
          // Cosmetic: a refusal or silence is recorded and the ritual goes on (never blocks the payload).
          let sessionRetried = false;
          let rearmed = false;
          for (let attempt = 0; attempt < MARKER_SENDS; attempt++) {
            checkpoint();
            await keepalive();
            // Checked before every send: a silent try costs S3 too. One re-arm per marker, and the payload
            // always keeps one of its own (R3).
            if (!freshAhead()) {
              if (rearmed || rearms >= MAX_REARMS - 1) {
                note('marker-gave-up', { did: step.did, detail: 'session stale and no marker re-arm left' });
                break;
              }
              rearmed = true;
              note('session-stale-rearm', {
                did: step.did,
                detail: `last proven ${Math.round(sessionAge())} ms ago`,
              });
              await rearm('marker');
            }
            const sentAt = clock.now();
            const freshAtSend = sessionConfirmedAt;
            try {
              // Identical bytes: its first tries may follow the last prompt locked.
              const r = await exchange(bytes, {
                timeoutMs: TIMEOUT.marker,
                locked: attempt < 2,
                extra: {
                  onTransmit: () => {
                    phase = phase === 'prepare' ? 'mutating' : phase;
                    setMarker(step.did, 'no-answer'); // on the wire: possibly stored from here on
                  },
                },
              });
              // A reply that is not ours leaves it `no-answer`.
              const ours = positive(r, bytes, 2);
              if (ours) setMarker(step.did, 'acked');
              note('marker', { did: step.did, detail: ours ? 'acked' : 'answer not ours: no-answer' });
              break;
            } catch (e) {
              if (e instanceof UdsExchangeError && e.nrc !== undefined && e.nrc !== 0x78) {
                // A 31 from a session that may have lapsed (or after a marker already got 31) is the live
                // signature of a lost session: re-armed and retried once, and never recorded as "not hosted" (R6).
                const lapsed = (tracksSession && sentAt - freshAtSend > SESSION_FRESH_MS) || marker31;
                const lost = SESSION_LOST_NRCS.has(e.nrc) || (e.nrc === 0x31 && lapsed);
                if (!sessionRetried && lost && !rearmed && rearms < MAX_REARMS - 1) {
                  sessionRetried = true;
                  rearmed = true;
                  note('nrc-session-lost-retry', { did: step.did, detail: `NRC ${hex2(e.nrc)}` });
                  await rearm('marker');
                  continue;
                }
                const notHosted = e.nrc === 0x31 && !lapsed;
                if (e.nrc === 0x31) marker31 = true;
                setMarker(step.did, notHosted ? 'not-hosted' : 'refused');
                note('marker', {
                  did: step.did,
                  detail: `NRC ${hex2(e.nrc)}: ${notHosted ? 'not-hosted' : 'refused'}`,
                });
                break;
              }
              if (!tolerable(e)) throw e;
              // A 78: it is being stored — do not re-send. Silence: the identical bytes may be re-sent at once.
              if (e instanceof UdsExchangeError && e.detail === 'pending') {
                note('marker', { did: step.did, detail: 'pending (78): not re-sent' });
                break;
              }
              note('marker', { did: step.did, detail: `no answer to send ${attempt + 1}/${MARKER_SENDS}` });
              if (attempt === MARKER_SENDS - 1)
                note('marker-gave-up', { did: step.did, detail: `no answer after ${MARKER_SENDS} sends` });
            }
          }
          break;
        }
        case 'restore': {
          const saved = scratch.get(step.did);
          if (!saved) {
            note('step', { did: step.did, detail: 'no read value to write back' });
            throw new NotSent(`There is no read value to write back to ${step.did}.`);
          }
          await mutate([0x2e, ...bytesOf(step.did), ...saved], 2);
          break;
        }
        case 'mutating': {
          const cmd = bytesOf(step.cmd);
          await mutate(cmd, cmd[0] === 0x14 ? 0 : cmd[0] === 0x31 ? 3 : 1);
          if (cmd[0] === 0x11) await clock.sleep(settle);
          break;
        }
        case 'exit': {
          // The last part of the payload: the transfer is complete only when this is acknowledged.
          try {
            const r = await exchange([0x37], {
              timeoutMs: TIMEOUT.exit,
              extra: { pendingListenMs: undefined, onResponsePending: () => options.onPending() },
            });
            if (r[0] !== 0x77) throw new Partial('The control unit did not confirm the end of the transfer.');
          } catch (e) {
            const nrc = e instanceof UdsExchangeError ? e.nrc : undefined;
            note('payload', {
              detail: `exit 37 not confirmed${nrc !== undefined ? ` (NRC ${hex2(nrc)})` : e instanceof Partial ? ' (unexpected answer)' : tolerable(e) ? ' (no answer)' : ' (link failure)'}`,
            });
            if (e instanceof Partial || tolerable(e))
              throw new Partial(
                e instanceof UdsExchangeError && e.nrc !== undefined
                  ? `The control unit refused the end of the transfer (code ${hex2(e.nrc)}).`
                  : 'The control unit did not confirm the end of the transfer.',
              );
            throw e;
          }
          phase = 'post';
          break;
        }
      }
    };

    checkpoint();
    await run(compiled.pre);

    // ---- payload ----
    checkpoint();
    await keepalive();
    const markSent = () => {
      if (phase !== 'payload' && phase !== 'post') {
        phase = 'payload';
        options.onSend?.();
      }
    };
    const onResponsePending = () => {
      if (!pendingSeen) note('pending', { detail: '78 responsePending' });
      pendingSeen = true;
      options.onPending();
    };
    if (spec.write.kind === 'did') {
      const write = spec.write;
      const bytes = [0x2e, ...bytesOf(write.did), ...bytesOf(write.bytes)];
      const intended = write.bytes.toUpperCase();
      const original = options.originalBytes?.toUpperCase();
      const readDid = [0x22, ...bytesOf(write.did)];
      let sends = 0;
      /** Sends that went out complete (a first frame no flow control answered is not one): two at most, as BW. */
      let completeSends = 0;
      let sessionRetried = false;
      /** This send's 78 arrived (the write was delivered and is being committed). */
      let pendingAt: number | undefined;
      /** When the last frame of a send that met silence was handed to the adapter. */
      let silentSince: number | undefined;
      const send = () => {
        note('payload', { did: write.did, detail: `send ${++sends}/${compiled.payloadSends}` });
        return exchange(bytes, {
          timeoutMs: TIMEOUT.payload,
          extra: {
            onTransmit: markSent,
            onResponsePending: () => {
              pendingAt ??= clock.now();
              onResponsePending();
            },
          },
        });
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
       * The module's own memory decides a write without its final answer (R5), as the single-DID writer: each read at
       * the previous one's prompt — no idle wait, so no read needs a re-search (each risks a 4.4 s UNABLE TO CONNECT
       * that lets S3 lapse). After a 78 the pre-write bytes prove nothing until a read that left after
       * 78 + min(P2*, {@link PROOF_WINDOW_MS}); after plain silence, until one that left {@link SILENT_PROOF_MS} after
       * the silent send (a write whose 78 was lost may still be committing). A read refused busy (21/78) is asked again.
       */
      const proof = async (): Promise<string | undefined> => {
        const until =
          pendingAt !== undefined
            ? pendingAt + Math.min(p2star, PROOF_WINDOW_MS)
            : silentSince !== undefined
              ? silentSince + SILENT_PROOF_MS
              : 0;
        for (let i = 1; i <= MAX_PROOF_READS; i++) {
          const askedAt = clock.now();
          let stored: string | undefined;
          let busy = false;
          try {
            const r = await ladder(readDid);
            if (positive(r, readDid, 2)) stored = hexOf(r.slice(3));
          } catch (e) {
            if (!tolerable(e) && !(e instanceof UdsExchangeError && e.detail === 'truncated')) throw e;
            busy =
              e instanceof UdsExchangeError && (e.nrc === 0x21 || e.nrc === 0x78 || e.detail === 'pending');
          }
          note('proof-read', { did: write.did, detail: `${i}: ${busy ? 'busy' : describe(stored)}` });
          if (stored === intended) return stored;
          if (askedAt >= until) return busy ? undefined : stored;
          // Inside the window the old bytes (or a busy answer) are what a module shows until it is done.
          if (!busy && stored !== original) return stored;
        }
        // The commit window never closed on a read: undecided, so no re-send.
        return undefined;
      };
      let r: number[] | undefined;
      for (;;) {
        await keepalive();
        await ensureSession();
        pendingAt = undefined;
        silentSince = undefined;
        r = undefined;
        completeSends++;
        try {
          r = await send();
        } catch (e) {
          if (!tolerable(e)) throw e;
          silentSince = e.txFrames.at(-1)?.at;
          if (e.nrc === 0x33 && defaultCodeRefused) {
            note('nrc', { did: write.did, detail: 'NRC 33 after the unit-default code was refused' });
            return {
              kind: 'nrc',
              code: '33',
              detail: PLAIN.defaultCode,
            };
          }
          if (e.nrc !== undefined && e.nrc !== 0x78) {
            // A refusal stores nothing, so one retry in a re-armed session is safe — and it is the only way to tell
            // a lapsed session from a real "no" (live false "code 31"). Believed only after that retry (R6).
            if (
              !sessionRetried &&
              sends < compiled.payloadSends &&
              (SESSION_LOST_NRCS.has(e.nrc) || e.nrc === 0x31)
            ) {
              sessionRetried = true;
              note('nrc-session-lost-retry', { did: write.did, detail: `NRC ${hex2(e.nrc)}` });
              // A refusal stored nothing: it does not spend one of the complete sends.
              completeSends--;
              await rearm(`payload NRC ${hex2(e.nrc)}`);
              continue;
            }
            note('nrc', {
              did: write.did,
              detail: `NRC ${hex2(e.nrc)}${sessionRetried ? ' (after a re-armed retry)' : ''}`,
            });
            throw e;
          }
          // A multi-frame write whose first frame got no flow control never reached the module as a request.
          if (
            bytes.length > 7 &&
            e.txFrames.length <= 1 &&
            pendingAt === undefined &&
            sends < compiled.payloadSends
          ) {
            note('resend', {
              did: write.did,
              detail: 'no flow control to the first frame: the write never left',
            });
            completeSends--;
            continue;
          }
        }
        note('payload', {
          did: write.did,
          detail: !r
            ? pendingAt !== undefined
              ? 'pending, no final answer'
              : 'no answer'
            : positive(r, bytes, 2)
              ? 'acked (6E)'
              : 'answer not ours',
        });
        if (r && positive(r, bytes, 2)) break;
        // Silent, pending or not ours: the unit's own memory decides (the live clone never forwards a final
        // answer after its prompt, so listening would only let the session lapse).
        const stored = await proof();
        silentSince = undefined;
        if (stored === intended) {
          // Landed: the ritual's steps after the payload still belong to it.
          phase = 'post';
          try {
            await run(compiled.post);
          } catch (e) {
            if (e instanceof Partial) throw e;
          }
          return { kind: 'pending-no-final' };
        }
        if (
          original !== undefined &&
          stored === original &&
          sends < compiled.payloadSends &&
          completeSends < 2
        ) {
          // Provably not stored: one identical re-send, re-armed first only if the session may have lapsed.
          note('resend', { did: write.did, detail: 'proof read shows the pre-write bytes: not stored' });
          continue;
        }
        return pendingSeen ? { kind: 'pending-no-final' } : { kind: 'no-reply' };
      }
      phase = 'post';
    } else {
      const payload = bytesOf(spec.write.bytes);
      const request = bytesOf(compiled.downloadRequest ?? '');
      let index = -1;
      let dl: number[];
      try {
        // The download keeps its own pending listen (untested on the clone; no catalogue recipe downloads).
        dl = await exchange(request, {
          timeoutMs: TIMEOUT.download,
          extra: { pendingListenMs: undefined, onTransmit: () => (index = begin(hexOf(request))) },
        });
      } catch (e) {
        const nrc = e instanceof UdsExchangeError ? e.nrc : undefined;
        if (index >= 0) settleStep(index, nrc !== undefined ? 'refused' : 'no-answer', nrc);
        note('payload', {
          detail: `download request ${nrc !== undefined ? `NRC ${hex2(nrc)}` : tolerable(e) ? 'no answer' : 'link failure'}`,
        });
        if (!tolerable(e)) throw e;
        throw new NotSent(
          nrc !== undefined
            ? `The control unit refused the download request (code ${hex2(nrc)}).`
            : 'The download request got no clear answer, so we stopped.',
        );
      }
      // 74 <lengthFormatIdentifier: high nibble = byte count, low nibble 0> <maxNumberOfBlockLength>
      const count = (dl[1] ?? 0) >> 4;
      const malformed =
        dl[0] !== 0x74 || ((dl[1] ?? 0) & 0x0f) !== 0 || count < 1 || count > 4 || dl.length !== 2 + count;
      const maxLength = malformed ? 0 : dl.slice(2).reduce((v, b) => v * 256 + b, 0);
      settleStep(index, 'acked');
      if (malformed || maxLength < 3 || maxLength > MAX_BLOCK_DATA + 2) {
        note('payload', {
          detail: malformed ? 'download answer malformed' : `unusable block size ${maxLength}`,
        });
        throw new NotSent(
          'The control unit answered the download request with an unusable block size, so we sent no data.',
        );
      }
      const block = maxLength - 2;
      const blocks = Math.ceil(payload.length / block);
      note('payload', { detail: `download accepted: ${blocks} block(s) of up to ${block} bytes` });
      if (tx.frames.length + blocks * (framesFor(block + 2) + 2) + 4 > MAX_TX_FRAMES)
        throw new NotSent(
          'The block size the control unit offered would need more frames than the record can hold.',
        );
      for (let i = 0, counter = 1; i < payload.length; i += block, counter = (counter + 1) & 0xff) {
        if (i > 0) await keepalive();
        const request36 = [0x36, counter, ...payload.slice(i, i + block)];
        let r: number[];
        try {
          r = await exchange(request36, {
            timeoutMs: TIMEOUT.block,
            extra: { pendingListenMs: undefined, onTransmit: markSent, onResponsePending },
          });
        } catch (e) {
          const nrc = e instanceof UdsExchangeError ? e.nrc : undefined;
          note('payload', {
            detail: `block ${i / block + 1}/${blocks} ${nrc !== undefined ? `NRC ${hex2(nrc)}` : tolerable(e) ? 'no answer' : 'link failure'}`,
          });
          if (!tolerable(e)) throw e;
          throw new Partial(
            e instanceof UdsExchangeError && e.nrc !== undefined
              ? `The control unit refused data block ${i / block + 1} of ${blocks} (code ${hex2(e.nrc)}).`
              : `Data block ${i / block + 1} of ${blocks} got no answer.`,
          );
        }
        // Each answer must be for THIS block: the counter echoes what was sent.
        if (r[0] !== 0x76 || r[1] !== counter) {
          note('payload', { detail: `block ${i / block + 1}/${blocks} wrong counter` });
          throw new Partial(`Data block ${i / block + 1} of ${blocks} was answered for a different block.`);
        }
      }
      note('payload', { detail: `all ${blocks} block(s) acknowledged` });
    }

    // ---- after the payload ----
    try {
      await run(compiled.post);
    } catch (e) {
      if (e instanceof Partial) throw e;
      // The payload stands; `incomplete` (set by `run`) says which step stopped and why.
      if (current() === 'post') return { kind: 'acked' };
      throw e;
    }
    return { kind: 'acked' };
  };
  /** The ritual ends with its own session change or reset: no closing 10 01 of ours. */
  const endsItself = compiled.post.some(
    (s) => s.kind === 'session' || (s.kind === 'mutating' && s.cmd.startsWith('11')),
  );
  const withDefaultSession = async (ch: UdsChannel): Promise<DidWrite> => {
    try {
      return await sequence(ch);
    } finally {
      // Back to the default session deterministically (native `02 10 01`), best effort.
      if (!endsItself && !link.session.isClosed && !options.signal?.aborted) {
        try {
          // One send, at the prompt when it can be (B12): its answer, or its absence, changes nothing.
          if (ch.target !== module.request) await ch.retarget(module.request, module.response);
          await ch.exchange([0x10, 0x01], { timeoutMs: TIMEOUT.step, pendingListenMs: 0, ...tx.exchange() });
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
          target: module.request,
          responseId: module.response,
          timing: CODING_TIMING,
          padding: 'native',
          ...(options.frameMode ? { frameMode: options.frameMode } : {}),
        },
        withDefaultSession,
      ),
    );
  } catch (e) {
    // After an acknowledged payload, only `incomplete` can change: the acknowledgement is never erased.
    if (current() === 'post') {
      incomplete ??= { step: 'adapter', reason: 'link-lost' };
      return done({ kind: 'acked' });
    }
    if (e instanceof Partial) {
      note('stopped', { detail: e.message });
      return done({ kind: 'partial', detail: PLAIN.partial });
    }
    if (current() === 'payload') {
      if (link.session.isClosed || (e instanceof UdsExchangeError && !tolerable(e)))
        return done({ kind: 'link-lost' });
      if (e instanceof UdsExchangeError && e.nrc !== undefined && e.nrc !== 0x78)
        return done({ kind: 'nrc', code: hex2(e.nrc) });
      return done(pendingSeen ? { kind: 'pending-no-final' } : { kind: 'no-reply' });
    }
    // Nothing of the payload left. Earlier mutations are reported through `steps` and `markers`.
    if (e instanceof Cancelled || options.signal?.aborted) return done({ kind: 'cancelled' });
    if (e instanceof NotReady)
      return done({
        kind: 'not-sent',
        reason: 'not-ready',
        detail: PLAIN.notReady,
      });
    if (link.session.isClosed || (e instanceof UdsExchangeError && e.failure === 'closed'))
      return done({ kind: 'link-lost' });
    if (e instanceof NotSent) {
      note('stopped', { detail: e.message });
      return done({ kind: 'not-sent', detail: e.plain });
    }
    if (e instanceof UdsExchangeError && e.nrc !== undefined) {
      note('stopped', { detail: `preparation step refused, NRC ${hex2(e.nrc)}` });
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
}
