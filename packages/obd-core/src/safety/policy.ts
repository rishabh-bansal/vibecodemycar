/**
 * OBDCraft send policy: reads are allowed; writes need a narrowly scoped guarded path. Default deny:
 * a service that is not on the read list is refused.
 *
 *  - generic OBD-II: 01, 02, 03, 06, 07, 09, 0A; 05 only on non-CAN protocols; 08 only "0800"
 *  - manufacturer / UDS / KWP reads: 12, 13, 17, 18, 19, 1A, 21, 22, 23, 24, A8 (Subaru SSM block read)
 *  - link management a read session needs: 10 (default / extended / dataset-declared sessions, never programming),
 *    3E tester present, 81 start and 82 stop communication
 *  - 04 only with a single-use token from the guarded clear-codes flow
 *  - 2E only with a short-lived, exact-command/physical-target permit from the coding workflow
 *  - refused with a reason: 2E, 31, 27, 34-38, 3B, 3D, 2F, 30, 14, 11, 28, 83, 85-87 and every other service
 *  - adapter commands: the allowlist below (no EEPROM writes, except the CAN filler byte `ATPP26` set to its default
 *    00 and switched on/off, which the `trim-zero` frame mode needs)
 *  - STN `STPX`: only as a carrier of one physical request, which is checked as if sent on its own (same permit)
 *  - while a read-only scan holds the policy ({@link SafetyPolicy.enterReadOnly}): only `22` reads of one
 *    identifier, `3E` tester present and `10 01` / `10 03` sessions; no permit or clear token is issued or honoured
 *  - while a health snapshot holds the policy ({@link SafetyPolicy.enterHealthReadOnly}): only the OBD-II reads
 *    01, 02, 03, 05, 06, 07, 0800, 09 and 0A, the fault-memory reads `19 01/02/03/04/06/0A`, `22` reads of one
 *    identifier, `3E` and `10 01` / `10 03`; still subject to the rules above (05 only off CAN, 08 only 0800); no
 *    permit or clear token is issued or honoured
 */
export class PolicyError extends Error {
  readonly command: string;

  constructor(message: string, command: string) {
    super(message);
    this.command = command;
    this.name = 'PolicyError';
  }
}

const AT_ALLOWED: RegExp[] = [
  /^ATZ$/, /^ATWS$/, /^ATD$/, /^ATI$/, /^AT@1$/, /^AT@2$/, /^ATRV$/, /^ATCS$/, /^ATIGN$/,
  /^ATE[01]$/, /^ATL[01]$/, /^ATS[01]$/, /^ATH[01]$/, /^ATM[01]$/, /^ATD[01]$/, /^ATR[01]$/, /^ATCAF[01]$/, /^ATCFC[01]$/,
  /^ATAL$/, /^ATNL$/, /^ATAR$/, /^ATPC$/, /^ATDPN?$/,
  /^ATSPA?[0-9A-C]$/, /^ATTPA?[0-9A-C]$/,
  /^ATAT[0-2]$/, /^ATST[0-9A-F]{2}$/,
  /^ATSH[0-9A-F]{3}$/, /^ATSH[0-9A-F]{6}$/, /^ATSH[0-9A-F]{8}$/,
  /^ATCRA$/, /^ATCRA[0-9A-F]{3}$/, /^ATCRA[0-9A-F]{8}$/,
  /^ATFCSH[0-9A-F]{3}$/, /^ATFCSH[0-9A-F]{8}$/, /^ATFCSD[0-9A-F]{2,10}$/, /^ATFCSM[01]$/,
  /^ATSI$/, /^ATFI$/, /^ATKW[01]$/, /^ATIB(10|48|96)$/, /^ATSW[0-9A-F]{2}$/,
  // Programmable-parameter summary (read-only) and the CAN filler byte (PP 26), only ever at its default 00.
  /^ATPPS$/, /^ATPP26SV00$/, /^ATPP26(ON|OFF)$/,
];

