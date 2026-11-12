import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRouter, createAppRouter } from '../../app/router.tsx';
import type { CarSelection } from '../../domain/catalog/types.ts';
import { useCarStore } from '../../state/car-store.ts';

const MONTE_CARLO: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};

function mount(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppRouter instance={router} />);
  return router;
}
const stubDesktop = (matches: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));

beforeEach(() => {
  useCarStore.setState({ selection: MONTE_CARLO, pairing: undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mobile list', () => {
  it("shows the unlock count and service-tool count for the car — its whole family's cards (Kushaq: 141 and 30)", async () => {
    mount('/features');
    expect(
      await screen.findByRole('heading', { level: 1, name: /141 things\s*to unlock/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/\+30 service tools/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^unlocks · 141$/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^service tools · 30$/i })).toBeInTheDocument();
  });

  it('shows the proven feature as the hero, with a status that came from the support data', async () => {
    mount('/features');
    await screen.findByRole('heading', { level: 1, name: /things/i });
    const hero = screen.getByText('MOST LOVED').closest('a');
    expect(hero).toHaveTextContent(/lane change blinks/i);
    // Under ALL each section shows what this car can take first.
    const lights = screen.getByRole('region', { name: 'Lights' });
    expect(within(lights).getAllByText('AVAILABLE FOR YOUR CAR')).toHaveLength(3);
    // no testing language on the list
    expect(screen.queryByText(/tested|experimental/i)).not.toBeInTheDocument();
  });

  it('keeps at most 3 rows per section under ALL and expands with SEE ALL', async () => {
    const user = userEvent.setup();
    mount('/features');
    const lights = await screen.findByRole('region', { name: 'Lights' });
    expect(within(lights).getAllByRole('link')).toHaveLength(3);
    await user.click(within(lights).getByRole('button', { name: /see all/i }));
    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Lights' })).getAllByRole('link').length).toBe(51),
    );
    expect(screen.queryByText('MOST LOVED')).not.toBeInTheDocument();
  });

  it('switches to service tools, which have no hero', async () => {
    const user = userEvent.setup();
    mount('/features');
    await user.click(await screen.findByRole('radio', { name: /^service tools · 30$/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /30 service tools/i })).toBeInTheDocument();
    expect(screen.queryByText('MOST LOVED')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Service tools' })).toBeInTheDocument();
  });

  it('search filters by name, reports N of M, and offers CLEAR when nothing matches', async () => {
    const user = userEvent.setup();
    mount('/features?q=needle');
    expect(await screen.findByText(/^1 of 141$/)).toBeInTheDocument();
    expect(screen.getByText('Needle Sweep')).toBeInTheDocument();
    const box = screen.getByRole('searchbox', { name: /search features/i });
    await user.clear(box);
    await user.type(box, 'zzzz');
    expect(await screen.findByText(/nothing matches “zzzz”\./i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /141 things/i })).toBeInTheDocument();
  });

  // The shipped catalogue carries no third-party text (scripts/build-public-catalogue.mjs); the parsing of
  // the research text is covered in domain/catalogue/catalogue.test.ts.
  it('needle sweep detail: our own intro, no source text, and no empty sections', async () => {
    mount('/features?f=gauge-test-needle-sweep');
    expect(await screen.findByRole('heading', { level: 1, name: /needle sweep\./i })).toBeInTheDocument();
    expect(screen.queryByText(/research entry/i)).not.toBeInTheDocument();
    // Unverified on this cluster is advisory: the feature is still offered.
    expect(screen.getByRole('link', { name: /apply to my car/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/connect'),
    );
  });

  it('lane change blinks detail: photo, name and controls only', async () => {
    mount('/features?f=comfort-turn-signals');
    expect(
      await screen.findByRole('heading', { level: 1, name: /lane change blinks\./i }),
    ).toBeInTheDocument();
    // The default is the recipe's first choice — never the highest raw value.
    const radios = screen.getAllByRole('radio', { name: /blinks/i });
    expect(radios[0]).toBeChecked();
    expect(radios.at(-1)).not.toBeChecked();
    expect(screen.queryByText(/before you start/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/what it does/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /apply to my car/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/connect'),
    );
  });

  it('a feature with a legal warning shows it as information, and the Code button straight away', async () => {
    mount('/features?f=drl-off-with-handbrake'); // its ATTENTION mentions the law
    await screen.findByRole('heading', { level: 1, name: /drl/i });
    expect(screen.getByText(/might be against the law/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /i understand/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /apply to my car/i })).toBeInTheDocument();
  });

  it('a free-value scalar takes a typed number, encoded as value:<n>, and refuses one out of range', async () => {
    mount('/features?f=headlight-washer');
    await screen.findByRole('heading', { level: 1, name: /headlight washer/i });
    const box = screen.getByRole('spinbutton', { name: /headlight washer frequency value/i });
    // No preset to pick: nothing to start until a value is typed.
    expect(screen.queryByRole('link', { name: /apply to my car/i })).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: '12' } });
    expect(await screen.findByRole('link', { name: /apply to my car/i })).toHaveAttribute(
      'href',
      expect.stringMatching(/setting=value%3A12/),
    );
    fireEvent.change(box, { target: { value: '999' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a value from 0 to 255/i);
    expect(screen.queryByRole('link', { name: /apply to my car/i })).not.toBeInTheDocument();
  });

  it('never makes a legal feature the hero', async () => {
    mount('/features');
    await screen.findByRole('heading', { level: 1, name: /things/i });
    expect(screen.getByText('MOST LOVED').closest('a')).not.toHaveTextContent(/speed warning/i);
  });

  it('narrows a link carrying several groups to the one chip mobile shows', async () => {
    const router = mount('/features?g=dashboard,comfort');
    await screen.findByRole('heading', { level: 1, name: /things/i });
    await waitFor(() => expect(router.state.location.search).toMatchObject({ g: 'dashboard' }));
    expect(screen.queryByRole('region', { name: 'Comfort' })).not.toBeInTheDocument();
  });

  it("gives a listed car without a feature list of its own its family's cards, under its own name", async () => {
    const user = userEvent.setup();
    useCarStore.setState({
      selection: { brand: 'skoda', model: 'octavia-rs', variant: 'base', year: 2024, cluster: 'digital' },
    });
    const router = mount('/features');
    // The Octavia RS shares its platform with the Kodiaq, Superb and Tiguan: their 28 unlocks.
    expect(
      await screen.findByRole('heading', { level: 1, name: /28 things\s*to unlock/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no feature list/i)).not.toBeInTheDocument();
    expect(useCarStore.getState().selection.model).toBe('octavia-rs');
    await user.click(screen.getByRole('radio', { name: /^service tools · 24$/i }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'service' }));
    // Browsing never changes the car that is set up.
    expect(useCarStore.getState().selection.model).toBe('octavia-rs');
  });

  it('"Other model": the India 2.0 family\'s cards before connecting, the family the car names after', async () => {
    useCarStore.setState({
      selection: { brand: 'volkswagen', model: 'other', variant: 'other', year: 2025, cluster: 'analogue' },
    });
    mount('/features');
    expect(
      await screen.findByRole('heading', { level: 1, name: /141 things\s*to unlock/i }),
    ).toBeInTheDocument();
    cleanup();
    useCarStore.setState({
      selection: {
        brand: 'volkswagen',
        model: 'other',
        variant: 'other',
        year: 2025,
        cluster: 'analogue',
        detected: { bcmPart: '5Q0937084AF', platform: 'MQB' },
      },
    });
    mount('/features');
    expect(
      await screen.findByRole('heading', { level: 1, name: /28 things\s*to unlock/i }),
    ).toBeInTheDocument();
  });

  it('says how many listed features are available for your car', async () => {
    mount('/features');
    expect(await screen.findByText(/\d+ available for your car/i)).toBeInTheDocument();
  });

  it('lists writable features that have no catalogue card; each opens the detail view to pick a setting', async () => {
    const user = userEvent.setup();
    const router = mount('/features');
    const region = await screen.findByRole('region', { name: /more for your car/i });
    const links = within(region).getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', expect.stringMatching(/\/features\?.*f=.+/));
      expect(link).not.toHaveAttribute('href', expect.stringContaining('/connect'));
    }
    const first = links[0];
    if (!first) throw new Error('no extra');
    await user.click(first);
    await waitFor(() => expect(router.state.location.search).toHaveProperty('f'));
    expect(await screen.findByRole('link', { name: /apply to my car/i })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/connect\?.*setting=.+/),
    );
  });

  it('never offers a "log investigation" download anywhere', async () => {
    for (const path of [
      '/features?car=slavia&f=comfort-turn-signals',
      '/features?f=speed-warning-for-india',
      '/features?f=gauge-test-needle-sweep',
      '/features?f=third-brake-light-when-trunk-open',
    ]) {
      mount(path);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByRole('button', { name: /log investigation/i })).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('the search box follows a change made elsewhere (Clear) and keeps what you type', async () => {
    const user = userEvent.setup();
    const router = mount('/features?q=zzzz');
    await user.click(await screen.findByRole('button', { name: /^clear$/i }));
    await waitFor(() => expect(screen.getByRole('searchbox', { hidden: true })).toHaveValue(''));
    await user.type(screen.getByRole('searchbox', { hidden: true }), 'needle');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'needle' }));
    expect(screen.getByRole('searchbox', { hidden: true })).toHaveValue('needle');
  });

  it('ignores an unknown feature in the URL and an unknown car', async () => {
    mount('/features?f=does-not-exist&car=nope');
    expect(await screen.findByRole('heading', { level: 1, name: /things/i })).toBeInTheDocument();
  });

  it('browsing a car you have not set up claims no support status and offers to set it up', async () => {
    const user = userEvent.setup();
    mount('/features?car=slavia&f=comfort-turn-signals');
    expect(await screen.findByText(/select this car to check/i)).toBeInTheDocument();
    expect(screen.queryByText(/available for your car/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /select this car/i }));
    await waitFor(() => expect(useCarStore.getState().selection.model).toBe('slavia'));
  });
});

