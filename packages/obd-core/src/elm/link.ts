import type { ElmReply, ElmSession } from './session.ts';
import { SafetyPolicy } from '../safety/policy.ts';
import { parseProtocol, type ProtocolInfo } from '../can/frames.ts';
import type { AdapterProfile } from '../adapters/identify.ts';
import type { FrameMode } from './uds.ts';

export interface AdapterConfig {
  /** ATS1 (spaces between bytes) or ATS0 (compact, fewer bytes over BLE). */
  spaces: boolean;
  /** ATH1 is needed to tell ECUs apart; OBDCraft keeps it on. */
  headers: boolean;
  /** ATAT0/1/2 adaptive timing. */
  adaptiveTiming: 0 | 1 | 2;
  /** ATST value in 4 ms units; null = adapter default. */
  st: number | null;
  /** 'functional' (7DF, every ECU answers) or a physical request header such as '7E0'. */
  target: string;
}

export const DEFAULT_CONFIG: AdapterConfig = { spaces: true, headers: true, adaptiveTiming: 1, st: null, target: 'functional' };

export interface AdapterInfo {
  identity: string;
  device: string;
  voltage: string;
  protocol: ProtocolInfo;
  /** What the adapter turned out to be (class, STN chip, branding). */
  profile: AdapterProfile;
}

/**
 * The ELM327 as configured: tracks which AT settings are applied, so the tuner
 * and the request runner only send a setting when it actually changes.
 */
export class ElmLink {
  config: AdapterConfig = { ...DEFAULT_CONFIG };
  protocol: ProtocolInfo = { number: 0, auto: true, name: 'unknown', family: 'unknown' };
  info: Partial<AdapterInfo> = {};
  /** Commands the adapter rejected with '?' (feature not supported by this clone). */
  readonly unsupportedAt = new Set<string>();
  atTimeoutMs = 1500;
  /**
   * Native module binding (the native VAG coding tool's way): the adapter stays on automatic protocol (ATSP0), the
   * first request to a module runs the protocol search, and addressing another module re-runs it (ATSP0 again).
   */
  nativeBind = false;
  /** The module the adapter last searched with; null while the startup search is pending for whichever comes first. */
  searchTarget: string | null = null;
  /**
   * How every diagnostic channel on this link hands its CAN frames to the adapter, unless the channel names its own
   * (see {@link FrameMode}). `full` until another mode is proven on the car.
   */
  frameMode: FrameMode = 'full';

  readonly session: ElmSession;
  readonly policy: SafetyPolicy;

  constructor(session: ElmSession, policy: SafetyPolicy = new SafetyPolicy(() => session.clock.now())) {
    this.session = session;
    this.policy = policy;
  }

  get clock() {
    return this.session.clock;
  }

  /** Sends an AT command (policy-checked). ok = adapter answered OK / a value, not '?'. */
  async at(cmd: string, timeoutMs = this.atTimeoutMs): Promise<{ ok: boolean; reply: ElmReply }> {
    const c = cmd.replace(/\s+/g, '').toUpperCase();
    this.policy.check(c, { family: this.protocol.family });
    const reply = await this.session.send(c, timeoutMs);
    const ok = reply.status === 'ok' && !reply.statuses.includes('?');
    if (reply.status === 'ok' && reply.statuses.includes('?')) this.unsupportedAt.add(c);
    if (ok) this.track(c);
    return { ok, reply };
  }

  /** Keeps `config` true to the adapter for settings changed through `at()` (e.g. by a diagnostic script). */
  private track(c: string): void {
    if (/^ATST[0-9A-F]{2}$/.test(c)) this.config.st = parseInt(c.slice(4), 16);
    else if (c === 'ATS0' || c === 'ATS1') this.config.spaces = c === 'ATS1';
    else if (c === 'ATH0' || c === 'ATH1') this.config.headers = c === 'ATH1';
    else if (/^ATAT[0-2]$/.test(c)) this.config.adaptiveTiming = Number(c.slice(4)) as AdapterConfig['adaptiveTiming'];
    else if (/^ATSH[0-9A-F]+$/.test(c)) {
      const header = c.slice(4);
      this.config.target = header === functionalHeader(this.protocol.number) ? 'functional' : header;
    }
  }

