import { waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const install = vi.fn();
vi.mock('../infra/cloud/lifecycle.ts', () => ({ installCloudLifecycle: install }));

describe('app start', () => {
  it('still starts the background log upload, with nothing about it on screen', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await import('../main.tsx');
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    expect(document.body.textContent ?? '').not.toMatch(/private log|upload|build /i);
    root.remove();
  });
});
