/**
 * Promoted unchanged from docs/reviews/2026-10-25/sequence-followup/sequence.test.ts (acceptance review of
 * fb612c3): only the import paths differ.
 *
 * The declared-command dataset writer on the deterministic replay rig: a fake MIB3 unit
 * answering the verbatim delegate ritual (sessions, seed/key, markers, identity
 * read-restore, payload write, reset) on the real engine, ISO-TP and safety policy.
 */
import {
  type EcuModel,
  Elm327Emulator,
  kushaqLikeSpecs,
  OBDCraftEngine,
  runVirtual,
  StandardEcu,
  VirtualClock,
} from '@obdcraft/obd-core';
import { afterEach, describe, expect, it } from 'vitest';
import { WebBluetoothLink } from '../../infra/link/web-bluetooth.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { buildApplyPlan } from '../../domain/coding/plan.ts';

const UNIT5F = { request: '773', response: '7DD' };
const PASSWORD = '20103';

/** MIB3 headunit: sessions 01/03/40, security 27 03/04, identity DIDs, dataset DID, reset. */
class Mib3 implements EcuModel {
  readonly id = '7DD';
  readonly requestId = '773';
  readonly pad = 0xaa;
  readonly latencyMs = 10;
  session = 1;
  unlocked = false;
  dataset = 'AABB';
  resetAt: number | null = null;
  /** Every UDS request that reached this unit, in order. */
  readonly requests: string[] = [];
  /** 2E payloads received per DID. */
  readonly writes: Record<string, string> = {};
  refuseSession40 = false;
  seed = [0x10, 0x20, 0x30, 0x40];
  handle(req: number[], _t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    const hex = req.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    this.requests.push(hex);
    const [svc, a = 0, b = 0] = req;
    const did = a * 256 + b;
    if (svc === 0x3e) return [0x7e, 0x80];
    if (svc === 0x10) {
      if (a === 0x40 && this.refuseSession40) return [0x7f, 0x10, 0x12];
      if (![1, 3, 0x40, 0x83].includes(a)) return [0x7f, 0x10, 0x12];
      this.session = a;
      return [0x50, a, 0x00, 0x32, 0x01, 0xf4];
    }
    if (svc === 0x11) {
      this.resetAt = _t;
      return [0x51, a];
    }
    if (svc === 0x22) {
      if (did === 0x7201) return [0x62, a, b, ...Buffer.from(this.dataset, 'hex')];
      if (did === 0xf1a0) return [0x62, a, b, 0xaa, 0x11];
      if (did === 0xf1a1) return [0x62, a, b, 0xbb, 0x22];
      if (did === 0xf1a5) return [0x62, a, b, 0x01, 0x02, 0x03, 0x04];
      if (did === 0xf199) return [0x7f, 0x22, 0x31];
      return [0x7f, 0x22, 0x31];
    }
    if (svc === 0x27) {
      if (a === 0x03) return [0x67, 0x03, ...this.seed];
      const seed = this.seed.reduce((v, x) => (v * 256 + x) >>> 0, 0);
      const key = req.slice(2).reduce((v, x) => (v * 256 + x) >>> 0, 0);
      if (key !== (seed + Number(PASSWORD)) >>> 0) return [0x7f, 0x27, 0x35];
      this.unlocked = true;
      return [0x67, 0x04];
    }
    if (svc === 0x2e) {
      this.writes[did.toString(16).toUpperCase().padStart(4, '0')] = req
        .slice(3)
        .map((x) => x.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
      if (did === 0x7201) this.dataset = this.writes['7201']!;
      return [0x6e, a, b];
    }
    return [0x7f, svc ?? 0, 0x11];
  }
}

async function rig() {
  const clock = new VirtualClock();
  const mib = new Mib3();
  const emulator = new Elm327Emulator({
    clock,
    ecus: [...kushaqLikeSpecs().map((s) => new StandardEcu(s)), mib],
    protocol: 6,
    voltage: () => 12.7,
    id: 'seq',
  });
  const engine = new OBDCraftEngine({ clock });
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  await run(engine.connect(emulator));
  const link = WebBluetoothLink.adopt(engine);
  return { clock, mib, emulator, engine, link, run };
}

const SPEC = {
  pre: ['1003', '1040', '22F1A0', '22F1A1', '2704', '2EF198', '2EF199', '2EF1A0', '2EF1A1'],
  post: ['1102'],
};

const opts = () => ({
  securityPassword: PASSWORD,
  onPending: () => {},
  today: () => new Date(2026, 9, 24),
  resetSettleMs: 200,
});

describe('independent follow-up', () => {
  afterEach(async () => { await WebBluetoothLink.retireCurrent(); });
  it('bundled sound recipe actually routes to the sequence executor', () => {
    const r = APP_DATA.recipes['csmqb-mib3-sound-signature']!;
    const p = buildApplyPlan(r,r.choices![0]!.id,'AA'.repeat(2052));
    expect(p.sequence?.pre).toContain('1040');
  });
  it('readiness expiry after acknowledged payload must not report not-sent', async () => {
    const r = await rig();
    const res = await r.run(r.link.sequence!(UNIT5F,
      {...SPEC,write:{kind:'did',did:'7201',bytes:'CCDD'},password:PASSWORD},
      {...opts(), assertReady:()=>{if(r.mib.dataset==='CCDD')throw new Error('expired');}}));
    expect(r.mib.dataset).toBe('CCDD');
    expect(res.kind).not.toBe('not-sent');
  });
  it('reset NRC after acknowledged payload must not be reported as payload NRC', async () => {
    const r = await rig();
    const handle = r.mib.handle.bind(r.mib);
    r.mib.handle = (req,t,physical)=>req[0]===0x11 ? [0x7f,0x11,0x22] : handle(req,t,physical);
    const res = await r.run(r.link.sequence!(UNIT5F,
      {...SPEC,write:{kind:'did',did:'7201',bytes:'CCDD'},password:PASSWORD},opts()));
    expect(r.mib.dataset).toBe('CCDD');
    expect(res.kind).not.toBe('nrc');
  });
});

describe('dataset command-sequence writer', () => {
  afterEach(async () => {
    await WebBluetoothLink.retireCurrent();
  });

  it('runs the verbatim MIB3 ritual: sessions, security, markers, restore-writes, payload, reset', async () => {
    const r = await rig();
    const res = await r.run(
      r.link.sequence!(
        UNIT5F,
        { ...SPEC, write: { kind: 'did', did: '7201', bytes: 'CCDD' }, password: PASSWORD },
        opts(),
      ),
    );
    expect(res.kind).toBe('acked');
    const req = r.mib.requests;
    expect(req).toContain('1040');
    expect(req).toContain('2703');
    const keyIdx = req.findIndex((x) => x.startsWith('2704'));
    expect(keyIdx).toBeGreaterThan(-1);
    expect(req).toContain('2E7201CCDD');
    expect(r.mib.writes['7201']).toBe('CCDD');
    // Restore-pairs write back the values the 22-reads returned (F1A0=AA11, F1A1=BB22).
    expect(r.mib.writes['F1A0']).toBe('AA11');
    expect(r.mib.writes['F1A1']).toBe('BB22');
    // F198 marker wrote the probed F1A5 bytes; F199 wrote today's BCD date.
    expect(r.mib.writes['F198']).toBe('01020304');
    expect(r.mib.writes['F199']).toBe('261024');
    expect(r.mib.resetAt).not.toBeNull();
    expect(res.markers?.some((m) => m.did === 'F198' && m.outcome === 'acked')).toBe(true);
    expect(res.txFrames?.length).toBeGreaterThan(0);
  });

  it('aborts before the payload when a required step is refused', async () => {
    const r = await rig();
    r.mib.refuseSession40 = true;
    const res = await r.run(
      r.link.sequence!(
        UNIT5F,
        { ...SPEC, write: { kind: 'did', did: '7201', bytes: 'CCDD' }, password: PASSWORD },
        opts(),
      ),
    );
    expect(res.kind).toBe('not-sent');
    expect(r.mib.writes['7201']).toBeUndefined();
    expect(r.mib.resetAt).toBeNull();
  });

  it('refuses an unknown command token without transmitting it', async () => {
    const r = await rig();
    const res = await r.run(
      r.link.sequence!(
        UNIT5F,
        {
          pre: ['1003', 'BEEF'],
          write: { kind: 'did', did: '7201', bytes: 'CCDD' },
          post: [],
          password: PASSWORD,
        },
        opts(),
      ),
    );
    expect(res.kind).toBe('not-sent');
    expect(r.mib.requests).not.toContain('BEEF');
    expect(r.mib.writes['7201']).toBeUndefined();
  });

  it('runs a download write: 34 request, 36 blocks, 37 exit', async () => {
    const r = await rig();
    const bytes = 'A0'.repeat(600);
    const res = await r.run(
      r.link.sequence!(
        UNIT5F,
        {
          pre: ['1003', '1040', '2704'],
          write: { kind: 'download', address: '0D0000', addressFormat: 4, lengthFormat: 4, bytes },
          post: ['37', '1102'],
          password: PASSWORD,
        },
        opts(),
      ),
    );
    // Our fake unit doesn't speak 34 — it NRCs, so the run must fail closed.
    expect(res.kind).toBe('not-sent');
    expect(r.mib.requests.some((x) => x.startsWith('3400'))).toBe(true);
    expect(r.mib.requests.some((x) => x.startsWith('36'))).toBe(false);
  });
});
