import type { CarLink, CarReader, DidRead, IdentifyResult, ModuleAddress } from '../coding/types.ts';

/** A full car scan tried to send something other than a read: nothing was sent. */
export class ReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`A read-only scan never sends ${what}. Nothing was sent.`);
    this.name = 'ReadOnlyViolation';
  }
}

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/**
 * The only requests a full car scan may put on the wire: `22` ReadDataByIdentifier of one identifier, `3E`
 * tester present (00 / 80) and `10 01` / `10 03` session changes. Anything else — `2E`, `27`, `31`, `11`, `14`, a
 * programming session, a multi-identifier read — throws before it is sent.
 */
export function assertReadOnlyRequest(pdu: readonly number[]): void {
  const ok =
    pdu.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff) &&
    ((pdu.length === 3 && pdu[0] === 0x22) ||
      (pdu.length === 2 && pdu[0] === 0x3e && (pdu[1] === 0x00 || pdu[1] === 0x80)) ||
      (pdu.length === 2 && pdu[0] === 0x10 && (pdu[1] === 0x01 || pdu[1] === 0x03)));
  if (!ok) throw new ReadOnlyViolation(`the request ${pdu.map(hx).join(' ') || '(empty)'}`);
}

/** The read request for a DID, asserted read-only before anyone may send it. */
function readRequest(did: string): void {
  if (!/^[0-9A-Fa-f]{4}$/.test(did))
    throw new ReadOnlyViolation(`a read of the malformed identifier "${did}"`);
  const n = Number.parseInt(did, 16);
  assertReadOnlyRequest([0x22, n >> 8, n & 0xff]);
}

function guardReader(reader: CarReader): CarReader {
  return {
    identify: (bound?: ModuleAddress): Promise<IdentifyResult> => {
      readRequest('F190');
      return reader.identify(bound);
    },
    readDid: (module: ModuleAddress, did: string): Promise<DidRead> => {
      readRequest(did);
      return reader.readDid(module, did);
    },
  };
}

/** A link a full scan holds: reads only, and `release` (idempotent) gives the wire lock back. */
export interface ReadOnlyLink extends CarLink {
  readonly canWrite: false;
  release(): void;
}

/**
 * Wraps a link for a full car scan. Every request is asserted read-only before it reaches the link; a write, a
 * declared sequence or a readiness read (OBD service 01) throws {@link ReadOnlyViolation} without touching it.
 * The underlying connection's send policy is locked to read-only requests as well ({@link CarLink.lockReadOnly}),
 * so even a path that bypassed this wrapper could not write while the scan holds the link.
 */
export function readOnlyLink(link: CarLink): ReadOnlyLink {
  let release: () => void = () => {};
  try {
    release = link.lockReadOnly?.() ?? release;
  } catch {
    // A connection already closed has no wire left to lock; every read on it reports the lost link.
  }
  const guarded = guardReader(link);
  return {
    mode: link.mode,
    canWrite: false,
    banner: link.banner,
    identify: guarded.identify,
    readDid: guarded.readDid,
    withReads<T>(module: ModuleAddress, work: (reader: CarReader) => Promise<T>): Promise<T> {
      return link.withReads ? link.withReads(module, (reader) => work(guardReader(reader))) : work(guarded);
    },
    readiness: async () => {
      throw new ReadOnlyViolation('a readiness read (OBD service 01)');
    },
    writeDid: async () => {
      throw new ReadOnlyViolation('a data write (service 2E)');
    },
    sequence: async () => {
      throw new ReadOnlyViolation('a command sequence');
    },
    ...(link.observeWire ? { observeWire: link.observeWire.bind(link) } : {}),
    close: () => link.close(),
    release: () => {
      const r = release;
      release = () => {};
      r();
    },
  };
}
