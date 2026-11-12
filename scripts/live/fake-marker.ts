/**
 * The fake bridge's mark on this machine: while it serves a port, a file names that port and its pid. The CLI then
 * treats every run on that port as synthetic (never uploaded to the real log) whatever the car's identity reads
 * returned — the adapter's own answers (ATI, AT@1) are the real clone's, so the wire cannot tell the two apart.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const markerOf = (port: number) => join(tmpdir(), `obdcraft-fake-bridge-${port}.pid`);

export function markFakeBridge(port: number): () => void {
  const file = markerOf(port);
  writeFileSync(file, String(process.pid));
  return () => rmSync(file, { force: true });
}

/** A fake bridge process is alive and owns `port`. */
export function fakeBridgeOn(port: number): boolean {
  try {
    const pid = Number(readFileSync(markerOf(port), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
