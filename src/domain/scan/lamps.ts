/**
 * BCM (unit 09) lamp records: DID `0x0550 + slot` for slots 0..34 (the vendor `GetLightConfigurationMQB()` map),
 * plus 0573..0583 (the PQ26-style table puts the side and rear turn lamps at 0580..0583). Each record is 16 bytes:
 *
 *   0 lamp type · 1 defect-bit position · 2 (00) · 3 fault byte
 *   4/5 function A/B · 6 dim AB (bits 0-6; bit 7 = only while the tailgate is closed)
 *   7/8 function C/D · 9 dim CD (bit 7 = direction, 1 = minimise)
 *   10/11 function E/F · 12 dim EF · 13/14 function G/H · 15 dim GH (bit 7 = direction)
 *
 * Priority GH > EF > CD > AB. Bit 7 of every function byte is reserved (the vendor editor keeps it on write).
 * Names: the vendor `mqb_light_functions` / `mqb_light_types` resources (English titles), docs/research/
 * REMAINING_FEATURES.md §A.0. Function codes from 0x3B up have not been confirmed on the A0 BCM.
 */

/** First and last lamp-record DID a scan reads on unit 09. */
export const LAMP_FIRST = 0x0550;
export const LAMP_LAST = 0x0583;

/** Every lamp-record DID a scan reads (0550..0583), upper-case hex. */
export const LAMP_DIDS: readonly string[] = Array.from({ length: LAMP_LAST - LAMP_FIRST + 1 }, (_, i) =>
  (LAMP_FIRST + i).toString(16).toUpperCase().padStart(4, '0'),
);

/** Function codes above this one have only the vendor's name: not seen on the A0 BCM. */
const LAST_CONFIRMED_FUNCTION = 0x3a;

/** The MQB slot map (slot → lamp). */
const SLOT_NAMES: readonly string[] = [
  'front turn signal, left',
  'front turn signal, right',
  'front side light / DRL, left',
  'front side light / DRL, right',
  'daytime running light, left',
  'daytime running light, right',
  'low beam, left',
  'low beam, right',
  'high beam, left',
  'high beam, right',
  'shutter, left',
  'shutter, right',
  'front fog light, left',
  'front fog light, right',
  'lock / unlock LED',
  'hazard-button LED',
  'slot 16',
  'slot 17',
  'rear turn signal, left',
  'rear turn signal, right',
  'brake light, left',
  'brake light, right',
  'third brake light',
  'tail light, left',
  'tail light, right',
  'number-plate light',
  'rear fog light, left',
  'rear fog light, right',
  'reverse light, left',
  'reverse light, right',
  'footwell light',
  'ambient light 1',
  'ambient light 2',
  'ambient light 3',
  'ambient light 4',
];