  /** Applies a configuration, sending only the settings that differ. Returns what failed. */
  async apply(next: Partial<AdapterConfig>): Promise<{ applied: string[]; failed: string[] }> {
    const applied: string[] = [];
    const failed: string[] = [];
    const want = { ...this.config, ...next };
    const step = async (cmd: string, commit: () => void) => {
      const { ok } = await this.at(cmd);
      if (ok) {
        commit();
        applied.push(cmd);
      } else failed.push(cmd);
    };
    if (want.spaces !== this.config.spaces) await step(want.spaces ? 'ATS1' : 'ATS0', () => (this.config.spaces = want.spaces));
    if (want.headers !== this.config.headers) await step(want.headers ? 'ATH1' : 'ATH0', () => (this.config.headers = want.headers));
    if (want.adaptiveTiming !== this.config.adaptiveTiming) {
      await step(`ATAT${want.adaptiveTiming}`, () => (this.config.adaptiveTiming = want.adaptiveTiming));
    }
    if (want.st !== this.config.st && want.st !== null) {
      await step(`ATST${want.st.toString(16).toUpperCase().padStart(2, '0')}`, () => (this.config.st = want.st));
    }
    if (want.target !== this.config.target) {
      // the header decides who is addressed; the receive filter (ATCRA) is a bonus some clones lack
      if (want.target === 'functional') {
        await step(`ATSH${functionalHeader(this.protocol.number)}`, () => (this.config.target = 'functional'));
        if (this.config.target === 'functional' && this.protocol.family !== 'legacy' && !(await this.at('ATCRA')).ok)
          failed.push('ATCRA');
      } else if (this.protocol.family === 'legacy') {
        failed.push(`ATSH${want.target}`);
      } else {
        await step(`ATSH${want.target}`, () => (this.config.target = want.target));
        const rx = physicalReplyId(want.target);
        // A header with no known reply id must not inherit the previous module's receive filter; and a
        // refused filter must not leave the previous one in place, hiding the new module's replies.
        if (this.config.target === want.target) {
          const filter = rx ? `ATCRA${rx}` : 'ATCRA';
          if (!(await this.at(filter)).ok) {
            failed.push(filter);
            if (filter !== 'ATCRA' && !(await this.at('ATCRA')).ok) failed.push('ATCRA');
          }
        }
      }
    }
    return { applied, failed };
  }

  async readProtocol(): Promise<ProtocolInfo> {
    const { ok, reply } = await this.at('ATDPN');
    if (ok && reply.lines[0]) this.protocol = parseProtocol(reply.lines[0]);
    return this.protocol;
  }
}

/** The ELM's default (functional, "every ECU") request header for a protocol. */
export function functionalHeader(protocol: number): string {
  if (protocol === 7 || protocol === 9 || protocol === 0xa) return '18DB33F1';
  if (protocol === 1) return '616AF1';
  if (protocol === 2 || protocol === 3) return '686AF1';
  if (protocol === 4 || protocol === 5) return 'C133F1';
  return '7DF';
}

/** 7E0 -> 7E8 (CAN 11-bit request/response pair); 18DA10F1 -> 18DAF110. */
export function physicalReplyId(requestHeader: string): string | null {
  const h = requestHeader.toUpperCase();
  if (/^7E[0-7]$/.test(h)) return (parseInt(h, 16) + 8).toString(16).toUpperCase();
  const m = /^18DA([0-9A-F]{2})([0-9A-F]{2})$/.exec(h);
  if (m) return `18DA${m[2]}${m[1]}`;
  return null;
}

/** 7E8 -> 7E0; 18DAF110 -> 18DA10F1. */
export function physicalRequestId(ecu: string): string | null {
  const h = ecu.toUpperCase();
  if (/^7E[8-F]$/.test(h)) return (parseInt(h, 16) - 8).toString(16).toUpperCase();
  const m = /^18DAF1([0-9A-F]{2})$/.exec(h);
  if (m) return `18DA${m[1]}F1`;
  return null;
}
