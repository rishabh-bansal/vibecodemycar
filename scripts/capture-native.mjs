#!/usr/bin/env node
/**
 * Owner-started read-only native observation. Run --self-test first; it opens no Bluetooth.
 * node scripts/capture-native.mjs <prepared-directory> <new-output.ndjson> [bcm|cluster|--self-test] [--upload]
 *
 * --upload: afterwards, the (already redacted) capture is also uploaded to the private cloud log as `session`
 * items, like a browser connection log, so it can be fetched with `npm run logs:pull`. The local file stays.
 *
 * Captures only structured observer records, redacts BEFORE persistence, discards unstructured console
 * output (which legacy tools may print with identifiers), and never accepts arbitrary native arguments.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync, writeSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createWireRedactor, fitItem, sessionItem } from '../src/domain/logs/redact.ts';

const PREFIX = '@@OBDCRAFT_TRACE ';
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function readTraceLine(line, redact) {
  if (!line.startsWith(PREFIX)) return undefined;
  let entry;
  try { entry = JSON.parse(line.slice(PREFIX.length)); }
  catch { throw new Error('Malformed capture event; raw fragments were not saved'); }
  if (!Number.isFinite(entry.monoMs) || !['tx', 'rx', 'event'].includes(entry.direction)
      || typeof entry.text !== 'string' || typeof entry.at !== 'string') {
    throw new Error('Malformed capture event; recording cannot be trusted');
  }
  return redact(entry);
}

export async function capture(root, output, target) {
  if (!['bcm', 'cluster', '--self-test'].includes(target)) throw new Error('Choose bcm, cluster or --self-test');
  root = resolve(root);
  output = resolve(output);
  if (!existsSync(dirname(output))) throw new Error('Output parent must exist');
  const provenance = spawnSync('python3', [
    join(root, 'scripts/verify-provenance.py'), root, join(root, 'scripts/bin'),
  ], { encoding: 'utf8' });
  if (provenance.status !== 0) throw new Error('Native provenance verification failed; rebuild the capture copy');
  const build = JSON.parse(readFileSync(join(root, 'capture-build.json'), 'utf8'));
  if (sha(join(root, 'scripts/bin/build-manifest.json')) !== build.instrumentedBuildManifestSha256) {
    throw new Error('Capture build manifest changed');
  }
  const executable = join(root, 'NativeCapture.app/Contents/MacOS/ble-write');
  if (sha(executable) !== sha(join(root, 'scripts/bin/ble-write'))) throw new Error('Bundled executable changed');
  const observation = `${output}.observation.json`;
  if (existsSync(observation)) throw new Error('An observation already exists here; choose a new output');
  const fd = openSync(output, 'wx', 0o600);
  const redact = createWireRedactor();
  let count = 0, omitted = 0, failure;
  let bluetoothState;
  const bluetoothStates = ['unknown', 'resetting', 'unsupported', 'unauthorized', 'powered off', 'powered on'];
  let firstWireMs;
  const save = entry => writeSync(fd, JSON.stringify(entry) + '\n');
  const nativeArgs = target === '--self-test' ? ['--capture-self-test'] : [
    '--qualify', '--module', target === 'bcm' ? '70E:778' : '714:77E',
    '--qual-out', observation,
  ];
  save({ direction: 'event', at: new Date().toISOString(), text: 'capture:started',
    schema: 'obdcraft.host-capture/1', target, executableSha256: sha(executable), build });
  const child = spawn(executable, nativeArgs, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  // This wrapper can only execute bounded reads; a wall-time backstop never kills a coding operation.
  const timer = setTimeout(() => { failure = new Error('Read-only capture exceeded 120 seconds'); child.kill('SIGTERM'); }, 120_000);
  const stop = () => { failure = new Error('Read-only capture interrupted'); child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on('line', line => {
      try {
        const entry = readTraceLine(line, redact);
        if (entry) {
          save(entry);
          count++;
          if (entry.direction === 'tx' || entry.direction === 'rx') {
            firstWireMs ??= entry.monoMs;
            // This is the already-redacted record. Full Bluetooth metadata stays in the NDJSON file.
            const text = entry.text.replace(/[\r\n]+/g, ' | ').trim();
            console.log(`+${(entry.monoMs - firstWireMs).toFixed(3)}ms ${entry.direction.toUpperCase()} ${text}`);
          }
        }
        else {
          // The legacy delegate can exit before its first observer event. This exact numeric
          // status contains no device identity; all other unstructured output remains omitted.
          const state = /^BT state ([0-5])$/.exec(line);
          if (state) {
            bluetoothState = bluetoothStates[Number(state[1])];
            console.log(`macOS Bluetooth: ${bluetoothState}`);
          }
          omitted++;
        }
      } catch (error) {
        failure = error;
        child.kill('SIGTERM');
      }
    });
  }
  let exitCode, signal;
  try {
    [exitCode, signal] = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => done([code, sig]));
    });
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    save({ direction: 'event', at: new Date().toISOString(), text: 'capture:ended',
      exitCode, signal, events: count, omittedConsoleLines: omitted,
      ...(bluetoothState ? { bluetoothState } : {}),
      recordingError: failure ? String(failure.message) : null });
    closeSync(fd);
  }
  console.log(JSON.stringify({ output, events: count, exitCode, signal, recordingError: failure?.message ?? null }));
  if (failure) throw failure;
  if (count === 0) throw new Error('No observation events: this is not a usable capture');
  return exitCode ?? 1;
}

const LOG_ENDPOINT = process.env.OBDCRAFT_LOG_ENDPOINT ?? 'https://obdcraft-logs.rishabhbansal1855.workers.dev';
const CHUNK = 1000;

/**
 * Uploads a finished capture (NDJSON written by `capture`, redacted before it was written) to the private log:
 * registers an upload-only collector, then PUTs one `session` item per CHUNK entries (redacted again and fitted
 * to the size limit by the same code as the browser). Returns the uploaded item ids.
 */