const LAMP_FUNCTIONS: ReadonlyMap<number, string> = new Map([
  [0x00, 'Not active'],
  [0x01, 'Always on'],
  [0x02, 'Turn signal: left: bright phase'],
  [0x03, 'Turn signal: left: dark phase'],
  [0x04, 'Turn signal: right: bright phase'],
  [0x05, 'Turn signal: right: dark phase'],
  [0x06, 'Turn signal: left (both phases)'],
  [0x07, 'Turn signal: right (both phases)'],
  [0x08, 'Parking light in general (rear light, position light, boundary light)'],
  [0x09, 'Parking light on the left (parking light activated on both sides left & right)'],
  [0x0a, 'Parking light on the right'],
  [0x0b, 'Low beam on the left'],
  [0x0c, 'Low beam on the right'],
  [0x0d, 'High beam on the left'],
  [0x0e, 'High beam on the right'],
  [0x0f, 'High beam flashing'],
  [
    0x10,
    'Headlight flasher when the low beam is already active or the continuous driving light is already active',
  ],
  [0x11, 'Headlight flasher when the low beam is not active or the DRL is already active'],
  [0x12, 'Fog light on the left'],
  [0x13, 'Fog light on the right'],
  [0x14, 'Daytime running lights'],
  [0x15, 'Constant low beam'],
  [0x16, 'Cornering light on the left'],
  [0x17, 'Cornering light on the right'],
  [0x18, 'Stop signal'],
  [0x19, 'Reversing light'],
  [0x1a, 'Rear fog light when no trailer attached'],
  [0x1b, 'Rear fog light when no trailer attached and right-hand traffic'],
  [0x1c, 'Rear fog light when no trailer attached and left-hand traffic'],
  [0x1d, 'High beam assistant activated'],
  [0x1e, 'Coming Home or Leaving Home active'],
  [0x1f, 'Auxiliary light (position light, parking light)'],
  [0x20, 'Rear fog light even when trailer fitted'],
  [0x21, 'The tailgate is open'],
  [0x22, 'Tailgate is closed'],
  [0x23, 'CCP light function: initialized to 0 after Kl.30 reset and changeable via CCP'],
  [0x24, 'Acknowledgment function 1'],
  [0x25, 'Clamp 30G'],
  [0x26, 'Dimming clamp 58xs (interior dimming regulator)'],
  [0x27, 'Dimming the lighting: clamp 58xt'],
  [0x28, 'Clamp 15 with a lag after vehicle standstill'],
  [0x29, 'Interior lighting'],
  [0x2a, 'Trunk light'],
  [0x2b, 'Footwell light'],
  [0x2c, 'Ambient light 5'],
  [0x2d, 'Ambient light 1'],
  [0x2e, 'Ambient light 2'],
  [0x2f, 'Ambient light 3'],
  [0x30, 'Ambient light 4'],
  [0x31, 'Ambient lighting'],
  [0x32, 'Door opened: rear left'],
  [0x33, 'Door opened: rear right'],
  [0x34, 'Vehicle with automatic start-stop is in the stop mode (s)'],
  [0x35, 'Clamp 75 variant a_vfzg'],
  [0x36, 'Door opened: front left'],
  [0x37, 'Door opened: front right'],
  [0x38, 'Door opened: left side'],
  [0x39, 'Door opened: right side'],
  [0x3a, 'Both sides permanent parking light'],
  [0x3b, 'Clamp 75 Variant vfzg'],
  [0x3c, 'Turn signal left active (both phases); Dimming up and down with p_t_ flash ramp'],
  [0x3d, 'Turn signal right active (both phases); Dimming up and down with p_t_ flash ramp'],
  [0x3e, 'Tail light active without brake light active; is deactivated; when brake light is active'],
  [
    0x3f,
    'Active blink function has an assigned bit set to 1 in pa_dynamisch_blinken (dynamic turn signals function active)',
  ],
  [0x40, 'Engine compartment opened light'],
  [0x41, 'Vehicle is not ready to drive (engine does not run: electric drive not active or similar)'],
  [0x42, 'Hand brake is applied'],
  [0x43, 'Clamp 15 without overrun'],
  [0x44, 'Debug light function (based on CCP)'],
  [0x45, 'Debug light function error memory'],
  [0x46, 'Supply requirements for the LCM modules'],
  [0x47, 'Brightness control: clamp 58xd'],
  [0x48, 'Circuit isolation relay for 2nd battery'],
  [0x49, 'Active dynamic turn signal blinking function on the left'],
  [0x4a, 'Active dynamic turn signal blinking function on the right'],
  [0x4b, 'Aesthetic lighting'],
  [0x4c, 'Hazard warning flashers'],
  [0x4d, 'Charge level indicator at the front'],
  [0x4e, 'Charge level indicator at the rear'],
  [0x4f, 'Radio remote control trunk lid button'],
  [0x52, 'Supply requirements for the LED LeiMo3G modules'],
]);
const LAMP_TYPES: ReadonlyMap<number, string> = new Map([
  [0x00, 'Not active'],
  [0x01, 'LED daytime running light module supply'],
  [0x02, 'Shutter (LED low-beam diagnosis)'],
  [0x03, 'Xenon low beam'],
  [0x04, 'LED daytime running light module signal'],
  [0x05, 'LED low beam'],
  [0x06, 'LED light module'],
  [0x07, 'Reserved_07'],
  [0x08, 'General light bulb 12W'],
  [0x09, 'General incandescent lamp 27W also H15'],
  [0x0a, 'General headlights'],
  [0x0b, 'Low beam'],
  [0x0c, 'Direction indicators/Turn signals'],
  [0x0d, 'Brake lights'],
  [0x0e, 'Combined flashing brake lights'],
  [0x0f, 'General incandescent lamp 6W; also H6W'],
  [0x10, '2* 3W'],
  [0x11, '4* 3W'],
  [0x12, '2* 5W'],
  [0x13, '3* 5W'],
  [0x14, '4* 5W'],
  [0x15, '2* 13W Blinker'],
  [0x16, '2* 16W Blinker'],
  [0x17, 'General headlights'],
  [0x18, '2* 5W KZL + LED Sidemarker'],
  [0x19, 'General light bulb indoor or outdoor light'],
  [0x20, 'General LED up to 12W'],
  [0x21, 'LED module flashing lights/turn lights'],
  [0x22, 'LED brake lights'],
  [0x23, 'Combined LED turn lights and brake lights'],
  [0x24, 'LED low power'],
  [0x25, 'General LED up to 12W'],
  [0x26, 'LED flashing lights/turn lights'],
  [0x27, 'LED brake lights'],
  [0x28, 'General LED'],
  [0x29, 'LED low power'],
  [0x2a, 'LED third brake light'],
  [0x2b, 'General LED'],
  [0x2c, 'LED footwell or interior light'],
  [0x2d, 'General LED up to 6W'],
  [0x2e, 'LED low power'],
  [0x2f, 'LED 12 W Open Load U ab 65'],
  [0x30, 'LED BLK Open Load U ab 65'],
  [0x31, 'LED BL Open Load U ab 65'],
  [0x32, '21 W + 5 W turn light'],
  [0x33, 'LED BLK Open Load U ab 65 T200'],
  [0x34, 'LED BL o U Reg PWM Ratio'],
  [0x35, 'LED LeiMo3G o Open Load'],
]);

