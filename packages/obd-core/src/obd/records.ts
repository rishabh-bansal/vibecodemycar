import type { RecoveryResult } from '../elm/session.ts';
import type { MessageProblem } from '../can/isotp.ts';

/**
 * decoded     - a valid answer arrived (from at least one ECU) and was decoded
 * unsupported - the ECU said no (negative response), or the PID is not advertised
 * no_data     - the adapter said NO DATA: nobody answered
 * incomplete  - an answer started but consecutive frames were missing after all retries
 * conflict    - only replies to somebody else's requests arrived (another tester on the bus)
 * timeout     - no prompt within the hard deadline; the session recovered
 * invalid     - an answer arrived complete but its length or content is not valid for this item
 * error       - the adapter reported a bus or command error (CAN ERROR, BUS BUSY, ?, ...)
 * refused     - OBDCraft's safety policy blocked the command; nothing was sent
 */
export type RequestStatus =
  | 'decoded' | 'unsupported' | 'no_data' | 'incomplete' | 'conflict' | 'timeout' | 'invalid' | 'error' | 'refused';

export type Purpose = 'init' | 'discovery' | 'scan' | 'live' | 'tuner' | 'identity' | 'dtc' | 'freeze' | 'monitor' | 'clear' | 'manual';

export interface AttemptRecord {
  n: number;
  cmd: string;
  txHex: string;
  rxRaw: string;
  lines: string[];
  elmStatuses: string[];
  startedAt: number;
  durationMs: number;
  timeoutMs: number;
  outcome: RequestStatus;
  /** ECUs that answered with a usable message in this attempt. */
  answered: string[];
  foreign: number;
  problems: { ecu: string; problem: MessageProblem; missingCf: number[] }[];
  recovery?: RecoveryResult;
  staleBefore?: string;
}

export interface EcuResult {
  ecu: string;
  status: 'ok' | 'incomplete' | 'negative' | 'missing';
  /** Whole response message, service byte first (e.g. 41 0C 1C 56). */
  payload: number[];
  attempt: number;
  nrc?: number;
  problem?: MessageProblem;
  missingCf?: number[];
  /** Filled from several attempts with verified agreement (static data only). */
  merged?: boolean;
  /** Arrived after the prompt, before the next command. */
  late?: boolean;
  /** Further messages from the same ECU in the same attempt (legacy multi-message items, duplicates). */
  more?: number[][];
}

export interface RequestRecord {
  id: number;
  service: number;
  params: number[];
  cmd: string;
  purpose: Purpose;
  status: RequestStatus;
  attempts: AttemptRecord[];
  ecus: Record<string, EcuResult>;
  expectEcus: string[];
  foreign: { ecu: string; hex: string }[];
  startedAt: number;
  endedAt: number;
  timeoutMs: number;
  note?: string;
}
