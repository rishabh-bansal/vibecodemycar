import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HeroPhoto } from './HeroPhoto.tsx';

describe('HeroPhoto', () => {
  it("shows the model's hero photo", () => {
    render(<HeroPhoto modelKey="skoda-kushaq" alt="Škoda Kushaq" />);
    expect(screen.getByRole('img', { name: 'Škoda Kushaq' })).toHaveAttribute(
      'src',
      '/f/hero/skoda-kushaq.webp',
    );
  });

  it('removes itself instead of showing a broken image when the file cannot load', () => {
    render(<HeroPhoto modelKey="skoda-kushaq" alt="Škoda Kushaq" />);
    fireEvent.error(screen.getByRole('img', { name: 'Škoda Kushaq' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
