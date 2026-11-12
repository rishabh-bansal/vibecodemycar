import { useSyncExternalStore } from 'react';

/** Subscribes to a CSS media query. Without matchMedia (tests, very old browsers) it reports `false` = mobile. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener('change', notify);
      return () => mq?.removeEventListener('change', notify);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
