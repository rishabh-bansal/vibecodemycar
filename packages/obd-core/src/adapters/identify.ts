import type { ElmLink } from '../elm/link.ts';
import type { TuneConfig } from '../engine/tuner.ts';

/**
 * Adapter identification, after the adapter-id kit and corrected against what real adapters answer.
 *
 * What can be known: STN chips (OBDLink, some vLinker) answer `STI` with "STNxxxx"; every plain ELM
 * answers '?'. What cannot: a genuine ELM327 and a clone both say "ELM327 v1.5/v2.1" and both answer
 * `AT@1` with the stock "OBDII to RS232 Interpreter", so that string says nothing about the maker. The
 * kit called any `AT@1` text "branded"; the user's own OBDBLE clone (ATI "ELM327 v2.1", AT@1 the stock
 * string) would have been classed as branded, then given branded-class settings. Here only a non-stock
 * description or a programmed identifier (`AT@2`) counts as branding, and a plain ELM stays "elm":
 * speed is found by the throughput tuner on the actual hardware, not assumed from a label.
 */

export type AdapterClass = 'stn' | 'branded' | 'elm' | 'unknown';

export interface AdapterProfile {
  cls: AdapterClass;
  /** For the connect screen. */
  label: string;
  /** 'confirmed' = the adapter said so itself (STI); 'likely' = inferred; 'unknown' = no useful answers. */
  confidence: 'confirmed' | 'likely' | 'unknown';
  /** First line of ATI. On clones this may be a made-up version string. */
  firmware: string;
  /** "v2.1" parsed out of an "ELM327 v2.1" banner. */
  claimedVersion?: string;
  /** AT@1 text when it is not the stock ELM string. */
  description?: string;
  /** AT@2 identifier. Identifies a unit; keep it out of shared exports. */
  serial?: string;
  voltage?: number;
  stn?: { chip: string; model: number; device?: string };
  /**
   * The programmable-parameter summary (`ATPPS`, read-only), when the adapter printed one: PIC-based ELM327s and
   * their copies usually do, single-chip "v2.1" clones answer '?'. Firmware evidence only; never used to decide.
   */
  ppSummary?: string;
  /** What led to the class, for a "why does it say that" view. */
  evidence: string[];
  caps: { stCommands: boolean };
  /** The replies as text, for AdapterInfo. */
  raw: { identity: string; device: string; voltage: string };
}

export const STOCK_DESCRIPTION = /^OBDII to RS232 Interpreter\.?$/i;

const clean = (s: string | undefined) => (s ?? '').trim();

/** Reads the adapter's identity. Needs the ELM already reset and echo off (the engine's init does that). */
export async function identifyAdapter(link: ElmLink): Promise<AdapterProfile> {
  const evidence: string[] = [];
  const ati = await link.at('ATI');
  const at1 = await link.at('AT@1');
  const at2 = await link.at('AT@2');
  const rv = await link.at('ATRV');
  const sti = await link.at('STI');
  // STN chips keep their settings in ST commands, not ELM programmable parameters: the summary is asked of the rest.
  const pps = /STN\d{4}/i.test(sti.ok ? clean(sti.reply.lines[0]) : '') ? undefined : await link.at('ATPPS');

  const firmware = ati.ok ? clean(ati.reply.lines[0]) : '';
  const device = at1.ok ? clean(at1.reply.lines[0]) : '';
  const serial = at2.ok ? clean(at2.reply.lines[0]) : '';
  const voltageText = rv.ok ? clean(rv.reply.lines[0]) : '';
  const stiText = sti.ok ? clean(sti.reply.lines[0]) : '';
  const ppSummary = pps?.ok ? pps.reply.lines.map(clean).filter((l) => l && l !== 'OK').join(' ').slice(0, 600) : '';

  const voltageMatch = /(\d+(?:\.\d+)?)\s*V/i.exec(voltageText);
  const voltage = voltageMatch ? parseFloat(voltageMatch[1]!) : undefined;
  const claimed = /ELM327\s+v?(\d+\.\d+[a-z]?)/i.exec(firmware)?.[1];

  const stnMatch = /(STN\d{4})/i.exec(stiText);
  const stnByName = /OBDLink|vLinker|STN\d{4}/i.test(`${firmware} ${device}`);
  const nonStock = device !== '' && !STOCK_DESCRIPTION.test(device) && device !== '?';

  let cls: AdapterClass = 'unknown';
  let confidence: AdapterProfile['confidence'] = 'unknown';
  let stn: AdapterProfile['stn'];
  let label = 'Unidentified adapter';

  if (stnMatch) {
    cls = 'stn';
    confidence = 'confirmed';
    evidence.push(`STI -> ${stnMatch[1]!.toUpperCase()}`);
    const chip = stnMatch[1]!.toUpperCase();
    const dev = await link.at('STDI');
    const devText = dev.ok ? clean(dev.reply.lines[0]) : '';
    stn = { chip, model: parseInt(chip.slice(3), 10), ...(devText ? { device: devText } : {}) };
    label = `${devText || 'STN adapter'} (${chip})`;
  } else if (stnByName) {
    cls = 'stn';
    confidence = 'likely';
    evidence.push('name says OBDLink / vLinker / STN, but STI was not answered');
    label = `${device || firmware} (STN-class, unconfirmed)`;
  } else if (nonStock || serial) {
    cls = 'branded';
    confidence = 'likely';
    if (nonStock) evidence.push(`AT@1 -> "${device}"`);
    if (serial) evidence.push('AT@2 identifier programmed');
    label = nonStock ? device : `Branded adapter${claimed ? ` (ELM327 v${claimed})` : ''}`;
  } else if (/ELM327/i.test(firmware)) {
    cls = 'elm';
    confidence = 'likely';
    evidence.push(`ATI -> "${firmware}"`);
    if (device) evidence.push('AT@1 is the stock ELM string (identical on genuine chips and clones)');
    label = `ELM327-compatible${claimed ? ` (reports v${claimed})` : ''}`;
  } else if (firmware) {
    evidence.push(`ATI -> "${firmware}"`);
    label = firmware;
  } else {
    evidence.push('no answer to ATI');
  }
  if (/[^\x20-\x7e]/.test(firmware)) evidence.push('ATI reply contains non-printable bytes');
  if (pps) evidence.push(ppSummary ? 'ATPPS answered (programmable parameters listed)' : 'ATPPS not answered');

  return {
    cls, label, confidence, firmware: firmware || '(no banner)',
    ...(claimed ? { claimedVersion: claimed } : {}),
    ...(nonStock ? { description: device } : {}),
    ...(serial ? { serial } : {}),
    ...(voltage !== undefined ? { voltage } : {}),
    ...(stn ? { stn } : {}),
    ...(ppSummary ? { ppSummary } : {}),
    evidence,
    caps: { stCommands: cls === 'stn' && confidence === 'confirmed' },
    raw: { identity: firmware || 'unknown', device, voltage: voltageText },
  };
}