describe('mobile search', () => {
  it('is always there, pinned to the top while the list scrolls', async () => {
    mount('/features');
    const box = await screen.findByRole('searchbox', { name: /search features/i });
    expect(box.closest('[role="search"]')?.parentElement).toHaveClass('sticky', 'top-0');
  });

  it('finds features by the words people use, codable ones first, and clears with one tap', async () => {
    const user = userEvent.setup();
    const router = mount('/features');
    const box = await screen.findByRole('searchbox', { name: /search features/i });
    await user.type(box, 'drl');
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'drl' }));
    const lights = await screen.findByRole('region', { name: 'Lights' });
    const labels = within(lights)
      .getAllByRole('link')
      .map((l) => /NOT AVAILABLE/.test(l.textContent ?? ''));
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.indexOf(true) === -1 || labels.indexOf(true) > labels.lastIndexOf(false)).toBe(true);
    await user.click(screen.getByRole('button', { name: /clear search/i }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('q'));
    expect(box).toHaveValue('');
  });

  it('says so when nothing matches, with words to try instead', async () => {
    mount('/features?q=zzzz');
    expect(await screen.findByText(/nothing matches “zzzz”\./i)).toBeInTheDocument();
    expect(screen.getByText(/try another word/i)).toBeInTheDocument();
  });

  it('keeps the search in the address, so Back from a feature restores it', async () => {
    const user = userEvent.setup();
    const router = mount('/features?q=blinks');
    await user.click(await screen.findByRole('link', { name: /lane change blinks/i }));
    await screen.findByRole('heading', { level: 1, name: /lane change blinks/i });
    router.history.back();
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'blinks' }));
    expect(await screen.findByRole('searchbox', { name: /search features/i })).toHaveValue('blinks');
    expect(screen.getByRole('link', { name: /lane change blinks/i })).toBeInTheDocument();
  });
});

