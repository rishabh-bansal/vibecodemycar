import { exchangeUds, withUdsChannel, UdsExchangeError, toHex, type OBDCraftEngine } from '@obdcraft/obd-core';

export interface ModuleIdentity {
  at: number; target: string; responseId: string; deviceId: string;
  part: string | null; softwareNumber: string | null; software: string | null; hardware: string | null; odxFile: string | null; odxVersion: string | null; notes: string[];
}

/** An explicitly addressed identity read. It does not enter a privileged session, unlock a gateway or write a setting. */
export async function probeModule(engine: OBDCraftEngine, target: string, responseId: string): Promise<ModuleIdentity> {
  target = target.trim().toUpperCase(); responseId = responseId.trim().toUpperCase();
  if (!/^[0-7][0-9A-F]{2}$/.test(target) || target === '7DF' || !/^[0-7][0-9A-F]{2}$/.test(responseId)) throw new Error('Enter physical 11-bit request and response CAN IDs from the module map.');
  const { link, runner, transport } = engine;
  if (!link || !runner || !transport?.isOpen || link.protocol.family !== 'can11') throw new Error('Connect a CAN 11-bit adapter first.');
  await engine.stopLive();
  const result: ModuleIdentity = { at: Date.now(), target, responseId, deviceId: transport.id, part: null, softwareNumber: null, software: null, hardware: null, odxFile: null, odxVersion: null, notes: [] };
  try {
    const changed = await link.apply({ target, spaces: true, headers: true });
    if (changed.failed.length || link.config.target !== target) throw new Error('The adapter could not address this module.');
    // F1A2 is VAG-specific: retain the complete reported ODX version, distinct from ECU firmware F189.
    // Unsupported identifiers remain null, with the actual response recorded in notes.
    for (const [field, did] of [['part', 0xf187], ['softwareNumber', 0xf188], ['software', 0xf189], ['hardware', 0xf191], ['odxFile', 0xf19e], ['odxVersion', 0xf1a2]] as const) {
      try {
        const reply = await exchangeUds(link, [0x22, did >> 8, did & 255], { target, responseId, timeoutMs: 8000, padding: 'native' });
        const bytes = reply.response.slice(3);
        const text = String.fromCharCode(...bytes).replace(/\0/g, '').trim();
        result[field] = /^[\x20-\x7e]+$/.test(text) ? text : toHex(bytes, '');
      } catch (error) {
        if (engine.session?.isClosed || !(error instanceof UdsExchangeError)) throw error;
        // A refusal, a silent DID, an unresolved response-pending or a truncated reply: note it, read the next one.
        if (error.nrc) result.notes.push(`${field}: negative response ${error.nrc.toString(16).toUpperCase()}`);
        else if (error.failure === 'timeout' || error.detail) result.notes.push(`${field}: no complete answer`);
        else throw error;
      }
    }
    return result;
  } finally { await link.apply({ target: 'functional' }).catch(() => {}); }
}

/** Read one data identifier on an explicitly addressed module. Used to collect the blocks a candidate binds against. */
export async function readModuleDid(engine: OBDCraftEngine, target: string, responseId: string, did: number, timeoutMs = 15000): Promise<number[]> {
  return withModuleReads(engine, target, responseId, read => read(target, responseId, did), timeoutMs);
}

export type ModuleRead = (target: string, responseId: string, did: number) => Promise<number[]>;

/** Per-request options of a {@link ModuleRequest}: how long to listen after the adapter's prompt (see UdsRequestOptions). */
export interface ModuleRequestOptions {
  pendingListenMs?: number;
  /** Keep listening this long after a 78 response-pending by polling with a silent tester present (see UdsRequestOptions). */
  pendingPollMs?: number;
}

/** One request of a read group: the PDU (service byte first) to an addressed module; resolves to the whole positive answer. */
export type ModuleRequest = (target: string, responseId: string, pdu: readonly number[], opts?: ModuleRequestOptions) => Promise<number[]>;

