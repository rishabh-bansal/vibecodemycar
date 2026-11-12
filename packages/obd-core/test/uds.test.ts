import { describe, expect, it } from 'vitest';
import { exchangeUds, LOCKED_IDLE_MAX_MS, segmentDiagnosticPdu, separationTimeMs, stpxCommand, transmittedFrame, UdsExchangeError, withUdsChannel } from '../src/elm/uds.ts';
import type { AdapterProfile } from '../src/adapters/identify.ts';
import { toHex } from '../src/util/hex.ts';
import { scriptedRig } from './scripted.ts';

describe('logical UDS requests over raw ELM CAN', () => {
  it.each([[0x10, 0x03], [0x3e, 0x00]])('finishes native optional %j NO DATA at its prompt', async (service, subfunction) => {
    const r = scriptedRig(cmd => /^[0-9A-F]+$/.test(cmd) ? 'NO DATA' : '');
    r.link.nativeBind = true;
    await expect(r.run(exchangeUds(r.link, [service, subfunction], {
      target: '710', responseId: '77A', padding: 'native', timeoutMs: 6000,
    }))).rejects.toMatchObject({ failure: 'timeout' });
    // The caller still receives a failure and must decide whether this particular reply was optional.
    // No extra 3–6 second listening window follows a completed empty prompt.
    expect(r.clock.now()).toBeLessThan(1000);
    expect(r.elm.log.some(e => e.cmd === 'ATMA')).toBe(false);
  });

  it('keeps the native diagnostic wire silent after 78 while a final reply arrives past P2*', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '042E0E4600') {
        r.elm.emitLater('77E 03 6E 0E 46 AA AA AA AA', 12_000);
        return '77E 03 7F 2E 78 AA AA AA AA';
      }
      if (cmd === 'ATMA') return '?'; // This command was actually refused by the live adapter.
      return '';
    });
    r.link.nativeBind = true;
    const token = r.link.policy.issueCodingToken('2E0E4600', '714');
    let pending = 0;
    const result = await r.run(exchangeUds(r.link, [0x2e, 0x0e, 0x46, 0], {
      target: '714', responseId: '77E', padding: 'native', codingToken: token,
      timeoutMs: 30_000, onResponsePending: () => pending++,
    }));
    expect(result.response).toEqual([0x6e, 0x0e, 0x46]);
    expect(pending).toBe(1);
    expect(r.elm.sentTo('714')).toEqual(['042E0E4600']);
    expect(r.elm.log.map(e => e.cmd)).not.toContain('ATMA');
    expect(result.endedAt - result.startedAt).toBeGreaterThanOrEqual(12_000);
  });

  it('ends the captured F187 NO DATA read at its prompt, without ATMA, retries or accepting a late reply', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '0322F187') {
        // Same SEARCHING/NO DATA shape as the 2026-10-26 live attempt; a subsequent stray reply
        // must not turn the completed empty read into successful identity evidence.
        r.elm.emitLater('00 00 07 78 07 62 F1 87 54 45 53 54', 1000);
        return { body: 'SEARCHING...\rNO DATA', prompt: true, delayMs: 499 };
      }
      if (cmd === 'ATMA') return '?';
      return '';
    });
    const failure = await r.run(exchangeUds(r.link, [0x22, 0xf1, 0x87], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 8000,
    })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UdsExchangeError);
    expect((failure as UdsExchangeError).replies.some(reply => reply.statuses.includes('NO DATA'))).toBe(true);
    expect(r.clock.now()).toBeLessThan(1000);
    expect(r.elm.log.some(e => e.cmd === 'ATMA')).toBe(false);
    expect(r.elm.sentTo('70E')).toEqual(['0322F187']);
  });

  it('stops waiting on a read response-pending that never resolves instead of wedging the link', async () => {
    // Live 2026-10-30: unit-09 DID 0560 answered 7F 22 78 then went silent; waiting the full read
    // budget outlasted the BLE idle timeout and every sweep died at that DID. The pending window
    // is bounded so the DID classifies unanswered and the sweep moves on.
    const r = scriptedRig(cmd => {
      if (cmd === '03220560') return '778 03 7F 22 78 00 00 00 00';
      if (cmd === 'ATMA') return '?'; // No further frames ever arrive for this DID.
      if (cmd === 'X') return 'STOPPED';
      return '';
    });
    const started = r.clock.now();
    let pending = 0;
    const failure = await r.run(exchangeUds(r.link, [0x22, 0x05, 0x60], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 15_000,
      onResponsePending: () => pending++,
    })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UdsExchangeError);
    expect((failure as UdsExchangeError).failure).toBe('timeout');
    expect(pending).toBe(1);
    expect(r.elm.sentTo('70E')).toEqual(['03220560']);
    // ~3 s pending window, never the 15 s read budget that outlives the BLE link.
    expect(r.clock.now() - started).toBeLessThan(10_000);
  });

  it('still waits for a read that actually returned response-pending alongside NO DATA', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '0322F187') {
        r.elm.emitLater('00 00 07 78 07 62 F1 87 54 45 53 54', 1000);
        return '00 00 07 78 03 7F 22 78 AA AA AA AA\rNO DATA';
      }
      if (cmd === 'ATMA') return '?';
      return '';
    });
    const result = await r.run(exchangeUds(r.link, [0x22, 0xf1, 0x87], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 8000,
    }));
    expect(result.response).toEqual([0x62, 0xf1, 0x87, 0x54, 0x45, 0x53, 0x54]);
    expect(r.elm.sentTo('70E')).toEqual(['0322F187']);
  });

  it('segments known coding bytes and wraps sequence numbers without changing the PDU', () => {
    const frames = segmentDiagnosticPdu([0x2e, 6, 0, ...Array.from({ length: 20 }, (_, i) => i + 1)]);
    expect(frames.map(frame => toHex(frame, ''))).toEqual(['10172E0600010203', '210405060708090A', '220B0C0D0E0F1011', '2312131400000000']);
    const wrapped = segmentDiagnosticPdu(Array(130).fill(0x55));
    expect(wrapped.slice(15, 18).map(frame => frame[0])).toEqual([0x2f, 0x20, 0x21]);
    expect(() => segmentDiagnosticPdu(Array(4096).fill(0))).toThrow();
    expect(() => segmentDiagnosticPdu([256])).toThrow();
    expect([separationTimeMs(0), separationTimeMs(127), separationTimeMs(0xf5)]).toEqual([0, 127, 1]);
    expect(() => separationTimeMs(0x80)).toThrow();
  });

  it('honours block size and separation, serialises configuration, sends once and restores normal reads', async () => {
    let responses = true;
    const sent: { cmd: string; responses: boolean; at: number }[] = [];
    const r = scriptedRig(cmd => {
      if (cmd === 'ATR0') responses = false;
      if (cmd === 'ATR1') responses = true;
      if (cmd === 'ATI') return 'ELM test';
      if (cmd.startsWith('AT')) return '';
      sent.push({ cmd, responses, at: r.clock.now() });
      if (cmd === '10172E0600010203') return '7B0 30 02 07 00 00 00 00 00';
      if (cmd === '220B0C0D0E0F1011') return '7B0 30 02 07 00 00 00 00 00';
      if (cmd === '2312131400000000') return '7B0 03 6E 06 00 00 00 00 00';
      return '';
    });
    const pdu = [0x2e, 6, 0, ...Array.from({ length: 20 }, (_, i) => i + 1)];
    const token = r.link.policy.issueCodingToken(toHex(pdu, ''), '746');
    const work = exchangeUds(r.link, pdu, { target: '746', responseId: '7B0', codingToken: token });
    const queued = r.session.send('ATI', 1000);
    const [result, ordinary] = await r.run(Promise.all([work, queued]));
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(sent.map(s => s.cmd)).toEqual(['10172E0600010203', '210405060708090A', '220B0C0D0E0F1011', '2312131400000000']);
    // Responses stay on for every frame (native parity): no ATR0/ATR1 toggle right before the last CF.
    expect(sent.map(s => s.responses)).toEqual([true, true, true, true]);
    expect(r.elm.log.some(e => e.cmd === 'ATR0')).toBe(false);
    expect(sent.slice(1).every((s, i) => s.at - sent[i]!.at >= 7)).toBe(true);
    expect(ordinary.lines).toEqual(['ELM test']);
    expect(r.elm.log.at(-1)?.cmd).toBe('ATI');
    expect(r.elm.state.header).toBe('7DF');
    expect(r.elm.state.cra).toBeNull();
  });

  it('continues after response-pending without resending the write', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '042E060001000000') return '7B0 03 7F 2E 78 00 00 00 00';
      if (cmd === 'ATMA') return { body: '7B0 03 6E 06 00 00 00 00 00', prompt: false, delayMs: 4000 };
      if (cmd === 'X') return 'STOPPED';
      return '';
    });
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    const result = await r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], { target: '746', responseId: '7B0', codingToken: token }));
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(r.elm.log.filter(e => e.cmd === '042E060001000000')).toHaveLength(1);
    expect(r.elm.log.some(e => e.cmd === 'X')).toBe(true);
  });

  it('survives a response-pending storm and still resolves the final answer without resending', async () => {
    let pendings = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '042E060001000000') return '7B0 03 7F 2E 78 00 00 00 00';
      // One monitor window delivers three pending replies before the final positive answer.
      if (cmd === 'ATMA')
        return {
          body:
            '7B0 03 7F 2E 78 00 00 00 00\r7B0 03 7F 2E 78 00 00 00 00\r7B0 03 7F 2E 78 00 00 00 00\r7B0 03 6E 06 00 00 00 00 00',
          prompt: false,
        };
      if (cmd === 'X') return 'STOPPED';
      return '';
    });
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    const result = await r.run(
      exchangeUds(r.link, [0x2e, 6, 0, 1], {
        target: '746',
        responseId: '7B0',
        codingToken: token,
        onResponsePending: () => pendings++,
      }),
    );
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(pendings).toBeGreaterThanOrEqual(1);
    expect(r.elm.log.filter(e => e.cmd === '042E060001000000')).toHaveLength(1);
    // Wire truth is recorded even across pending replies.
    expect(result.txFrames).toEqual([{ can: '746', bytes: [4, 0x2e, 6, 0, 1, 0, 0, 0], at: expect.any(Number), stage: 'submitted' }]);
  });

  it('on an adapter without ATMA (answers ?), still hears the final reply after a response-pending, sent once', async () => {
    let atma = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '042E060001000000') {
        r.elm.emitLater('7B0 03 6E 06 00 00 00 00 00', 3000);
        return '7B0 03 7F 2E 78 00 00 00 00';
      }
      if (cmd === 'ATMA') { atma++; return '?'; }
      return '';
    });
    let pendings = 0;
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    const result = await r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], {
      target: '746', responseId: '7B0', codingToken: token, timeoutMs: 30_000, onResponsePending: () => pendings++,
    }));
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(pendings).toBe(1);
    expect(atma).toBe(1);
    expect(r.elm.log.filter(e => e.cmd === '042E060001000000')).toHaveLength(1);
    // Once known, the adapter is not asked for ATMA again: the next continuation listens straight away.
    const token2 = r.link.policy.issueCodingToken('2E060001', '746');
    await r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], { target: '746', responseId: '7B0', codingToken: token2, timeoutMs: 30_000 }));
    expect(atma).toBe(1);
  });

  it('waits through response-pending renewals that arrive separately, seconds apart, without resending', async () => {
    let monitors = 0;
    let pendings = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '042E060001000000') return '7B0 03 7F 2E 78 00 00 00 00';
      // Each monitor window brings ONE renewal, 4 s later; the fourth brings the final answer.
      if (cmd === 'ATMA') {
        monitors++;
        return { body: monitors < 4 ? '7B0 03 7F 2E 78 00 00 00 00' : '7B0 03 6E 06 00 00 00 00 00', prompt: false, delayMs: 4000 };
      }
      if (cmd === 'X') return 'STOPPED';
      return '';
    });
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    const started = r.clock.now();
    const result = await r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], {
      target: '746', responseId: '7B0', codingToken: token, timeoutMs: 30_000,
      onResponsePending: () => pendings++,
    }));
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(monitors).toBe(4);
    expect(pendings).toBe(4); // the first in the request's own reply, then one per window
    expect(r.clock.now() - started).toBeGreaterThanOrEqual(16_000);
    expect(r.elm.log.filter(e => e.cmd === '042E060001000000')).toHaveLength(1);
  });

  it('a write pending gets the full cap even when the module stays silent past the first deadline', async () => {
    // Live 2026-10-31: module 732 answered 7F 2E 78 to the payload then went quiet; the 30 s
    // budget expired mid-commit. A 78 earns the whole P2* cap — silence after it is not proof
    // of a drop on this car (live 0E46: quiet ~12 s, then the final 6E).
    const r = scriptedRig(cmd => {
      if (cmd === '042E057437') return '79C 03 7F 2E 78 00 00 00 00';
      if (cmd === 'ATMA') return '?';
      return '';
    });
    const token = r.link.policy.issueCodingToken('2E057437', '732');
    const started = r.clock.now();
    const failure = await r.run(
      exchangeUds(r.link, [0x2e, 5, 0x74, 0x37], {
        target: '732',
        responseId: '79C',
        padding: 'native',
        codingToken: token,
        timeoutMs: 30_000,
      }),
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ requestStarted: true, failure: 'timeout' });
    // Bounded by the 60 s pending cap the first 78 earned — well past the caller's own 30 s.
    expect(r.clock.now() - started).toBeGreaterThanOrEqual(55_000);
    expect(r.elm.log.filter(e => e.cmd === '042E057437')).toHaveLength(1);
  });

  it('a write pending that resolves past the caller deadline still lands, with its RX reported', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '042E057437') {
        // The quiet-gap pattern this car actually shows: one 78, then the final answer at 20 s.
        r.elm.emitLater('79C 03 6E 05 74 AA AA AA AA', 20_000);
        return '79C 03 7F 2E 78 00 00 00 00';
      }
      if (cmd === 'ATMA') return '?';
      return '';
    });
    const token = r.link.policy.issueCodingToken('2E057437', '732');
    const rx: string[] = [];
    const result = await r.run(
      exchangeUds(r.link, [0x2e, 5, 0x74, 0x37], {
        target: '732',
        responseId: '79C',
        padding: 'native',
        codingToken: token,
        timeoutMs: 15_000, // the caller's budget — the 78 extends it to the cap
        onRxFrame: (f) => rx.push(`${f.ecu} ${f.bytes.map(b => b.toString(16).padStart(2, '0')).join('')}`),
      }),
    );
    expect(result.response).toEqual([0x6e, 5, 0x74]);
    // The module's actual words were reported: the pending, then the positive close.
    expect(rx[0]).toBe('79C 037f2e7800000000');
    expect(rx.at(-1)).toBe('79C 036e0574aaaaaaaa');
    expect(r.elm.log.filter(e => e.cmd === '042E057437')).toHaveLength(1);
  });

  it('a short-budget request that sees 78 does not stretch to the pending cap', async () => {
    // A 3 s marker/tester-present window stays bounded even when a module pends on it.
    const r = scriptedRig(cmd => {
      if (cmd === '022703') return '79C 03 7F 27 78 00 00 00 00';
      if (cmd === 'ATMA') return '?';
      return '';
    });
    const token = r.link.policy.issueCodingPermit('732', { securityAccess: true });
    const started = r.clock.now();
    const failure = await r.run(
      exchangeUds(r.link, [0x27, 0x03], {
        target: '732',
        responseId: '79C',
        padding: 'native',
        codingToken: token,
        timeoutMs: 3000,
      }),
    ).catch((e: unknown) => e);
    expect(failure).toMatchObject({ requestStarted: true, failure: 'timeout' });
    expect(r.clock.now() - started).toBeLessThan(10_000);
  });

  it('records a frame before handing it over, so a transport that throws after submitting never loses it', async () => {
    const r = scriptedRig(() => '');
    const original = r.elm.write.bind(r.elm);
    r.elm.write = async bytes => {
      await original(bytes);
      if (new TextDecoder().decode(bytes).startsWith('042E060001')) throw new Error('link lost after submission');
    };
    const seen: string[] = [];
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    const failure = await r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], {
      target: '746', responseId: '7B0', codingToken: token,
      onTxFrame: (i, f) => seen.push(`${i}:${f.can}:${f.stage}`),
    })).catch((e: unknown) => e);
    expect(r.elm.sentTo('746')).toContain('042E060001000000');
    expect(failure).toMatchObject({ requestStarted: true, txFrames: [{ can: '746', bytes: [4, 0x2e, 6, 0, 1, 0, 0, 0], stage: 'failed' }] });
    // Reported as attempted BEFORE the transport was awaited, then as failed.
    expect(seen).toEqual(['0:746:attempted', '0:746:failed']);
  });

  it('waits for CTS after WAIT without repeating the first frame', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '10082E0600010203') return '7B0 31 00 00 00 00 00 00 00';
      if (cmd === 'ATMA') return { body: '7B0 30 00 00 00 00 00 00 00', prompt: false };
      if (cmd === 'X') return 'STOPPED';
      if (cmd === '2104050000000000') return '7B0 03 6E 06 00 00 00 00 00';
      return '';
    });
    const pdu = [0x2e, 6, 0, 1, 2, 3, 4, 5];
    const token = r.link.policy.issueCodingToken(toHex(pdu, ''), '746');
    const result = await r.run(exchangeUds(r.link, pdu, { target: '746', responseId: '7B0', codingToken: token }));
    expect(result.response).toEqual([0x6e, 6, 0]);
    expect(r.elm.log.filter(e => e.cmd === '10082E0600010203')).toHaveLength(1);
  });

  it('reassembles a long read and ignores another ECU instead of treating its reply as ours', async () => {
    const r = scriptedRig(cmd => cmd === '0322060000000000' ? [
      '7E8 03 62 06 00 00 00 00 00',
      '7B0 10 0B 62 06 00 AA BB CC',
      '7B0 21 DD EE FF 01 02 00 00',
    ].join('\r') : '');
    const result = await r.run(exchangeUds(r.link, [0x22, 6, 0], { target: '746', responseId: '7B0' }));
    expect(result.response).toEqual([0x62, 6, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 1, 2]);
  });

  it.each([
    ['overflow', '7B0 32 00 00 00 00 00 00 00'],
    ['reserved status', '7B0 33 00 00 00 00 00 00 00'],
    ['reserved separation time', '7B0 30 00 80 00 00 00 00 00'],
  ])('stops on %s with no consecutive frame or automatic retry', async (_name, answer) => {
    const r = scriptedRig(cmd => cmd.startsWith('10') ? answer : '');
    const pdu = [0x2e, 6, 0, 1, 2, 3, 4, 5];
    const token = r.link.policy.issueCodingToken(toHex(pdu, ''), '746');
    await expect(r.run(exchangeUds(r.link, pdu, { target: '746', responseId: '7B0', codingToken: token }))).rejects.toBeInstanceOf(UdsExchangeError);
    expect(r.elm.sentTo('746')).toEqual(['10082E0600010203']);
    expect(r.elm.state.header).toBe('7DF');
  });

  it('refuses absent permits and adapter setup failures before any raw write', async () => {
    const r = scriptedRig(() => '');
    await expect(r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], { target: '746', responseId: '7B0' }))).rejects.toThrow();
    expect(r.elm.sentTo('746')).toEqual([]);
    const bad = scriptedRig(cmd => cmd === 'ATFCSM1' ? '?' : '');
    const token = bad.link.policy.issueCodingToken('2E06000102030405', '746');
    await expect(bad.run(exchangeUds(bad.link, [0x2e, 6, 0, 1, 2, 3, 4, 5], { target: '746', responseId: '7B0', codingToken: token }))).rejects.toMatchObject({ requestStarted: false });
    expect(bad.elm.sentTo('746')).toEqual([]);
  });

  it('closes the adapter if normal formatting cannot be restored', async () => {
    const r = scriptedRig(cmd => cmd === 'ATCAF1' ? '?' : cmd === '0322060000000000' ? '7B0 04 62 06 00 01 00 00 00' : '');
    await expect(r.run(exchangeUds(r.link, [0x22, 6, 0], { target: '746', responseId: '7B0' }))).rejects.toThrow('configuration could not be restored');
    expect(r.elm.isOpen).toBe(false);
  });

  it('expires coding permits on the connection clock before sending any CAN frame', async () => {
    const r = scriptedRig(() => '');
    const token = r.link.policy.issueCodingToken('2E060001', '746');
    await r.run(r.clock.sleep(5001));
    await expect(r.run(exchangeUds(r.link, [0x2e, 6, 0, 1], { target: '746', responseId: '7B0', codingToken: token }))).rejects.toMatchObject({ requestStarted: false });
    expect(r.elm.sentTo('746')).toEqual([]);
    expect(() => r.link.policy.check('ATMA', { family: 'can11' })).toThrow();
  });

  it('refuses a response carrying two different copies of one consecutive frame', async () => {
    const r = scriptedRig(cmd => cmd === '0322060000000000' ? [
      '7B0 10 14 62 06 00 01 02 03',
      '7B0 21 04 05 06 07 08 09 0A',
      '7B0 21 FF FF FF FF FF FF FF',
      '7B0 22 0B 0C 0D 0E 0F 10 11',
    ].join('\r') : '');
    await expect(r.run(exchangeUds(r.link, [0x22, 6, 0], { target: '746', responseId: '7B0' }))).rejects.toThrow('two different copies');
  });

  it('does not accept a short final consecutive frame as a complete response', async () => {
    const r = scriptedRig(cmd => cmd === '0322060000000000' ? '7B0 10 0B 62 06 00 AA BB CC\r7B0 21 DD EE FF 01' : '');
    await expect(r.run(exchangeUds(r.link, [0x22, 6, 0], { target: '746', responseId: '7B0' }))).rejects.toThrow('shorter than its declared length');
  });
});

