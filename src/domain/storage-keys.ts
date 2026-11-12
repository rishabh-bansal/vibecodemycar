/**
 * The app was called OBDCraft; its Web Storage keys carried that name. On start, before any store reads
 * storage (the car store hydrates when its module loads, diagnostics reads the boot counter on import), each
 * old key is copied to its new name once and then removed. A value already under the new name wins: it was
 * written by this version, so it is newer than anything left under the old name.
 *
 * IndexedDB is not renamed: the database is still called `obdcraft` (infra/storage/db.ts), so backups never move.
 */

const OLD = 'obdcraft.';
export const KEY_PREFIX = 'vibecode-my-car.';

/** Every key the app has kept in localStorage, by its current name. */
export const LOCAL_KEYS = {
  car: `${KEY_PREFIX}car.v1`,
  cloud: `${KEY_PREFIX}cloud.v1`,
  cloudOptOut: `${KEY_PREFIX}cloud.optout`,
  cloudPrevious: `${KEY_PREFIX}cloud.previous`,
  diagnostics: `${KEY_PREFIX}diagnostics.v1`,
} as const;

/** The adapter that last connected (the picker pins it). New with the new name: nothing to move. */
export const LAST_ADAPTER_KEY = `${KEY_PREFIX}last-adapter.v1`;

/** Every key the app has kept in sessionStorage, by its current name. */
export const SESSION_KEYS = {
  diagBoot: `${KEY_PREFIX}diag-boot`,
} as const;

const legacyName = (key: string): string => OLD + key.slice(KEY_PREFIX.length);

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Moves each key in `keys` from its old name to its new one. Returns the new names that received a value. */
export function moveLegacyKeys(storage: KeyStore, keys: readonly string[]): string[] {
  const moved: string[] = [];
  for (const key of keys) {
    const old = legacyName(key);
    try {
      const value = storage.getItem(old);
      if (value === null) continue;
      if (storage.getItem(key) === null) {
        storage.setItem(key, value);
        moved.push(key);
      }
      // Removed only once the new key holds a value (copied now, or already there).
      if (storage.getItem(key) !== null) storage.removeItem(old);
    } catch {
      // Blocked or full storage: leave the old key; the next start tries again.
    }
  }
  return moved;
}

const reach = (name: 'localStorage' | 'sessionStorage'): KeyStore | undefined => {
  try {
    return (globalThis as Record<string, unknown>)[name] as KeyStore | undefined;
  } catch {
    return undefined; // some browsers throw on access when site data is blocked
  }
};

/** Run once at start, before any store hydrates. Safe to run again: it finds nothing left to move. */
export function migrateLegacyKeys(
  local: KeyStore | undefined = reach('localStorage'),
  session: KeyStore | undefined = reach('sessionStorage'),
): string[] {
  return [
    ...(local ? moveLegacyKeys(local, Object.values(LOCAL_KEYS)) : []),
    ...(session ? moveLegacyKeys(session, Object.values(SESSION_KEYS)) : []),
  ];
}