/**
 * Consecutive UNABLE TO CONNECT answers before a module counts as not fitted for the rest of a read group. A fitted
 * module's search is lost ~9 % of the time, then ~36 % again right after, and about a quarter of the lost ones end
 * UNABLE (2026-11-02 analysis), so two in a row would still strike a fitted module ~0.2 % of the time (the VIN
 * module included), three ~0.02 %. An unfitted module costs one more ~4.4 s search.
 */
const UNABLE_BEFORE_UNFITTED = 3;

/**
 * A bounded caller-owned group of 22 reads. One adapter setup/restore, a native rebind before every
 * read, and one command-queue owner throughout. No session/security/write primitive is exposed.
 * Every answer that leaves the adapter at a normal prompt is reported to the caller and the group
 * goes on: an NRC, a finished NO DATA, a failed protocol search (UNABLE TO CONNECT), a response-pending
 * whose final answer never came, and a multi-frame reply that arrived truncated. Only an uncertain
 * transport stops the group.
 *
 * A module whose reads ended in completed UNABLE TO CONNECTs is treated as not fitted for the rest of
 * the group: its later reads fail at once with the same answer instead of each running its own ~4–7 s
 * protocol search (live 2026-10-30: units 06, 36 and 42 cost 53 s each, eight searches apiece).
 */
export async function withModuleReads<T>(
  engine: OBDCraftEngine, target: string, responseId: string,
  work: (read: ModuleRead) => Promise<T>, timeoutMs = 15000,
): Promise<T> {
  return withModuleRequests(engine, target, responseId, send => work(async (request, response, did) => {
    if (!Number.isInteger(did) || did < 0 || did > 0xffff) throw new Error('Invalid data identifier.');
    return (await send(request, response, [0x22, did >> 8, did & 255])).slice(3);
  }), timeoutMs);
}

/**
 * {@link withModuleReads} for any request the caller hands over: the same group discipline (one adapter setup, a
 * native rebind before every request, unfitted modules remembered, a known-state answer reported and the group
 * going on), with the PDU chosen by the caller. It adds no permission of its own: every PDU still passes the link's
 * send policy, and a caller that must stay read-only checks each PDU before it hands it over (the health snapshot
 * does, and locks the policy to its reads as well).
 */
