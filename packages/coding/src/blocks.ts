/**
 * A declared, unconditional write position beyond the user-selectable field.
 * Car Scanner's coding delegates force constant bits/bytes depending on the
 * ECU generation (e.g. polite-blink count always sets byte 0 bit 4 on the new
 * BCM, bit 7 on the old one). These are declared masks, not arbitrary writes.
 */
export interface AuxWrite {
  byteOffset: number;
  bitOffset: number;
  /** 1–8 bits inside one byte (`bitOffset + bitLength <= 8`). */
  bitLength: number;
  value: number;
}

/**
 * One declared bit operation of an `ops` recipe choice: write `value` into `len` bits at `byte`/`bit`.
 * `bit` is the LSB index (0..7); a span of more than the remaining bits continues big-endian into the
 * following bytes (the last byte holds the LSBs, exactly like a big-endian field). `len: 8, bit: 0`
 * is the whole byte. `len <= 32`.
 */
/**
 * `fill: true` (only with `bit: 0, len: 8`): the op repeats on every byte from `byte` to the end of the block
 * as read — "zero the whole record" whatever length the module returns.
 */
export interface BitOp { byte: number; bit: number; len: number; value: number; fill?: boolean }
export interface CodingChoice { id: string; label: string; value: number; aux?: readonly AuxWrite[] }
export interface CodingField {
  byteOffset: number;
  bitOffset: number;
  bitLength: number;
  byteOrder: 'little' | 'big';
  choices: readonly CodingChoice[];
}
/**
 * A scalar adaptation container: `raw` occupies `dataLength` bytes at `byteOffset`
 * (`reverseOrder` swaps byte order), and the physical value is
 * `raw * multiplier + offset`. Mirrors `MQBAdaptationTemplate`'s numeric containers.
 */
export interface CodingScalar {
  byteOffset: number;
  dataLength: 1 | 2 | 3 | 4;
  multiplier: number;
  offset: number;
  signed?: boolean;
  reverseOrder?: boolean;
}
export interface CodingBlock { length: number; field?: CodingField; auxWrites?: readonly AuxWrite[]; scalar?: CodingScalar }
export interface ByteChange { offset: number; before: number; after: number; mask: number }

export function parseCodingBytes(hex: string): number[] {
  if (!/^(?:[0-9A-Fa-f]{2}){1,4092}$/.test(hex)) throw new Error('Coding data must contain 1–4092 complete hexadecimal bytes.');
  return hex.match(/../g)!.map(byte => parseInt(byte, 16));
}

function validateAuxWrite(aux: AuxWrite, block: CodingBlock): void {
  // Any width inside one byte. A constant may share bits with the field: it is applied after the field
  // value (the vendor delegates do exactly that), and both are inside the owned mask.
  if (!Number.isInteger(aux.byteOffset) || aux.byteOffset < 0 || aux.byteOffset >= block.length ||
    !Number.isInteger(aux.bitOffset) || aux.bitOffset < 0 || aux.bitOffset > 7 ||
    !Number.isInteger(aux.bitLength) || aux.bitLength < 1 || aux.bitOffset + aux.bitLength > 8 ||
    !Number.isInteger(aux.value) || aux.value < 0 || aux.value >= 2 ** aux.bitLength) throw new Error('A declared constant write has an invalid range or value.');
}

function validateScalar(s: CodingScalar, block: CodingBlock): void {
  if (!Number.isInteger(s.byteOffset) || s.byteOffset < 0 ||
    ![1, 2, 3, 4].includes(s.dataLength) || s.byteOffset + s.dataLength > block.length ||
    typeof s.multiplier !== 'number' || !Number.isFinite(s.multiplier) || s.multiplier === 0 ||
    typeof s.offset !== 'number' || !Number.isFinite(s.offset)) throw new Error('The scalar definition has an invalid range or scale.');
}

