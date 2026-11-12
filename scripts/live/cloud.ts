/**
 * The private cloud log for the live kit, through the app's own outbox (src/infra/cloud — called, never changed):
 * every experiment, operation journal and connection log the CLI records in its local store is queued and
 * uploaded exactly as the browser does it, so the engineer pulls them with `npm run logs:pull`.
 *
 * The app keeps its upload credential in localStorage. Node has none, so this installs a small stand-in before
 * the cloud code runs: the cloud keys (`vibecode-my-car.cloud*`; `obdcraft.cloud*` before the rename) persist in <log-dir>/cloud-storage[-<endpoint hash>].json (mode 600);
 * everything else (diagnostics ring, boot counter) lives in memory for the one command. The token is never printed.
 *
 * OBDCRAFT_LOG_ENDPOINT (as logs:pull) points the uploads at another log Worker, e.g. a local `wrangler dev`.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateLegacyKeys } from '../../src/domain/storage-keys.ts';

const PERSISTED = /^(?:vibecode-my-car|obdcraft)\.cloud/;

/** A Web Storage stand-in: cloud keys are written through to `file`, the rest stay in memory. */
function installStorage(file: string): void {
  // Node's own Web Storage needs --localstorage-file; reading the global without it only warns. Replace it unread.
  const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (own && 'value' in own && own.value && typeof (own.value as Storage).getItem === 'function') return;
  const mem = new Map<string, string>();
  try {
    if (existsSync(file)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>)) mem.set(k, v);
  } catch {
    // An unreadable file is a fresh start: the next sync registers this machine again.
  }
  const persist = () => {
    const kept = Object.fromEntries([...mem].filter(([k]) => PERSISTED.test(k)));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  };
  const storage = {
    get length() {
      return mem.size;
    },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem(k: string, v: string) {
      mem.set(k, String(v));
      if (PERSISTED.test(k)) persist();
    },
    removeItem(k: string) {
      const had = mem.delete(k);
      if (had && PERSISTED.test(k)) persist();
    },
    clear() {
      mem.clear();
      persist();
    },
  };
  const session = new Map<string, string>();
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
  define('localStorage', storage);
  define('sessionStorage', {
    get length() {
      return session.size;
    },
    key: (i: number) => [...session.keys()][i] ?? null,
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, String(v)),
    removeItem: (k: string) => void session.delete(k),
    clear: () => session.clear(),
  });
}

export interface CloudUpload {
  /** Queues every changed local record, registers this machine when needed, uploads what is due. */
  sync(): Promise<UploadReport>;
}

export interface UploadReport {
  endpoint: string;
  registered: boolean;
  queued: number;
  uploaded: number;
  failed: number;
  /** Distinct errors the outbox recorded (never a token). */
  errors: string[];
}

/** Must run before any app module reads localStorage (diagnostics reads it on import). */
export function prepareCloudStorage(logDir: string): void {
  mkdirSync(logDir, { recursive: true });
  // One credential per endpoint: a token issued by a local Worker must never be presented to the real one.
  const override = process.env.OBDCRAFT_LOG_ENDPOINT;
  const suffix = override ? `-${createHash('sha256').update(override).digest('hex').slice(0, 8)}` : '';
  installStorage(join(logDir, `cloud-storage${suffix}.json`));
  // A credential saved before the rename moves to its new key, as the app does on start.
  migrateLegacyKeys();
}

export async function openCloud(database: () => import('../../src/infra/storage/db.ts').ObdcraftDb): Promise<CloudUpload> {
  const [{ syncOutbox, drainOutbox, reportStatus }, { ensureCollector }, { logEndpoint, readEnrollment }] = await Promise.all([
    import('../../src/infra/cloud/outbox.ts'),
    import('../../src/infra/cloud/api.ts'),
    import('../../src/infra/cloud/config.ts'),
  ]);
  const built = logEndpoint();
  const override = process.env.OBDCRAFT_LOG_ENDPOINT?.replace(/\/+$/, '');
  const endpoint = override ?? built;
  // ensureCollector only knows the build's endpoint: an override re-addresses its one request.
  const redirect: typeof fetch = (input, init) => {
    const url = String(input);
    return fetch(override && built && url.startsWith(built) ? override + url.slice(built.length) : url, init);
  };
  return {
    async sync() {
      if (!endpoint) throw new Error('no log endpoint configured');
      await syncOutbox(undefined, database, new Date(), { full: true });
      let enrollment = readEnrollment();
      if (!enrollment) enrollment = await ensureCollector(redirect);
      if (enrollment) {
        await drainOutbox({ enrollment, endpoint, database, fetchImpl: redirect });
        await reportStatus({ enrollment, endpoint, database, fetchImpl: redirect, force: true });
      }
      const entries = await database().outbox.toArray();
      const count = (s: string) => entries.filter((e) => e.status === s).length;
      return {
        endpoint,
        registered: !!enrollment,
        queued: count('queued'),
        uploaded: count('uploaded'),
        failed: count('failed'),
        errors: [...new Set(entries.filter((e) => e.status !== 'uploaded' && e.lastError).map((e) => `${e.kind}: ${e.lastError}`))].slice(0, 5),
      };
    },
  };
}
