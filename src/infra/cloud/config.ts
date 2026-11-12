import { LOCAL_KEYS } from '../../domain/storage-keys.ts';

/**
 * Private cloud log settings. The endpoint is not a secret (a build-time setting); the device token is this
 * browser's credential, issued by the log Worker on enrollment and kept only on this device.
 */
export interface CloudEnrollment {
  deviceId: string;
  token: string;
  label: string;
  /** `collector` (registered automatically, upload-only) or `owner` (enrolled with the owner code). */
  role?: 'owner' | 'collector';
  /** When this browser registered or enrolled (informational: every local record uploads, whenever made). */
  enrolledAt: string;
}

const KEY = LOCAL_KEYS.cloud;

/** The log Worker — public, upload-only for collectors; baked in so no build can forget it. */
const DEFAULT_LOG_ENDPOINT = 'https://obdcraft-logs.rishabhbansal1855.workers.dev';

export const logEndpoint = (): string | undefined => {
  const raw = import.meta.env?.VITE_LOG_ENDPOINT ?? DEFAULT_LOG_ENDPOINT;
  return typeof raw === 'string' && /^https:\/\/[^\s/]+$|^http:\/\/localhost(:\d+)?$/.test(raw)
    ? raw
    : undefined;
};

export function readEnrollment(): CloudEnrollment | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as CloudEnrollment) : undefined;
    return v?.token && v.deviceId && v.enrolledAt ? v : undefined;
  } catch {
    return undefined;
  }
}

const OPT_OUT = LOCAL_KEYS.cloudOptOut;

/** The person chose not to upload logs from this browser. Logs are still kept locally. */
export function uploadsOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT) === '1';
  } catch {
    return false;
  }
}

export function setUploadsOptedOut(out: boolean): void {
  try {
    if (out) localStorage.setItem(OPT_OUT, '1');
    else localStorage.removeItem(OPT_OUT);
  } catch {
    // Blocked storage: the choice does not persist.
  }
}

export function writeEnrollment(e: CloudEnrollment | undefined): void {
  try {
    if (e) localStorage.setItem(KEY, JSON.stringify(e));
    else localStorage.removeItem(KEY);
  } catch {
    // Blocked storage: enrollment simply does not persist; nothing uploads.
  }
}

const PREVIOUS = LOCAL_KEYS.cloudPrevious;

/**
 * Tokens of this browser's earlier enrollments (newest last, at most 5), kept after they stopped being used
 * (revoked, signed out, replaced by owner access) only so the next registration can prove it is the same
 * browser and take over the items those tokens uploaded. They are sent nowhere else.
 */
export function readPreviousTokens(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PREVIOUS) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(-5) : [];
  } catch {
    return [];
  }
}

export function rememberPreviousToken(token: string | undefined): void {
  try {
    if (!token) localStorage.removeItem(PREVIOUS);
    else
      localStorage.setItem(
        PREVIOUS,
        JSON.stringify([...readPreviousTokens().filter((t) => t !== token), token].slice(-5)),
      );
  } catch {
    // Blocked storage: the next registration simply starts fresh.
  }
}

/** Forgets an enrollment the server no longer accepts, so the next sync registers again (and takes over). */
export function retireEnrollment(token: string): void {
  if (readEnrollment()?.token !== token) return;
  rememberPreviousToken(token);
  writeEnrollment(undefined);
}