export function validateCodingBlock(block: CodingBlock): void {
  if (!Number.isInteger(block.length) || block.length < 1 || block.length > 4092) throw new Error('The coding block length is invalid.');
  const f = block.field, s = block.scalar;
  if (!!f === !!s) throw new Error('The coding block must declare exactly one field or scalar range.');
  if (s) {
    validateScalar(s, block);
    if (block.auxWrites?.length) throw new Error('Scalar blocks do not support constant writes.');
    return;
  }
  if (!Number.isInteger(f!.byteOffset) || f!.byteOffset < 0 || !Number.isInteger(f!.bitOffset) || f!.bitOffset < 0 || f!.bitOffset > 7 ||
    !Number.isInteger(f!.bitLength) || f!.bitLength < 1 || f!.bitLength > 32 ||
    !['little', 'big'].includes(f!.byteOrder) || f!.byteOffset + Math.ceil((f!.bitOffset + f!.bitLength) / 8) > block.length ||
    f!.choices.length < 1 || f!.choices.length > 256 || new Set(f!.choices.map(c => c.id)).size !== f!.choices.length ||
    f!.choices.some(c => !c.id || !c.label || !Number.isInteger(c.value) || c.value < 0 || c.value >= 2 ** f!.bitLength)) {
    throw new Error('The coding field has an invalid range, encoding or option list.');
  }
  for (const aux of block.auxWrites ?? []) validateAuxWrite(aux, block);
  for (const choice of f!.choices) for (const aux of choice.aux ?? []) validateAuxWrite(aux, block);
  if (f!.choices.some(c => (c.aux?.length ?? 0) > 64) || (block.auxWrites?.length ?? 0) > 64) throw new Error('A coding definition may declare at most 64 constant writes.');
}

function integerAt(bytes: readonly number[], field: CodingField): bigint {
  const part = bytes.slice(field.byteOffset, field.byteOffset + Math.ceil((field.bitOffset + field.bitLength) / 8));
  if (field.byteOrder === 'little') part.reverse();
  return part.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

/** Per-byte masks of the bits a field occupies, honouring its byte order. */
function fieldByteMasks(field: CodingField): Map<number, number> {
  const masks = new Map<number, number>();
  const mask = ((1n << BigInt(field.bitLength)) - 1n) << BigInt(field.bitOffset);
  const count = Math.ceil((field.bitOffset + field.bitLength) / 8);
  for (let i = 0; i < count; i++) {
    const shift = BigInt(8 * (field.byteOrder === 'little' ? i : count - i - 1));
    masks.set(field.byteOffset + i, Number((mask >> shift) & 255n));
  }
  return masks;
}

const auxByteMask = (aux: AuxWrite): number => (((1 << aux.bitLength) - 1) << aux.bitOffset) & 0xff;

/**
 * Every bit this definition can write, per byte (length = block.length): the field (or scalar
 * range), block-level constant writes and every choice's constant writes. Bits outside this mask
 * belong to other features or to the module itself.
 */
export function ownedMask(block: CodingBlock): number[] {
  validateCodingBlock(block);
  const owned = new Array<number>(block.length).fill(0);
  if (block.scalar) {
    for (let i = 0; i < block.scalar.dataLength; i++) owned[block.scalar.byteOffset + i] = 0xff;
    return owned;
  }
  const field = block.field!;
  for (const [offset, m] of fieldByteMasks(field)) owned[offset]! |= m;
  for (const aux of [...(block.auxWrites ?? []), ...field.choices.flatMap(c => c.aux ?? [])]) owned[aux.byteOffset]! |= auxByteMask(aux);
  return owned;
}

export function readCodingValue(hex: string, block: CodingBlock): number {
  validateCodingBlock(block);
  const bytes = parseCodingBytes(hex);
  if (bytes.length !== block.length) throw new Error('The coding block length does not match this ECU definition.');
  const field = block.field!;
  return Number((integerAt(bytes, field) >> BigInt(field.bitOffset)) & ((1n << BigInt(field.bitLength)) - 1n));
}

/** Apply one declared constant write inside its own byte mask. */
function applyAuxWrite(bytes: number[], aux: AuxWrite): void {
  const mask = auxByteMask(aux);
  bytes[aux.byteOffset] = (bytes[aux.byteOffset]! & ~mask & 0xff) | ((aux.value << aux.bitOffset) & mask);
}

/** Read the physical scalar value: `raw * multiplier + offset`. */
export function readScalarValue(before: string, block: CodingBlock): number {
  validateCodingBlock(block);
  const s = block.scalar!;
  const bytes = parseCodingBytes(before);
  if (bytes.length !== block.length) throw new Error('The coding block length does not match this ECU definition.');
  const part = bytes.slice(s.byteOffset, s.byteOffset + s.dataLength);
  if (s.reverseOrder) part.reverse(); // Car Scanner "Reversed" = little-endian storage
  let raw = part.reduce((v, b) => v * 256 + b, 0);
  const bits = s.dataLength * 8;
  if (s.signed && raw >= 2 ** (bits - 1)) raw -= 2 ** bits;
  return raw * s.multiplier + s.offset;
}

/** Write a physical scalar value inside its byte range; all other bytes are preserved. */
export function patchScalarBlock(before: string, block: CodingBlock, value: number): { after: string; changes: ByteChange[] } {
  validateCodingBlock(block);
  const s = block.scalar!;
  if (!Number.isFinite(value)) throw new Error('Enter a finite numeric value.');
  const bytes = parseCodingBytes(before), old = [...bytes];
  if (bytes.length !== block.length) throw new Error('The coding block length does not match this ECU definition.');
  const bits = s.dataLength * 8;
  let raw = Math.round((value - s.offset) / s.multiplier);
  const min = s.signed ? -(2 ** (bits - 1)) : 0, max = s.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  if (raw < min || raw > max || !Number.isInteger(raw)) {
    const ends = [min * s.multiplier + s.offset, max * s.multiplier + s.offset].sort((a, b) => a - b);
    throw new Error(`The value must map to an integer in [${ends[0]}, ${ends[1]}].`);
  }
  if (raw < 0) raw += 2 ** bits;
  for (let i = 0; i < s.dataLength; i++) {
    bytes[s.byteOffset + (s.reverseOrder ? i : s.dataLength - 1 - i)] = (raw >> (8 * i)) & 255;
  }
  const changes: ByteChange[] = [];
  for (let i = 0; i < s.dataLength; i++) {
    const offset = s.byteOffset + i;
    if (old[offset] !== bytes[offset]) changes.push({ offset, before: old[offset]!, after: bytes[offset]!, mask: 0xff });
  }
  return { after: bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''), changes };
}