const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** The lamp a record DID drives (by the MQB slot map; 0573..0583 by position only). */
export function lampName(did: string): string {
  const n = Number.parseInt(did, 16);
  const slot = n - LAMP_FIRST;
  if (slot >= 0 && slot < SLOT_NAMES.length) return SLOT_NAMES[slot] as string;
  if (n >= 0x0580 && n <= 0x0583) return `side / rear turn lamp ${n - 0x0580 + 1} (PQ26-style table)`;
  return `record ${did} (outside the MQB slot map)`;
}

export interface LampFunction {
  /** Slot letter A..H. */
  slot: string;
  /** The function code (bit 7 cleared). */
  code: number;
  name: string;
  /** False for codes above 0x3A: the vendor's name only, not seen on the A0 BCM. */
  confirmed: boolean;
  /** Bit 7 of the function byte, which the vendor editor keeps as it is. */
  reservedBit: boolean;
}

export interface LampDim {
  /** Function pair: AB, CD, EF or GH. */
  pair: string;
  /** Brightness 0..127 (halogen up to 100). */
  level: number;
  /** AB: only while the tailgate is closed; CD/EF/GH: 1 = minimise. */
  bit7: boolean;
}

export interface LampRecord {
  did: string;
  slot: number;
  lamp: string;
  hex: string;
  /** All bytes zero: the slot is not configured. */
  empty: boolean;
  /** Fewer than 16 bytes arrived (a truncated reply, or a shorter record): only those bytes are decoded. */
  short: boolean;
  type?: { code: number; name: string };
  defectBit?: number;
  faultByte?: number;
  /** Active functions (code ≠ 0), highest priority last as in the record (A..H). */
  functions: LampFunction[];
  dims: LampDim[];
}

const PAIRS: readonly { pair: string; slots: readonly [string, number][]; dim: number }[] = [
  {
    pair: 'AB',
    slots: [
      ['A', 4],
      ['B', 5],
    ],
    dim: 6,
  },
  {
    pair: 'CD',
    slots: [
      ['C', 7],
      ['D', 8],
    ],
    dim: 9,
  },
  {
    pair: 'EF',
    slots: [
      ['E', 10],
      ['F', 11],
    ],
    dim: 12,
  },
  {
    pair: 'GH',
    slots: [
      ['G', 13],
      ['H', 14],
    ],
    dim: 15,
  },
];

/** The function's name from the code table (bit 7 cleared). */
export function lampFunctionName(code: number): string {
  return LAMP_FUNCTIONS.get(code & 0x7f) ?? `unknown function ${hx(code & 0x7f)}`;
}

/** Decodes one lamp record (hex as read, DID data only). Pure; never throws on short input. */
export function decodeLampRecord(did: string, hex: string): LampRecord {
  const bytes = (hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
  const at = (i: number) => bytes[i];
  const record: LampRecord = {
    did: did.toUpperCase(),
    slot: Number.parseInt(did, 16) - LAMP_FIRST,
    lamp: lampName(did),
    hex: hex.toUpperCase(),
    empty: bytes.length > 0 && bytes.every((b) => b === 0),
    short: bytes.length < 16,
    functions: [],
    dims: [],
  };
  const type = at(0);
  if (type !== undefined)
    record.type = { code: type, name: LAMP_TYPES.get(type) ?? `unknown type ${hx(type)}` };
  if (at(1) !== undefined) record.defectBit = at(1);
  if (at(3) !== undefined) record.faultByte = at(3);
  for (const { pair, slots, dim } of PAIRS) {
    let active = false;
    for (const [slot, index] of slots) {
      const raw = at(index);
      if (raw === undefined) continue;
      const code = raw & 0x7f;
      if (code === 0) continue;
      active = true;
      record.functions.push({
        slot,
        code,
        name: lampFunctionName(code),
        confirmed: code <= LAST_CONFIRMED_FUNCTION,
        reservedBit: (raw & 0x80) !== 0,
      });
    }
    const d = at(dim);
    if (d !== undefined && (active || d !== 0))
      record.dims.push({ pair, level: d & 0x7f, bit7: (d & 0x80) !== 0 });
  }
  return record;
}

/** True for a lamp-record DID (0550..0583). */
export function isLampDid(did: string): boolean {
  const n = Number.parseInt(did, 16);
  return /^[0-9A-Fa-f]{4}$/.test(did) && n >= LAMP_FIRST && n <= LAMP_LAST;
}