it.each(['778', '00 00 07 78', '00000778'])('accepts captured display header %s', async header => {
  const r = scriptedRig(cmd => cmd === '03220A5E00000000' ? `${header} 04 62 0A 5E 3A 00 00 00` : '');
  const result = await r.run(exchangeUds(r.link, [0x22,0x0A,0x5E], { target: '70E', responseId: '778' }));
  expect(result.response).toEqual([0x62,0x0A,0x5E,0x3A]);
});

describe('bounded answers for the live clone (failures 2026-10-31)', () => {
  it('reports a write\'s 78 at once when the caller bounds the passive listen to 0', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '042E0E4600') {
        r.elm.emitLater('77E 03 6E 0E 46 AA AA AA AA', 12_000);
        return '77E 03 7F 2E 78 AA AA AA AA';
      }
      if (cmd === 'ATMA') return '?';
      return '';
    });
    r.link.nativeBind = true;
    const token = r.link.policy.issueCodingToken('2E0E4600', '714');
    let pending = 0;
    const failure = await r.run(exchangeUds(r.link, [0x2e, 0x0e, 0x46, 0], {
      target: '714', responseId: '77E', padding: 'native', codingToken: token,
      timeoutMs: 30_000, pendingListenMs: 0, onResponsePending: () => pending++,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', detail: 'pending', requestStarted: true });
    expect(pending).toBe(1);
    expect(r.clock.now()).toBeLessThan(2000);
    expect(r.elm.sentTo('714')).toEqual(['042E0E4600']);
  });

  it('reports a write\'s completed NO DATA at once with pendingListenMs 0', async () => {
    const r = scriptedRig(cmd => (cmd === '042E0E4600' ? 'NO DATA' : ''));
    const token = r.link.policy.issueCodingToken('2E0E4600', '714');
    const failure = await r.run(exchangeUds(r.link, [0x2e, 0x0e, 0x46, 0], {
      target: '714', responseId: '77E', padding: 'native', codingToken: token, timeoutMs: 30_000, pendingListenMs: 0,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', requestStarted: true });
    expect((failure as UdsExchangeError).detail).toBeUndefined();
    expect(r.clock.now()).toBeLessThan(2000);
  });

  it('marks a read whose response-pending never resolved as "pending" (a sweep may skip it)', async () => {
    const r = scriptedRig(cmd => (cmd === '03220560' ? '778 03 7F 22 78 00 00 00 00' : cmd === 'ATMA' ? '?' : ''));
    const failure = await r.run(exchangeUds(r.link, [0x22, 0x05, 0x60], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 15_000,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', detail: 'pending' });
  });

  it('grants the next block after every 4 consecutive frames, so a 43-byte reply is read whole', async () => {
    // Live 2026-10-31: replies needing 5–6 CFs arrived with exactly 4. With block size 4 the module waits
    // for another flow control after each 4, and the host sends it as its own frame.
    const data = Array.from({ length: 40 }, (_, i) => i + 1);
    const pdu = [0x62, 0x05, 0x09, ...data]; // 43 bytes: FF + 6 CFs
    const frames = [[0x10, pdu.length, ...pdu.slice(0, 6)]];
    for (let pos = 6, seq = 1; pos < pdu.length; pos += 7, seq++) {
      const chunk = pdu.slice(pos, pos + 7);
      frames.push([0x20 | seq, ...chunk, ...Array(7 - chunk.length).fill(0xaa)]);
    }
    const line = (f: number[]) => `7B0 ${toHex(f, ' ')}`;
    const fcs: string[] = [];
    const r = scriptedRig(cmd => {
      if (cmd === 'ATFCSD300405') return 'OK';
      if (cmd === '0322050900000000') return frames.slice(0, 5).map(line).join('\r');
      if (cmd.startsWith('300405')) { fcs.push(cmd); return frames.slice(5).map(line).join('\r'); }
      return '';
    });
    const result = await r.run(exchangeUds(r.link, [0x22, 0x05, 0x09], { target: '746', responseId: '7B0' }));
    expect(result.response).toEqual(pdu);
    expect(fcs).toEqual(['3004050000000000']);
    expect(r.elm.log.some(e => e.cmd === 'ATFCSD300405')).toBe(true);
  });

  it('on the clone, a first frame whose flow control gets NO DATA is "truncated" at once — no listen past the prompt', async () => {
    // Simulator: the module's only CF was lost before the prompt; the host's flow control then found nothing,
    // and a passive listen outlived the read's whole budget (nothing ever arrives after a prompt on this clone).
    const r = scriptedRig(cmd => {
      if (cmd === '03220A5E') return '778 10 08 62 0A 5E 3E 00 00';
      if (cmd.startsWith('300405')) return 'NO DATA';
      return '';
    });
    r.link.nativeBind = true;
    const failure = await r.run(exchangeUds(r.link, [0x22, 0x0a, 0x5e], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 8000,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'protocol', detail: 'truncated' });
    expect(r.clock.now()).toBeLessThan(2000);
  });

  it('a request that ended UNABLE TO CONNECT leaves the search pending: the next one needs no re-bind', async () => {
    let unable = 1;
    const r = scriptedRig(cmd => {
      if (cmd === '03220A5E') return unable-- > 0 ? 'SEARCHING...\rUNABLE TO CONNECT' : '778 04 62 0A 5E 3E';
      return '';
    });
    r.link.nativeBind = true;
    const reads = await r.run(withUdsChannel(r.link, { target: '70E', responseId: '778', padding: 'native' }, async ch => {
      const first = await ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 }).catch((e: unknown) => e);
      const from = r.elm.log.length;
      await ch.retarget('70E', '778'); // already addressed, search still pending: nothing to send
      const second = await ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 });
      return { first, second, between: r.elm.log.slice(from).map(e => e.cmd) };
    }));
    expect(reads.first).toMatchObject({ failure: 'adapter' });
    expect(reads.second.response).toEqual([0x62, 0x0a, 0x5e, 0x3e]);
    expect(reads.between).toEqual(['03220A5E']);
  });

  it('on the clone, a final CF met with NO DATA is sent again at once — a lost CF completes, a delivered one is ignored', async () => {
    // The clone drops the first CF after a flow control ~17 % of the time (live 4/23); the module then still waits for
    // it inside N_Cr. A copy of a CF that did arrive finds no reception open and is ignored (ISO 15765-2).
    let cfs = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '10082E0A5E3E0000') return '778 30 0F 05 AA AA AA AA AA';
      if (cmd === '210000AAAAAAAAAA') return ++cfs === 1 ? 'NO DATA' : '778 03 7F 2E 78 AA AA AA AA';
      return '';
    });
    r.link.nativeBind = true;
    const token = r.link.policy.issueCodingToken('2E0A5E3E00000000', '70E');
    const failure = await r.run(exchangeUds(r.link, [0x2e, 0x0a, 0x5e, 0x3e, 0, 0, 0, 0], {
      target: '70E', responseId: '778', padding: 'native', codingToken: token, timeoutMs: 15_000, pendingListenMs: 0,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', detail: 'pending' });
    expect(r.elm.sentTo('70E')).toEqual(['10082E0A5E3E0000', '210000AAAAAAAAAA', '210000AAAAAAAAAA']);

    // Still silent: at most two copies, then the request's own silence is reported.
    const quiet = scriptedRig(cmd => (cmd === '10082E0A5E3E0000' ? '778 30 0F 05 AA AA AA AA AA' : cmd.startsWith('21') ? 'NO DATA' : ''));
    quiet.link.nativeBind = true;
    const again = await quiet.run(exchangeUds(quiet.link, [0x2e, 0x0a, 0x5e, 0x3e, 0, 0, 0, 0], {
      target: '70E', responseId: '778', padding: 'native', timeoutMs: 15_000, pendingListenMs: 0,
      codingToken: quiet.link.policy.issueCodingToken('2E0A5E3E00000000', '70E'),
    })).catch((e: unknown) => e);
    expect(again).toMatchObject({ failure: 'timeout', requestStarted: true });
    expect(quiet.elm.sentTo('70E').filter(c => c.startsWith('21'))).toHaveLength(3);
  });

  it('a long read whose second block never came is "truncated" and carries the bytes it did get', async () => {
    const r = scriptedRig(cmd => {
      if (cmd === '0322720D') return '7DD 10 29 62 72 0D 01 02 03\r7DD 21 04 05 06 07 08 09 0A\r7DD 22 0B 0C 0D 0E 0F 10 11\r7DD 23 12 13 14 15 16 17 18\r7DD 24 19 1A 1B 1C 1D 1E 1F';
      if (cmd.startsWith('300405')) return 'NO DATA';
      return '';
    });
    r.link.nativeBind = true;
    const failure = await r.run(exchangeUds(r.link, [0x22, 0x72, 0x0d], {
      target: '773', responseId: '7DD', padding: 'native', timeoutMs: 8000,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'protocol', detail: 'truncated' });
    expect((failure as UdsExchangeError).partial).toEqual([0x62, 0x72, 0x0d, ...Array.from({ length: 31 }, (_, i) => i + 1)]);
  });

  it('on the clone, a request after > LOCKED_IDLE_MAX_MS idle is re-searched first, and says so', async () => {
    const r = scriptedRig(cmd => (cmd === '03220A5E' ? '778 04 62 0A 5E 3E' : ''));
    r.link.nativeBind = true;
    const seen = await r.run(withUdsChannel(r.link, { target: '70E', responseId: '778', padding: 'native' }, async ch => {
      const first = await ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 });
      // At the prompt: a locked request goes out alone.
      let from = r.elm.log.length;
      const locked = await ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 });
      const atPrompt = r.elm.log.slice(from).map(e => e.cmd);
      await r.clock.sleep(LOCKED_IDLE_MAX_MS + 5);
      from = r.elm.log.length;
      const idle = await ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 });
      return { first, locked, atPrompt, idle, afterIdle: r.elm.log.slice(from).map(e => e.cmd) };
    }));
    expect(seen.first.searched).toBe(true);
    expect(seen.atPrompt).toEqual(['03220A5E']);
    expect(seen.locked.searched).toBe(false);
    expect(seen.afterIdle).toEqual(['ATSH70E', 'ATCRA778', 'ATFCSH70E', 'ATSP0', '03220A5E']);
    expect(seen.idle.searched).toBe(true);
  });

  it('sets up only what the adapter does not already hold, and restores only what it changed', async () => {
    const r = scriptedRig(cmd => (cmd === '03220A5E' ? '778 04 62 0A 5E 3E' : ''));
    r.link.config = { spaces: true, headers: true, adaptiveTiming: 1, st: 0x32, target: 'functional' };
    await r.run(withUdsChannel(r.link, { target: '70E', responseId: '778', padding: 'native', timing: { adaptive: 1, st: 0x96 } },
      ch => ch.exchange([0x22, 0x0a, 0x5e], { timeoutMs: 8000 })));
    const at = r.elm.log.map(e => e.cmd).filter(c => c.startsWith('AT'));
    // Headers and spaces always: an adapter that reset without the link closing is back at its defaults.
    // ATAL keeps the 8th byte of full frames (the clone drops it otherwise); ATNL puts the default back.
    expect(at).toEqual(['ATH1', 'ATS1', 'ATD0', 'ATCAF0', 'ATAL', 'ATCFC1', 'ATSH70E', 'ATCRA778', 'ATFCSH70E', 'ATFCSD300405', 'ATFCSM1', 'ATST96',
      'ATR1', 'ATCAF1', 'ATNL', 'ATFCSM0', 'ATSH7DF', 'ATCRA', 'ATST32']);
  });

  it('a reply cut short anywhere else is "truncated", not a desynchronised stream', async () => {
    const r = scriptedRig(cmd => cmd === '0322060000000000' ? '7B0 10 0B 62 06 00 AA BB CC\r7B0 21 DD EE FF 01' : '');
    const failure = await r.run(exchangeUds(r.link, [0x22, 6, 0], { target: '746', responseId: '7B0' })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'protocol', detail: 'truncated' });
  });
});