/** STN-chip identity queries (chip id, device name). Adapter-only, nothing reaches the car. */
const ST_IDENTITY: RegExp[] = [/^STI$/, /^STDI$/];
/** STN CAN segmentation on/off for transmit (T) and receive (R): adapter settings, nothing reaches the car. */
const ST_SETTINGS: RegExp[] = [/^STCSEG[TR][01]$/];
/** `STPX h:<11-bit header>,d:<PDU>,r:<1-9>`, whitespace removed and upper-cased. */
const STPX = /^STPXH:([0-7][0-9A-F]{2}),D:((?:[0-9A-F]{2})+),R:[1-9]$/;

/** Read services beyond generic OBD-II. */
export const READ_SERVICES: ReadonlySet<number> = new Set([0x12, 0x13, 0x17, 0x18, 0x19, 0x1a, 0x21, 0x22, 0x23, 0x24, 0xa8]);

/** Why a service is refused, for the ones people expect to work. */
export const WRITE_SERVICES: Readonly<Record<number, string>> = {
  0x11: 'ECU reset', 0x14: 'clears fault memory', 0x27: 'security access (unlocking an ECU for writes)', 0x28: 'communication control',
  0x2e: 'writes data to the ECU', 0x2f: 'drives outputs / actuators', 0x30: 'drives outputs / actuators',
  0x31: 'starts ECU routines', 0x34: 'starts a download (flashing)', 0x35: 'starts an upload', 0x36: 'transfers flash data',
  0x37: 'ends a transfer', 0x38: 'file transfer', 0x3b: 'writes data to the ECU', 0x3d: 'writes ECU memory',
  0x83: 'sets timing parameters', 0x85: 'switches fault logging off', 0x86: 'arms events', 0x87: 'changes the link',
};

/** Diagnostic sessions: default, extended, and the KWP standard mode. Programming / adjustment sessions are never allowed. */
export const DEFAULT_SESSIONS: ReadonlySet<string> = new Set(['01', '03', '81', '83']);
export const BANNED_SESSIONS: ReadonlySet<string> = new Set(['02', '82', '85', '86', '87']);

/** What a read-only scan may send to a module: one-identifier reads, tester present, default/extended session. */
const READ_ONLY_REQUEST = /^(22[0-9A-F]{4}|3E(00|80)|10(01|03))$/;

/**
 * What a read-only health snapshot may send: generic OBD-II reads (01 with up to six PIDs, 02 PID+frame pairs, 03, 05,
 * 06, 07, 08 only as the 0800 list, 09, 0A), UDS ReadDTCInformation 19 with sub-functions 01 (count by status mask),
 * 02 (list by status mask), 03 (snapshot identification), 04 (snapshot record of one DTC), 06 (extended data of one
 * DTC) and 0A (supported DTCs), plus what a scan may send. Never 04, 14, 2E, 2F, 31, 27, 11, 28, 85 or 10 02.
 */
const HEALTH_REQUEST =
  /^(01(?:[0-9A-F]{2}){1,6}|02(?:[0-9A-F]{4}){1,3}|03|07|0A|05[0-9A-F]{4}|06[0-9A-F]{2}|0800|09[0-9A-F]{2}|19(?:01[0-9A-F]{2}|02[0-9A-F]{2}|03|04[0-9A-F]{8}|06[0-9A-F]{8}|0A)|22[0-9A-F]{4}|3E(?:00|80)|10(?:01|03))$/;

export interface PolicyState {
  family: 'can11' | 'can29' | 'legacy' | 'unknown';
  target?: string;
}

