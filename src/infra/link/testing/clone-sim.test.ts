/**
 * Calibration of the clone simulator (forensics BRIEF.md §2.5): before any writer is judged against it, the
 * simulator must reproduce what the live traces measured. If one of these fails, the simulator is wrong — not
 * the writer.
 *
 * Full calibration (500 seeds for the HEAD replay): `CLONE_SIM_SEEDS=500 npx vitest run clone-sim.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElmLink } from '@obdcraft/obd-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DidWrite, ModuleAddress, WriteOptions } from '../../../domain/coding/types.ts';
import { writeCodingDid } from '../ble-writer.ts';
import { WebBluetoothLink } from '../web-bluetooth.ts';
import { DEFAULT_FAULT_MODEL, type EcuSpec, kushaqEcus, type TruthEvent } from './clone-sim.ts';
import { drive, installDeterministicDigest, type SimRig, simRig } from './harness.ts';

const SEEDS = Number(process.env.CLONE_SIM_SEEDS ?? 100);

let restoreDigest = () => {};
beforeAll(() => {
  restoreDigest = installDeterministicDigest();
});
afterAll(() => restoreDigest());
afterEach(async () => {
  await WebBluetoothLink.retireCurrent();
});

const BCM: ModuleAddress = { request: '70E', response: '778' };
const CLU: ModuleAddress = { request: '714', response: '77E' };

/** Raw adapter conversation on a connected rig: one command, its reply lines and how long the host waited. */
async function cmd(r: SimRig, command: string): Promise<{ lines: string[]; ms: number; silent: boolean }> {
  const session = r.engine.session;
  if (!session) throw new Error('not connected');
  const t = r.clock.now();
  const reply = await session.send(command, 8000);
  const lines = reply.lines.map((l) => l.trim()).filter(Boolean);
  const silent = reply.statuses.includes('NO DATA') || reply.statuses.includes('UNABLE TO CONNECT');
  return { lines, ms: r.clock.now() - t, silent };
}

/** Coding-channel addressing (as `withUdsChannel` sets it up), ending in a pending search. */
async function bind(r: SimRig, m: ModuleAddress, extra: string[] = []): Promise<void> {
  for (const c of [
    'ATH1',
    'ATS1',
    'ATCAF0',
    'ATCFC1',
    `ATSH${m.request}`,
    `ATCRA${m.response}`,
    `ATFCSH${m.request}`,
    ...extra,
    'ATSP0',
  ])
    await cmd(r, c);
}

/** Re-search and send until the module answers (bounded); the answer's data bytes. */
async function ask(r: SimRig, frame: string): Promise<number[]> {
  for (let i = 0; i < 12; i++) {
    await cmd(r, 'ATSP0');
    const a = await cmd(r, frame);
    if (!a.silent) return dataOf(a.lines[0] ?? '');
  }
  throw new Error(`no answer to ${frame}`);
}

/** `778 06 67 03 ...` / `00 00 07 78 06 67 03 ...` → the UDS bytes after the PCI. */
const dataOf = (line: string): number[] => {
  const parts = line.split(/\s+/);
  const body = parts.length > 9 ? parts.slice(4) : parts.slice(1);
  const bytes = body.map((b) => Number.parseInt(b, 16));
  return bytes.slice(1, 1 + ((bytes[0] ?? 0) & 15));
};
/** The module's current challenge: 27 03, re-opening the extended session first if it lapsed meanwhile. */
async function seedOf(r: SimRig): Promise<number[]> {
  for (let i = 0; i < 4; i++) {
    const a = await ask(r, '022703');
    if (a[0] === 0x67) return a.slice(2);
    await ask(r, '021003');
  }
  throw new Error('no seed');
}
const truthAfter = (r: SimRig, t: number) => r.sim.truth.filter((e) => e.t >= t);

