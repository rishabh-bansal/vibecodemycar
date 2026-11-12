import type { Frame, ProtocolFamily } from './frames.ts';

/**
 * Why a multi-frame message is incomplete. `conflicting_cf`: the same consecutive frame arrived twice with
 * different data, so which copy belongs to the message cannot be known.
 */
export type MessageProblem = 'missing_cf' | 'truncated' | 'restarted' | 'orphan_cf' | 'bad_length' | 'conflicting_cf';

export interface IsoTpMessage {
  ecu: string;
  /** Payload: service byte first. For incomplete messages, only bytes known in order (up to the first hole). */
  bytes: number[];
  complete: boolean;
  multiFrame: boolean;
  declaredLength: number;
  /** Count of payload bytes actually received (holes excluded). */
  receivedLength: number;
  /** Consecutive-frame indexes (1-based, as counted from the first frame) that never arrived. */
  missingCf: number[];
  problem?: MessageProblem;
  frames: Frame[];
  /** For multi-frame: the first-frame data and every received CF chunk by index, for verified merging. */
  slots?: { ff: number[]; cf: (number[] | undefined)[] };
}

interface Open {
  msg: IsoTpMessage;
  ff: number[];
  cf: (number[] | undefined)[];
  needed: number;
  lastIndex: number;
}

function finish(o: Open): IsoTpMessage {
  const { msg, ff, cf, needed } = o;
  const missing: number[] = [];
  for (let i = 1; i <= needed; i++) if (!cf[i]) missing.push(i);
  // bytes in order up to the first hole
  const ordered = [...ff];
  for (let i = 1; i <= needed; i++) {
    const c = cf[i];
    if (!c) break;
    ordered.push(...c);
  }
  const received = ff.length + cf.reduce((n, c) => n + (c ? c.length : 0), 0);
  msg.missingCf = missing;
  msg.complete = missing.length === 0 && ordered.length >= msg.declaredLength;
  msg.bytes = ordered.slice(0, msg.declaredLength);
  msg.receivedLength = Math.min(received, msg.declaredLength);
  msg.slots = { ff: [...ff], cf: cf.map((c) => (c ? [...c] : undefined)) };
  if (!msg.complete && !msg.problem) {
    // a hole before the last received frame = a frame went missing; otherwise the tail never came
    msg.problem = missing.some((i) => i < o.lastIndex) ? 'missing_cf' : 'truncated';
  }
  return msg;
}

/**
 * Reassembles ISO-TP messages from the frames of one ELM reply.
 * - One open multi-frame message per ECU; a single frame from that ECU in the
 *   middle (another tester's reply, or ours to a different request) is emitted
 *   on its own and does NOT abort the open message.
 * - Consecutive frames are placed by sequence number, so a lost frame leaves a
 *   hole in the right place instead of shifting later bytes.
 * - A new first frame from the same ECU closes the previous message as restarted.
 */
