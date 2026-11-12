/**
 * The declared-sequence writer on a STRICT emulated MIB3 unit (real engine, ELM session, ISO-TP, safety policy):
 * the unit enforces sessions and security, negotiates its download block size and checks every block counter,
 * so the writer's protocol checks (brief C4) and phase-truthful outcomes (C2) are exercised, not assumed.
 */
import {
  type EcuModel,
  Elm327Emulator,
  kushaqLikeSpecs,
  OBDCraftEngine,
  runVirtual,
  SafetyPolicy,
  StandardEcu,
  VirtualClock,
} from '@obdcraft/obd-core';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_TX_FRAMES } from '../../domain/backups/schema.ts';
import { APP_DATA } from '../../domain/catalog/data.ts';
import type { DatasetRecipe } from '../../domain/catalog/types.ts';
import type { DidWrite, SequenceSpec, WriterNote } from '../../domain/coding/types.ts';
import { compileSequence } from './dataset-writer.ts';
import { WebBluetoothLink } from './web-bluetooth.ts';

const UNIT = { request: '773', response: '7DD' };
const PASSWORD = '20103';
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
const bytes = (h: string) => (h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16));

type Fault =
  | { at: 'reset'; answer: 'nrc' | 'silent' | 'disconnect' }
  | { at: 'session40'; answer: 'nrc' }
  | { at: 'read'; did: string; answer: 'nrc' | 'silent' }
  | { at: 'marker'; did: 'F198' | 'F199'; answer: 'silent' }
  | { at: 'block'; n: number; answer: 'nrc' | 'wrong-counter' | 'silent' }
  | { at: 'download'; reply: number[] }
  | { at: 'exit'; answer: 'nrc' };

/** MIB3 head unit: sessions 01/03/40, 27 03/04, identity DIDs, the 7201 dataset, a strict 34/36/37 download. */
class StrictMib3 implements EcuModel {
  readonly id = '7DD';
  readonly requestId = '773';
  readonly pad = 0xaa;
  readonly latencyMs = 10;
  session = 1;
  unlocked = false;
  seed = [0x10, 0x20, 0x30, 0x40];
  dataset = 'AABB';
  identity: Record<string, string> = { F1A0: 'AA11', F1A1: 'BB22', F1A5: '01020304' };
  /** maxNumberOfBlockLength reported in 74 (service + counter + data). */
  maxBlockLength = 0x0102;
  download: { size: number; data: number[]; counter: number } | null = null;
  memory: number[] = [];
  exited = false;
  resets = 0;
  faults: Fault[] = [];
  onReset?: () => void;
  readonly requests: string[] = [];
  readonly writes: Record<string, string> = {};
  private fault<K extends Fault['at']>(at: K): Extract<Fault, { at: K }>[] {
    return this.faults.filter((f): f is Extract<Fault, { at: K }> => f.at === at);
  }

