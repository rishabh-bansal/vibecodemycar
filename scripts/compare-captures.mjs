#!/usr/bin/env node
/**
 * Host-level timing comparison. Accepts native NDJSON, a browser connection log, log-item envelope,
 * or a D1 --json result containing ONE connection (possibly several chunks).
 * Never calls Bluetooth, a vehicle, a server or a captured URL.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWireRedactor } from '../src/domain/logs/redact.ts';

export function loadEntries(text) {
  let document;
  try { document = JSON.parse(text); }
  catch { document = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  const groups = [];
  const collect = item => {
    if (typeof item === 'string') { try { collect(JSON.parse(item)); } catch {} }
    else if (Array.isArray(item)) {
      if (item.every(e => typeof e?.direction === 'string')) groups.push({ entries: item });
      else item.forEach(collect);
    } else if (item && typeof item === 'object') {
      if (Array.isArray(item.entries)) groups.push(item);
      else if (item.results) collect(item.results);
      else if (item.body && (!item.kind || item.kind === 'session')) collect(item.body);
    }
  };
  collect(document);
  const sessions = new Set(groups.map(g => g.session).filter(Boolean));
  if (sessions.size > 1) throw new Error('Select one connection per input; clocks must not be combined across sessions');
  groups.sort((a, b) => (a.chunk ?? 0) - (b.chunk ?? 0));
  const entries = groups.flatMap(g => g.entries).map(createWireRedactor(true));
  if (!entries.some(e => e.direction === 'tx')) throw new Error('Input has no transmitted commands');
  return entries;
}

const stats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = percentile => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? null;
  return { n: sorted.length, min: sorted[0] ?? null, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
};
const statuses = /NO DATA|UNABLE TO CONNECT|CAN ERROR|BUS ERROR|BUS BUSY|BUFFER FULL|DATA ERROR|STOPPED|(?:^|[\r\n])\?(?=[\r\n>]|$)/g;
const frameLine = /(?:^|[\r\n])\s*((?:[0-9A-F]{2}\s+){3}[0-9A-F]{2}|[0-9A-F]{8}|[0-9A-F]{3})\s+((?:[0-9A-F]{2}|··)(?:\s+(?:[0-9A-F]{2}|··))*)/gi;

function diagnostic(cmd) {
  if (!/^[0-9A-F]+$/.test(cmd) || cmd.length < 4) return undefined;
  const type = Number.parseInt(cmd[0], 16);
  const offset = type === 0 ? 2 : type === 1 ? 4 : -1;
  if (offset < 0 || cmd.length < offset + 2) return undefined;
  return { service: cmd.slice(offset, offset + 2), pduPrefix: cmd.slice(offset, offset + 6) };
}

export function analyze(entries) {
  const wire = entries.filter(e => ['tx', 'rx', 'stale'].includes(e.direction));
  const monotonic = wire.every(e => Number.isFinite(e.monoMs));
  const time = e => monotonic ? e.monoMs : Date.parse(e.at);
  if (wire.some(e => !Number.isFinite(time(e)))) throw new Error('Missing/invalid wire timestamps');
  if (wire.some((e, i) => i > 0 && time(e) < time(wire[i - 1]))) throw new Error('Clock moved backwards: timing comparison is invalid');
  const start = time(wire[0]);
  let header = 'unknown', responseFilter = 'unknown', active, lastPrompt;
  const commands = [], stale = [], ble = [];
  for (const entry of entries) {
    if (entry.direction === 'event') {
      const m = /^ble:(\S+) (.*)$/.exec(entry.text);
      if (m) { try { ble.push({ kind: m[1], ...JSON.parse(m[2]), monoMs: entry.monoMs }); } catch {} }
      continue;
    }
    if (entry.direction === 'tx') {
      const cmd = entry.text.replace(/\s/g, '').toUpperCase();
      active = {
        cmd, requestedHeader: header, requestedResponseFilter: responseFilter,
        atMs: time(entry) - start, firstByteMs: null, promptMs: null,
        firstCompleteCanFrameMs: null, firstExpectedCanFrameMs: null,
        gapAfterPromptMs: lastPrompt === undefined ? null : time(entry) - lastPrompt,
        rxChunks: 0, rx: '', diagnostic: diagnostic(cmd),
      };
      commands.push(active);
      const bind = /^ATSH([0-9A-F]+)$/.exec(cmd);
      if (bind) header = bind[1]; // requested configuration; this does not claim the adapter accepted it
      if (/^ATCRA[0-9A-F]*$/.test(cmd)) responseFilter = cmd.slice(5) || 'any';
    } else if (entry.direction === 'stale') {
      stale.push({ atMs: time(entry) - start, text: entry.text });
    } else if (entry.direction === 'rx' && active) {
      const elapsed = time(entry) - start - active.atMs;
      active.firstByteMs ??= elapsed;
      active.rxChunks++;
      // A redactor can replace an incomplete notification with a placeholder, then emit its completed
      // line in a later notification. The placeholder is not part of the ELM stream.
      active.rx += entry.text.replaceAll('[redacted: identity fragment]', '');
      const lineEnd = Math.max(active.rx.lastIndexOf('\r'), active.rx.lastIndexOf('\n'), active.rx.lastIndexOf('>')) + 1;
      const completeFrames = [...active.rx.slice(0, lineEnd).matchAll(frameLine)];
      if (completeFrames.length) active.firstCompleteCanFrameMs ??= elapsed;
      if (completeFrames.some(m => Number.parseInt(m[1].replace(/\s/g, ''), 16)
          === Number.parseInt(active.requestedResponseFilter, 16))) active.firstExpectedCanFrameMs ??= elapsed;
      if (entry.text.includes('>')) {
        active.promptMs ??= elapsed;
        lastPrompt = time(entry);
      }
    }
  }
  const groups = {};
  for (const command of commands) {
    command.statuses = [...new Set((command.rx.match(statuses) ?? []).map(s => s.trim()))];
    const frames = [...command.rx.matchAll(frameLine)];
    command.frameHeaders = [...new Set(frames.map(m => Number.parseInt(m[1].replace(/\s/g, ''), 16).toString(16).toUpperCase()))];
    command.frameTypes = frames.map(m => (m[2].trim().split(/\s+/)[0] ?? '')[0]);
    command.pendingMarkers = [...command.rx.matchAll(/\b03\s+7F\s+([0-9A-F]{2})\s+78\b/gi)].map(m => m[1].toUpperCase());
    const key = `${command.requestedHeader}:${command.diagnostic?.pduPrefix ?? command.cmd}`;
    (groups[key] ??= []).push(command);
  }
  const connected = ble.find(e => e.kind === 'connected')?.monoMs;
  const connecting = ble.find(e => e.kind === 'connect-start')?.monoMs;
  const ready = ble.find(e => e.kind === 'notifications-ready'
    || (e.kind === 'notifications-state' && e.error === false))?.monoMs;
  return {
    clock: monotonic ? 'monotonic-ms' : 'wall-clock-ms (legacy capture)',
    wireDurationMs: time(wire.at(-1)) - start,
    counts: {
      commands: commands.length, rxChunks: wire.filter(e => e.direction === 'rx').length,
      staleChunks: stale.length, noPrompt: commands.filter(c => c.promptMs === null).length,
      pendingMarkers: commands.reduce((n, c) => n + c.pendingMarkers.length, 0),
      diagnosticRequests: commands.filter(c => c.diagnostic).length,
    },
    voltageReplies: commands.filter(c => c.cmd === 'ATRV').flatMap(c => [...c.rx.matchAll(/\b(\d+\.\d+)V\b/g)].map(m => Number(m[1]))),
    observedProtocolReplies: commands.filter(c => c.cmd === 'ATDPN' || c.cmd === 'ATDP').map(c => ({ cmd: c.cmd, reply: c.rx.trim() })),
    // A session/security request is also excluded from the initial read-only comparison.
    nonReadRequests: commands.filter(c => c.diagnostic && !['22', '01', '09'].includes(c.diagnostic.service))
      .map(c => ({ atMs: c.atMs, header: c.requestedHeader, ...c.diagnostic })),
    timings: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, {
      attempts: rows.length, firstByteMs: stats(rows.map(r => r.firstByteMs).filter(v => v !== null)),
      promptMs: stats(rows.map(r => r.promptMs).filter(v => v !== null)),
      firstCompleteCanFrameMs: stats(rows.map(r => r.firstCompleteCanFrameMs).filter(v => v !== null)),
      firstExpectedCanFrameMs: stats(rows.map(r => r.firstExpectedCanFrameMs).filter(v => v !== null)),
      statusCounts: Object.fromEntries([...new Set(rows.flatMap(r => r.statuses))].map(s => [s, rows.filter(r => r.statuses.includes(s)).length])),
    }])),
    bluetooth: {
      connectMs: Number.isFinite(connected) && Number.isFinite(connecting) ? connected - connecting : null,
      discoveryAndSubscriptionMs: Number.isFinite(ready) && Number.isFinite(connected) ? ready - connected : null,
      profiles: ble.filter(e => e.kind === 'profile'),
      submittedSizes: stats(ble.filter(e => e.kind === 'write-submit').map(e => e.bytes)),
      completionMs: stats(ble.filter(e => e.kind === 'write-resolved').map(e => e.durationMs)),
      notifications: ble.filter(e => e.kind === 'notification').length,
      queuedChunks: ble.filter(e => e.kind === 'write-queued').length,
      writeFailures: ble.filter(e => e.kind === 'write-failed').length,
      disconnects: ble.filter(e => e.kind === 'disconnected').length,
      visibilityChanges: ble.filter(e => e.kind === 'page-visibility'),
      nativeLoggingUs: stats(entries.map(e => e.previousLoggingUs)),
    },
    stale, commands,
    limits: [
      'Host delivery times include Bluetooth, ELM and ECU delays; these components cannot be separated with this interface.',
      'GATT completion, an ELM prompt and a UDS acknowledgement are different events.',
      'First byte can be SEARCHING or an echo. A complete CAN frame is timed separately when its line is delivered.',
      'No write-success conclusion is inferred by this report.',
      'Recorded requested headers are not proof the adapter accepted the configuration.',
      'Small-sample percentiles are descriptive only; n is reported for every metric.',
    ],
  };
}

export function compare(left, right) {
  const differing = (a, b) => {
    const i = Array.from({ length: Math.max(a.length, b.length) }, (_, n) => n).find(n => a[n] !== b[n]);
    return i === undefined ? null : { index: i, left: a.slice(Math.max(0, i - 2), i + 5), right: b.slice(Math.max(0, i - 2), i + 5) };
  };
  const all = report => report.commands.map(c => `${c.requestedHeader}:${c.cmd}`);
  const reads = report => report.commands.filter(c => c.diagnostic).map(c => `${c.requestedHeader}:${c.diagnostic.pduPrefix}`);
  return { firstWireDifference: differing(all(left), all(right)), firstDiagnosticDifference: differing(reads(left), reads(right)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const inputs = process.argv.slice(2);
  if (inputs.length < 1 || inputs.length > 3) throw new Error('Usage: node scripts/compare-captures.mjs <left> [right] [new-report.json]');
  const sources = inputs.slice(0, 2).map(path => {
    const text = readFileSync(path, 'utf8');
    return { name: basename(path), sha256: createHash('sha256').update(text).digest('hex'), report: analyze(loadEntries(text)) };
  });
  const result = { schema: 'obdcraft.capture-comparison/1', sources,
    ...(sources[1] ? { comparison: compare(sources[0].report, sources[1].report) } : {}) };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (inputs[2]) writeFileSync(inputs[2], json, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(json);
}
