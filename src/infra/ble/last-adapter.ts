import type { LastAdapter } from '../../domain/adapters/scan-list.ts';
import { LAST_ADAPTER_KEY } from '../../domain/storage-keys.ts';

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

const local = (): KeyStore | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // blocked site data
  }
};

/** The adapter that last connected successfully, if one was remembered. */
export function loadLastAdapter(storage: KeyStore | undefined = local()): LastAdapter | undefined {
  try {
    const raw = storage?.getItem(LAST_ADAPTER_KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || typeof (v as LastAdapter).id !== 'string') return undefined;
    const { id, name } = v as LastAdapter;
    return typeof name === 'string' ? { id, name } : { id };
  } catch {
    return undefined;
  }
}

/** Remembers an adapter whose handshake answered. A storage failure only loses the pin. */
export function saveLastAdapter(adapter: LastAdapter, storage: KeyStore | undefined = local()): void {
  try {
    storage?.setItem(
      LAST_ADAPTER_KEY,
      JSON.stringify(adapter.name ? { id: adapter.id, name: adapter.name } : { id: adapter.id }),
    );
  } catch {
    // Full or blocked storage: the next visit simply has no pin.
  }
}
