import { describe, expect, it } from 'vitest';
import { rig } from './helpers.ts';
import { scriptedRig } from './scripted.ts';
import { normalizeReply } from '../src/elm/normalize.ts';
import type { ElmTransaction } from '../src/elm/session.ts';

describe('ELM session', () => {
  it('serializes commands within a transaction and invalidates its sender when the transaction ends', async () => {
    const { emu, session, run } = rig();
    await emu.open();
    let sender: ElmTransaction | undefined;
    const replies = await run(session.transaction(async tx => {
      sender = tx;
      return Promise.all([tx.send('ATI', 1000), tx.send('AT@1', 1000)]);
    }));
    expect(replies.every(reply => reply.status === 'ok' && !reply.statuses.includes('STOPPED'))).toBe(true);
    await expect(sender!.send('ATI', 1000)).rejects.toThrow('transaction has ended');
    await emu.close();
  });
  it('frames replies on the prompt and strips echo', async () => {
    const { emu, session, run } = rig();
    await emu.open();
    const r = await run(session.send('ATI', 1000));
    expect(r.status).toBe('ok');
    expect(r.echoSeen).toBe(true);
    expect(r.lines).toEqual(['ELM327 v2.1']);
  });

  it('disposing wakes a pending command and prevents queued commands from being sent', async () => {
    const { emu, session, run, clock } = rig({ hangRate: 1 });
    await emu.open();
    const pending = session.send('0170', 10_000);
    const queued = session.send('AT@1', 1000);
    await run(clock.sleep(100));
    session.dispose();
    const replies = await run(Promise.all([pending, queued]));
    expect(replies.map((r) => r.status)).toEqual(['closed', 'closed']);
    expect(clock.now()).toBeLessThan(1000);
    expect(emu.log.some((l) => l.cmd === 'AT@1')).toBe(false);
    await emu.close();
  });

  it('enforces a hard timeout and recovers without a lone CR (bug 6)', async () => {
    const { emu, session, run, wire, clock } = rig();
    await emu.open();
    await run(session.send('ATE0', 1000));
    emu.set({ hangRate: 1 });
    const t0 = clock.now();
    const r = await run(session.send('0170', 2000));
    emu.set({ hangRate: 0 });
    expect(r.status).toBe('timeout');
    expect(r.durationMs).toBeGreaterThanOrEqual(2000);
    expect(r.durationMs).toBeLessThan(2100);
    expect(r.recovery?.ok).toBe(true);
    expect(r.recovery?.steps[0]).toBe('"X"');
    // total time including recovery stays bounded
    expect(clock.now() - t0).toBeLessThan(5000);
    const txs = wire.filter((w) => w.dir === 'tx').map((w) => w.text);
    expect(txs).not.toContain('\r');
    // the next command works normally
    const ok = await run(session.send('ATI', 1000));
    expect(ok.lines).toEqual(['ELM327 v2.1']);
  });

  it('recovers when only the prompt was lost (adapter idle)', async () => {
    const { emu, session, run } = rig();
    await emu.open();
    await run(session.send('ATE0', 1000));
    emu.dropNextPrompt();
    const r = await run(session.send('ATI', 800));
    expect(r.status).toBe('timeout');
    expect(r.recovery?.ok).toBe(true);
    // 'X' sat in the ELM buffer, so the second step ended as "XATI" -> '?'
    expect(r.recovery?.steps).toEqual(['"X"', '"ATI\\r"']);
    const ok = await run(session.send('ATI', 1000));
    expect(ok.lines).toEqual(['ELM327 v2.1']);
  });

  it('a throttled timer cannot stretch the deadline: the clock is checked on every wake-up', async () => {
    const { emu, session, run, clock } = rig();
    await emu.open();
    emu.set({ hangRate: 1 });
    // simulate Chrome throttling: sleep() fires 60 s late
    const orig = clock.sleep.bind(clock);
    clock.sleep = (ms: number) => orig(ms + 60_000);
    const r = await run(session.send('0170', 2000));
    clock.sleep = orig;
    expect(r.status).toBe('timeout');
    // without visibility handling the wake-up itself is late, but the session reports it as a timeout
    // at the first wake-up instead of waiting for another full timeout
    expect(r.durationMs).toBeLessThan(63_000);
  });

  it('normalizes SEARCHING, NO DATA and error tails', () => {
    expect(normalizeReply('0100\rSEARCHING...\r7E8 06 41 00 BE 3E A8 13 00\r\r>', '0100')).toMatchObject({
      lines: ['7E8 06 41 00 BE 3E A8 13 00'], searching: true, echoSeen: true,
    });
    expect(normalizeReply('NO DATA\r\r>', '0A').statuses).toEqual(['NO DATA']);
    expect(normalizeReply('7E8 03 41 0D 00 <RX ERROR\r>', '010D')).toMatchObject({ lines: ['7E8 03 41 0D 00'], statuses: ['RX ERROR'] });
    expect(normalizeReply('?\r>', 'ATXX').statuses).toEqual(['?']);
  });
});

describe('ElmLink configuration stays true to the adapter', () => {
  it('a refused receive filter is reported and cleared, never left pointing at the previous module', async () => {
    // 7E1 answers on 7E9; the adapter refuses that filter while 7E0's (7E8) was in place.
    const r = scriptedRig((cmd) => (cmd === 'ATCRA7E9' ? '?' : ''));
    r.link.config.target = '7E0';
    const result = await r.run(r.link.apply({ target: '7E1' }));
    expect(result.failed).toContain('ATCRA7E9');
    expect(r.elm.log.map((l) => l.cmd)).toContain('ATCRA');
    expect(r.elm.state.cra).toBeNull();
  });

  it('records header, spacing, header-display and timing changes made through at()', async () => {
    const r = scriptedRig(() => '');
    await r.run(r.link.at('ATH0'));
    await r.run(r.link.at('ATS0'));
    await r.run(r.link.at('ATAT2'));
    await r.run(r.link.at('ATSH70E'));
    expect(r.link.config).toMatchObject({ headers: false, spaces: false, adaptiveTiming: 2, target: '70E' });
    await r.run(r.link.at('ATSH7DF'));
    expect(r.link.config.target).toBe('functional');
  });
});
