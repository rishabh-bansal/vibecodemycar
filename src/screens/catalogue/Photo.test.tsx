import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Photo } from './Photo.tsx';

const img = (c: HTMLElement) => c.querySelector('img');

describe('feature photo', () => {
  it('retries a failed photo once, bypassing a stale cached response, before showing the icon', () => {
    const { container } = render(<Photo id="abc123" group="dashboard" size="sm" />);
    expect(img(container)?.getAttribute('src')).toBe('/f/sm/abc123.webp');
    fireEvent.error(img(container) as HTMLImageElement);
    expect(img(container)?.getAttribute('src')).toBe('/f/sm/abc123.webp?reload=1');
    fireEvent.error(img(container) as HTMLImageElement);
    expect(img(container)).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('a box that failed for one feature shows the next feature’s photo (the detail panel reuses it)', () => {
    const { container, rerender } = render(<Photo id="first" group="dashboard" size="lg" />);
    fireEvent.error(img(container) as HTMLImageElement);
    fireEvent.error(img(container) as HTMLImageElement);
    expect(img(container)).toBeNull();
    rerender(<Photo id="second" group="dashboard" size="lg" />);
    expect(img(container)?.getAttribute('src')).toBe('/f/lg/second.webp');
  });
});