describe('clone simulator — calibration (BRIEF §2.5)', () => {
  it('1. idle drops: a locked 3E after 500 ms idle drops ~95 %; right after ATSP0 ~9 %', async () => {
    let idle = 0;
    let idleSilent = 0;
    let search = 0;
    let searchSilent = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = await simRig({ seed, ecus: kushaqEcus() });
      await drive(r.clock, async () => {
        await bind(r, BCM);
        for (let k = 0; k < 10; k++) {
          await cmd(r, 'ATSP0');
          const s = await cmd(r, '023E00');
          search++;
          if (s.silent) searchSilent++;
          await r.clock.sleep(500);
          const l = await cmd(r, '023E00');
          idle++;
          if (l.silent) idleSilent++;
        }
      });
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
    expect(idleSilent / idle).toBeGreaterThan(0.9);
    expect(idleSilent / idle).toBeLessThan(0.99);
    // Marginal of the bursty search model: 0.06 after an answered search, 0.36 after a silent one (≈ 0.086).
    expect(searchSilent / search).toBeGreaterThan(0.05);
    expect(searchSilent / search).toBeLessThan(0.14);
  });

  it('2. a dropped key leaves the seed unchanged; a delivered key rolls it', async () => {
    let dropped = 0;
    let delivered = 0;
    for (let seed = 1; seed <= 200 && (dropped < 20 || delivered < 2); seed++) {
      const r = await simRig({ seed, ecus: kushaqEcus() });
      await drive(r.clock, async () => {
        await bind(r, BCM);
        await ask(r, '021003');
        const s1 = await seedOf(r);
        const key = ((s1.reduce((v, b) => v * 256 + b, 0) + 31347) >>> 0)
          .toString(16)
          .toUpperCase()
          .padStart(8, '0');
        // Sent after 600 ms of idle: the clone drops it ~95 % of the time.
        await r.clock.sleep(600);
        const t = r.clock.now();
        await cmd(r, `062704${key}`);
        const keyArrived = truthAfter(r, t).some((e) => e.type === 'key');
        // As live: the seed is asked again inside a re-opened session when the retries outlasted S3.
        const s2 = await seedOf(r);
        if (keyArrived) {
          delivered++;
          expect(s2).not.toEqual(s1);
        } else {
          dropped++;
          expect(s2).toEqual(s1);
        }
      });
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
    expect(dropped).toBeGreaterThanOrEqual(20);
    expect(delivered).toBeGreaterThan(0);
  });

  it('3. S3 lapse: 5.1 s between delivered requests, then 2E → 7F 2E 31; 3E still 7E 00; 4 s keeps it', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = await simRig({ seed, ecus: kushaqEcus() });
      await drive(r.clock, async () => {
        await bind(r, BCM);
        expect((await ask(r, '021003')).slice(0, 2)).toEqual([0x50, 0x03]);
        await r.clock.sleep(4000);
        expect(await ask(r, '052EF199261102')).toEqual([0x6e, 0xf1, 0x99]);
        await r.clock.sleep(5100);
        const t = r.clock.now();
        expect(await ask(r, '052EF199261102')).toEqual([0x7f, 0x2e, 0x31]);
        expect(truthAfter(r, t).some((e) => e.type === 'session' && e.why === 's3-lapse')).toBe(true);
        expect(await ask(r, '023E00')).toEqual([0x7e, 0x00]);
      });
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
  });

  it('4. ATST is ignored: after ATSTFF a dropped request is still NO DATA at ~205 ms (host 205–290 ms)', async () => {
    const times: number[] = [];
    let sent = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const r = await simRig({ seed, ecus: kushaqEcus() });
      await drive(r.clock, async () => {
        await bind(r, BCM);
        await ask(r, '023E00');
        for (let k = 0; k < 5; k++) {
          // An AT command with no search pending: the next locked send is stale (~95 % dropped).
          await cmd(r, 'ATSTFF');
          const t = r.clock.now();
          const a = await cmd(r, '023E00');
          sent++;
          const drop = truthAfter(r, t).find((e) => e.type === 'dropped');
          if (a.silent && drop?.type === 'dropped' && drop.reason === 'stale-at') times.push(a.ms);
        }
      });
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
    expect(times.length / sent).toBeGreaterThan(0.88);
    for (const ms of times) {
      expect(ms).toBeGreaterThanOrEqual(DEFAULT_FAULT_MODEL.windowMs);
      expect(ms).toBeLessThan(290);
    }
  });

  it('5. 4-CF cap: a 43-byte read arrives as FF + 4 CFs, prompt at ~950 ms', async () => {
    const ecus: EcuSpec[] = kushaqEcus({ values: { '70E:ABCD': '11'.repeat(40) } });
    for (let seed = 1; seed <= 20; seed++) {
      const r = await simRig({ seed, ecus });
      await drive(r.clock, async () => {
        // The live capture's flow control: block size 0, 5 ms.
        await bind(r, BCM, ['ATFCSD300005', 'ATFCSM1']);
        for (let i = 0; i < 12; i++) {
          await cmd(r, 'ATSP0');
          const a = await cmd(r, '0322ABCD');
          if (a.silent) continue;
          expect(a.lines.filter((l) => / 1[0-9A-F] [0-9A-F]{2} 62 AB CD/.test(l))).toHaveLength(1);
          expect(a.lines).toHaveLength(5);
          // Host-side: search delay + ~950 ms adapter wait.
          expect(a.ms).toBeGreaterThan(900);
          expect(a.ms).toBeLessThan(1400);
          return;
        }
        throw new Error('never answered');
      });
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
  });

  it('determinism: one seed gives one transcript; another seed another', async () => {
    const run = async (seed: number) => {
      const r = await simRig({ seed, ecus: kushaqEcus({ values: { '70E:0A5E': '3A00000000' } }) });
      await drive(r.clock, () =>
        r.link.writeDid(BCM, '0A5E', '3E00000000', {
          securityPassword: '31347',
          originalBytes: '3A00000000',
          onPending: () => {},
          today: () => new Date(2026, 10, 2),
        } as WriteOptions),
      );
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
      return r.sim.transcriptHash();
    };
    expect(await run(7)).toBe(await run(7));
    expect(await run(7)).not.toBe(await run(8));
  });
});

describe('clone simulator — a write answered 78 whose change lands on the byte-8 stray (live 2026-11-09)', () => {
  /** BCM 0A5F, 4 bytes: `2E 0A 5F b0 b1 b2 b3` is a full 8-byte single frame, so b3 is where the stray lands. */
  const strayRig = (seed: number, strayByte: number | undefined) =>
    simRig({
      seed,
      ecus: kushaqEcus({ values: { '70E:0A5F': '00000030' } }).map((e) =>
        e.request === '70E' && strayByte !== undefined ? { ...e, strayByte } : e,
      ),
    });
  const write = (r: SimRig, after: string) =>
    drive(r.clock, () =>
      r.link.writeDid(BCM, '0A5F', after, {
        securityPassword: '31347',
        originalBytes: '00000030',
        onPending: () => {},
        today: () => new Date(2026, 10, 9),
      } as WriteOptions),
    );
  const delivered = (r: SimRig) =>
    r.sim.truth.filter((e) => e.type === 'writeDelivered' && e.did === '0A5F').length;

  it('78, then the module answers reads with the pre-write bytes: reported as stored, never re-sent', async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const r = await strayRig(seed, 0x30);
      const res = await write(r, '00000031');
      // Delivered once (answered 78), committed with the stray: the module holds 00000030, the pre-write value.
      expect(delivered(r), `seed ${seed}`).toBe(1);
      expect(r.sim.stored('70E', '0A5F')).toBe('00000030');
      expect(res, `seed ${seed}`).toMatchObject({ kind: 'pending-no-final', stored: '00000030' });
      expect(r.sim.truth.filter((e) => e.type === 'key' && e.duplicate)).toHaveLength(0);
      await drive(r.clock, () => WebBluetoothLink.retireCurrent());
    }
  });

  it('a change away from the stray position is unaffected: stored as intended, no stored field', async () => {
    const r = await strayRig(3, 0x30);
    // b1 changes, b3 already holds the stray byte: the write lands whole.
    const res = await write(r, '00010030');
    expect(r.sim.stored('70E', '0A5F')).toBe('00010030');
    expect(res.kind === 'pending-no-final' ? res.stored : undefined).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. Replay of the deployed build (HEAD 26c9b50, the only writer that ran on the car, 11-01)
// ---------------------------------------------------------------------------------------------------------------

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const DEPLOYED = '26c9b50';

type Writer = (
  link: ElmLink,
  module: ModuleAddress,
  did: string,
  bytes: string,
  options: WriteOptions & { today?: () => Date },
) => Promise<DidWrite>;

/**
 * The deployed writer and its UDS channel, extracted with `git show` into a temp folder, imports pointed at this
 * tree. Everything else (engine, session, policy, link) is today's. Undefined without git or the commit.
 */
async function deployedWriter(): Promise<Writer | undefined> {
  let writer: string;
  let uds: string;
  try {
    const show = (path: string) =>
      execFileSync('git', ['show', `${DEPLOYED}:${path}`], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
    writer = show('src/infra/link/ble-writer.ts');
    uds = show('packages/obd-core/src/elm/uds.ts');
  } catch {
    return undefined;
  }
  const dir = join(tmpdir(), `obdcraft-deployed-${DEPLOYED}`);
  mkdirSync(dir, { recursive: true });
  const core = join(REPO, 'packages/obd-core/src');
  writeFileSync(
    join(dir, 'uds.ts'),
    uds
      .replace(/from '\.\.\/([^']+)'/g, `from '${core}/$1'`)
      .replace(/from '\.\/([^']+)'/g, `from '${core}/elm/$1'`),
  );
  writeFileSync(
    join(dir, 'core.ts'),
    [
      `export * from '${core}/index.ts';`,
      `export { CHANNEL_CONFIG_BUDGET_MS, CHANNEL_RESTORE_BUDGET_MS, CODING_TIMING, READ_TIMING, UdsExchangeError, exchangeUds, withUdsChannel } from './uds.ts';`,
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'ble-writer.ts'),
    writer
      .replace(`from '@obdcraft/obd-core'`, `from './core.ts'`)
      .replace(`from '../../domain/coding/types.ts'`, `from '${join(REPO, 'src/domain/coding/types.ts')}'`)
      .replace(`from './tx-evidence.ts'`, `from '${join(REPO, 'src/infra/link/tx-evidence.ts')}'`),
  );
  const mod = (await import(/* @vite-ignore */ join(dir, 'ble-writer.ts'))) as { writeCodingDid: Writer };
  return mod.writeCodingDid;
}

/** HEAD's readiness evidence expired 30 s after it was measured; the write starts ~5 s after the measurement. */
const READINESS_MAX_AGE_MS = 30_000;
const READINESS_LEAD_MS = 5_000;

const RECIPES = [
  { name: 'BCM 0A5E', m: BCM, did: '0A5E', before: '3A00000000', after: '3E00000000', password: '31347' },
  { name: 'CLU 0E46', m: CLU, did: '0E46', before: '31', after: '00', password: '47115' },
] as const;

interface WriterRun {
  stored: boolean;
  result: DidWrite['kind'];
  code?: string;
  falseNrc31: boolean;
  notReady: boolean;
  duplicateKeys: number;
  ms: number;
}

async function writerRun(
  write: Writer,
  seed: number,
  rc: (typeof RECIPES)[number],
  /** HEAD's domain passed a readiness check that expired 30 s after the measurement; today's passes none. */
  readinessWindow: boolean,
): Promise<WriterRun> {
  const { m, did, before, after, password } = rc;
  const r = await simRig({ seed, ecus: kushaqEcus({ values: { [`${m.request}:${did}`]: before } }) });
  const link = r.engine.link;
  if (!link) throw new Error('not connected');
  const t0 = r.clock.now();
  const res = await drive(r.clock, () =>
    write(link, m, did, after, {
      securityPassword: password,
      originalBytes: before,
      onPending: () => {},
      today: () => new Date(2026, 10, 1),
      ...(readinessWindow
        ? {
            assertReady: () => {
              if (r.clock.now() - t0 + READINESS_LEAD_MS > READINESS_MAX_AGE_MS)
                throw new Error('readiness expired');
            },
          }
        : {}),
    } as WriteOptions),
  );
  const ms = r.clock.now() - t0;
  await drive(r.clock, () => WebBluetoothLink.retireCurrent());
  const lapsed31 = r.sim.truth.some(
    (e: TruthEvent) =>
      e.type === 'nrc' && e.service === 0x2e && e.nrc === 0x31 && e.cause === 'default-session',
  );
  return {
    stored: r.sim.stored(m.request, did) === after,
    result: res.kind,
    ...(res.kind === 'nrc' ? { code: res.code } : {}),
    falseNrc31: res.kind === 'nrc' && res.code === '31' && lapsed31,
    notReady: res.kind === 'not-sent' && res.reason === 'not-ready',
    duplicateKeys: r.sim.truth.filter((e) => e.type === 'key' && e.duplicate).length,
    ms,
  };
}

describe('clone simulator — replay of the deployed writer (BRIEF §2.5 item 6)', () => {
  it(`HEAD ${DEPLOYED} lands the BCM/CLU write on the first attempt 25–40 % of the time, with the live failure signatures`, async () => {
    const write = await deployedWriter();
    if (!write) return; // no git history here: nothing to replay
    const lines: string[] = [];
    for (const rc of RECIPES) {
      const runs: WriterRun[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) runs.push(await writerRun(write, seed, rc, true));
      const rate = runs.filter((x) => x.stored).length / runs.length;
      const kinds: Record<string, number> = {};
      for (const x of runs)
        kinds[x.code ? `nrc ${x.code}` : x.result] = (kinds[x.code ? `nrc ${x.code}` : x.result] ?? 0) + 1;
      lines.push(
        `${rc.name}: ${(100 * rate).toFixed(1)}% stored over ${runs.length} seeds; false31 ${runs.filter((x) => x.falseNrc31).length}, not-ready ${runs.filter((x) => x.notReady).length}; ${JSON.stringify(kinds)}`,
      );
      // 500 seeds: the brief's band. Fewer: the same band widened by ~2 standard errors.
      const slack = SEEDS >= 500 ? 0 : 2 * Math.sqrt((0.33 * 0.67) / SEEDS);
      expect(rate).toBeGreaterThanOrEqual(0.25 - slack);
      expect(rate).toBeLessThanOrEqual(0.4 + slack);
      // The signatures the traces show: a false "doesn't have this setting" (31 from a lapsed session) and the
      // readiness window expiring during the waits.
      expect(runs.some((x) => x.falseNrc31)).toBe(true);
      expect(runs.some((x) => x.notReady)).toBe(true);
    }
    process.stdout.write(`\n[clone-sim] deployed writer ${DEPLOYED}:\n  ${lines.join('\n  ')}\n`);
  }, 600_000);

  it('the current writer, same harness: far above the deployed band, never a duplicate key or a false 31', async () => {
    const lines: string[] = [];
    for (const rc of RECIPES) {
      const runs: WriterRun[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) runs.push(await writerRun(writeCodingDid, seed, rc, false));
      const rate = runs.filter((x) => x.stored).length / runs.length;
      const dupKeys = runs.reduce((a, x) => a + x.duplicateKeys, 0);
      lines.push(
        `${rc.name}: ${(100 * rate).toFixed(1)}% stored over ${runs.length} seeds; dupKeys ${dupKeys}`,
      );
      // A floor, not the measured rate (97–100 %): a regression toward the deployed 25–40 % band fails here.
      expect(rate).toBeGreaterThanOrEqual(0.9);
      expect(dupKeys).toBe(0);
      expect(runs.filter((x) => x.falseNrc31)).toHaveLength(0);
    }
    process.stdout.write(`\n[clone-sim] current writer:\n  ${lines.join('\n  ')}\n`);
  }, 600_000);
});
