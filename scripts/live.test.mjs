import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIVE = fileURLToPath(new URL('./live.ts', import.meta.url));

/** A local port nothing listens on: bound, read, then released. */
const closedPort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const runLive = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [LIVE, ...args], { timeout: 60_000, env: { ...process.env, OBDCRAFT_LOG_ENDPOINT: '' } }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}` }),
    );
  });

test('a command whose bridge connection fails records and uploads nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'obdcraft-live-'));
  try {
    const port = await closedPort();
    const { output } = await runLive(['status', '--host', '127.0.0.1', '--port', String(port), '--log-dir', dir]);
    assert.match(output, /could not connect/);
    assert.doesNotMatch(output, /\[upload\]/);
    const snapshot = JSON.parse(readFileSync(join(dir, 'db', 'obdcraft-live.json'), 'utf8'));
    assert.equal(snapshot.tables.connectionLogs?.length ?? 0, 0);
    assert.equal(snapshot.tables.outbox?.length ?? 0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