export interface CodingPermitSpec {
  /** Exact commands allowed once each, e.g. the computed `2E <did> <bytes>` write. */
  writes?: readonly string[];
  /**
   * Extra transmissions allowed per exact write (max 3 → at most four sends of the identical
   * bytes). The writer spends them only on a send the ECU provably did not store: a refusal
   * answered in a lapsed session (re-armed, retried once), or a proof read that still shows the
   * pre-write bytes. It is a bound, not permission to re-send blindly.
   */
  writeRetries?: number;
  /** Command prefixes allowed once each — only for bounded echo writes whose data
   *  depends on a live read (VAG `2EF199<date>` / `2EF198<sequence>` markers). */
  writePrefixes?: readonly string[];
  /**
   * Extra transmissions allowed per write prefix (max 4 → at most five sends of one marker).
   * A marker re-send always carries the identical payload — writing the same date or the same
   * sequence bytes again is idempotent — so the bound exists only to absorb silent answers
   * (live 2026-10-29: single no-answers cost whole write sessions).
   */
  writePrefixRetries?: number;
  /**
   * Exact non-`2E`/`27` commands allowed once per listing (list one twice to allow two sends) — dataset rituals need bounded
   * access to otherwise refused services (`10<declared>`, `11`, `14`, `31`).
   * Anything not listed byte-for-byte is still refused.
   */
  commands?: readonly string[];
  /**
   * One download bound to its exact payload: the `34` request once, then `36` TransferData requests that
   * carry the payload IN ORDER — each with the next block counter (from 1, wrapping FF → 00) and the next
   * bytes of `payload`, at most `maxBlock` data bytes — and finally one `37`, only after the last byte.
   * Out-of-order, repeated, altered or extra transfers are refused.
   */
  download?: { request: string; payload: string; maxBlock: number };
  /**
   * Permit bounded `2703` seed requests (the challenge read is idempotent — a re-sent request
   * only produces a new seed, and the key is computed from whichever reply returns) and bounded
   * `2704<8-hex>` key replies, enough for the initial unlock, a silent-key redo and the re-arms
   * that a lapsed session needs before the markers, the payload and a proved-safe re-send.
   */
  securityAccess?: boolean;
  /**
   * How many `2703` seed requests and `2704` keys the writer's own bounds can send (it derives them from its
   * retry and re-arm limits, so the two cannot drift). Default {seed: 8, key: 6}; capped at {seed: 64, key: 16}.
   */
  securityBudget?: { seed: number; key: number };
  /** Permit lifetime; the coding sequence runs several exchanges. Default 20 s; writers pass their worst case. */
  ttlMs?: number;
}

interface CodingPermit {
  target: string;
  /** Exact write → transmissions still allowed. */
  writes: Map<string, number>;
  writePrefixes: string[];
  /** Prefix → transmissions still allowed (re-sends carry identical bytes). */
  prefixSends: Map<string, number>;
  /** Command → transmissions still allowed. */
  commands: Map<string, number>;
  download: { request: string; payload: string; maxBlock: number; started: boolean; offset: number; counter: number; exited: boolean } | null;
  securityAccess: { seed: number; key: number } | null;
  expiresAt: number;
}

export class SafetyPolicy {
  private clearTokens = new Set<string>();
  private codingTokens = new Map<string, CodingPermit>();
  private tokenSeq = 0;
  readonly refused: { at: number; command: string; reason: string }[] = [];

  private readonly sessions = new Set<string>();
  private readonly now: () => number;
  /** Read-only scans holding this policy; while any does, nothing but {@link READ_ONLY_REQUEST} reaches a module. */
  private readOnlyHolds = 0;
  /** Health snapshots holding this policy; while any does, nothing but {@link HEALTH_REQUEST} reaches a module. */
  private healthHolds = 0;

  constructor(now: () => number = Date.now) { this.now = now; }

  /** Refusals are kept for diagnostics: stamped on the policy's own clock, and bounded. */
  private noteRefusal(command: string, reason: string): void {
    this.refused.push({ at: this.now(), command, reason });
    if (this.refused.length > 200) this.refused.splice(0, this.refused.length - 200);
  }

  /**
   * Session sub-functions the dataset declares for the module being read (a diagnostic system's `sess`, a profile
   * script's own "10xx"). Programming and adjustment sessions are ignored even if declared.
   */
  declareSessions(subs: Iterable<string>): void {
    for (const raw of subs) {
      const x = raw.toUpperCase();
      if (/^[0-9A-F]{2}$/.test(x) && !BANNED_SESSIONS.has(x)) this.sessions.add(x);
    }
  }

