import type { IsoTpMessage } from '../can/isotp.ts';

export interface ObdRequestShape {
  service: number;
  /** PIDs (01, 09), [pid, frame] (02), MIDs (06), TIDs (05, 08); empty for 03/04/07/0A. */
  params: number[];
}

export type MatchKind = 'ours' | 'negative' | 'pending' | 'foreign';

export interface Classified {
  kind: MatchKind;
  /** Negative response code for 7F replies. */
  nrc?: number;
}

export const NRC_NAMES: Record<number, string> = {
  0x10: 'general reject',
  0x11: 'service not supported',
  0x12: 'sub-function not supported',
  0x13: 'incorrect message length',
  0x21: 'busy, repeat request',
  0x22: 'conditions not correct',
  0x31: 'request out of range',
  0x78: 'response pending',
};

/**
 * Decides whether a reassembled message answers our request, is a negative
 * answer to it, or belongs to somebody else's request (another tester on the
 * bus, or a late reply to an earlier command).
 */
export function classify(req: ObdRequestShape, msg: IsoTpMessage): Classified {
  const b = msg.bytes;
  if (b.length === 0) return { kind: 'foreign' };
  if (b[0] === 0x7f) {
    if (b[1] !== req.service) return { kind: 'foreign' };
    const nrc = b[2] ?? 0;
    return { kind: nrc === 0x78 ? 'pending' : 'negative', nrc };
  }
  if (b[0] !== req.service + 0x40) return { kind: 'foreign' };
  switch (req.service) {
    case 0x22:
    case 0x2e:
      return { kind: b.length >= 3 && b[1] === req.params[0] && b[2] === req.params[1] ? 'ours' : 'foreign' };
    case 0x10:
    case 0x3e:
      return { kind: b[1] === req.params[0] ? 'ours' : 'foreign' };
    case 0x01:
      return { kind: b[1] !== undefined && req.params.includes(b[1]) ? 'ours' : 'foreign' };
    case 0x02:
      return { kind: b[1] === req.params[0] && (b.length < 3 || b[2] === (req.params[1] ?? 0)) ? 'ours' : 'foreign' };
    case 0x05:
    case 0x06:
    case 0x08:
    case 0x09:
      return { kind: b.length < 2 || b[1] === req.params[0] ? 'ours' : 'foreign' };
    default:
      return { kind: 'ours' };
  }
}
