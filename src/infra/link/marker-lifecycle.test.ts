/**
 * Independent review 2026-10-25, R3: a marker whose frame went out is recorded even if the adapter
 * disconnects before its answer. Promoted from docs/reviews/2026-10-25/independent/review.test.ts.
 */
import { expect, it } from 'vitest';
import { scriptedRig } from '../../../packages/obd-core/test/scripted.ts';
import { writeCodingDid } from './ble-writer.ts';

it('re-arms the session and security before the payload when a silent marker wait went stale', async () => {
  // Live 2026-10-30: an ~8 s silent F199 wait outlived S3 after the security unlock — the
  // payload and both markers came back NRC 31. Marker waits are now capped, and a stale gap
  // re-opens the session and re-unlocks (a fresh seed, never a re-sent exchange) before writing.
  let f199Writes = 0;
  const sent: string[] = [];
  const r = scriptedRig((cmd) => {
    if (/^[0-9A-F]+$/.test(cmd)) sent.push(cmd);
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '0322F199') return '778 06 62 F1 99 24 10 25';
    if (cmd === '0322F1A5') return '778 05 62 F1 A5 01 02';
    // Tester present never answers — the swallowed keepalive leaves lastReply stale.
    if (cmd === '023E00') return 'NO DATA';
    if (cmd === '022703') return '778 06 67 03 39 6A 08 20';
    if (cmd.startsWith('062704')) return '778 02 67 04';
    if (cmd.startsWith('062EF199')) {
      f199Writes++;
      // Two silent attempts (~3 s each); the third is refused.
      return f199Writes < 3 ? { body: '', prompt: false } : '778 03 7F 2E 31';
    }
    if (cmd.startsWith('052EF198')) return '778 03 7F 2E 31';
    if (cmd === '042E0A5E3E') return '778 03 6E 0A 5E';
    if (cmd === '03220A5E') return '778 04 62 0A 5E 3E';
    return '';
  });
  const result = await r.run(
    writeCodingDid(r.link, { request: '70E', response: '778' }, '0A5E', '3E', {
      securityPassword: '12345',
      onPending: () => {},
    }),
  );
  // Markers never block: F199 spent its one re-arm and gave up (it may be stored: `no-answer`), the
  // payload kept its own re-arms and landed.
  expect(result).toMatchObject({ kind: 'acked' });
  expect(result.markers).toContainEqual({ did: 'F199', outcome: 'no-answer' });
  expect(result.markers).toContainEqual({ did: 'F198', outcome: 'not-hosted' });
  // Every send after a stale gap went into a re-armed session: 10 03 + a fresh challenge first. The first
  // challenge follows the opening probes directly — their answers keep the session proven (BRIEF B10).
  const seeds = sent.flatMap((c, i) => (c === '022703' ? [i] : []));
  expect(seeds.length).toBeGreaterThanOrEqual(2);
  expect(sent[(seeds[0] ?? 0) - 1]).toBe('0322F1A5');
  for (const i of seeds.slice(1)) expect(sent[i - 1]).toBe('021003');
  // Any 10 03 voids the grant: every re-armed session gets its key, even for a repeated challenge.
  expect(sent.filter((c) => c.startsWith('062704'))).toHaveLength(seeds.length);
  // The payload went into a session re-armed after the last stale (silent) marker wait.
  const payload = sent.indexOf('042E0A5E3E');
  expect(payload).toBeGreaterThan(-1);
  const lastF199 = sent.flatMap((c, i) => (c.startsWith('062EF199') ? [i] : [])).at(-1) ?? -1;
  expect(sent.lastIndexOf('021003', payload)).toBeGreaterThan(lastF199);
});

it('still proof-reads and re-sends after a pending write outlived the readiness window', async () => {
  // Live 2026-10-31: a 30 s response-pending write ended with the readiness evidence expired.
  // The proof read's own send hit assertReady, so the DID was never re-read, no re-send ran and
  // the journal could only report mismatch. Post-transmit steps must not gate on that window.
  let stale = false;
  const sent: string[] = [];
  const r = scriptedRig((cmd) => {
    if (/^[0-9A-F]+$/.test(cmd)) sent.push(cmd);
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '0322F199') return '778 03 7F 22 31';
    if (cmd === '0322F1A5') return '778 03 7F 22 31';
    if (cmd === '023E00') return '778 02 7E 00';
    if (cmd === '022703') return '778 06 67 03 39 6A 08 20';
    if (cmd.startsWith('062704')) return '778 02 67 04';
    if (cmd.startsWith('062EF199')) return '778 03 6E F1 99';
    if (cmd === '03220A5E') return '778 04 62 0A 5E 3A'; // proof: still the pre-write byte
    if (cmd === '042E0A5E3E') {
      stale = true; // the write's own wait is what lets the evidence lapse
      return { body: '', prompt: false }; // response-pending forever: the write times out
    }
    return '';
  });
  const result = await r.run(
    writeCodingDid(r.link, { request: '70E', response: '778' }, '0A5E', '3E', {
      securityPassword: '12345',
      originalBytes: '3A',
      onPending: () => {},
      assertReady: () => {
        if (stale) throw new Error('Readiness expired before transmission.');
      },
    }),
  );
  expect(result).toMatchObject({ kind: expect.stringMatching(/pending-no-final|no-reply/) });
  // The in-session proof read ran even though the readiness window had lapsed…
  expect(sent).toContain('03220A5E');
  // …and the module's unchanged memory authorized one identical re-send: a silent single frame may have been
  // delivered and ignored (B7 0574, live 3/3), so it is never sent more than twice (BRIEF §5.9).
  expect(sent.filter((c) => c === '042E0A5E3E')).toHaveLength(2);
});

it('keeps an in-flight F199 marker as "may be stored" when the adapter disconnects before its ACK', async () => {
  const r = scriptedRig((cmd) => {
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '0322F199') return '778 06 62 F1 99 24 10 25';
    if (cmd === '0322F1A5') return '778 03 7F 22 31';
    if (cmd === '023E00') return '778 02 7E 00';
    if (cmd.startsWith('062EF199')) {
      r.clock.schedule(1, () => void r.elm.close());
      return { body: '', prompt: false };
    }
    return '';
  });
  const result = await r.run(
    writeCodingDid(r.link, { request: '70E', response: '778' }, '0A5E', '3E00000000', {
      securityPassword: null,
      onPending: () => {},
    }),
  );
  expect(r.elm.log.some((l) => l.cmd.startsWith('062EF199'))).toBe(true);
  expect(result).toMatchObject({ kind: 'link-lost', markers: [{ did: 'F199', outcome: 'no-answer' }] });
});
