import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppRouter, createAppRouter } from './router.tsx';

const mount = (path: string) => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppRouter instance={router} />);
  return router;
};

describe('hand-typed or mangled URLs', () => {
  it.each([
    ['/features?q=123', /things/i],
    ['/features?f=1', /things/i],
    ['/features?car=7', /things/i],
    ['/features?g=1', /things/i],
  ])('%s still shows the features, never an error page', async (path, heading) => {
    mount(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.queryByText(/something went wrong|something broke/i)).not.toBeInTheDocument();
  });

  it('treats a number typed into the search box as text', async () => {
    const router = mount('/features?q=123');
    await screen.findByRole('heading', { level: 1, name: /things/i });
    expect(router.state.location.search).toMatchObject({ q: '123' });
  });

  it.each(['/connect?action=foo&backup=x', '/connect?feature=1&setting=2'])(
    '%s says the request is unavailable instead of crashing',
    async (path) => {
      mount(path);
      expect(await screen.findByText(/we can't start that one/i)).toBeInTheDocument();
    },
  );
});
