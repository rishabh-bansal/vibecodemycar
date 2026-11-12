import type { LogKind } from '../../domain/logs/contract.ts';
import {
  type CloudEnrollment,
  logEndpoint,
  readEnrollment,
  readPreviousTokens,
  rememberPreviousToken,
  uploadsOptedOut,
  writeEnrollment,
} from './config.ts';

/** Authenticated calls to the private log Worker, besides uploads (which go through the outbox). */

async function problemOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { message?: string }).message ?? `The log service answered ${res.status}.`;
  } catch {
    return `The log service answered ${res.status}.`;
  }
}

function require(): { endpoint: string; enrollment: CloudEnrollment } {
  const endpoint = logEndpoint();
  const enrollment = readEnrollment();
  if (!endpoint || !enrollment) throw new Error('This browser is not enrolled in the private log.');
  return { endpoint, enrollment };
}
const auth = (e: CloudEnrollment) => ({ Authorization: `Bearer ${e.token}` });

/** Exchanges the owner's enrollment code for this browser's device token. The code is not kept. */
export async function enroll(code: string, label: string): Promise<CloudEnrollment> {
  const endpoint = logEndpoint();
  if (!endpoint) throw new Error('Cloud logging is not configured in this build.');
  const res = await fetch(`${endpoint}/v1/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label }),
  });
  if (!res.ok) throw new Error(await problemOf(res));
  const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
  // Logs this browser already collected keep uploading under the owner token (owners may update any item);
  // the collector token is remembered so a later re-registration can take its items over.
  const replaced = readEnrollment();
  if (replaced) rememberPreviousToken(replaced.token);
  const enrollment: CloudEnrollment = {
    token,
    deviceId,
    label,
    role: 'owner',
    enrolledAt: replaced?.enrolledAt ?? new Date().toISOString(),
  };
  writeEnrollment(enrollment);
  return enrollment;
}

/**
 * Registers this browser as an upload-only collector, once, so its logs upload automatically. Nothing happens
 * without a configured endpoint, after an opt-out, or when it is already registered. A browser whose earlier
 * token stopped working (revoked, signed out) presents it, so the new device takes over what it uploaded.
 */
export async function ensureCollector(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<CloudEnrollment | undefined> {
  const endpoint = logEndpoint();
  const existing = readEnrollment();
  if (!endpoint || existing || uploadsOptedOut()) return existing;
  const previousTokens = readPreviousTokens();
  const res = await fetchImpl(`${endpoint}/v1/register`, {
    method: 'POST',
    ...(previousTokens.length
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previousTokens }) }
      : {}),
  });
  if (!res.ok) throw new Error(await problemOf(res));
  const { token, deviceId } = (await res.json()) as { token: string; deviceId: string };
  const enrollment: CloudEnrollment = {
    token,
    deviceId,
    label: 'auto',
    role: 'collector',
    enrolledAt: new Date().toISOString(),
  };
  writeEnrollment(enrollment);
  rememberPreviousToken(undefined);
  return enrollment;
}

/** The whole private log, as one JSON file. */
export async function exportCloud(): Promise<Blob> {
  const { endpoint, enrollment } = require();
  const res = await fetch(`${endpoint}/v1/export`, { headers: auth(enrollment) });
  if (!res.ok) throw new Error(await problemOf(res));
  return res.blob();
}

export async function deleteCloudItem(kind: LogKind, id: string): Promise<void> {
  const { endpoint, enrollment } = require();
  const res = await fetch(`${endpoint}/v1/items/${kind}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: auth(enrollment),
  });
  if (!res.ok) throw new Error(await problemOf(res));
}

/**
 * Revokes this browser's token on the server and forgets it here. Local records are untouched, and automatic
 * logging carries on: the next sync registers this browser as a collector again, taking over its items.
 */
export async function signOut(): Promise<void> {
  const { endpoint, enrollment } = require();
  try {
    await fetch(`${endpoint}/v1/device`, { method: 'DELETE', headers: auth(enrollment) });
  } finally {
    rememberPreviousToken(enrollment.token);
    writeEnrollment(undefined);
  }
}