/**
 * A starting point for the throughput tuner, used only when nothing is remembered for this adapter.
 * The tuner re-measures it first and falls back to its normal ladder if the adapter does worse than 80%
 * of the requested values, so a wrong seed costs one measurement window. Only confirmed STN hardware
 * gets one: the kit's slower per-class settings (pacing, small batches) are not applied, since the
 * tuner finds an adapter's real limits by measuring and the project sets no rate cap.
 */
export function tunerSeedFor(profile: AdapterProfile): TuneConfig | null {
  if (profile.cls === 'stn' && profile.confidence === 'confirmed') {
    return { responseCount: true, maxPids: 6, maxReplyBytes: 4095, spaces: false, adaptiveTiming: 1, physical: false };
  }
  return null;
}

/** The profile without the unit-identifying parts, for exports that leave the device. */
export function shareableProfile(p: AdapterProfile): Omit<AdapterProfile, 'serial'> & { serial?: string } {
  const { serial, ...rest } = p;
  return serial ? { ...rest, serial: `…${serial.slice(-4)}` } : rest;
}

/**
 * The first query after ATSP0 triggers the protocol search, and K-line start-up (5-baud init) alone can
 * take several seconds, so it gets a long window. The adapter-id kit waited 1.5 s and would call a
 * working car "not alive".
 */
export const FIRST_QUERY_TIMEOUT_MS = 15_000;

export interface VehicleLink {
  alive: boolean;
  /** "NO DATA", "UNABLE TO CONNECT", "BUS INIT ERROR" when the car did not answer; null when it did. */
  failure: string | null;
  protocol: string;
}

/** True when two consecutive BYTES of a reply line are `a b` (not a match across byte boundaries). */
function hasBytes(line: string, a: number, b: number): boolean {
  const t = line.trim().toUpperCase();
  const compact = t.replace(/\s+/g, '');
  // Spaced lines split into bytes; a compact line with a 3-digit CAN id is re-aligned after the id.
  const tokens = /\s/.test(t)
    ? t.split(/\s+/)
    : (compact.length % 2 ? compact.slice(3) : compact).match(/../g) ?? [];
  const bytes = tokens.map((x) => Number.parseInt(x, 16));
  return bytes.some((x, i) => x === a && bytes[i + 1] === b);
}

/** Confirms the car side is talking before the UI says "connected": 0100 must answer 41 00. */
export async function verifyVehicleLink(link: ElmLink): Promise<VehicleLink> {
  await link.at('ATSP0');
  link.policy.check('0100', { family: link.protocol.family });
  const reply = await link.session.send('0100', FIRST_QUERY_TIMEOUT_MS);
  const alive = reply.lines.some((line) => hasBytes(line, 0x41, 0x00));
  const dp = await link.at('ATDP');
  const failure = alive ? null : reply.statuses.find((s) => s === 'NO DATA' || s === 'UNABLE TO CONNECT' || s === 'BUS INIT ERROR') ?? (reply.status === 'timeout' ? 'no reply' : 'no 41 00 in the reply');
  return { alive, failure, protocol: dp.ok ? clean(dp.reply.lines[0]) : '' };
}
