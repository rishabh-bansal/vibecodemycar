import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo.tsx';

describe('Logo', () => {
  it('reads "Vibecode my car" and spells VIBEC + gauge O + DE, then MY CAR in yellow', () => {
    const { container } = render(<Logo className="text-base" />);
    const logo = screen.getByRole('img', { name: 'Vibecode my car' });
    expect(logo.textContent).toBe('VIBECDEMY CAR');
    expect(container.querySelectorAll('[data-logo-o]')).toHaveLength(1);
    expect(screen.getByText('MY CAR')).toHaveClass('text-yellow');
  });

  it('stacked: VIBECODE over MY CAR', () => {
    render(<Logo stacked />);
    const logo = screen.getByRole('img', { name: 'Vibecode my car' });
    expect(logo).toHaveClass('flex-col');
    expect([...logo.children].map((c) => c.textContent)).toEqual(['VIBECDE', 'MY CAR']);
  });

  it('collapsible: carries the dial alone for widths below 360px', () => {
    const { container } = render(<Logo collapsible />);
    expect(container.querySelector('svg.min-\\[360px\\]\\:hidden')).not.toBeNull();
    expect(container.querySelector('.max-\\[360px\\]\\:hidden')?.textContent).toBe('VIBECDEMY CAR');
  });
});
