/**
 * The health snapshot's read-only guard. Everything `live health` and `live log` put on the wire is checked here
 * before it is handed to the adapter, and the adapter's send policy is locked to the same set for the whole run
 * (`SafetyPolicy.enterHealthReadOnly`), so a request that bypassed this check would still be refused.
 *
 * Allowed, and nothing else:
 *  - generic OBD-II reads: 01 (up to six PIDs), 02 (PID + frame pairs), 03, 05, 06, 07, 08 only as the `08 00` list
 *    of tests (never runs one), 09, 0A
 *  - UDS 19 ReadDTCInformation with sub-function 01 (count by status mask), 02 (list by status mask), 03 (snapshot
 *    identification), 04 (snapshot record of one DTC), 06 (extended data of one DTC), 0A (supported DTCs)
 *  - what the full car scan may send: 22 of one identifier, 3E 00 / 3E 80 tester present, 10 01 / 10 03 sessions
 *
 * Refused (the services people reach for after a scan): 04 clear codes, 14 clear DTC information, 2E writes, 2F
 * IO control, 31 routines, 27 security access, 11 resets, 10 02 programming session, 28 communication control,
 * 85 DTC setting control, and every write, flash or adaptation service.
 */

/** A health run tried to send something other than one of its reads: nothing was sent. */
export class HealthReadOnlyViolation extends Error {
  constructor(what: string) {
    super(`The health snapshot is read-only and never sends ${what}. Nothing was sent.`);
    this.name = 'HealthReadOnlyViolation';
  }
}

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** ReadDTCInformation sub-functions a health run may use, with the parameter bytes each takes. */
export const HEALTH_DTC_SUBFUNCTIONS: Readonly<Record<number, number>> = Object.freeze({
  1: 1, // status mask
  2: 1, // status mask
  3: 0,
  4: 4, // DTC (3 bytes) + snapshot record number
  6: 4, // DTC (3 bytes) + extended data record number
  10: 0,
});

/** Why a well-known service is refused, for the message. */
const REFUSED: Readonly<Record<number, string>> = {
  4: 'service 04 (clears the fault codes)',
  20: 'service 14 (clears the fault memory)',
  46: 'service 2E (writes data to a module)',
  47: 'service 2F (drives outputs / actuators)',
  49: 'service 31 (starts a module routine)',
  39: 'service 27 (security access)',
  17: 'service 11 (resets a module)',
  40: 'service 28 (communication control)',
  133: 'service 85 (switches fault logging off)',
  59: 'service 3B (writes data to a module)',
  61: 'service 3D (writes module memory)',
  52: 'service 34 (starts a download)',
  54: 'service 36 (transfers flash data)',
};

/** True when the request is one of the health snapshot's reads (see the file comment). */
export function isHealthRequest(pdu: readonly number[]): boolean {
  if (!pdu.length || !pdu.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) return false;
  const [service, ...rest] = pdu as [number, ...number[]];
  switch (service) {
    case 0x01:
      return rest.length >= 1 && rest.length <= 6;
    case 0x02:
      return rest.length >= 2 && rest.length <= 6 && rest.length % 2 === 0;
    case 0x03:
    case 0x07:
    case 0x0a:
      return rest.length === 0;
    case 0x05:
      return rest.length === 2;
    case 0x06:
    case 0x09:
      return rest.length === 1;
    case 0x08:
      return rest.length === 1 && rest[0] === 0x00;
    case 0x19: {
      const sub = rest[0];
      if (sub === undefined) return false;
      const params = HEALTH_DTC_SUBFUNCTIONS[sub];
      return params !== undefined && rest.length === 1 + params;
    }
    case 0x22:
      return rest.length === 2;
    case 0x3e:
      return rest.length === 1 && (rest[0] === 0x00 || rest[0] === 0x80);
    case 0x10:
      return rest.length === 1 && (rest[0] === 0x01 || rest[0] === 0x03);
    default:
      return false;
  }
}

/** Throws {@link HealthReadOnlyViolation} unless the request is one of the health snapshot's reads. */
export function assertHealthRequest(pdu: readonly number[]): void {
  if (isHealthRequest(pdu)) return;
  const service = pdu[0];
  const why = service !== undefined && REFUSED[service];
  if (service === 0x10 && pdu[1] === 0x02) throw new HealthReadOnlyViolation('a programming session (10 02)');
  throw new HealthReadOnlyViolation(why || `the request ${pdu.map(hx).join(' ') || '(empty)'}`);
}