/** Read-modify-write a complete block. Nothing outside the declared masks can change. */
export function patchCodingBlock(before: string, block: CodingBlock, choiceId: string): { after: string; changes: ByteChange[] } {
  // Any current value may be overwritten: an undeclared value on the car is still just the field's bits.
  readCodingValue(before, block);
  const field = block.field!;
  const choice = field.choices.find(c => c.id === choiceId);
  if (!choice) throw new Error('Select a value declared by the coding definition.');
  const bytes = parseCodingBytes(before), old = [...bytes];
  const mask = ((1n << BigInt(field.bitLength)) - 1n) << BigInt(field.bitOffset);
  const value = (integerAt(bytes, field) & ~mask) | (BigInt(choice.value) << BigInt(field.bitOffset));
  const count = Math.ceil((field.bitOffset + field.bitLength) / 8);
  for (let i = 0; i < count; i++) {
    const shift = BigInt(8 * (field.byteOrder === 'little' ? i : count - i - 1));
    bytes[field.byteOffset + i] = Number((value >> shift) & 255n);
  }
  for (const aux of [...(block.auxWrites ?? []), ...(choice.aux ?? [])]) applyAuxWrite(bytes, aux);
  const allowed = fieldByteMasks(field);
  for (const aux of [...(block.auxWrites ?? []), ...(choice.aux ?? [])]) {
    allowed.set(aux.byteOffset, (allowed.get(aux.byteOffset) ?? 0) | auxByteMask(aux));
  }
  const changes: ByteChange[] = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    if (old[offset] === bytes[offset]) continue;
    const mask8 = allowed.get(offset) ?? 0;
    if (((old[offset]! ^ bytes[offset]!) & ~mask8) !== 0) throw new Error('The proposed change exceeds its permitted bit mask.');
    changes.push({ offset, before: old[offset]!, after: bytes[offset]!, mask: mask8 });
  }
  return { after: bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(''), changes };
}

/** A restore may put back any original value, but only inside the bits this definition owns. */
export function validateCodingRestore(before: string, after: string, block: CodingBlock): void {
  if (block.scalar) {
    const beforeBytes = parseCodingBytes(before), afterBytes = parseCodingBytes(after), s = block.scalar;
    if (beforeBytes.length !== afterBytes.length || beforeBytes.length !== block.length) throw new Error('The backup block length does not match this definition.');
    readScalarValue(after, block); // any raw encoding is a legal value for a scalar
    for (let i = 0; i < beforeBytes.length; i++) {
      if (i >= s.byteOffset && i < s.byteOffset + s.dataLength) continue;
      if (beforeBytes[i] !== afterBytes[i]) throw new Error('The backup changes bytes outside the scalar range.');
    }
    return;
  }
  // A restore writes saved original bytes: they may hold a value no choice declares (the car had it
  // before we touched it). What must hold: they differ from the current block only inside the
  // declared field/aux masks — everything else is off-limits data.
  readCodingValue(after, block);
  const beforeBytes = parseCodingBytes(before), afterBytes = parseCodingBytes(after);
  if (beforeBytes.length !== afterBytes.length || beforeBytes.length !== block.length) throw new Error('The backup block length does not match this definition.');
  const owned = ownedMask(block);
  for (let i = 0; i < beforeBytes.length; i++) {
    if (((beforeBytes[i]! ^ afterBytes[i]!) & ~owned[i]!) !== 0) throw new Error('The backup changes bytes outside this field.');
  }
}