export async function uploadCapture(output, endpoint = LOG_ENDPOINT, fetchImpl = fetch) {
  const lines = readFileSync(output, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((line) => {
    const { at, monoMs, direction, text, ...rest } = JSON.parse(line);
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return {
      at: typeof at === 'string' ? at : new Date().toISOString(),
      ...(Number.isFinite(monoMs) ? { monoMs } : {}),
      direction: ['tx', 'rx', 'event'].includes(direction) ? direction : 'event',
      text: `${direction === 'event' ? 'native:' : ''}${String(text ?? '')}${direction === 'event' ? extra : ''}`.slice(0, 4096),
    };
  });
  if (!entries.length) throw new Error('Nothing to upload: the capture is empty');
  const reg = await fetchImpl(`${endpoint}/v1/register`, { method: 'POST' });
  if (!reg.ok) throw new Error(`Registration refused: HTTP ${reg.status}`);
  const { token } = await reg.json();
  const session = `native-${createHash('sha256').update(readFileSync(output)).digest('hex').slice(0, 24)}`;
  const ids = [];
  for (let chunk = 0; chunk * CHUNK < entries.length; chunk++) {
    const part = entries.slice(chunk * CHUNK, (chunk + 1) * CHUNK);
    const log = {
      schema: 'obdcraft.connection-log/1',
      id: `${session}-${String(chunk).padStart(4, '0')}`,
      session,
      chunk,
      startedAt: part[0].at,
      updatedAt: part.at(-1).at,
      buildId: 'native-capture',
      entries: part,
      closed: true,
    };
    const { text } = fitItem(sessionItem(log));
    const res = await fetchImpl(`${endpoint}/v1/items/session/${encodeURIComponent(log.id)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: text,
    });
    if (!res.ok) throw new Error(`Upload of ${log.id} refused: HTTP ${res.status}`);
    ids.push(log.id);
  }
  return ids;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , root, output, target, ...flags] = process.argv;
  const upload = flags.includes('--upload');
  if (!root || !output || !target || flags.some((f) => f !== '--upload')) {
    console.error('Usage: node scripts/capture-native.mjs <prepared-directory> <new-output.ndjson> <bcm|cluster|--self-test> [--upload]');
    process.exitCode = 64;
  } else {
    try { process.exitCode = await capture(root, output, target); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    // Even a failed capture's partial file is worth having in the cloud log; it is already redacted.
    if (upload && existsSync(output)) {
      try { console.log(`Uploaded to the private log: ${(await uploadCapture(output)).join(', ')}`); }
      catch (error) { console.error(`Upload failed (the local file is kept): ${error.message}`); process.exitCode ||= 1; }
    }
  }
}
