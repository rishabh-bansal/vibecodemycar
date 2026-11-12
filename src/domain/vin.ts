/**
 * VIN handling. A backup and the cloud log keep the full VIN (`full`), so every record can be tied to its car;
 * screens show the short masked form, and the fingerprint matches a backup to the connected car.
 */

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export const isPlausibleVin = (vin: string): boolean => VIN_RE.test(vin.toUpperCase());

/** The stored form of a VIN: trimmed and upper-case. */
export const normalizeVin = (vin: string): string => vin.trim().toUpperCase();

/** `MEXTEST0SAMPLE042` → `MEXT…E042` (matches the design's masked form). */
export function maskVin(vin: string): string {
  const v = normalizeVin(vin);
  return v.length < 9 ? '•••' : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/** SHA-256 hex of the upper-cased VIN — a stable key for matching a backup to the connected car. */
export async function fingerprintVin(vin: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeVin(vin));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a backup record stores about its car (`BackupRecord['vin']`): masked, fingerprint and the full VIN. */
export async function vinRecord(vin: string): Promise<{ masked: string; fingerprint: string; full: string }> {
  return { masked: maskVin(vin), fingerprint: await fingerprintVin(vin), full: normalizeVin(vin) };
}
