import { KEY_PREFIX } from '../../domain/storage-keys.ts';
import { nativeScanner } from './native-scanner.ts';
import type { BleScanner } from './scanner.ts';
import { webScanner } from './web-scanner.ts';

const DEV_FLAG = `${KEY_PREFIX}dev-scanner`;

/**
 * Development only: `?scanner=fake` (optionally `&scan=off|denied|empty`) shows the in-app picker with the fake
 * scanner, for review without a native build. Remembered for the tab, so navigating keeps it; `?scanner=web`
 * turns it off. Production builds never read it (the branch is removed with `import.meta.env.DEV`).
 */
export function devScannerRequest(search: string = globalThis.location?.search ?? ''): string | undefined {
  const params = new URLSearchParams(search);
  const asked = params.get('scanner');
  try {
    if (asked === 'fake') {
      const value = `fake:${params.get('scan') ?? 'adapters'}`;
      globalThis.sessionStorage?.setItem(DEV_FLAG, value);
      return value;
    }
    if (asked) {
      globalThis.sessionStorage?.removeItem(DEV_FLAG);
      return undefined;
    }
    return globalThis.sessionStorage?.getItem(DEV_FLAG) ?? undefined;
  } catch {
    return asked === 'fake' ? `fake:${params.get('scan') ?? 'adapters'}` : undefined;
  }
}

/**
 * The scanner this build uses: the native one when a native shell provides it, else the browser's chooser.
 * In development, `?scanner=fake` swaps in the fake (loaded on demand, never part of a production bundle).
 */
export async function selectScanner(): Promise<BleScanner> {
  if (import.meta.env.DEV) {
    const dev = devScannerRequest();
    if (dev?.startsWith('fake:')) {
      const { fakeScanner } = await import('./fake-scanner.ts');
      const scenario = dev.slice('fake:'.length);
      return fakeScanner({
        scenario: (['adapters', 'off', 'denied', 'empty'] as const).find((s) => s === scenario) ?? 'adapters',
      });
    }
  }
  return nativeScanner() ?? webScanner;
}
