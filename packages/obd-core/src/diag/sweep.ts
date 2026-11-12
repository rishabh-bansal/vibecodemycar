import type { ElmLink } from '../elm/link.ts';
import { RequestRunner } from '../obd/request.ts';
import { PolicyError } from '../safety/policy.ts';
import { decodeDtcReply, findNegative, replyBytes, type DtcReply } from './dtcReply.ts';

/**
 * profiles/_uds_dtc_commands.json: 5,021 per-module recipes {mk, hdr, read[], clr[]} for 568 vehicle
 * profiles. A recipe belongs to ONE module: its `read` list is meant for its own `hdr` only. Union the
 * lists onto one header and every module is asked every question; a module answers a foreign one with a
 * negative reply at best. So: each row is its own header and its own list, in order, and the first command
 * the module answers positively ends that module's sweep. Addressing is restored after every module.
 * The `clr` lists are not used here (clearing faults goes through the guarded flow only).
 */

export interface UdsRecipe {
  mk: string;
  /** Request header: 3 hex digits (11-bit CAN id) or 6 (29-bit short form). */
  hdr: string;
  read: string[];
  clr: string[];
}

export type TryOutcome = 'positive' | 'negative' | 'no-data' | 'undecodable' | 'refused' | 'timeout' | 'invalid';

export interface Tried {
  cmd: string;
  outcome: TryOutcome;
  nrc?: number;
}

export interface ModuleSweep {
  hdr: string;
  status: 'codes' | 'none' | 'no-answer' | 'skipped';
  /** The command that worked. */
  command: string | null;
  reply: DtcReply | null;
  tried: Tried[];
  note?: string;
}

export interface SweepOptions {
  timeoutMs?: number;
  /** Commands tried per module at most (a recipe lists up to 20). */
  maxPerModule?: number;
}

const VALID_CMD = /^[0-9A-F]{2,}$/;

/** Rows for one vehicle profile (mk "acr00"), recipe order kept, rows without a usable header dropped. */
export function recipesFor(all: UdsRecipe[], mk: string): UdsRecipe[] {
  return all.filter((r) => r.mk === mk && /^[0-9A-Fa-f]{3}$|^[0-9A-Fa-f]{6}$/.test(r.hdr));
}

export async function sweepRecipes(link: ElmLink, recipes: UdsRecipe[], opts: SweepOptions = {}): Promise<ModuleSweep[]> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const rr = new RequestRunner(link);
  const family = link.protocol.family;
  const out: ModuleSweep[] = [];
  const previous = link.config.target;
  const can = family === 'can11' || family === 'can29';
  for (const row of recipes) {
    const hdr = row.hdr.toUpperCase();
    const result: ModuleSweep = { hdr, status: 'no-answer', command: null, reply: null, tried: [] };
    out.push(result);
    if (!can) {
      result.status = 'skipped';
      result.note = 'module recipes are CAN requests; this car is not on CAN';
      continue;
    }
    const { failed } = await link.apply({ target: hdr });
    if (failed.length) {
      result.status = 'skipped';
      result.note = `could not address ${hdr}: ${failed.join(', ')}`;
      await link.apply({ target: previous });
      continue;
    }
    let tries = 0;
    for (const raw of row.read) {
      const cmd = raw.replace(/\s+/g, '').toUpperCase();
      if (!VALID_CMD.test(cmd) || cmd.length % 2 === 1) {
        result.tried.push({ cmd: raw, outcome: 'invalid' });
        continue;
      }
      if (++tries > (opts.maxPerModule ?? 24)) break;
      try {
        link.policy.check(cmd, { family });
      } catch (e) {
        if (!(e instanceof PolicyError)) throw e;
        result.tried.push({ cmd, outcome: 'refused' });
        continue;
      }
      const reply = await link.session.send(cmd, timeoutMs);
      if (reply.status === 'timeout') {
        result.tried.push({ cmd, outcome: 'timeout' });
        continue;
      }
      const msgs = rr.messages(reply).filter((m) => m.complete);
      const candidates = msgs.length ? msgs.map((m) => m.bytes) : [replyBytes(reply.lines)];
      let decoded: DtcReply | null = null;
      let nrc: number | undefined;
      for (const bytes of candidates) {
        decoded = decodeDtcReply(bytes, { can: true });
        if (decoded) break;
        nrc ??= findNegative(bytes)?.nrc;
      }
      if (decoded) {
        result.tried.push({ cmd, outcome: 'positive' });
        result.command = cmd;
        result.reply = decoded;
        result.status = decoded.codes.length ? 'codes' : 'none';
        break;
      }
      if (nrc !== undefined) result.tried.push({ cmd, outcome: 'negative', nrc });
      else if (reply.statuses.includes('NO DATA') || reply.lines.length === 0) result.tried.push({ cmd, outcome: 'no-data' });
      else result.tried.push({ cmd, outcome: 'undecodable' });
    }
    await link.apply({ target: previous });
  }
  return out;
}
