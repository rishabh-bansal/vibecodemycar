import { afterEach, describe, expect, it, vi } from 'vitest';
import { logEndpoint } from './config.ts';
import { kickCloudSync } from './outbox.ts';

/** Regression: test runs used to enroll as collectors and upload simulator runs to the production log. */
describe('tests never reach the cloud log', () => {
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
    await expect(fetch(new URL('https://example.com/'))).rejects.toThrow(/may not reach the network/);
  });
});