describe('desktop catalogue, narrow (1024–1099 px): the panel slides over the list', () => {
  beforeEach(() =>
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: !query.includes('1100px'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })),
  );

  it('is a modal dialog: focus moves in, the list behind is inert, and focus returns on close', async () => {
    const user = userEvent.setup();
    mount('/features?q=needle');
    const card = await screen.findByRole('link', { name: /needle sweep/i });
    await user.click(card);
    const dialog = await screen.findByRole('dialog', { name: /needle sweep/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() =>
      expect(within(dialog).getAllByRole('button', { name: /close details/i })).toContain(
        document.activeElement,
      ),
    );
    expect(screen.getByRole('searchbox').closest('[inert]')).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /close details/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('searchbox').closest('[inert]')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('link', { name: /needle sweep/i })),
    );
  });
});

describe('desktop catalogue', () => {
  beforeEach(() => stubDesktop(true));

  it('lists all 8 cars in the rail with their feature counts, and switching is instant', async () => {
    const user = userEvent.setup();
    mount('/features');
    const rail = await screen.findByRole('navigation', { name: 'Škoda' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['kushaq171', 'slavia171', 'kylaq171', 'kodiaq52', 'superb52']);
    expect(within(screen.getByRole('navigation', { name: 'Volkswagen' })).getAllByRole('link')).toHaveLength(
      3,
    );
    await user.click(within(rail).getByRole('link', { name: /kylaq/i }));
    expect(await screen.findByText(/ŠKODA KYLAQ · 171 FEATURES/)).toBeInTheDocument();
  });

  it('multi-select chips compose, ALL clears them', async () => {
    const user = userEvent.setup();
    mount('/features');
    await user.click(await screen.findByRole('button', { name: /^dashboard · 24$/i }));
    await user.click(screen.getByRole('button', { name: /^comfort · 35$/i }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Dashboard' })).toBeInTheDocument());
    expect(screen.getByRole('region', { name: 'Comfort' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lights' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^all$/i }));
    expect(await screen.findByRole('region', { name: 'Lights' })).toBeInTheDocument();
  });

  it('opens the panel on a card, Esc closes it, then clears the search; "/" focuses search', async () => {
    const user = userEvent.setup();
    mount('/features?q=needle');
    await user.click(await screen.findByRole('link', { name: /needle sweep/i }));
    const panel = await screen.findByRole('complementary', { name: /needle sweep/i });
    // Beside the list the page keeps one h1; the panel's title is an h2.
    expect(within(panel).getByRole('heading', { level: 2, name: /needle sweep/i })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: /needle sweep/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('searchbox')).toHaveValue('needle');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveValue(''));
    await user.keyboard('/');
    expect(screen.getByRole('searchbox')).toHaveFocus();
  });
});
