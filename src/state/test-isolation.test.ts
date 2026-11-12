import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEndpoint } from '../infra/cloud/config.ts';
import { kickCloudSync } from '../infra/cloud/outbox.ts';

/**
 * Regression, in the `dom` project where it happened: session-store and connection-store tests used to enroll
 * as collectors and upload simulator runs to the production log. (`src/infra/cloud/test-isolation.test.ts`
 * covers the `node` project.)
 */
describe('dom tests never reach the cloud log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('has no log endpoint under vitest', () => {
    expect(import.meta.env.VITE_LOG_ENDPOINT).toBe('');
    expect(logEndpoint()).toBeUndefined();
  });

  it('kickCloudSync sends nothing', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    kickCloudSync();
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it('the global fetch refuses anything but localhost', async () => {
    await expect(fetch('https://obdcraft-logs.rishabhbansal1855.workers.dev/v1/register')).rejects.toThrow(
      /may not reach the network/,
    );
    await expect(fetch('/v1/export')).rejects.toThrow(/may not reach the network/);
  });
});