  /**
   * Locks the policy to read-only requests until the returned release is called (idempotent). Holds nest: the
   * policy stays locked while any holder remains. While locked, permits and clear tokens are neither issued
   * nor honoured.
   */
  enterReadOnly(): () => void {
    this.readOnlyHolds += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.readOnlyHolds -= 1;
    };
  }

  get readOnly(): boolean {
    return this.readOnlyHolds > 0;
  }

  /**
   * Locks the policy to the health snapshot's reads ({@link HEALTH_REQUEST}) until the returned release is called
   * (idempotent). Holds nest like {@link enterReadOnly}; while locked, permits and clear tokens are neither issued nor
   * honoured, so not even the guarded clear flow can send 04.
   */
  enterHealthReadOnly(): () => void {
    this.healthHolds += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.healthHolds -= 1;
    };
  }

  get healthReadOnly(): boolean {
    return this.healthHolds > 0;
  }

  private refuseWhileReadOnly(what: string): void {
    if (this.readOnlyHolds > 0) throw new PolicyError(`A read-only scan is in progress: no ${what} is issued.`, what);
    if (this.healthHolds > 0) throw new PolicyError(`A read-only health snapshot is in progress: no ${what} is issued.`, what);
  }

  /** Issued only by the guarded clear flow after its checks pass; valid for one "04". */
  issueClearToken(): string {
    this.refuseWhileReadOnly('clear token');
    const t = `clear-${++this.tokenSeq}-${Math.random().toString(36).slice(2)}`;
    this.clearTokens.add(t);
    return t;
  }

  /** The coding workflow issues this only after identity, parked/voltage, read-before-write and durable-backup checks. */
  issueCodingToken(command: string, target: string): string {
    return this.issueCodingPermit(target, { writes: [command], ttlMs: 5000 });
  }

  /**
   * A short-lived permit covering one bounded coding sequence on one physical target:
   * the exact write command(s), optional VAG marker echo writes (`2EF199`/`2EF198` prefixes)
   * and optionally one security-access seed/key pair. Every entry is consumed on use.
   */
  issueCodingPermit(target: string, spec: CodingPermitSpec): string {
    this.refuseWhileReadOnly('coding permit');
    if (!/^[0-7][0-9A-F]{2}$/.test(target) || target === '7DF') {
      throw new PolicyError('Coding permits require a physical CAN address.', target);
    }
    const writes = new Map<string, number>();
    for (const command of spec.writes ?? []) {
      if (!/^2E[0-9A-F]{4}(?:[0-9A-F]{2}){1,4092}$/.test(command)) {
        throw new PolicyError('Coding permits require an exact UDS data write of at most 4095 bytes.', command);
      }
      writes.set(command, 1 + Math.min(3, Math.max(0, spec.writeRetries ?? 0)));
    }
    const writePrefixes = [...(spec.writePrefixes ?? [])];
    for (const prefix of writePrefixes) {
      if (!/^2E[0-9A-F]{4}$/.test(prefix)) throw new PolicyError('Coding write prefixes must be an exact service and identifier.', prefix);
    }
    const commands = new Map<string, number>();
    for (const raw of spec.commands ?? []) {
      const c = raw.toUpperCase();
      // Bounded ritual steps only: session control, reset, DTC clear, routine control,
      // request-download and transfer-exit. Reads and tester-present never need a permit;
      // 2E/27 stay on the writes/security mechanisms; flashing primitives 35/38 stay banned.
      if (!/^(10[0-9A-F]{2}|11[0-9A-F]{2}|14[0-9A-F]{6}|31[0-9A-F]{4}(?:[0-9A-F]{2})*)$/.test(c)) {
        throw new PolicyError('Sequence commands must be a session, reset, DTC-clear or routine request.', raw);
      }
      // A permit never opens a programming or adjustment session, whatever a recipe declares.
      if (c.startsWith('10') && BANNED_SESSIONS.has(c.slice(2, 4))) {
        throw new PolicyError(`Session ${c.slice(2, 4)} is a programming or adjustment session.`, raw);
      }
      commands.set(c, (commands.get(c) ?? 0) + 1);
    }
    let download: CodingPermit['download'] = null;
    if (spec.download) {
      const { request, payload, maxBlock } = spec.download;
      if (!/^3400[1-4][1-4](?:[0-9A-F]{2}){2,8}$/.test(request)) throw new PolicyError('A download permit needs an exact 34 request.', request);
      if (!/^(?:[0-9A-F]{2}){1,65536}$/.test(payload)) throw new PolicyError('A download permit needs its exact payload.', target);
      if (!Number.isInteger(maxBlock) || maxBlock < 1 || maxBlock > 4093) throw new PolicyError('A download block bound must fit one request.', target);
      download = { request, payload, maxBlock, started: false, offset: 0, counter: 1, exited: false };
    }
    if (!writes.size && !writePrefixes.length && !commands.size && !download && !spec.securityAccess) {
      throw new PolicyError('A coding permit must cover at least one bounded operation.', target);
    }
    const now = this.now();
    for (const [token, permit] of this.codingTokens) if (permit.expiresAt < now) this.codingTokens.delete(token);
    const token = `coding-${++this.tokenSeq}-${Math.random().toString(36).slice(2)}`;
    this.codingTokens.set(token, {
      target, writes, writePrefixes,
      prefixSends: new Map(
        writePrefixes.map((p) => [
          p,
          1 + Math.min(4, Math.max(0, spec.writePrefixRetries ?? 0)),
        ]),
      ),
      commands, download,
      // Default key budget 6 / seeds 8; a writer passes its own worst case (`securityBudget`): every
      // unlock it may run times its seed retries and silent-key redos. A re-sent seed request only
      // produces a new challenge.
      securityAccess: spec.securityAccess
        ? {
            seed: Math.min(64, Math.max(1, Math.floor(spec.securityBudget?.seed ?? 8))),
            key: Math.min(16, Math.max(1, Math.floor(spec.securityBudget?.key ?? 6))),
          }
        : null,
      expiresAt: now + (spec.ttlMs ?? 20000),
    });
    return token;
  }

  private checkPermit(c: string, svc: number, state: PolicyState, codingToken: string): void {
    const refuse = (reason: string): never => {
      this.noteRefusal(c, reason);
      throw new PolicyError(`${c}: ${reason}`, c);
    };
    const permit = this.codingTokens.get(codingToken);
    const usable = !!permit && permit.target === state.target && state.family === 'can11' && this.now() <= permit.expiresAt;
    if (usable && svc === 0x2e) {
      const left = permit.writes.get(c) ?? 0;
      if (left > 0) { permit.writes.set(c, left - 1); return; }
      const prefix = permit.writePrefixes.find(p => c.startsWith(p) && (permit.prefixSends.get(p) ?? 0) > 0 && c.length >= p.length + 2 && c.length <= p.length + 64);
      if (prefix) { permit.prefixSends.set(prefix, (permit.prefixSends.get(prefix) ?? 1) - 1); return; }
    }
    if (usable && svc === 0x27 && permit!.securityAccess) {
      if (c === '2703' && permit!.securityAccess.seed > 0) { permit!.securityAccess.seed -= 1; return; }
      if (/^2704[0-9A-F]{8}$/.test(c) && permit!.securityAccess.key > 0) { permit!.securityAccess.key -= 1; return; }
    }
    this.codingTokens.delete(codingToken);
    refuse(usable ? 'coding permit does not cover this command' : 'coding permit does not match this command, module or connection');
  }

  /** Throws PolicyError when the command must not be sent. */
  check(command: string, state: PolicyState, clearToken?: string, codingToken?: string): void {
    const c = command.replace(/\s+/g, '').toUpperCase();
    const refuse = (reason: string): never => {
      this.noteRefusal(c, reason);
      throw new PolicyError(`${c}: ${reason}`, c);
    };
    if (c.startsWith('AT')) {
      if (!AT_ALLOWED.some((r) => r.test(c))) refuse('adapter command not on the allowlist');
      return;
    }
    if (ST_IDENTITY.some((r) => r.test(c)) || ST_SETTINGS.some((r) => r.test(c))) return;
    if (c.startsWith('STPX')) {
      // The carrier must address the module the state names, and its PDU passes the same rules (and spends the same
      // permit) as that PDU sent on its own: STPX can never reach what the plain request could not.
      const m = STPX.exec(c);
      if (!m) refuse('STPX must carry one physical request: h:<header>,d:<bytes>,r:<count>');
      if (!state.target || m![1] !== state.target.toUpperCase()) refuse('STPX header differs from the addressed module');
      return this.check(m![2]!, state, clearToken, codingToken);
    }
    if (!/^[0-9A-F]+$/.test(c) || c.length < 2) refuse('not a hex OBD request');
    // a trailing single hex digit can be the ELM response-count digit
    const body = c.length % 2 === 1 ? c.slice(0, -1) : c;
    const svc = parseInt(body.slice(0, 2), 16);
    if (this.readOnlyHolds > 0) {
      if (!READ_ONLY_REQUEST.test(body)) refuse('a read-only scan sends only 22 reads, 3E tester present and 10 01 / 10 03 sessions');
      return;
    }
    if (this.healthHolds > 0) {
      if (clearToken || codingToken) refuse('a read-only health snapshot honours no clear token or coding permit');
      if (!HEALTH_REQUEST.test(body)) {
        refuse('a read-only health snapshot sends only OBD-II reads (01 02 03 05 06 07 0800 09 0A), 19 01/02/03/04/06/0A, 22 reads, 3E and 10 01 / 10 03');
      }
      // Then the ordinary rules below as well (05 only off CAN, 08 only 0800).
    }
    if (codingToken) {
      if (svc === 0x2e || svc === 0x27) return this.checkPermit(c, svc, state, codingToken);
      // A declared-sequence permit may cover individual ritual commands (sessions beyond the
      // default set, routines, download control). Each is consumed on use; anything else falls
      // through to the normal rules — reads and tester-present never consume the permit.
      const permit = this.codingTokens.get(codingToken);
      const usable = !!permit && permit.target === state.target && state.family === 'can11' && this.now() <= permit.expiresAt;
      if (usable) {
        const left = permit!.commands.get(c) ?? 0;
        if (left > 0) {
          permit!.commands.set(c, left - 1);
          return;
        }
        const d = permit!.download;
        if (d && (svc === 0x34 || svc === 0x36 || svc === 0x37)) {
          if (svc === 0x34 && !d.started && c === d.request) { d.started = true; return; }
          if (svc === 0x36 && d.started && !d.exited && c.length >= 6 && c.length % 2 === 0) {
            const counter = parseInt(c.slice(2, 4), 16);
            const data = c.slice(4);
            const next = d.payload.slice(d.offset * 2, d.offset * 2 + data.length);
            if (counter === d.counter && data.length / 2 <= d.maxBlock && data === next) {
              d.offset += data.length / 2;
              d.counter = (d.counter + 1) & 0xff;
              return;
            }
          }
          if (svc === 0x37 && c === '37' && d.started && !d.exited && d.offset * 2 === d.payload.length) { d.exited = true; return; }
          this.codingTokens.delete(codingToken);
          refuse('the download permit does not cover this transfer (order, counter, bytes or size)');
        }
      }
    }
    switch (svc) {
      case 0x01: case 0x02: case 0x03: case 0x06: case 0x07: case 0x09: case 0x0a:
        return;
      case 0x05:
        if (state.family === 'legacy' || state.family === 'unknown') return;
        return refuse('service 05 is only defined for non-CAN protocols (CAN cars report it in service 06)');
      case 0x08:
        if (body === '0800') return;
        return refuse('service 08 is limited to the 0800 "which tests exist" query; tests are never run');
      case 0x04:
        if (body !== '04') return refuse('malformed service 04 request');
        if (!clearToken || !this.clearTokens.delete(clearToken)) {
          return refuse('service 04 (clear codes) needs the guarded confirmation flow');
        }
        return;
      case 0x10: {
        const sub = body.slice(2, 4);
        if (body.length !== 4) return refuse('diagnostic session control takes one sub-function byte');
        if (BANNED_SESSIONS.has(sub)) return refuse(`session ${sub} is a programming or adjustment session`);
        if (DEFAULT_SESSIONS.has(sub) || this.sessions.has(sub)) return;
        return refuse(`session ${sub} is neither a default / extended session nor one the dataset declares for this module`);
      }
      case 0x3e:
        return; // tester present: keeps a read session alive
      case 0x81: case 0x82:
        if (body.length === 2) return; // start / stop communication on K-line
        return refuse(`service ${body.slice(0, 2)} takes no parameters here`);
      default: {
        if (READ_SERVICES.has(svc)) return;
        const hex = body.slice(0, 2);
        const why = WRITE_SERVICES[svc];
        return refuse(why ? `service ${hex} ${why}; Vibecode my car only reads` : `service ${hex} is not on the read list`);
      }
    }
  }
}
