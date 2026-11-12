import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppRouter, createAppRouter } from '../app/router.tsx';
import { withDetected } from '../domain/catalog/selection.ts';
import type { CarSelection } from '../domain/catalog/types.ts';
import { BRAND_OPTIONS, brandLabel, defaultSelection, modelsFor } from '../domain/catalog/vehicles.ts';
import { useCarStore } from '../state/car-store.ts';
import { modelImage } from '../ui/car-images.ts';

const show = async (selection: CarSelection) => {
  useCarStore.setState({ selection });
  render(<AppRouter instance={createAppRouter(createMemoryHistory({ initialEntries: ['/car'] }))} />);
  await screen.findByText(/see features/i);
};

afterEach(cleanup);

const ALL_MODELS = BRAND_OPTIONS.flatMap((b) =>
  modelsFor(b.id).map((m) => ({ brand: b.id, model: m.id, label: m.label })),
);

/** The questions the screen asks: every radio group and every form control, by name. */
function questions(): string[] {
  const groups = screen.getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label') ?? '');
  const selects = screen.queryAllByRole('combobox').map((c) => c.getAttribute('name') ?? 'select');
  return [...groups, ...selects];
}

describe('car screen — the same two questions for every car', () => {
  it.each(ALL_MODELS)('$brand $model: brand and model, nothing else', async ({ brand, model }) => {
    await show(defaultSelection(brand, model));
    expect(questions()).toEqual(['Brand', 'Model']);
    expect(screen.queryByText(/^(variant|year|cluster|built)$/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/year, trim and instrument cluster come from your car when you connect/i),
    ).toBeVisible();
  });

  it.each(ALL_MODELS)('$brand $model: shown as a card in its brand', async ({ brand, model, label }) => {
    await show(defaultSelection(brand, model));
    const cards = within(screen.getByRole('radiogroup', { name: 'Model' }));
    expect(cards.getByRole('radio', { name: label })).toBeChecked();
    // Every listed model, then "Other model" for any car not in the list.
    expect(cards.getAllByRole('radio')).toHaveLength(modelsFor(brand).length + 1);
    expect(cards.getAllByRole('radio').at(-1)).toHaveAccessibleName('Other model');
  });

  it('an earlier saved selection with a variant and year shows the same screen', async () => {
    await show({ brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2024, cluster: 'digital' });
    expect(questions()).toEqual(['Brand', 'Model']);
  });

  it('has no colour picker: one picture per model', async () => {
    await show(defaultSelection('skoda', 'kushaq'));
    expect(screen.queryByRole('radiogroup', { name: /colou?r/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^colou?r$/i)).not.toBeInTheDocument();
  });

  it('shows one picture per model, whatever trim an older saved selection named', async () => {
    await show({ brand: 'skoda', model: 'kushaq', variant: 'monte-carlo', year: 2024, cluster: 'digital' });
    expect(screen.getByRole('img', { name: `${brandLabel('skoda')} Kushaq` })).toHaveAttribute(
      'src',
      modelImage('skoda', 'kushaq'),
    );
  });

  it('picking a model card sets that car up', async () => {
    await show(defaultSelection('skoda', 'kushaq'));
    fireEvent.click(screen.getByRole('radio', { name: 'Slavia' }));
    expect(useCarStore.getState().selection.model).toBe('slavia');
    expect(screen.getByText(`${brandLabel('skoda')} Slavia`.toUpperCase())).toBeInTheDocument();
  });

  it('says what the connected car reported', async () => {
    await show(withDetected(defaultSelection('skoda', 'kushaq'), { cluster: 'digital', modelYear: 2023 }));
    expect(screen.getByText('Your Kushaq: 2023 model year · digital instrument cluster.')).toBeVisible();
  });
});

describe('car screen — any Škoda or Volkswagen', () => {
  it.each(BRAND_OPTIONS)('$label: "Other model" sets up a car not in the list', async ({ id }) => {
    await show(defaultSelection(id, 'kushaq'));
    fireEvent.click(screen.getByRole('radio', { name: 'Other model' }));
    expect(useCarStore.getState().selection).toMatchObject({ brand: id, model: 'other' });
    expect(screen.getByText(`${brandLabel(id)} (other model)`.toUpperCase())).toBeInTheDocument();
    expect(screen.getByText(/we'll confirm yours when you connect/i)).toBeVisible();
  });

  it('says which family the car turned out to be once it has connected', async () => {
    await show(
      withDetected(defaultSelection('volkswagen', 'other'), { bcmPart: '5Q0937084AF', platform: 'MQB' }),
    );
    expect(screen.getByText(/same platform as the .*Kodiaq.*so it gets their features/i)).toBeVisible();
  });
});

describe('car screen — plain wording', () => {
  it('shows no testing notes or scan tools', async () => {
    for (const sel of [defaultSelection(), { ...defaultSelection(), variant: 'monte-carlo' }]) {
      await show(sel);
      expect(
        screen.queryByText(/evidence|haven't seen this variant|experimental|read-back/i),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /scan every control unit/i })).not.toBeInTheDocument();
      cleanup();
    }
  });
});

describe('car screen — each brand opens on its default model', () => {
  it.each([
    ['skoda', 'Kushaq'],
    ['volkswagen', 'Taigun'],
  ] as const)('%s opens on the %s', async (brand, label) => {
    await show(defaultSelection(brand === 'skoda' ? 'volkswagen' : 'skoda'));
    fireEvent.click(screen.getByRole('radio', { name: brandLabel(brand) }));
    expect(useCarStore.getState().selection.model).toBe(label.toLowerCase());
    expect(screen.getByRole('radio', { name: label })).toBeChecked();
  });
});