describe('malformed replies', () => {
  it('refuses a reply whose first frame announces an impossible length, without asking for more frames', async () => {
    const sent: string[] = [];
    const r = scriptedRig((cmd) => {
      sent.push(cmd);
      return cmd === '03220A5E00000000' ? '778 10 05 62 0A 5E 3A 00 00' : '';
    });
    const failure = await r.run(exchangeUds(r.link, [0x22, 0x0a, 0x5e], { target: '70E', responseId: '778' })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UdsExchangeError);
    expect((failure as Error).message).toMatch(/invalid ISO-TP first frame/);
    expect(sent.some((c) => c.startsWith('30'))).toBe(false);
  });
});

describe('frame modes (the clone that corrupts the 8th byte of a full frame)', () => {
  /** F198 written with its 8th first-frame byte (data byte 2) set to `byte8`: FF 10 09 2E F1 98 01 41 <byte8>. */
  const pdu = (byte8: number) => [0x2e, 0xf1, 0x98, 0x01, 0x41, byte8, 0xf6, 0x30, 0x39];
  const module = (cmd: string) => {
    if (/^10092EF198/.test(cmd)) return '778 30 00 00 00 00 00 00 00';
    if (cmd.startsWith('21F63039')) return '778 03 6E F1 98 AA AA AA AA';
    return '';
  };

  it('trim-zero hands a full frame ending in 00 over as its first 7 bytes; any other frame goes whole', () => {
    const frames = segmentDiagnosticPdu(pdu(0), 'native');
    expect(frames.map(f => toHex(f, ''))).toEqual(['10092EF198014100', '21F63039AAAAAAAA']);
    expect(toHex(transmittedFrame(frames[0]!, 'trim-zero'), '')).toBe('10092EF1980141');
    expect(toHex(transmittedFrame(frames[0]!, 'full'), '')).toBe('10092EF198014100');
    expect(toHex(transmittedFrame(frames[0]!, 'fc-alt'), '')).toBe('10092EF198014100');
    expect(toHex(transmittedFrame(segmentDiagnosticPdu(pdu(0x5a), 'native')[0]!, 'trim-zero'), '')).toBe('10092EF19801415A');
    // Short frames are never trimmed: the 00 inside a short frame is data.
    expect(transmittedFrame([0x03, 0x22, 0xf1, 0x00], 'trim-zero')).toEqual([0x03, 0x22, 0xf1, 0x00]);
    expect(transmittedFrame([0x07, 1, 2, 3, 4, 5, 6, 0], 'trim-zero')).toEqual([0x07, 1, 2, 3, 4, 5, 6]);
  });

  it('formats STPX for one physical request and refuses anything else', () => {
    expect(stpxCommand('70e', pdu(0))).toBe('STPX h:70E,d:2EF198014100F63039,r:1');
    expect(stpxCommand('714', [0x22, 0xf1, 0x87], 2)).toBe('STPX h:714,d:22F187,r:2');
    expect(() => stpxCommand('7DF0', [0x22])).toThrow();
    expect(() => stpxCommand('70E', [])).toThrow();
    expect(() => stpxCommand('70E', [256])).toThrow();
    expect(() => stpxCommand('70E', [0x22], 0)).toThrow();
  });

  it('trim-zero: sets the 00 filler (ATPP26SV00, ATPP26ON), sends 7 bytes, logs intended and sent, and turns the filler off', async () => {
    const r = scriptedRig(module);
    const token = r.link.policy.issueCodingToken(toHex(pdu(0), ''), '70E');
    const seen: string[] = [];
    const result = await r.run(exchangeUds(r.link, pdu(0), {
      target: '70E', responseId: '778', padding: 'native', frameMode: 'trim-zero', codingToken: token,
      onTxFrame: (i, f) => { if (f.stage === 'submitted') seen.push(`${i}:${toHex(f.bytes, '')}>${f.sent ?? '-'}`); },
    }));
    expect(result.response).toEqual([0x6e, 0xf1, 0x98]);
    expect(r.elm.sentTo('70E')).toEqual(['10092EF1980141', '21F63039AAAAAAAA']);
    expect(seen).toEqual(['0:10092EF198014100>10092EF1980141', '1:21F63039AAAAAAAA>-']);
    const at = r.elm.log.map(e => e.cmd).filter(c => c.startsWith('ATPP'));
    expect(at).toEqual(['ATPP26SV00', 'ATPP26ON', 'ATPP26OFF']);
  });

  it('trim-zero on a clone that refuses programmable parameters (?) still runs, and leaves them alone', async () => {
    const r = scriptedRig(cmd => (cmd.startsWith('ATPP') ? '?' : module(cmd)));
    const token = r.link.policy.issueCodingToken(toHex(pdu(0), ''), '70E');
    const result = await r.run(exchangeUds(r.link, pdu(0), {
      target: '70E', responseId: '778', padding: 'native', frameMode: 'trim-zero', codingToken: token,
    }));
    expect(result.response).toEqual([0x6e, 0xf1, 0x98]);
    expect(r.elm.log.map(e => e.cmd).filter(c => c.startsWith('ATPP'))).toEqual(['ATPP26SV00']);
    expect(r.elm.sentTo('70E')[0]).toBe('10092EF1980141');
  });

  it('a link-wide frame mode applies to every channel that names none; fc-alt changes only the adapter flow-control data', async () => {
    const r = scriptedRig(module);
    r.link.frameMode = 'fc-alt';
    const token = r.link.policy.issueCodingToken(toHex(pdu(0), ''), '70E');
    await r.run(exchangeUds(r.link, pdu(0), { target: '70E', responseId: '778', padding: 'native', codingToken: token }));
    const at = r.elm.log.map(e => e.cmd);
    expect(at).toContain('ATFCSD310005');
    expect(at).not.toContain('ATFCSD300405');
    expect(r.elm.sentTo('70E')).toEqual(['10092EF198014100', '21F63039AAAAAAAA']);
  });

  it('stpx is refused before anything is sent when the adapter is not a confirmed STN chip', async () => {
    const r = scriptedRig(module);
    const token = r.link.policy.issueCodingToken(toHex(pdu(0), ''), '70E');
    const failure = await r.run(exchangeUds(r.link, pdu(0), {
      target: '70E', responseId: '778', frameMode: 'stpx', codingToken: token,
    })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(UdsExchangeError);
    expect(failure).toMatchObject({ requestStarted: false, failure: 'adapter' });
    expect(r.elm.log).toEqual([]);
  });

  it('stpx on an STN chip: ATCAF1 + STCSEGT1, the whole PDU in one STPX recorded against both frames, then restored', async () => {
    const r = scriptedRig(cmd => (cmd.startsWith('STPX') ? '778 03 6E F1 98 AA AA AA AA' : cmd.startsWith('ST') ? 'OK' : ''));
    r.link.info = { profile: { caps: { stCommands: true } } as AdapterProfile };
    const token = r.link.policy.issueCodingToken(toHex(pdu(0), ''), '70E');
    const seen: string[] = [];
    const result = await r.run(exchangeUds(r.link, pdu(0), {
      target: '70E', responseId: '778', padding: 'native', frameMode: 'stpx', codingToken: token,
      onTxFrame: (i, f) => { if (f.stage === 'submitted') seen.push(`${i}:${toHex(f.bytes, '')}>${f.sent}`); },
    }));
    expect(result.response).toEqual([0x6e, 0xf1, 0x98]);
    expect(r.elm.sentTo('70E').filter(c => !c.startsWith('STCS'))).toEqual(['STPXH:70E,D:2EF198014100F63039,R:1']);
    expect(seen).toEqual(['0:10092EF198014100>STPX h:70E,d:2EF198014100F63039,r:1', '1:21F63039AAAAAAAA>STPX']);
    const cmds = r.elm.log.map(e => e.cmd);
    expect(cmds).toContain('STCSEGT1');
    expect(cmds).toContain('STCSEGT0');
    expect(cmds.slice(0, cmds.indexOf('STCSEGT1'))).not.toContain('ATCAF0');
    expect(cmds.some(c => c.startsWith('ATFCSD') || c === 'ATAL')).toBe(false);
  });
});

describe('response-pending poll for the clone that prints nothing after its prompt (live 2026-11-09)', () => {
  const PENDING = '77D 03 7F 19 78 AA AA AA AA';
  const LIST = '77D 07 59 02 FF C1 00 00 28';
  const window = (body = 'NO DATA') => ({ body, prompt: true, delayMs: 205 });

  it('keeps the adapter listening with silent tester presents and hears the final answer ~3 s after 78', async () => {
    let at = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '0319022D') { at = r.clock.now(); return PENDING; }
      // Only a send's response window prints the late answer; a passive listen after the prompt would hear nothing.
      if (cmd === '023E80') return r.clock.now() - at >= 3000 ? window(LIST) : window();
      if (cmd === 'ATMA') return '?';
      return '';
    });
    r.link.nativeBind = true;
    let pending = 0;
    const result = await r.run(exchangeUds(r.link, [0x19, 0x02, 0x2d], {
      target: '713', responseId: '77D', padding: 'native', timeoutMs: 8000,
      pendingListenMs: 0, pendingPollMs: 10_000, onResponsePending: () => pending++,
    }));
    expect(result.response).toEqual([0x59, 0x02, 0xff, 0xc1, 0x00, 0x00, 0x28]);
    expect(pending).toBe(1);
    const sent = r.elm.sentTo('713');
    expect(sent[0]).toBe('0319022D');
    expect(sent.filter(c => c === '0319022D')).toHaveLength(1);
    expect(sent.slice(1).every(c => c === '023E80')).toBe(true);
    expect(r.elm.log.some(e => e.cmd === 'ATMA')).toBe(false);
    expect(result.endedAt - result.startedAt).toBeGreaterThanOrEqual(3000);
  });

  it('follows 78 renewals past P2* without re-sending the request', async () => {
    let at = 0;
    let renewed = false;
    const r = scriptedRig(cmd => {
      if (cmd === '0319022D') { at = r.clock.now(); return PENDING; }
      if (cmd === '023E80') {
        const t = r.clock.now() - at;
        if (t >= 4000 && !renewed) { renewed = true; return window(PENDING); }
        return t >= 8000 ? window(LIST) : window();
      }
      return '';
    });
    r.link.nativeBind = true;
    let pending = 0;
    const result = await r.run(exchangeUds(r.link, [0x19, 0x02, 0x2d], {
      target: '713', responseId: '77D', padding: 'native', timeoutMs: 8000,
      pendingListenMs: 0, pendingPollMs: 10_000, onResponsePending: () => pending++,
    }));
    expect(result.response.slice(0, 2)).toEqual([0x59, 0x02]);
    expect(pending).toBe(2);
    expect(r.elm.sentTo('713').filter(c => c === '0319022D')).toHaveLength(1);
  });

  it('a final answer lost between two windows: the read is sent once more after P2* of silence', async () => {
    let requests = 0;
    const r = scriptedRig(cmd => {
      if (cmd === '0319022D') return ++requests === 1 ? PENDING : LIST;
      if (cmd === '023E80') return window();
      return '';
    });
    r.link.nativeBind = true;
    const result = await r.run(exchangeUds(r.link, [0x19, 0x02, 0x2d], {
      target: '713', responseId: '77D', padding: 'native', timeoutMs: 8000, pendingListenMs: 0, pendingPollMs: 10_000,
    }));
    expect(result.response.slice(0, 2)).toEqual([0x59, 0x02]);
    expect(requests).toBe(2);
    expect(result.endedAt - result.startedAt).toBeGreaterThanOrEqual(5500);
  });

  it('gives up as "pending" when no final answer comes within the poll window', async () => {
    const r = scriptedRig(cmd => (cmd === '0319022D' ? PENDING : cmd === '023E80' ? window() : ''));
    r.link.nativeBind = true;
    const failure = await r.run(exchangeUds(r.link, [0x19, 0x02, 0x2d], {
      target: '713', responseId: '77D', padding: 'native', timeoutMs: 8000, pendingListenMs: 0, pendingPollMs: 10_000,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', detail: 'pending' });
    // One extra send at most, and the whole read bounded by the poll window (plus the one P2* re-send).
    expect(r.elm.sentTo('713').filter(c => c === '0319022D')).toHaveLength(2);
    expect(r.clock.now()).toBeLessThan(10_000 + 6_000);
  });

  it('without pendingPollMs a 78 is still reported at the prompt, with no poll sent', async () => {
    const r = scriptedRig(cmd => (cmd === '042E0E4600' ? '77E 03 7F 2E 78 AA AA AA AA' : cmd === 'ATMA' ? '?' : ''));
    r.link.nativeBind = true;
    const token = r.link.policy.issueCodingToken('2E0E4600', '714');
    const failure = await r.run(exchangeUds(r.link, [0x2e, 0x0e, 0x46, 0], {
      target: '714', responseId: '77E', padding: 'native', codingToken: token, timeoutMs: 8000, pendingListenMs: 0,
    })).catch((e: unknown) => e);
    expect(failure).toMatchObject({ failure: 'timeout', detail: 'pending' });
    expect(r.elm.sentTo('714')).toEqual(['042E0E4600']);
  });
});
