// Development-only page: never imported by the product entry point or shipped in a production build.
import { WebBluetoothLink } from '../src/infra/link/web-bluetooth.ts';
import { ConnectionLogger } from '../src/infra/cloud/connection-log.ts';
import { ensureCollector } from '../src/infra/cloud/api.ts';
import { kickCloudSync } from '../src/infra/cloud/outbox.ts';
import { db } from '../src/infra/storage/db.ts';
import captureSource from './capture-browser.ts?raw';

const button = document.querySelector<HTMLButtonElement>('#start')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const ready = document.querySelector<HTMLInputElement>('#ready')!;
const select = document.querySelector<HTMLSelectElement>('#module')!;
const status = document.querySelector<HTMLPreElement>('#status')!;
let running = false;
let loggingReady = false;
let captureHash = '';
let cancelled = false;
let link: WebBluetoothLink | undefined;
let logger: ConnectionLogger | undefined;

const note = (kind: string, details: Record<string, string | number | boolean> = {}) => {
  logger?.bluetooth({ at: new Date().toISOString(), monoMs: performance.now(), kind, details });
};
ready.onchange = () => { button.disabled = running || !loggingReady || !ready.checked; };
// Enroll before starting a session: the outbox intentionally excludes records made before enrollment.
void Promise.all([
  ensureCollector(),
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(captureSource)),
]).then(([collector, hash]) => {
  captureHash = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  loggingReady = true;
  button.disabled = !ready.checked;
  status.textContent = collector
    ? 'Recorder ready. Redacted logs will upload automatically. No connection opened.'
    : 'Recorder ready for local storage. Upload is disabled. No connection opened.';
}).catch(() => {
  status.textContent = 'Could not prepare the recorder. Check the connection to the log service and reload before starting.';
});
document.addEventListener('visibilitychange', () => note('page-visibility', { state: document.visibilityState }));
stop.onclick = () => { cancelled = true; void link?.close(); };

button.onclick = async () => {
  if (running || !loggingReady || !ready.checked) return;
  running = true;
  cancelled = false;
  button.disabled = true;
  stop.disabled = false;
  select.disabled = true;
  const module = select.value === 'bcm'
    ? { request: '70E', response: '778' } : { request: '714', response: '77E' };
  const capture = new ConnectionLogger();
  logger = capture;
  status.textContent = `Session ${capture.session}\nOpening a read-only connection…`;
  kickCloudSync();
  const started = performance.now();
  const timer = setTimeout(() => { cancelled = true; void link?.close(); }, 120_000);
  try {
    // This page only ever reads; it never calls a write on the link.
    link = await WebBluetoothLink.connect(navigator, {
      onWire: capture.wire,
      onBluetooth: capture.bluetooth,
    });
    if (cancelled) return;
    note('capture-start', {
      target: module.request, profile: 'native-qualification-read-order', visible: document.visibilityState,
      appBuild: import.meta.env.VITE_BUILD_ID ?? 'development', captureSha256: captureHash, browser: navigator.userAgent,
      canWrite: link.canWrite,
    });
    // Same logical identity order as the native writer's read-only qualification.
    const odx = await link.readDid(module, 'F19E');
    note('read-result', { target: module.request, did: 'F19E', result: odx.kind });
    status.textContent += `\nODX: ${odx.kind}.`;
    if (cancelled || odx.kind !== 'ok') return;
    const vin = await link.identify(module);
    note('identity-result', { target: module.request, result: vin.kind }); // never record the raw VIN
    status.textContent += `\nVIN: ${vin.kind}.`;
    if (cancelled || vin.kind !== 'ok') return;
    const part = await link.readDid(module, 'F187');
    note('read-result', { target: module.request, did: 'F187', result: part.kind });
    status.textContent += `\nPart: ${part.kind}.`;
  } catch {
    // The wire/transport log carries the evidence. Unknown exception strings can contain identifiers.
    note('capture-error');
    status.textContent += '\nThe read cycle stopped. See this session’s recorded traffic.';
  } finally {
    clearTimeout(timer);
    note('capture-finished', { cancelled, durationMs: performance.now() - started });
    await link?.close();
    link = undefined;
    await capture.stop('read-only comparison finished');
    kickCloudSync();
    logger = undefined;
    running = false;
    select.disabled = false;
    button.disabled = !ready.checked;
    stop.disabled = true;
    const saved = await db().connectionLogs.get(`${capture.session}-0000`).catch(() => undefined);
    status.textContent += saved?.closed
      ? '\nDisconnected. The log is saved locally and queued for automatic upload when enabled.'
      : '\nDisconnected. Could not confirm the log was saved; this capture must not be treated as complete.';
  }
};
