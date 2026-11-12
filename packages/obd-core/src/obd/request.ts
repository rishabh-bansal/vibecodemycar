import type { ElmLink } from '../elm/link.ts';
import type { ElmReply } from '../elm/session.ts';
import { parseFrameLine, type Frame } from '../can/frames.ts';
import { mergeVerified, reassemble, type IsoTpMessage } from '../can/isotp.ts';
import { isHexLine } from '../elm/normalize.ts';
import { classify, type ObdRequestShape } from './matching.ts';
import type { AttemptRecord, EcuResult, Purpose, RequestRecord, RequestStatus } from './records.ts';
import { PolicyError } from '../safety/policy.ts';
import { toHex, hex2 } from '../util/hex.ts';

export interface ObdRequest extends ObdRequestShape {
  purpose: Purpose;
  /** ECUs expected to answer; a missing one triggers a retry. */
  expectEcus?: string[];
  /** ELM response-count digit (1-15): the ELM returns as soon as this many replies arrived. */
  responseCount?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Retry when the adapter says NO DATA (scan of an advertised PID). */
  retryNoData?: boolean;
  /** Static data (service 09): fill frame holes across attempts when every overlap agrees. */
  mergeStatic?: boolean;
  /** Single-use token from the guarded clear flow (service 04 only). */
  clearToken?: string;
  /** Exact-command, exact-target coding permit. A write is sent once, never automatically retried. */
  codingToken?: string;
}

export function buildCommand(service: number, params: number[], responseCount?: number): string {
  const body = hex2(service) + params.map(hex2).join('');
  return responseCount && responseCount > 0 && responseCount < 16 ? body + responseCount.toString(16).toUpperCase() : body;
}

const RETRYABLE: RequestStatus[] = ['timeout', 'incomplete', 'conflict', 'error'];

export interface RunnerOptions {
  defaultTimeoutMs?: number;
  defaultAttempts?: number;
  onRecord?: (r: RequestRecord) => void;
}

/**
 * Sends OBD requests and turns replies into request records. One record per
 * request, one attempt entry per send. Attempts are never spliced: each ECU's
 * result comes from one complete message of one attempt (or from a verified
 * merge for static data).
 */
export class RequestRunner {
  private seq = 0;
  private last: { req: ObdRequest; rec: RequestRecord } | null = null;
  readonly defaultTimeoutMs: number;
  readonly defaultAttempts: number;
  private readonly onRecord?: (r: RequestRecord) => void;

  readonly link: ElmLink;

  constructor(link: ElmLink, opts: RunnerOptions = {}) {
    this.link = link;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 2500;
    this.defaultAttempts = opts.defaultAttempts ?? 3;
    this.onRecord = opts.onRecord;
  }

  frames(reply: ElmReply | { lines: string[] }): Frame[] {
    const ctx = { family: this.link.protocol.family, headers: this.link.config.headers };
    const out: Frame[] = [];
    for (const line of reply.lines) {
      if (!isHexLine(line)) continue;
      const f = parseFrameLine(line, ctx);
      if (f) out.push(f);
    }
    return out;
  }

  messages(reply: ElmReply | { lines: string[] }): IsoTpMessage[] {
    return reassemble(this.frames(reply), this.link.protocol.family);
  }