  handle(req: number[], _t: number, physical: boolean): number[] | null {
    if (!physical) return null;
    this.requests.push(hex(req));
    const [svc = 0, a = 0, b = 0] = req;
    const did = hex([a, b]);
    const nrc = (code: number) => [0x7f, svc, code];
    const extended = this.session === 3 || this.session === 0x40 || this.session === 0x4f;
    switch (svc) {
      case 0x3e:
        return [0x7e, 0x00];
      case 0x10:
        if (a === 0x40 && this.fault('session40').length) return nrc(0x12);
        if (![1, 3, 0x40, 0x4f].includes(a)) return nrc(0x12);
        this.session = a;
        if (a === 1) this.unlocked = false;
        return [0x50, a, 0x00, 0x32, 0x01, 0xf4];
      case 0x22: {
        const f = this.fault('read').find((x) => x.did === did);
        if (f) return f.answer === 'silent' ? null : nrc(0x31);
        if (did === 'F187') return [0x62, a, b, ...[...'3G5035816A'].map((c) => c.charCodeAt(0))];
        if (did === '7201') return [0x62, a, b, ...bytes(this.dataset)];
        const value = this.identity[did];
        return value ? [0x62, a, b, ...bytes(value)] : nrc(0x31);
      }
      case 0x27: {
        if (!extended) return nrc(0x7f);
        if (a === 0x03) return [0x67, 0x03, ...this.seed];
        const seed = this.seed.reduce((v, x) => (v * 256 + x) >>> 0, 0);
        const key = req.slice(2).reduce((v, x) => (v * 256 + x) >>> 0, 0);
        if (key !== (seed + Number(PASSWORD)) >>> 0) return nrc(0x35);
        this.unlocked = true;
        return [0x67, 0x04];
      }
      case 0x2e: {
        if (!extended) return nrc(0x7f);
        const marker = this.fault('marker').find((x) => x.did === did);
        if (marker) return null;
        if (did === '7201' && !this.unlocked) return nrc(0x33);
        this.writes[did] = hex(req.slice(3));
        if (did === '7201') this.dataset = this.writes[did] as string;
        return [0x6e, a, b];
      }
      case 0x11: {
        const f = this.fault('reset')[0];
        if (f?.answer === 'nrc') return nrc(0x22);
        this.resets++;
        this.session = 1;
        this.unlocked = false;
        if (f?.answer === 'disconnect') this.onReset?.();
        return f?.answer === 'silent' ? null : [0x51, a];
      }
      case 0x34: {
        if (!extended || !this.unlocked) return nrc(0x33);
        const override = this.fault('download')[0];
        const lengthBytes = a === 0 ? b >> 4 : 0;
        const addressBytes = b & 0x0f;
        const size = req
          .slice(3 + addressBytes, 3 + addressBytes + lengthBytes)
          .reduce((v, x) => v * 256 + x, 0);
        this.download = { size, data: [], counter: 1 };
        return override?.reply ?? [0x74, 0x20, this.maxBlockLength >> 8, this.maxBlockLength & 0xff];
      }
      case 0x36: {
        const d = this.download;
        if (!d) return nrc(0x24);
        const n = d.data.length / (this.maxBlockLength - 2) + 1;
        const f = this.fault('block').find((x) => x.n === Math.floor(n));
        if (f?.answer === 'nrc') return nrc(0x72);
        if (f?.answer === 'silent') return null;
        if (a !== d.counter) return nrc(0x73);
        if (req.length - 2 > this.maxBlockLength - 2) return nrc(0x13);
        d.data.push(...req.slice(2));
        d.counter = (d.counter + 1) & 0xff;
        return f?.answer === 'wrong-counter' ? [0x76, (a + 1) & 0xff] : [0x76, a];
      }
      case 0x37: {
        const d = this.download;
        if (this.fault('exit').length) return nrc(0x22);
        if (!d || d.data.length !== d.size) return nrc(0x24);
        this.memory = d.data;
        this.download = null;
        this.exited = true;
        return [0x77];
      }
      default:
        return nrc(0x11);
    }
  }
}

/** The cluster that answers the VIN (F190), as on the Kushaq. */
class Cluster implements EcuModel {
  readonly id = '77E';
  readonly requestId = '714';
  readonly pad = 0x55;
  readonly latencyMs = 10;
  handle(req: number[], _t: number, physical: boolean) {
    if (!physical || req[0] !== 0x22) return null;
    return req[1] === 0xf1 && req[2] === 0x90
      ? [0x62, 0xf1, 0x90, ...[...'MEXTEST0000000001'].map((c) => c.charCodeAt(0))]
      : [0x7f, 0x22, 0x31];
  }
}

async function rig(setup: (u: StrictMib3) => void = () => {}) {
  const clock = new VirtualClock();
  const unit = new StrictMib3();
  setup(unit);
  // Parked, engine off: the readiness check the session makes before writing.
  const engineEcus = kushaqLikeSpecs().map(
    (spec) => new StandardEcu({ ...spec, pids: { ...spec.pids, 12: () => [0, 0], 13: () => [0] } }),
  );
  const emulator = new Elm327Emulator({
    clock,
    ecus: [...engineEcus, unit, new Cluster()],
    protocol: 6,
    voltage: () => 12.7,
    id: 'strict',
  });
  const engine = new OBDCraftEngine({ clock });
  const run = <T>(p: Promise<T>) => runVirtual(clock, p);
  await run(engine.connect(emulator));
  const link = WebBluetoothLink.adopt(engine);
  unit.onReset = () => void emulator.close();
  return { clock, unit, emulator, engine, link, run };
}