export function reassemble(frames: Frame[], family: ProtocolFamily): IsoTpMessage[] {
  if (family === 'legacy') {
    return frames.map((f) => ({
      ecu: f.ecu, bytes: f.bytes, complete: true, multiFrame: false, declaredLength: f.bytes.length,
      receivedLength: f.bytes.length, missingCf: [], frames: [f],
    }));
  }
  const out: IsoTpMessage[] = [];
  const open = new Map<string, Open>();
  for (const f of frames) {
    const b = f.bytes;
    if (b.length === 0) continue;
    const pci = b[0]! >> 4;
    if (f.ecu === '?') {
      // headers off (ATH0, CAF1): the ELM already removed the PCI of single frames
      out.push({ ecu: '?', bytes: b, complete: true, multiFrame: false, declaredLength: b.length, receivedLength: b.length, missingCf: [], frames: [f] });
      continue;
    }
    if (pci === 0) {
      const len = b[0]! & 0x0f;
      const ok = len >= 1 && len <= b.length - 1;
      out.push({
        ecu: f.ecu, bytes: b.slice(1, 1 + (ok ? len : b.length - 1)), complete: ok, multiFrame: false,
        declaredLength: len, receivedLength: Math.min(len, b.length - 1), missingCf: [], frames: [f],
        ...(ok ? {} : { problem: 'bad_length' as const }),
      });
    } else if (pci === 1) {
      const prev = open.get(f.ecu);
      if (prev) {
        prev.msg.problem = 'restarted';
        out.push(finish(prev));
      }
      const len = ((b[0]! & 0x0f) << 8) | (b[1] ?? 0);
      // A first frame is a full CAN frame announcing 8–4095 bytes: a shorter message is a single frame,
      // and 0 is the escape for >4095 bytes, which classic CAN diagnostics never use here.
      if (b.length < 8 || len < 8) {
        out.push({
          ecu: f.ecu, bytes: [], complete: false, multiFrame: true, declaredLength: len, receivedLength: 0,
          missingCf: [], frames: [f], problem: 'bad_length',
        });
        continue;
      }
      const ff = b.slice(2, 8);
      const needed = Math.max(0, Math.ceil((len - ff.length) / 7));
      const msg: IsoTpMessage = {
        ecu: f.ecu, bytes: [], complete: false, multiFrame: true, declaredLength: len, receivedLength: 0,
        missingCf: [], frames: [f],
      };
      open.set(f.ecu, { msg, ff, cf: [], needed, lastIndex: 0 });
      if (needed === 0) {
        out.push(finish(open.get(f.ecu)!));
        open.delete(f.ecu);
      }
    } else if (pci === 2) {
      const o = open.get(f.ecu);
      if (!o) {
        out.push({ ecu: f.ecu, bytes: [], complete: false, multiFrame: true, declaredLength: 0, receivedLength: 0, missingCf: [], frames: [f], problem: 'orphan_cf' });
        continue;
      }
      const seq = b[0]! & 0x0f;
      // A repeat of the frame just placed (an adapter or bus duplicate) is not the next frame. Only a
      // byte-identical repeat is a duplicate: different data under the same sequence number makes the
      // message ambiguous, so it is closed as incomplete and never completed from either copy.
      if (o.lastIndex > 0 && seq === (o.lastIndex & 0x0f)) {
        o.msg.frames.push(f);
        const placed = o.cf[o.lastIndex];
        const repeat = b.slice(1, 1 + (placed?.length ?? 0));
        if (!placed || repeat.length !== placed.length || repeat.some((x, i) => x !== placed[i])) {
          o.msg.problem = 'conflicting_cf';
          out.push(finish(o));
          open.delete(f.ecu);
        }
        continue;
      }
      const expectSeq = (o.lastIndex + 1) & 0x0f;
      const index = o.lastIndex + 1 + ((seq - expectSeq + 16) & 0x0f);
      o.msg.frames.push(f);
      if (index <= o.needed) {
        const remaining = o.msg.declaredLength - o.ff.length - (index - 1) * 7;
        o.cf[index] = b.slice(1, 1 + Math.min(7, remaining));
        o.lastIndex = index;
      }
      let filled = true;
      for (let i = 1; i <= o.needed; i++) if (!o.cf[i]) { filled = false; break; }
      if (filled) {
        out.push(finish(o));
        open.delete(f.ecu);
      }
    }
    // pci 3 (flow control) is never sent by the ECU to us; ignore anything else
  }
  for (const o of open.values()) out.push(finish(o));
  return out;
}

/**
 * Merges the same multi-frame message received in several attempts, filling
 * holes slot by slot. Only allowed for static data (service 09): the first
 * frames must be byte-identical and every slot present in two attempts must
 * agree, otherwise null is returned and nothing is merged.
 */
export function mergeVerified(messages: IsoTpMessage[]): IsoTpMessage | null {
  const usable = messages.filter((m) => m.multiFrame && m.slots && m.declaredLength > 0);
  if (usable.length < 2) return null;
  const first = usable[0]!;
  const ff = first.slots!.ff;
  if (!usable.every((m) => m.declaredLength === first.declaredLength && m.slots!.ff.join() === ff.join())) return null;
  const needed = Math.ceil((first.declaredLength - ff.length) / 7);
  const cf: (number[] | undefined)[] = [];
  for (let i = 1; i <= needed; i++) {
    for (const m of usable) {
      const c = m.slots!.cf[i];
      if (!c) continue;
      if (cf[i] && cf[i]!.join() !== c.join()) return null;
      cf[i] = c;
    }
  }
  for (let i = 1; i <= needed; i++) if (!cf[i]) return null;
  const bytes = [...ff, ...cf.slice(1).flatMap((c) => c ?? [])].slice(0, first.declaredLength);
  return {
    ecu: first.ecu, bytes, complete: true, multiFrame: true, declaredLength: first.declaredLength,
    receivedLength: bytes.length, missingCf: [], frames: usable.flatMap((m) => m.frames),
    slots: { ff, cf },
  };
}
