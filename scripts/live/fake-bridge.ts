/**
 * Offline stand-in for tools/live/elm-bridge: serves the ELM327 emulator on a TCP port, so `npm run live`
 * can be exercised without the car.
 *
 *   node scripts/live/fake-bridge.ts [--host 127.0.0.1] [--port 35000] [--profile <vehicle-profile.json>]
 *                                    [--asleep] [--hang-rate 0.0] [--prompt-loss 0.0] [--stn]
 *   node scripts/live/fake-bridge.ts --sim [--seed 1] [--calm] [--byte8] [--rx-fc-loss 0.2]
 *
 * Default: the ELM327 emulator (a well-behaved adapter) in front of scripts/live/fake-car.ts.
 * --sim: the clone simulator (scripts/live/sim-car.ts) — the live clone's drops and quirks, in real time, in front
 * of the Kushaq's modules seeded from the app's demo fixtures. `--seed` makes the run reproducible as far as wall
 * clock timing allows; `--calm` turns every drop chance off (a perfect adapter with the same modules); `--byte8`
 * adds the owner's clone's raw-frame fault (the 8th byte of a full 8-byte frame arrives as the flow-control byte).
 * `--rx-fc-loss <0..1>` sets how often the host's own flow control for the next block of a long answer is lost (default
 * 0.2; untested on the car): `--rx-fc-loss 1` makes every answer longer than four consecutive frames arrive truncated,
 * as the live clone delivered them before the host granted blocks (the health snapshot's 19 02 split by status mask).
 * `--stn` makes the emulator an STN chip (STI answers, STPX works), for the frame test's `stpx` mode.
 *
 * Same contract as the BLE bridge: bytes pass unmodified, one client at a time (a second is refused), the
 * "adapter" (one emulator instance, with its ELM state) stays up across client reconnects, and status lines
 * go to stdout as JSON {ts, event, ...}.
 */
import { createServer, type Socket } from 'node:net';
import { Elm327Emulator, realClock, type Transport } from '@obdcraft/obd-core';
import type { FaultModel } from '../../src/infra/link/testing/clone-sim.ts';
import { fakeCarEcus, loadProfile } from './fake-car.ts';
import { markFakeBridge } from './fake-marker.ts';
import { simCar } from './sim-car.ts';

const args = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : def;
};
const host = flag('--host', '127.0.0.1');
const port = Number(flag('--port', '35000'));
const profilePath = flag('--profile', '');
let asleep = args.includes('--asleep');

const emit = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

const sim = args.includes('--sim');
const seed = Number(flag('--seed', '1'));

/** The "adapter": either Transport, written in arrival order, whose output goes to the one client. */
let adapter: Transport;
let ready: Record<string, unknown>;
let writesOf: () => unknown;
if (sim) {
  const calm: Partial<FaultModel> = args.includes('--calm')
    ? { pStale: 0, pLocked: 0, transitions: [], pSearchOk: 0, pSearchAfterSilent: 0, pSearchUnable: 0, pFirstCf: 0, pRxFc: 0, pLastRxCfLoss: 0 }
    : {};
  const rxFcLoss = args.includes('--rx-fc-loss') ? { pRxFc: Number(flag('--rx-fc-loss', '0.2')) } : {};
  const car = simCar(seed, { ...calm, ...rxFcLoss, ...(args.includes('--byte8') ? { corruptFullFrames: true } : {}) });
  adapter = car.sim;
  ready = { adapter: 'clone simulator', seed, calm: args.includes('--calm'), byte8: args.includes('--byte8'), modules: car.modules };
  writesOf = () => ({
    stored: car.sim.truth.filter((e) => e.type === 'stored').map((e) => e.type === 'stored' && `${e.ecu} ${e.did}`),
    drops: car.sim.truth.filter((e) => e.type === 'dropped').length,
  });
} else {
  const profile = loadProfile(profilePath || undefined);
  const { ecus, modules } = fakeCarEcus(profile);
  adapter = new Elm327Emulator({
    clock: realClock,
    ecus,
    protocol: profile.protocol,
    identity: profile.adapter.identity,
    device: profile.adapter.device,
    voltage: () => (asleep ? 12.3 : profile.adapter.voltage),
    hangRate: Number(flag('--hang-rate', '0')),
    promptLossRate: Number(flag('--prompt-loss', '0')),
    asleep: () => asleep,
    name: 'Fake bridge emulator',
    id: 'fake-bridge',
    ...(args.includes('--stn') ? { stnChip: 'STN2255 v5.10.3', stnDevice: 'OBDLink MX+ (fake)' } : {}),
  });
  ready = {
    adapter: profile.adapter.identity,
    profile: profile.name,
    modules: modules.map((m) => `${m.requestId}:${m.id}`),
    ecus: ecus.map((e) => `${e.requestId}:${e.id}`),
  };
  writesOf = () => ({ modules: modules.map((m) => ({ module: m.requestId, writes: m.writes.length })) });
}
await adapter.open();

let client: Socket | null = null;
let seq = 0;
let txBytes = 0;
let rxBytes = 0;
// Writes are applied strictly in arrival order (the emulator delays each by its write latency).
let chain: Promise<void> = Promise.resolve();

adapter.onData((chunk) => {
  rxBytes += chunk.length;
  client?.write(chunk);
});

const server = createServer((socket) => {
  if (client) {
    emit('client-refused', { reason: 'another client is connected' });
    socket.destroy();
    return;
  }
  const id = ++seq;
  client = socket;
  socket.setNoDelay(true);
  emit('client-connected', { client: id, bleReady: true });
  socket.on('data', (buf: Buffer) => {
    txBytes += buf.length;
    const bytes = new Uint8Array(buf);
    chain = chain.then(() => adapter.write(bytes)).catch((e) => emit('error', { message: String(e) }));
  });
  const closed = (reason: string) => {
    if (client !== socket) return;
    client = null;
    emit('client-closed', { client: id, reason, txBytes, rxBytes });
  };
  socket.on('error', (e) => closed(`error: ${e.message}`));
  socket.on('close', () => closed('eof'));
});

server.on('error', (e) => {
  emit('error', { message: `listen failed: ${e.message}` });
  process.exit(2);
});
let unmark = () => {};
server.listen(port, host, () => {
  // Runs against this bridge are synthetic: the CLI never uploads them to the real log.
  unmark = markFakeBridge(port);
  emit('listening', { host, port });
  emit('ready', ready);
});

// Typing "sleep" / "wake" on stdin toggles the bus, to rehearse ignition-off behaviour.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line: string) => {
  const cmd = line.trim().toLowerCase();
  if ((cmd === 'sleep' || cmd === 'wake') && !sim) {
    asleep = cmd === 'sleep';
    emit('bus', { asleep });
  } else if (cmd === 'writes') {
    emit('writes', writesOf() as Record<string, unknown>);
  }
});

const stop = () => {
  emit('exit', { txBytes, rxBytes });
  unmark();
  client?.destroy();
  server.close();
  void adapter.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
