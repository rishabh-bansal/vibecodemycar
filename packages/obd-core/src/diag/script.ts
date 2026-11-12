/**
 * The profile script language found in the dataset (profiles/<make>.json: init, dtcReadSeq, dtcClrSeq).
 * A script is a string of tokens separated by ";" (or newlines):
 *
 *   ATxxx        an adapter command ("ATSH7E0", "ATFCSD300F05"); a leading "_" has no meaning on these
 *   1800FF00     hex: send the request and wait for its reply
 *   _1800FF00    hex with the reply-collecting marker: this reply is the one to decode for DTCs
 *   [CAN11] ... [/CAN11]   the steps in between apply only to cars on that protocol family (CAN11 / CAN29);
 *                          on a car whose protocol is not set yet, the tag selects it (ATSP6 / ATSP7)
 *   WAIT500, DELAY 200      sleep that many milliseconds (capped); no profile in the dataset uses these yet
 *
 * Anything else is kept as an `unknown` step and never sent.
 */

export type Section = 'CAN11' | 'CAN29';

export type ScriptStep =
  | { kind: 'at'; cmd: string; section?: Section }
  | { kind: 'send'; cmd: string; marked: boolean; section?: Section }
  | { kind: 'wait'; ms: number; section?: Section }
  | { kind: 'unknown'; raw: string; section?: Section };

export interface ParsedScript {
  steps: ScriptStep[];
  /** Session sub-functions the script itself opens ("1092" -> "92"): candidates for SafetyPolicy.declareSessions. */
  sessions: string[];
}

export const MAX_WAIT_MS = 5000;

const HEX = /^[0-9A-F]+$/;

export function parseScript(src: string | string[] | null | undefined): ParsedScript {
  const steps: ScriptStep[] = [];
  const sessions = new Set<string>();
  const text = Array.isArray(src) ? src.join(';') : src ?? '';
  let section: Section | undefined;
  for (const raw of text.split(/[;\n\r]+/)) {
    let tok = raw.trim();
    if (!tok) continue;
    // section tags can sit in front of a command ("[CAN11]ATSH7E0") or behind it
    for (;;) {
      const open = /^\[(CAN11|CAN29)\]/i.exec(tok);
      const close = /^\[\/(CAN11|CAN29)\]/i.exec(tok);
      if (open) { section = open[1]!.toUpperCase() as Section; tok = tok.slice(open[0].length).trim(); }
      else if (close) { section = undefined; tok = tok.slice(close[0].length).trim(); }
      else break;
    }
    const trailing = /\[\/(CAN11|CAN29)\]$/i.exec(tok);
    if (trailing) tok = tok.slice(0, trailing.index).trim();
    if (tok) {
      const s = section ? { section } : {};
      const up = tok.toUpperCase();
      const wait = /^(WAIT|DELAY)[\s:=]*(\d+)?\s*(MS)?$/.exec(up);
      if (wait) {
        steps.push({ kind: 'wait', ms: Math.min(MAX_WAIT_MS, wait[2] ? Number(wait[2]) : 100), ...s });
      } else {
        const marked = up.startsWith('_');
        const body = marked ? up.slice(1) : up;
        const compact = body.replace(/\s+/g, '');
        // AT and STN ("STCAF 1,07") commands are adapter commands; the policy decides which may go out
        if (/^(AT|ST)[A-Z0-9@,]*$/.test(compact)) steps.push({ kind: 'at', cmd: compact, ...s });
        else if (HEX.test(compact) && compact.length >= 2) {
          steps.push({ kind: 'send', cmd: compact, marked, ...s });
          const m = /^10([0-9A-F]{2})$/.exec(compact);
          if (m) sessions.add(m[1]!);
        } else steps.push({ kind: 'unknown', raw: tok, ...s });
      }
    }
    if (/\[\/(CAN11|CAN29)\]$/i.test(raw.trim())) section = undefined;
  }
  return { steps, sessions: [...sessions] };
}

/* ---------------------------------------------------------------- protocol */

/**
 * A profile's `protoSel` -> the ELM protocol digit for ATSP. 0 = leave the adapter on automatic.
 * 11, 43 and 44 are vendor K-line protocols the ELM327 cannot speak: unsupported, and the adapter stays on automatic.
 */
export function protoSelToAtsp(protoSel: number): { atsp: string; supported: boolean } {
  if (protoSel === 0) return { atsp: '0', supported: true };
  if (protoSel >= 5 && protoSel <= 9) return { atsp: String(protoSel), supported: true };
  if (protoSel === 10) return { atsp: 'A', supported: true };
  return { atsp: '0', supported: false };
}

/* ----------------------------------------------------------------- session */

export interface SessionSpec {
  /** Session-control request, e.g. "1092". */
  sessionCmd: string;
  /** Tester-present request, e.g. "3E". */
  testerPresent: string;
  /** How often to send tester-present while the session is in use. */
  intervalMs: number;
}

/** A diagnostic system's `sess` field: "(10_92, $3E, 3500)". */
export function parseSession(sess: string | null | undefined): SessionSpec | null {
  if (!sess) return null;
  const m = /^\s*\(?\s*([0-9A-Fa-f_]+)\s*,\s*\$?([0-9A-Fa-f]{2,4})\s*,\s*(\d+)\s*\)?\s*$/.exec(sess);
  if (!m) return null;
  const sessionCmd = m[1]!.replace(/_/g, '').toUpperCase();
  if (!/^10[0-9A-F]{2}$/.test(sessionCmd)) return null;
  const intervalMs = Number(m[3]);
  if (intervalMs < 100 || intervalMs > 60_000) return null;
  return { sessionCmd, testerPresent: m[2]!.toUpperCase(), intervalMs };
}