  async execute(req: ObdRequest): Promise<RequestRecord> {
    const clock = this.link.clock;
    const cmd = buildCommand(req.service, req.params, req.responseCount);
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const maxAttempts = req.codingToken ? 1 : Math.max(1, req.maxAttempts ?? this.defaultAttempts);
    const expect = req.expectEcus ?? [];
    const rec: RequestRecord = {
      id: ++this.seq, service: req.service, params: [...req.params], cmd, purpose: req.purpose, status: 'no_data',
      attempts: [], ecus: {}, expectEcus: [...expect], foreign: [], startedAt: clock.now(), endedAt: 0, timeoutMs,
    };
    try {
      this.link.policy.check(cmd, { family: this.link.protocol.family, target: this.link.config.target }, req.clearToken, req.codingToken);
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      rec.status = 'refused';
      rec.note = e.message;
      rec.endedAt = clock.now();
      this.onRecord?.(rec);
      return rec;
    }
    const incompleteByEcu = new Map<string, IsoTpMessage[]>();
    for (let n = 1; n <= maxAttempts; n++) {
      const reply = await this.link.session.send(cmd, timeoutMs);
      // Before a retry, late bytes answer THIS request's earlier attempt; before a first attempt, the previous request.
      this.absorbLate(reply, n > 1 ? { req, rec } : this.last);
      const msgs = this.messages(reply);
      const attempt: AttemptRecord = {
        n, cmd, txHex: reply.txHex, rxRaw: reply.rxRaw, lines: reply.lines, elmStatuses: reply.statuses,
        startedAt: reply.startedAt, durationMs: reply.durationMs, timeoutMs, outcome: 'no_data', answered: [], foreign: 0,
        problems: [],
        ...(reply.recovery ? { recovery: reply.recovery } : {}),
        ...(reply.staleBefore ? { staleBefore: reply.staleBefore } : {}),
      };
      let ours = 0;
      let incomplete = 0;
      let negative = 0;
      for (const m of msgs) {
        const c = classify(req, m);
        if (c.kind === 'foreign' || c.kind === 'pending') {
          if (c.kind === 'foreign') {
            attempt.foreign++;
            if (rec.foreign.length < 50) rec.foreign.push({ ecu: m.ecu, hex: toHex(m.bytes) });
          }
          continue;
        }
        if (c.kind === 'negative') {
          negative++;
          if (!rec.ecus[m.ecu] || rec.ecus[m.ecu]!.status === 'missing') {
            rec.ecus[m.ecu] = { ecu: m.ecu, status: 'negative', payload: m.bytes, attempt: n, nrc: c.nrc };
          }
          continue;
        }
        if (!m.complete) {
          incomplete++;
          attempt.problems.push({ ecu: m.ecu, problem: m.problem ?? 'truncated', missingCf: m.missingCf });
          const list = incompleteByEcu.get(m.ecu) ?? [];
          list.push(m);
          incompleteByEcu.set(m.ecu, list);
          const prev = rec.ecus[m.ecu];
          if (!prev || prev.status !== 'ok') {
            rec.ecus[m.ecu] = {
              ecu: m.ecu, status: 'incomplete', payload: m.bytes, attempt: n, problem: m.problem ?? 'truncated', missingCf: m.missingCf,
            };
          }
          continue;
        }
        ours++;
        attempt.answered.push(m.ecu);
        const prev = rec.ecus[m.ecu];
        if (!prev || prev.status !== 'ok') {
          rec.ecus[m.ecu] = { ecu: m.ecu, status: 'ok', payload: m.bytes, attempt: n };
        } else if (prev.attempt === n) {
          // legacy protocols send several messages per item (e.g. VIN in 5 parts)
          (prev.more ??= []).push(m.bytes);
        }
      }
      attempt.outcome = outcomeOf(reply, ours, incomplete, negative, attempt.foreign);
      rec.attempts.push(attempt);

      if (req.mergeStatic) {
        for (const [ecu, list] of incompleteByEcu) {
          if (rec.ecus[ecu]?.status === 'ok') continue;
          const merged = mergeVerified(list);
          if (merged) rec.ecus[ecu] = { ecu, status: 'ok', payload: merged.bytes, attempt: n, merged: true };
        }
      }
      const okEcus = Object.values(rec.ecus).filter((e) => e.status === 'ok').map((e) => e.ecu);
      const missingExpected = expect.filter((e) => !okEcus.includes(e) && rec.ecus[e]?.status !== 'negative');
      const anyIncomplete = Object.values(rec.ecus).some((e) => e.status === 'incomplete');
      const retry =
        n < maxAttempts &&
        (RETRYABLE.includes(attempt.outcome) ||
          anyIncomplete ||
          (attempt.outcome === 'no_data' && !!req.retryNoData) ||
          // some ECUs answered but an expected one stayed silent
          (attempt.outcome === 'decoded' && missingExpected.length > 0));
      if (!retry) break;
      if (attempt.outcome === 'conflict') await clock.sleep(15 + Math.floor(Math.random() * 40));
    }
    for (const e of expect) if (!rec.ecus[e]) rec.ecus[e] = { ecu: e, status: 'missing', payload: [], attempt: rec.attempts.length };
    rec.status = finalStatus(rec);
    rec.endedAt = clock.now();
    this.last = { req, rec };
    this.onRecord?.(rec);
    return rec;
  }

  /** Bytes that arrived after the previous prompt may be late answers to `owner` (the request sent before). */
  private absorbLate(reply: ElmReply, owner: { req: ObdRequest; rec: RequestRecord } | null | undefined): void {
    if (!reply.staleBefore || !owner) return;
    const lines = reply.staleBefore.split(/[\r\n>]+/).map((s) => s.trim()).filter(Boolean);
    const msgs = this.messages({ lines });
    const { req, rec } = owner;
    let changed = false;
    for (const m of msgs) {
      if (!m.complete) continue;
      const c = classify(req, m);
      if (c.kind !== 'ours') continue;
      if (rec.ecus[m.ecu]?.status === 'ok') continue;
      rec.ecus[m.ecu] = { ecu: m.ecu, status: 'ok', payload: m.bytes, attempt: rec.attempts.length, late: true };
      changed = true;
    }
    if (changed) {
      rec.status = finalStatus(rec);
      this.onRecord?.(rec);
    }
  }
}

function outcomeOf(reply: ElmReply, ours: number, incomplete: number, negative: number, foreign: number): RequestStatus {
  if (ours > 0) return 'decoded';
  if (incomplete > 0) return 'incomplete';
  if (negative > 0) return 'unsupported';
  if (reply.status === 'timeout') return 'timeout';
  if (reply.status === 'closed') return 'error';
  if (foreign > 0) return 'conflict';
  if (reply.statuses.includes('NO DATA')) return 'no_data';
  if (reply.statuses.length > 0) return 'error';
  return 'no_data';
}

function finalStatus(rec: RequestRecord): RequestStatus {
  const vals = Object.values(rec.ecus);
  if (vals.some((e) => e.status === 'ok')) return 'decoded';
  if (vals.some((e) => e.status === 'incomplete')) return 'incomplete';
  if (vals.some((e) => e.status === 'negative')) return 'unsupported';
  const last = rec.attempts[rec.attempts.length - 1];
  return last?.outcome ?? 'no_data';
}

export function okResults(rec: RequestRecord): EcuResult[] {
  return Object.values(rec.ecus).filter((e) => e.status === 'ok');
}