const RITUAL = {
  pre: ['1003', '1040', '22F1A0', '22F1A1', '2704', '2EF198', '2EF199', '2EF1A0', '2EF1A1'],
  post: ['1102'],
};
const didSpec = (data = 'CCDD'): SequenceSpec => ({
  ...RITUAL,
  write: { kind: 'did', did: '7201', bytes: data },
  password: PASSWORD,
});
const downloadSpec = (data: string, post = ['37', '1102']): SequenceSpec => ({
  pre: ['1003', '1040', '2704'],
  write: { kind: 'download', address: '0D0000', addressFormat: 4, lengthFormat: 4, bytes: data },
  post,
  password: PASSWORD,
});

async function send(
  r: Awaited<ReturnType<typeof rig>>,
  spec: SequenceSpec,
  extra: { assertReady?: () => void; signal?: AbortSignal; pending?: number[]; notes?: WriterNote[] } = {},
): Promise<DidWrite> {
  const sent: number[] = [];
  const result = await r.run(
    r.link.sequence(UNIT, spec, {
      securityPassword: PASSWORD,
      onPending: () => extra.pending?.push(1),
      onSend: () => sent.push(1),
      today: () => new Date(2026, 9, 24),
      resetSettleMs: 200,
      onNote: (n: WriterNote) => extra.notes?.push(n),
      ...(extra.assertReady ? { assertReady: extra.assertReady } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
    } as Parameters<WebBluetoothLink['sequence']>[2]),
  );
  return result;
}

afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

/** Runs `task` with the virtual clock stepped only when nothing real (digests, I/O) is still in flight. */
async function drive<T>(clock: VirtualClock, task: Promise<T>): Promise<T> {
  let done = false;
  const settled = task.finally(() => {
    done = true;
  });
  for (let i = 0; i < 2_000_000 && !done; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!done && !clock.step()) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  return settled;
}

describe('payload truth is independent of what follows it (C2)', () => {
  it('payload ACK, then a refused reset: acked, the reset named and refused, nothing repeated', async () => {
    const r = await rig((u) => u.faults.push({ at: 'reset', answer: 'nrc' }));
    const res = await send(r, didSpec());
    expect(r.unit.dataset).toBe('CCDD');
    expect(res).toMatchObject({ kind: 'acked', incomplete: { step: '1102', reason: 'refused', nrc: '22' } });
    expect(res.steps).toEqual([
      { cmd: '2EF1A0AA11', outcome: 'acked' },
      { cmd: '2EF1A1BB22', outcome: 'acked' },
      { cmd: '1102', outcome: 'refused', nrc: '22' },
    ]);
    expect(r.unit.requests.filter((q) => q.startsWith('2E7201'))).toHaveLength(1);
  });

  it('payload ACK, then the readiness evidence expires: acked, and the reset is NOT sent', async () => {
    const r = await rig();
    const res = await send(r, didSpec(), {
      assertReady: () => {
        if (r.unit.dataset === 'CCDD') throw new Error('expired');
      },
    });
    expect(res).toMatchObject({ kind: 'acked', incomplete: { step: '1102', reason: 'not-ready' } });
    expect(r.unit.requests).not.toContain('1102');
  });

  it('payload ACK, then the reset goes unanswered: acked, with the reset as "no answer"', async () => {
    const r = await rig((u) => u.faults.push({ at: 'reset', answer: 'silent' }));
    const res = await send(r, didSpec());
    expect(res).toMatchObject({ kind: 'acked', incomplete: { step: '1102', reason: 'no-answer' } });
    expect(res.steps?.at(-1)).toEqual({ cmd: '1102', outcome: 'no-answer' });
  });

  it('a reset that drops the connection: the acknowledgement stands, the drop is named', async () => {
    const r = await rig((u) => u.faults.push({ at: 'reset', answer: 'disconnect' }));
    const res = await send(r, didSpec());
    expect(r.unit.dataset).toBe('CCDD');
    expect(res.kind).toBe('acked');
    expect(res.incomplete?.reason).toMatch(/link-lost|no-answer/);
  });

  it('a silent marker never blocks the payload: it is re-sent (bounded), kept as "no answer", and the change goes', async () => {
    const r = await rig((u) => u.faults.push({ at: 'marker', did: 'F199', answer: 'silent' }));
    const res = await send(r, didSpec());
    expect(res.kind).toBe('acked');
    expect(res.markers).toEqual([
      { did: 'F198', outcome: 'acked' },
      { did: 'F199', outcome: 'no-answer' }, // sent without an answer: it may have been stored — never "refused"
    ]);
    expect(r.unit.requests.filter((q) => q.startsWith('2EF199'))).toHaveLength(4); // MARKER_SENDS
    expect(r.unit.writes['7201']).toBe('CCDD');
  });

  it("runs a recipe without any security code: the key step is skipped and the unit's NRC 33 is reported", async () => {
    const r = await rig();
    const res = await r.run(
      r.link.sequence(UNIT, { ...didSpec(), password: null }, {
        securityPassword: null,
        onPending: () => {},
        today: () => new Date(2026, 9, 24),
        resetSettleMs: 200,
      } as Parameters<WebBluetoothLink['sequence']>[2]),
    );
    expect(r.unit.requests.some((q) => q.startsWith('27'))).toBe(false);
    // Refused for security in a fresh session: re-run once (sessions; still no key), then believed.
    expect(r.unit.requests.filter((q) => q.startsWith('2E7201'))).toHaveLength(2);
    expect(res).toMatchObject({ kind: 'nrc', code: '33' });
  });

  it('cancelled before anything changed: cancelled, no marker or step', async () => {
    const r = await rig();
    const controller = new AbortController();
    controller.abort();
    const res = await send(r, didSpec(), { signal: controller.signal });
    expect(res).toMatchObject({ kind: 'cancelled' });
    expect(res.markers).toBeUndefined();
    expect(r.unit.requests.some((q) => q.startsWith('2E'))).toBe(false);
  });

  it('cancelled after a mutation: cancelled before the payload, with what was changed', async () => {
    const r = await rig();
    const controller = new AbortController();
    const res = await send(r, didSpec(), {
      assertReady: () => {
        if (r.unit.writes.F1A0) controller.abort();
      },
      signal: controller.signal,
    });
    expect(res.kind).toBe('cancelled');
    expect(res.steps).toEqual([{ cmd: '2EF1A0AA11', outcome: 'acked' }]);
    expect(res.markers?.every((m) => m.outcome === 'acked')).toBe(true);
    expect(r.unit.writes['7201']).toBeUndefined();
  });

  it('refuses before any mutation when a value it must write back could not be read', async () => {
    const r = await rig((u) => u.faults.push({ at: 'read', did: 'F1A0', answer: 'nrc' }));
    const notes: WriterNote[] = [];
    const res = await send(r, didSpec(), { notes });
    expect(res).toMatchObject({ kind: 'not-sent', detail: "Your car didn't get ready for the change." });
    // The technical reason is journaled as a writer note, not shown.
    expect(notes).toContainEqual({ step: 'stopped', detail: expect.stringMatching(/F1A0/) });
    expect(res.markers).toBeUndefined();
    expect(Object.keys(r.unit.writes)).toEqual([]);
  });

  it('writes the full-size bundled preset once, and every frame fits the record', async () => {
    const payload = APP_DATA.recipes['csmqb-mib3-sound-signature']?.choices?.[0]?.payload as string;
    const r = await rig();
    const res = await send(r, didSpec(payload));
    expect(res.kind).toBe('acked');
    expect(r.unit.dataset).toBe(payload);
    expect(res.txFrames?.length).toBeGreaterThan(294);
    expect(res.txFrames?.length).toBeLessThanOrEqual(MAX_TX_FRAMES);
    expect(res.txFrames?.every((f) => f.can === '773' && f.stage === 'submitted')).toBe(true);
  });
});

describe('download protocol (C4)', () => {
  const data = (n: number) => Array.from({ length: n }, (_, i) => hex([i & 0xff])).join('');

  it('transfers in negotiated blocks with bound counters, exits, then resets', async () => {
    const r = await rig();
    const pending: number[] = [];
    const res = await send(r, downloadSpec(data(600)), { pending });
    expect(res.kind).toBe('acked');
    expect(res.incomplete).toBeUndefined();
    expect(hex(r.unit.memory)).toBe(data(600));
    expect(r.unit.exited).toBe(true);
    const blocks = r.unit.requests.filter((q) => q.startsWith('36'));
    expect(blocks.map((q) => q.slice(2, 4))).toEqual(['01', '02', '03']); // 256-byte blocks
    expect(r.unit.resets).toBe(1);
    expect(res.steps?.map((s) => s.cmd.slice(0, 2))).toEqual(['34', '11']);
  });

  it('wraps the block counter FF → 00 and the unit accepts every block', async () => {
    const r = await rig((u) => (u.maxBlockLength = 7)); // 5 data bytes per block
    const res = await send(r, downloadSpec(data(1300)));
    expect(res.kind).toBe('acked');
    const counters = r.unit.requests.filter((q) => q.startsWith('36')).map((q) => q.slice(2, 4));
    expect(counters).toHaveLength(260);
    expect(counters.slice(253, 258)).toEqual(['FE', 'FF', '00', '01', '02']);
    expect(hex(r.unit.memory)).toBe(data(1300));
  });

  it('a block answered for a different counter stops the transfer: partial', async () => {
    const r = await rig((u) => u.faults.push({ at: 'block', n: 2, answer: 'wrong-counter' }));
    const notes: WriterNote[] = [];
    const res = await send(r, downloadSpec(data(600)), { notes });
    expect(res).toMatchObject({ kind: 'partial', detail: 'The update stopped partway.' });
    expect(notes).toContainEqual({ step: 'stopped', detail: expect.stringMatching(/different block/) });
    expect(r.unit.requests.filter((q) => q.startsWith('36'))).toHaveLength(2);
    expect(r.unit.requests).not.toContain('37');
  });

  it('a refused block stops the transfer: partial, never "rejected"', async () => {
    const r = await rig((u) => u.faults.push({ at: 'block', n: 2, answer: 'nrc' }));
    const notes: WriterNote[] = [];
    const res = await send(r, downloadSpec(data(600)), { notes });
    expect(res).toMatchObject({ kind: 'partial', detail: 'The update stopped partway.' });
    expect(notes).toContainEqual({ step: 'stopped', detail: expect.stringMatching(/refused data block 2/) });
  });

  it.each([
    ['truncated', [0x74, 0x20, 0x01]],
    ['zero-size', [0x74, 0x20, 0x00, 0x00]],
    ['bad format nibble', [0x74, 0x21, 0x01, 0x02]],
  ])('a %s 74 answer: no data is sent, the accepted request is recorded', async (_name, reply) => {
    const r = await rig((u) => u.faults.push({ at: 'download', reply }));
    const res = await send(r, downloadSpec(data(600)));
    expect(res.kind).toBe('not-sent');
    expect(res.steps).toEqual([{ cmd: expect.stringMatching(/^3400/), outcome: 'acked' }]);
    expect(r.unit.requests.some((q) => q.startsWith('36'))).toBe(false);
  });

  it('a refused transfer exit: partial (all data sent, completion unconfirmed)', async () => {
    const r = await rig((u) => u.faults.push({ at: 'exit', answer: 'nrc' }));
    const notes: WriterNote[] = [];
    const res = await send(r, downloadSpec(data(300)), { notes });
    expect(res).toMatchObject({ kind: 'partial', detail: 'The update stopped partway.' });
    expect(notes).toContainEqual({ step: 'stopped', detail: expect.stringMatching(/end of the transfer/) });
    expect(r.unit.resets).toBe(0);
  });

  it("a field/ops recipe's pre-write session (vendor PreWriteCommands 104F) runs before an unlocked-free write", async () => {
    const r = await rig();
    const res = await send(r, {
      pre: ['104F'],
      write: { kind: 'did', did: '243F', bytes: '01' },
      post: [],
      password: null,
    });
    expect(res.kind).toBe('acked');
    const at = (q: string) => r.unit.requests.indexOf(q);
    expect(at('104F')).toBeGreaterThanOrEqual(0);
    expect(at('2E243F01')).toBeGreaterThan(at('104F'));
    expect(r.unit.requests.some((q) => q.startsWith('27'))).toBe(false);
  });

  it('a download without its exit, or with a write-back that was never read, refuses before anything is sent', async () => {
    expect(compileSequence(downloadSpec(data(10), ['1102']))).toEqual({
      error: expect.stringMatching(/transfer exit/),
    });
    expect(compileSequence({ ...didSpec(), pre: ['1003', '2EF1A0'] })).toEqual({
      error: expect.stringMatching(/without reading/),
    });
    expect(compileSequence({ ...didSpec(), post: ['37'] })).toEqual({
      error: expect.stringMatching(/transfer exit/),
    });
    expect(compileSequence({ ...didSpec(), pre: ['700:2E7201AA'] })).toEqual({
      error: expect.stringMatching(/not understood/),
    });
    expect(compileSequence({ ...didSpec(), pre: ['1002'] })).toEqual({
      error: expect.stringMatching(/not allowed/),
    });
    // The policy refuses it too, whatever a permit lists.
    expect(() => new SafetyPolicy(() => 0).issueCodingPermit('773', { commands: ['1086'] })).toThrow(
      /programming/,
    );
    const r = await rig();
    const res = await send(r, downloadSpec(data(10), ['1102']));
    expect(res.kind).toBe('not-sent');
    expect(r.unit.requests).toEqual([]);
  });

  describe('the permit binds a download to its planned bytes, counter and order', () => {
    const REQUEST = '340044000D000000000004';
    const permit = () => {
      const policy = new SafetyPolicy(() => 0);
      const token = policy.issueCodingPermit('773', {
        download: { request: REQUEST, payload: 'AABBCCDD', maxBlock: 2 },
      });
      return (c: string) => () => policy.check(c, { family: 'can11', target: '773' }, undefined, token);
    };

    it('allows the planned transfer exactly, then nothing more', () => {
      const check = permit();
      for (const c of [REQUEST, '3601AABB', '3602CCDD', '37']) expect(check(c)).not.toThrow();
      expect(check('3603EE')).toThrow();
      expect(check('37')).toThrow();
    });

    it.each([
      ['a block before the request', ['3601AABB']],
      ['a wrong counter', [REQUEST, '3602AABB']],
      ['altered bytes', [REQUEST, '3601AABC']],
      ['a block larger than allowed', [REQUEST, '3601AABBCC']],
      ['blocks out of order', [REQUEST, '3601CCDD']],
      ['an exit before all data', [REQUEST, '3601AABB', '37']],
    ])('refuses %s, and the permit is gone afterwards', (_name, commands) => {
      const check = permit();
      const last = commands.at(-1) as string;
      for (const c of commands.slice(0, -1)) expect(check(c)).not.toThrow();
      expect(check(last)).toThrow(/download permit/);
      expect(check(REQUEST)).toThrow();
    });
  });
});

describe('end to end: session → real sequence writer → strict unit (C2)', () => {
  it('a refused reset after the acknowledged payload: verified on read-back, the refusal recorded in the journal', async () => {
    const { runSession } = await import('../../domain/coding/run.ts');
    const { settingsOf } = await import('../../domain/catalog/features.ts');
    const recipe: DatasetRecipe = {
      ...(APP_DATA.recipes['csmqb-mib3-sound-signature'] as DatasetRecipe),
      choices: [{ id: 'variant-001', label: 'Small preset', value: 0, payload: 'CCDD' }],
    };
    const feature = {
      id: 'beats-audio',
      name: recipe.name,
      tier: 'experimental' as const,
      statusLabel: 'EXPERIMENTAL',
      recipeId: recipe.id,
      settings: settingsOf(recipe),
      proof: {
        vehicle: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo' },
        module: { request: '773', response: '7DD', part: '3G5035816A' },
        recipe: { did: '7201', byte: 0, from: 'AA', to: 'CC' },
        readback: 'CCDD',
      },
    };
    const r = await rig((u) => u.faults.push({ at: 'reset', answer: 'nrc' }));
    const records = new Map<string, Record<string, unknown>>();
    const events: { type: string; outcome?: string; phase?: string }[] = [];
    const collect = async () => {
      for await (const e of runSession(
        {
          kind: 'apply',
          car: { brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2023, cluster: 'digital' },
          feature,
          settingId: 'variant-001',
        },
        {
          link: r.link,
          backups: {
            save: async (b) =>
              void records.set(b.id, structuredClone(b) as unknown as Record<string, unknown>),
            update: async (id, patch) => void records.set(id, { ...records.get(id), ...patch }),
          },
          signal: new AbortController().signal,
          recipeFor: (id) => (id === recipe.id ? recipe : APP_DATA.recipes[id]),
          featureFor: () => feature,
          newId: () => 'e2e-0001',
          readbackDelayMs: 0,
        },
      ))
        events.push(e);
    };
    // The session also does real async work (SHA-256 digests, its own backstop timer), which `runVirtual` reads
    // as a deadlock: let real turns of the event loop run between virtual-clock steps instead.
    await drive(r.clock, collect());
    expect(r.unit.dataset).toBe('CCDD');
    expect(events.find((e) => e.type === 'outcome')).toMatchObject({
      outcome: 'verified',
      phase: expect.stringMatching(/didn't accept the restart of that part of the car/),
    });
    expect(records.get('e2e-0001')).toMatchObject({
      status: 'verified',
      ack: 'received',
      sequenceIncomplete: { step: '1102', reason: 'refused', nrc: '22' },
      sequenceSteps: [
        { cmd: '2EF1A0AA11', outcome: 'acked' },
        { cmd: '2EF1A1BB22', outcome: 'acked' },
        { cmd: '1102', outcome: 'refused', nrc: '22' },
      ],
      markers: [
        { did: 'F198', outcome: 'acked' },
        { did: 'F199', outcome: 'acked' },
      ],
    });
    expect(r.unit.requests.filter((q) => q.startsWith('2E7201'))).toHaveLength(1);
  });
});

describe('silence and the unlock (failures §2A/§3.5)', () => {
  it('a silent seed, a silent paired read and a silent session are asked again inside S3, and the payload lands', async () => {
    const r = await rig();
    const inner = r.unit.handle.bind(r.unit);
    const silentOnce = new Set(['2703', '22F1A0', '1040']);
    r.unit.handle = (req, t, physical) => {
      const cmd = hex(req);
      if (physical && silentOnce.delete(cmd)) {
        r.unit.requests.push(cmd);
        return null;
      }
      return inner(req, t, physical);
    };
    const res = await send(r, didSpec());
    expect(res).toMatchObject({ kind: 'acked' });
    expect(r.unit.dataset).toBe('CCDD');
    expect(r.unit.requests.filter((q) => q === '2703')).toHaveLength(2);
    expect(r.unit.requests.filter((q) => q.startsWith('2704'))).toHaveLength(1);
  });

  it('a refused unit-default code carries on without security; the payload 33 then says so', async () => {
    const r = await rig();
    const result = await r.run(
      r.link.sequence(UNIT, { ...didSpec(), password: '11111' }, {
        securityPassword: '11111',
        passwordSource: 'unit-default',
        onPending: () => {},
        today: () => new Date(2026, 9, 24),
        resetSettleMs: 200,
      } as Parameters<WebBluetoothLink['sequence']>[2]),
    );
    expect(result).toMatchObject({
      kind: 'nrc',
      code: '33',
      detail: expect.stringMatching(/didn't accept the usual access code.*needs its own access code/),
    });
    // Plain words only: never the code it answered, never the access code itself.
    expect((result as { detail?: string }).detail).not.toMatch(/35|11111/);
    expect(r.unit.requests.filter((q) => q.startsWith('2704'))).toHaveLength(1);
    expect(r.unit.requests.filter((q) => q.startsWith('2E7201'))).toHaveLength(1);
  });

  it('NRC 31 on the payload after a 31 marker is retried once after a re-bind and the ritual re-run', async () => {
    const r = await rig();
    const inner = r.unit.handle.bind(r.unit);
    let payloads = 0;
    r.unit.handle = (req, t, physical) => {
      const cmd = hex(req);
      if (physical && cmd.startsWith('2EF199')) {
        r.unit.requests.push(cmd);
        return [0x7f, 0x2e, 0x31];
      }
      if (physical && cmd.startsWith('2E7201') && ++payloads === 1) {
        r.unit.requests.push(cmd);
        return [0x7f, 0x2e, 0x31];
      }
      return inner(req, t, physical);
    };
    expect(await send(r, didSpec())).toMatchObject({ kind: 'acked' });
    expect(payloads).toBe(2);
    expect(r.unit.dataset).toBe('CCDD');
  });
});
