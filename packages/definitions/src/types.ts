/** 'raw': no published formula; the value is shown as the bytes the car sent. */
export type FieldKind = 'numeric' | 'flag' | 'enum' | 'bitmask' | 'support_bitmap' | 'dtc' | 'readiness' | 'raw';
/** 'unlisted': not in OBDCraft's tables at all (manufacturer or newer PID); raw bytes only. */
export type Confidence = 'validated' | 'secondary' | 'observed' | 'unlisted';
export type PidKind = 'data' | 'support' | 'status';

export interface FieldDef {
  id: string;
  /** Globally unique data point id, e.g. "rpm". */
  key: string;
  name: string;
  short: string;
  formula: string;
  unit: string | null;
  kind: FieldKind;
  min: number | null;
  max: number | null;
  values?: Record<string, string>;
  bits?: Record<string, string>;
  /** Field only present when the reply carries at least this many data bytes. */
  requires_length: number | null;
  /** Field only present when this bit of byte A is set (masked multi-field PIDs). */
  mask_bit: number | null;
  /** Formula; when true the value is "not available" (e.g. O2 trim B = 0xFF). */
  na_when: string | null;
}

export interface PidDef {
  pid: string;
  services: string[];
  name: string;
  short: string;
  category: string;
  kind: PidKind;
  /** Every valid data length (bytes after the PID); empty = not known, any length is shown raw. */
  lengths: number[];
  /** Safe to combine with others in one multi-PID request (fixed length). */
  multi_pid: boolean;
  mask?: { byte: string };
  fields: FieldDef[];
  confidence: Confidence;
  source: string;
  notes?: string;
}

export interface ServiceDef {
  id: string;
  name: string;
  user: string;
  read_only: boolean;
  warning?: string;
}

export interface Mode09Def {
  pid: string;
  name: string;
  kind: 'support_bitmap' | 'count' | 'ascii' | 'ascii_list' | 'hex_list' | 'uint16_list';
  length?: number;
  item_bytes?: number;
  items?: string[];
  sensitive?: boolean;
}

export interface ObdDefinitions {
  schema: string;
  version: string;
  about: string;
  provenance: Record<string, string>;
  formula_language: string;
  units: Record<string, { symbol: string; name: string }>;
  services: ServiceDef[];
  readiness: { spark: string[]; compression: string[]; continuous: string[]; source: string };
  mode09: Mode09Def[];
  ipt_names: Record<string, string>;
  pids: PidDef[];
}

export interface Mode06Defs {
  schema: string;
  version: string;
  source: string;
  uasid: Record<string, { scale: number; offset?: number; unit: string | null; label: string; signed?: boolean }>;
  signed_rule: string;
  mids: Record<string, string>;
  mid_ranges: { from: string; to: string; label: string }[];
  tids: Record<string, string>;
  tid_note: string;
}

export interface DtcDefs {
  schema: string;
  version: string;
  licence: string;
  unknown_generic: string;
  unknown_manufacturer: string;
  systems: Record<string, string>;
  generic_ranges: { from: string; to: string; type: 'generic' | 'manufacturer' }[];
  subsystems: Record<string, Record<string, string>>;
  codes: Record<string, string>;
}

/** One decoded field of one PID reply. */
export interface DecodedField {
  key: string;
  id: string;
  name: string;
  short: string;
  unit: string | null;
  kind: FieldKind;
  /** null when the field is absent (mask bit clear, optional byte missing) or not available. */
  value: number | null;
  state: 'ok' | 'absent' | 'not_available' | 'out_of_range';
  /** Text for enum/bitmask/flag/dtc values. */
  text?: string;
  /** Names of set bits for bitmask/readiness fields. */
  setBits?: string[];
  breakdown: FormulaBreakdown;
}

export interface FormulaBreakdown {
  formula: string;
  bytes: { letter: string; hex: string; dec: number }[];
  substituted: string;
  result: string;
}

export interface DecodedPid {
  pid: string;
  name: string;
  status: 'decoded' | 'length_mismatch';
  lengthOk: boolean;
  expectedLengths: number[];
  dataHex: string;
  fields: DecodedField[];
  confidence: Confidence;
  error?: string;
}