export async function withModuleRequests<T>(
  engine: OBDCraftEngine, target: string, responseId: string,
  work: (send: ModuleRequest) => Promise<T>, timeoutMs = 15000,
): Promise<T> {
  const { link } = engine;
  if (!link || link.session.isClosed) throw new Error('Not connected to an adapter.');
  await engine.stopLive(); // nothing else may share the bus while a module is addressed
  if (link.config.target !== target) {
    const changed = await link.apply({ target, spaces: true, headers: true });
    if (changed.failed.length || link.config.target !== target) throw new Error('The adapter could not address this module.');
  }
  return withUdsChannel(link, { target, responseId, padding: 'native' }, async channel => {
    let active = true;
    const unreachable = new Map<string, UdsExchangeError>();
    /**
     * With ATSP0 on every read an ordinary silent read also comes back UNABLE TO CONNECT, so one such
     * answer proves nothing: a request is skipped only after {@link UNABLE_BEFORE_UNFITTED} in a row and only
     * when none of its reads succeeded in this group. Any successful read clears it.
     */
    const succeeded = new Set<string>();
    const unableCount = new Map<string, number>();
    /** The module whose read just ended in a completed NO DATA, with nothing sent since. */
    let emptyJustNow: string | undefined;
    try {
      return await work(async (request, response, pdu, opts = {}) => {
        if (!active) throw new Error('The read group has ended.');
        if (!pdu.length || pdu.some(b => !Number.isInteger(b) || b < 0 || b > 0xff)) throw new Error('Invalid diagnostic request.');
        let reading = false;
        const absent = unreachable.get(request.toUpperCase());
        if (absent) {
          throw new UdsExchangeError(absent.message, false, absent.replies, undefined, 'adapter');
        }
        try {
          // Every read re-binds, including the ATSP0 re-search — as the native rebind did on each
          // module switch. The clone's response window once the protocol is locked is ~250 ms
          // (ATST is ignored), but this BCM's slowest reads need ~270-430 ms (live 2026-10-28:
          // F190 answered with a search, went silent without it). The re-search is what gives a
          // slow module time to answer.
          // Except a retry at once after a completed NO DATA from the same module: the clone lost a search
          // right after a silent one 36 % of the time, an immediate send at the prompt ~20 % (7/37 live after
          // a silent locked send). The channel still re-searches it after any idle or AT command.
          const key = request.toUpperCase();
          const retryAtPrompt = emptyJustNow === key;
          emptyJustNow = undefined;
          if (!retryAtPrompt) await channel.retarget(request, response);
          reading = true;
          const reply = await channel.exchange(pdu, {
            timeoutMs,
            ...(opts.pendingListenMs !== undefined ? { pendingListenMs: opts.pendingListenMs } : {}),
            ...(opts.pendingPollMs !== undefined ? { pendingPollMs: opts.pendingPollMs } : {}),
          });
          succeeded.add(key);
          unableCount.delete(key);
          unreachable.delete(key);
          return reply.response;
        } catch (error) {
          const last = error instanceof UdsExchangeError ? error.replies.at(-1) : undefined;
          const completedEmpty = error instanceof UdsExchangeError && error.failure === 'timeout'
            && last?.status === 'ok' && last.statuses.includes('NO DATA');
          // A completed failed protocol search is also a known boundary, not a broken BLE stream.
          // The live BCM returned this before the cluster VIN fallback succeeded on the same link.
          const searchFailed = reading && error instanceof UdsExchangeError && error.failure === 'adapter'
            && last?.status === 'ok' && last.statuses.includes('UNABLE TO CONNECT');
          const key = request.toUpperCase();
          if (completedEmpty && reading) emptyJustNow = key;
          if (searchFailed) {
            const n = (unableCount.get(key) ?? 0) + 1;
            unableCount.set(key, n);
            if (!succeeded.has(key) && n >= UNABLE_BEFORE_UNFITTED) unreachable.set(key, error);
          } else if (reading && error instanceof UdsExchangeError && error.failure === 'nrc') {
            // An NRC is an answer: the module is there.
            succeeded.add(key);
            unableCount.delete(key);
          } else if (reading) unableCount.delete(key);
          // A pending read whose final answer never came, or a truncated multi-frame reply: the adapter
          // returned its prompt normally, so the stream is in a known state — skip the DID (live 2026-10-30:
          // every BCM sweep died at 0560 `7F 22 78`; ABS 0509 and gateway 04A3 died on truncated replies).
          const skippable = error instanceof UdsExchangeError && reading && !engine.session?.isClosed
            && (error.detail === 'pending' || error.detail === 'truncated');
          if (!(error instanceof UdsExchangeError && error.failure === 'nrc') && !completedEmpty && !searchFailed && !skippable) {
            // No configuration reset between reads may hide an unknown stream state.
            active = false;
            await link.session.transport.close();
          }
          throw error;
        }
      });
    } finally { active = false; }
  });
}

export interface ModuleCodingBackup {
  schema: 'obdcraft.module-coding-backup/1';
  createdAt: string;
  identity: ModuleIdentity;
  did: number;
  codingHex: string;
  byteLength: number;
  executable: false;
}

/** An explicit read of the VAG variant-coding block. A backup does not grant write permission or define field semantics. */
export async function readModuleCodingBackup(engine: OBDCraftEngine, target: string, responseId: string): Promise<ModuleCodingBackup> {
  const identity = await probeModule(engine, target, responseId);
  if (!identity.part || !identity.software || !identity.odxFile || !identity.odxVersion) throw new Error('A module identity and ODX version are required before collecting its coding backup.');
  const reply = await exchangeUds(engine.link!, [0x22, 0x06, 0x00], { target: identity.target, responseId: identity.responseId, timeoutMs: 15000, padding: 'native' });
  const bytes = reply.response.slice(3);
  if (!bytes.length || bytes.length > 4092) throw new Error('No valid coding block was returned for this module.');
  return { schema: 'obdcraft.module-coding-backup/1', createdAt: new Date().toISOString(), identity, did: 0x0600, codingHex: toHex(bytes, ''), byteLength: bytes.length, executable: false };
}
