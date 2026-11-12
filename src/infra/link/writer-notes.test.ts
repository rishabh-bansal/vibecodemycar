/**
 * The writers journal every decision they make on the wire (`onNote`), compactly: DIDs and NRC codes, never
 * the security code, the seed or the key (the wire trace has the bytes).
 */
import { expect, it } from 'vitest';
import { scriptedRig } from '../../../packages/obd-core/test/scripted.ts';
import type { WriterNote } from '../../domain/coding/types.ts';
import { writeCodingDid } from './ble-writer.ts';
import { writeCodingSequence } from './dataset-writer.ts';

const MODULE = { request: '70E', response: '778' };
const PASSWORD = '12345';
/** 0x396A0820 + 12345, as sent in 27 04. */
const KEY = (0x396a0820 + 12345).toString(16).toUpperCase().padStart(8, '0');

const steps = (notes: WriterNote[]) => notes.map((n) => n.step);
const secretFree = (notes: WriterNote[]) => {
  const text = JSON.stringify(notes);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain('396A0820');
};

it('the DID writer notes its sessions, security, markers, payload and closing session', async () => {
  const notes: WriterNote[] = [];
  const r = scriptedRig((cmd) => {
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '0322F199') return '778 06 62 F1 99 24 10 25';
    if (cmd === '0322F1A5') return '778 03 7F 22 31';
    if (cmd === '023E00') return '778 02 7E 00';
    if (cmd === '022703') return '778 06 67 03 39 6A 08 20';
    if (cmd.startsWith('062704')) return '778 02 67 04';
    if (cmd.startsWith('062EF199')) return '778 03 7F 2E 31';
    if (cmd === '042E0A5E3E') return '778 03 6E 0A 5E';
    if (cmd === '021001') return '778 02 50 01';
    return '';
  });
  const result = await r.run(
    writeCodingDid(r.link, MODULE, '0A5E', '3E', {
      securityPassword: PASSWORD,
      passwordSource: 'unit-default',
      onPending: () => {},
      onNote: (n) => notes.push(n),
    }),
  );
  expect(result).toMatchObject({ kind: 'acked' });
  expect(steps(notes)).toEqual(
    expect.arrayContaining([
      'retarget',
      'session-open',
      'probe',
      'seed',
      'key',
      'marker',
      'payload',
      'end-session',
    ]),
  );
  expect(notes).toContainEqual({ step: 'retarget', module: '710', detail: 'gateway 10 03, answer ignored' });
  expect(notes).toContainEqual({ step: 'probe', did: 'F1A5', detail: 'NRC 31' });
  expect(notes).toContainEqual({ step: 'key', detail: 'accepted (67 04)', passwordSource: 'unit-default' });
  expect(notes).toContainEqual({ step: 'marker', did: 'F199', detail: 'NRC 31: not-hosted' });
  expect(notes).toContainEqual({ step: 'marker', did: 'F198', detail: 'skipped: F1A5 returned no data' });
  expect(notes).toContainEqual({ step: 'payload', did: '0A5E', detail: 'acked (6E)' });
  expect(notes.at(-1)).toEqual({ step: 'end-session', detail: '10 01 answered' });
  secretFree(notes);
});

it('the DID writer notes a session-lost refusal, its re-arm and the final NRC', async () => {
  const notes: WriterNote[] = [];
  const r = scriptedRig((cmd) => {
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '0322F199' || cmd === '0322F1A5') return '778 03 7F 22 31';
    if (cmd === '023E00') return '778 02 7E 00';
    if (cmd === '022703') return '778 06 67 03 39 6A 08 20';
    if (cmd.startsWith('062704')) return '778 02 67 04';
    if (cmd.startsWith('062EF199')) return '778 03 6E F1 99';
    if (cmd === '042E0A5E3E') return '778 03 7F 2E 22';
    return '';
  });
  const result = await r.run(
    writeCodingDid(r.link, MODULE, '0A5E', '3E', {
      securityPassword: PASSWORD,
      onPending: () => {},
      onNote: (n) => notes.push(n),
    }),
  );
  expect(result).toMatchObject({ kind: 'nrc', code: '22' });
  const i = notes.findIndex((n) => n.step === 'nrc-session-lost-retry');
  expect(notes[i]).toMatchObject({ did: '0A5E', detail: expect.stringMatching(/^NRC 22/) });
  expect(notes.slice(i)).toContainEqual({ step: 'rearm', detail: 'payload NRC 22 (1/4)' });
  expect(notes).toContainEqual({ step: 'key', detail: 'accepted (67 04)', passwordSource: 'recipe' });
  expect(notes).toContainEqual({ step: 'nrc', did: '0A5E', detail: 'NRC 22 (after a re-armed retry)' });
  expect(steps(notes).filter((s) => s === 'payload')).toEqual(['payload', 'payload']);
  secretFree(notes);
});

it('the sequence writer notes its steps, the payload and the proof reads', async () => {
  const notes: WriterNote[] = [];
  let stored = '3A';
  const r = scriptedRig((cmd) => {
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '022703') return '778 06 67 03 39 6A 08 20';
    if (cmd.startsWith('062704')) return '778 02 67 04';
    if (cmd === '042E0A5E3E') {
      stored = '3E';
      return 'NO DATA';
    }
    if (cmd === '03220A5E') return `778 04 62 0A 5E ${stored}`;
    if (cmd === '021001') return '778 02 50 01';
    return '';
  });
  const result = await r.run(
    writeCodingSequence(
      r.link,
      MODULE,
      {
        pre: ['1003', '2704'],
        write: { kind: 'did', did: '0A5E', bytes: '3E' },
        post: [],
        password: PASSWORD,
      },
      { securityPassword: PASSWORD, onPending: () => {}, onNote: (n) => notes.push(n) },
    ),
  );
  expect(result).toMatchObject({ kind: 'pending-no-final' });
  expect(notes).toContainEqual({ step: 'session-open', detail: '1003 answered' });
  expect(notes).toContainEqual({ step: 'key', detail: 'accepted (67 04)', passwordSource: 'recipe' });
  expect(notes).toContainEqual({ step: 'payload', did: '0A5E', detail: 'send 1/3' });
  expect(notes).toContainEqual({ step: 'payload', did: '0A5E', detail: 'no answer' });
  expect(notes).toContainEqual({ step: 'proof-read', did: '0A5E', detail: '1: intended bytes' });
  secretFree(notes);
});

it('a throwing note callback never breaks the write', async () => {
  const r = scriptedRig((cmd) => {
    if (cmd === '021003') return '778 06 50 03 00 32 01 F4';
    if (cmd === '042E0A5E3E') return '778 03 6E 0A 5E';
    return cmd.startsWith('AT') ? '' : '778 03 7F 22 31';
  });
  const result = await r.run(
    writeCodingDid(r.link, MODULE, '0A5E', '3E', {
      securityPassword: null,
      onPending: () => {},
      onNote: () => {
        throw new Error('journal down');
      },
    }),
  );
  expect(result).toMatchObject({ kind: 'acked' });
});
