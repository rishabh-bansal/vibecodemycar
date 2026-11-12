import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, compare, loadEntries } from './compare-captures.mjs';
import { readTraceLine } from './capture-native.mjs';
import { createWireRedactor } from '../src/domain/logs/redact.ts';

const e = (monoMs, direction, text) => ({
  at: new Date(Date.UTC(2026, 9, 28) + monoMs).toISOString(), monoMs, direction, text,
});

test('native stream keeps VIN replies, blanks serial numbers and omits unstructured legacy output', () => {
  const redact = createWireRedactor();
  assert.equal(readTraceLine('VIN TMBJB7NS0P8012345', redact), undefined);
  const source = [
    e(0, 'tx', '0322F190\r'),
    e(1, 'rx', '00 00 07 7E 10 14 62 F1 90 54'),
    e(2, 'rx', ' 4D 42\r00 00 07 7E 21 4A 42 37 4E 53 30 50\r'),
    e(3, 'rx', '00 00 07 7E 22 38 30 31 32 33 34 35\r>'),
    e(4, 'tx', '0322F18C\r'),
    e(5, 'rx', '00 00 07 7E 10 0E 62 F1 8C 31 32 33\r00 00 07 7E 21 34 35 36 37 38 39 41\r>'),
  ];
  const output = source.map(entry => readTraceLine('@@OBDCRAFT_TRACE ' + JSON.stringify(entry), redact));
  // The VIN is kept as received, so every capture can be tied to its car.
  assert(JSON.stringify(output.slice(0, 4)).includes('38 30 31 32 33 34 35'));
  // The control unit's serial number is still blanked.
  assert(!JSON.stringify(output).includes('34 35 36 37 38 39 41'));
  assert(output.at(-1).text.includes('62 F1 8C'));
  assert(output.at(-1).text.includes('>'));
  assert.throws(() => readTraceLine('@@OBDCRAFT_TRACE {"text":"bad"}', redact), /Malformed/);
  assert.throws(() => readTraceLine('@@OBDCRAFT_TRACE {"text":"TMBJB7NS0P8012345', redact), error =>
    error.message.includes('Malformed') && !error.message.includes('TMBJB7NS0P8012345'));
});

test('measures fragmented response delivery and configuration differences on one clock', () => {
  const source = [
    e(0, 'tx', 'ATSH70E\r'), e(5, 'rx', 'OK\r>'),
    e(10, 'tx', '0322F187\r'), e(110, 'rx', 'SEARCHING...\r'), e(510, 'rx', 'NO DATA\r>'),
    e(511, 'event', 'ble:write-resolved {"id":1,"bytes":9,"durationMs":2.5}'),
    e(520, 'tx', 'ATCAF1\r'), e(525, 'rx', 'OK\r>'),
  ];
  const report = analyze(loadEntries(JSON.stringify({ entries: source, session: 'one' })));
  assert.equal(report.clock, 'monotonic-ms');
  assert.equal(report.commands[1].requestedHeader, '70E');
  assert.equal(report.commands[1].firstByteMs, 100);
  assert.equal(report.commands[1].promptMs, 500);
  assert.equal(report.commands[1].gapAfterPromptMs, 5);
  assert.equal(report.timings['70E:22F187'].statusCounts['NO DATA'], 1);
  assert.equal(report.commands[1].firstCompleteCanFrameMs, null); // SEARCHING is not an ECU reply
  assert.equal(report.bluetooth.completionMs.max, 2.5);
  assert.deepEqual(report.nonReadRequests, []);
  const native = analyze(source.slice(0, 5));
  assert.equal(compare(native, report).firstWireDifference.index, 2);
  assert.equal(compare(native, report).firstDiagnosticDifference, null);
});

test('timestamps complete expected CAN frames separately from SEARCHING and the final prompt', () => {
  const report = analyze([
    e(0, 'tx', 'ATCRA778\r'), e(5, 'rx', 'OK\r>'),
    e(10, 'tx', '0322F187\r'), e(110, 'rx', 'SEARCHING...\r'),
    e(210, 'rx', '00 00 07 78 07 62 F1 87 54 45'),
    e(310, 'rx', ' 53 54\r'), e(510, 'rx', '>'),
  ]);
  assert.equal(report.commands[1].firstByteMs, 100);
  assert.equal(report.commands[1].firstCompleteCanFrameMs, 300);
  assert.equal(report.commands[1].firstExpectedCanFrameMs, 300);
  assert.equal(report.commands[1].promptMs, 500);
});

test('legacy wall clocks, missing prompts, pending replies and mutating requests remain distinct', () => {
  const entries = [
    e(0, 'tx', '042E0E4600\r'),
    e(100, 'rx', '00 00 07 7E 03 7F 2E 78 AA AA AA AA\r'),
    e(30000, 'event', 'coding:unknown'),
  ].map(({ monoMs, ...entry }) => entry);
  const report = analyze(entries);
  assert.match(report.clock, /legacy/);
  assert.equal(report.counts.noPrompt, 1);
  assert.equal(report.counts.pendingMarkers, 1);
  assert.equal(report.nonReadRequests[0].service, '2E');
  assert.deepEqual(report.commands[0].frameHeaders, ['77E']);
  assert(!('success' in report));
});

test('decodes D1 envelopes, merges chunks of one session, and rejects mixed clocks', () => {
  const wrap = log => ({ kind: 'session', body: JSON.stringify({ kind: 'session', body: log }) });
  const document = [{ results: [
    wrap({ session: 'one', chunk: 1, entries: [e(2, 'rx', 'NO DATA\r>')] }),
    wrap({ session: 'one', chunk: 0, entries: [e(1, 'tx', '0322F187\r')] }),
  ] }];
  const entries = loadEntries(JSON.stringify(document));
  assert.deepEqual(entries.map(row => row.direction), ['tx', 'rx']);
  document[0].results.push(wrap({ session: 'other', entries: [e(0, 'tx', 'ATI\r')] }));
  assert.throws(() => loadEntries(JSON.stringify(document)), /one connection/);
  assert.throws(() => analyze([e(2, 'tx', 'ATI\r'), e(1, 'rx', 'OK\r>')]), /backwards/);
});