// ---- ops: per-choice declared bit operations ----------------------------------------------------

const toHex = (bytes: readonly number[]): string => bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');

/** Per-byte masks a bit op covers (a big-endian span, LSBs in its last byte). */
export function bitOpByteMasks(op: BitOp): Map<number, number> {
  return fieldByteMasks({ byteOffset: op.byte, bitOffset: op.bit, bitLength: op.len, byteOrder: 'big', choices: [] });
}

/** `fill` ops expanded to one whole-byte op per byte from `byte` to the end of a `length`-byte block. */
export function expandBitOps(ops: readonly BitOp[], length: number): BitOp[] {
  return ops.flatMap(op => {
    if (!op.fill) return [op];
    if (op.bit !== 0 || op.len !== 8) throw new Error('A fill operation must cover whole bytes (bit 0, 8 bits).');
    if (op.byte >= length) throw new Error(`A fill operation from byte ${op.byte} does not fit this ${length}-byte block.`);
    return Array.from({ length: length - op.byte }, (_, i) => ({ byte: op.byte + i, bit: 0, len: 8, value: op.value }));
  });
}

/** Validates one op against a block of `length` bytes. */
export function validateBitOp(op: BitOp, length: number): void {
  if (!Number.isInteger(op.byte) || op.byte < 0 || !Number.isInteger(op.bit) || op.bit < 0 || op.bit > 7 ||
    !Number.isInteger(op.len) || op.len < 1 || op.len > 32 ||
    op.byte + Math.ceil((op.bit + op.len) / 8) > length ||
    !Number.isInteger(op.value) || op.value < 0 || op.value >= 2 ** op.len) {
    throw new Error(`A bit operation (byte ${op.byte}, bit ${op.bit}, ${op.len} bits = ${op.value}) does not fit this ${length}-byte block.`);
  }
}

/** Every bit any of these op lists can write, per byte (the union over all choices of a recipe). */
export function ownedMaskOps(length: number, opLists: readonly (readonly BitOp[])[]): number[] {
  if (!Number.isInteger(length) || length < 1 || length > 4092) throw new Error('The coding block length is invalid.');
  const owned = new Array<number>(length).fill(0);
  for (const ops of opLists) for (const op of expandBitOps(ops, length)) {
    validateBitOp(op, length);
    for (const [offset, m] of bitOpByteMasks(op)) owned[offset]! |= m;
  }
  return owned;
}

/** Applies `ops` in order onto `before`; nothing outside the ops' own bits can change. */
export function patchOpsBlock(before: string, ops: readonly BitOp[]): { after: string; changes: ByteChange[] } {
  const bytes = parseCodingBytes(before), old = [...bytes];
  const allowed = new Map<number, number>();
  for (const op of expandBitOps(ops, bytes.length)) {
    validateBitOp(op, bytes.length);
    const field: CodingField = { byteOffset: op.byte, bitOffset: op.bit, bitLength: op.len, byteOrder: 'big', choices: [] };
    const mask = ((1n << BigInt(op.len)) - 1n) << BigInt(op.bit);
    const value = (integerAt(bytes, field) & ~mask) | (BigInt(op.value) << BigInt(op.bit));
    const count = Math.ceil((op.bit + op.len) / 8);
    for (let i = 0; i < count; i++) bytes[op.byte + i] = Number((value >> BigInt(8 * (count - i - 1))) & 255n);
    for (const [offset, m] of bitOpByteMasks(op)) allowed.set(offset, (allowed.get(offset) ?? 0) | m);
  }
  const changes: ByteChange[] = [];
  for (let offset = 0; offset < bytes.length; offset++) {
    if (old[offset] === bytes[offset]) continue;
    changes.push({ offset, before: old[offset]!, after: bytes[offset]!, mask: allowed.get(offset) ?? 0 });
  }
  return { after: toHex(bytes), changes };
}

/** True when every op already holds its value in `hex` (the choice is the car's current state). */
export function opsHold(hex: string, ops: readonly BitOp[]): boolean {
  const bytes = parseCodingBytes(hex);
  let expanded: BitOp[];
  try { expanded = expandBitOps(ops, bytes.length); } catch { return false; }
  return expanded.every(op => {
    try { validateBitOp(op, bytes.length); } catch { return false; }
    const field: CodingField = { byteOffset: op.byte, bitOffset: op.bit, bitLength: op.len, byteOrder: 'big', choices: [] };
    return Number((integerAt(bytes, field) >> BigInt(op.bit)) & ((1n << BigInt(op.len)) - 1n)) === op.value;
  });
}
