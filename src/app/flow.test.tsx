import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupRecord } from '../domain/backups/schema.ts';
import { findFeature } from '../domain/catalog/features.ts';
import type { CarSelection } from '../domain/catalog/types.ts';
import type { CarLink, CodingEvent } from '../domain/coding/types.ts';
import { createDemoCar, createDemoCarFromBackup } from '../infra/link/demo.ts';
import { type SimOptions, SimulatedCar } from '../infra/link/simulator.ts';
import { db } from '../infra/storage/db.ts';
import { warningsOf } from '../screens/CodingScreen.tsx';
import { viewFor } from '../screens/DoneScreen.tsx';
import { useCarStore } from '../state/car-store.ts';
import { useConnection } from '../state/connection-store.ts';
import { backupStore, useSession } from '../state/session-store.ts';
import { AppRouter, createAppRouter } from './router.tsx';

const MONTE_CARLO: CarSelection = {
  brand: 'skoda',
  model: 'kushaq',
  variant: 'monte-carlo',
  year: 2023,
  cluster: 'digital',
};
const BLINKS = 'comfort-lane-change-indicator-5-flashes';
/** Technical words that must never reach the Done or Coding screens (they stay in the background log). */
const INTERNAL =
  /control unit|byte|NRC|code 0x|\(code|marker|read.?back|backup records|definition|part number/i;

/**
 * The adapter the next "Connect via Bluetooth" tap finds. Tests build it themselves: a simulated car seeded
 * for the change at hand, presented to the app exactly like a real Bluetooth adapter.
 */
let adapter: (() => CarLink) | undefined;
vi.mock('../infra/link/web-bluetooth.ts', () => ({
  WebBluetoothLink: {
    connect: async () => {
      if (!adapter) throw new Error('no adapter in this test');
      return adapter();
    },
    reconnect: async () => undefined,
  },
  LinkConnectError: class extends Error {
    code = 'adapter-failed';
  },
}));

/** A simulated car that reports itself as a real adapter connection. */
const asAdapter = (car: SimulatedCar): SimulatedCar => Object.assign(car, { mode: 'live' as const });
const NO_WAIT = { latencyMs: 0, pendingMs: 0 };
/** The next Bluetooth connection is a car seeded for this change. */
function adapterFor(featureId: string, settingId: string) {
  adapter = () => {
    const feature = findFeature(MONTE_CARLO, featureId);
    if (!feature) throw new Error('fixture');
    return asAdapter(createDemoCar(feature, settingId, NO_WAIT));
  };
}
/** The next Bluetooth connection is a car holding what this backed-up change left there. */
function adapterForBackup(backup: BackupRecord) {
  adapter = () => asAdapter(createDemoCarFromBackup(backup, NO_WAIT));
}
const connectButton = () => screen.findByRole('button', { name: /connect via bluetooth/i });

function mount(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<AppRouter instance={router} />);
  return router;
}

beforeEach(async () => {
  // A session keeps recording briefly after its result renders, and `reset`/`arm` ignore a running one.
  await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 5000 });
  adapter = undefined;
  useCarStore.setState({ selection: MONTE_CARLO, pairing: undefined });
  useConnection.setState({ status: 'idle' });
  useSession.getState().reset();
  await db().backups.clear();
  await db().experiments.clear();
});

/** A connected car with the real module/value the blinks feature acts on, with a chosen failure mode. */
function connectSim(sim: SimOptions) {
  const car = new SimulatedCar({
    parts: { '70E': '2Q0937089D' },
    values: { '70E:0A5E': '3A00000000' },
    ...sim,
  });
  useConnection.setState({ status: 'connected', link: car });
  return car;
}
function armBlinks() {
  const feature = findFeature(MONTE_CARLO, BLINKS);
  if (!feature) throw new Error('fixture');
  useSession.getState().arm({ kind: 'apply', car: MONTE_CARLO, feature, settingId: 'value-5' });
}

describe('the whole flow, through the real screens', () => {
  it('picks a feature, connects the adapter, writes, reads back, and records a verified backup', async () => {
    const user = userEvent.setup();
    adapterFor(BLINKS, 'value-5');
    mount('/features');

    await user.click(await screen.findByRole('link', { name: /lane change blinks/i }));
    expect(await screen.findByRole('heading', { level: 1, name: /lane change blinks/i })).toBeInTheDocument();
    expect(screen.getAllByText(/available for your car/i).length).toBeGreaterThan(0);
    // The default is the first choice, never the highest value: pick 5 blinks explicitly.
    expect(screen.getByRole('radio', { name: '5 blinks' })).not.toBeChecked();
    await user.click(screen.getByRole('radio', { name: '5 blinks' }));
    expect(screen.getByRole('radio', { name: '5 blinks' })).toBeChecked();

    await user.click(screen.getByRole('link', { name: /apply to my car/i }));
    // Connect says exactly what will change before anything starts.
    const plan = await screen.findByRole('region', { name: /what will change/i });
    expect(plan).toHaveTextContent(/lane change blinks/i);
    expect(plan).toHaveTextContent(/5 blinks/i);
    // The only way in is a real adapter: nothing offers a simulated car.
    expect(screen.queryByRole('button', { name: /demo/i })).not.toBeInTheDocument();
    await user.click(await connectButton());

    expect(
      await screen.findByRole('heading', { name: /is set to 5 blinks/i }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/done and checked with your car/i)).toBeInTheDocument();

    const [record] = await db().backups.toArray();
    expect(record).toMatchObject({
      // The catalogue card's own feature (feature id = catalogue slug), on the same recipe as the old id.
      featureId: 'comfort-turn-signals',
      recipeId: 'live-bcm-polite-blinks',
      before: '3A00000000',
      intended: '3E00000000',
      status: 'verified',
      outcome: 'verified',
      ack: 'received',
      linkMode: 'live',
    });
    // The backup stays in the background: no list of backups, no logs, no evidence on the Done screen.
    expect(
      screen.queryByRole('region', { name: /backups|evidence|experiment|cloud log/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/session log|experiment log|flagged for review/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /undo this change/i })).toBeInTheDocument();
  });

  it('shows a legal warning as information and still offers to code the feature', async () => {
    mount('/features?f=speed-warning-for-india');
    expect(await screen.findByRole('heading', { level: 1, name: /india speed chime/i })).toBeInTheDocument();
    expect(screen.getByText(/might be against the law/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /apply to my car/i })).toBeInTheDocument();
  });

  it('lets you read about a feature with no bytes to write, without offering to code it', async () => {
    mount('/features?f=third-brake-light-with-hazard-lights');
    expect(await screen.findByRole('heading', { level: 1, name: /third brake light/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not available for your car/i })).toBeDisabled();
    expect(screen.queryByRole('link', { name: /apply to my car/i })).not.toBeInTheDocument();
  });

  it('never starts a write just because someone navigated (or went back) to /coding', async () => {
    const car = connectSim({});
    const router = mount('/coding');
    await waitFor(() => expect(router.state.location.pathname).toBe('/features'));
    expect(car.writes).toHaveLength(0);
  });

  it('says "your car didn\'t accept the change. nothing was changed." for a refusal', async () => {
    connectSim({ write: { kind: 'nrc', code: '88' } });
    armBlinks();
    mount('/coding');
    expect(
      await screen.findByText("your car didn't accept the change. nothing was changed."),
    ).toBeInTheDocument();
    expect(screen.queryByText(INTERNAL)).not.toBeInTheDocument();
    expect(screen.queryByText(/is set to/i)).not.toBeInTheDocument();
    expect((await db().backups.toArray())[0]?.status).toBe('refused');
  });

  it('never shows success when the car stores something else — offers check again and undo', async () => {
    connectSim({ write: { kind: 'ack-stores', bytes: '3C00000000' } });
    armBlinks();
    const router = mount('/coding');
    expect(
      await screen.findByText(/we couldn't confirm the result/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/checked with your car/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    // Undo asks first, then goes to Connect for that backup.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /undo this change/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /undo this change/i });
    await user.click(within(dialog).getByRole('button', { name: /undo this change/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/connect'));
    expect(router.state.location.search).toMatchObject({ action: 'restore' });
  });

  it('when saving the result fails after the write, says so plainly — no download (S11)', async () => {
    connectSim({ write: { kind: 'ack' } });
    const update = vi.spyOn(backupStore, 'update').mockRejectedValue(new Error('quota exceeded'));
    try {
      armBlinks();
      mount('/coding');
      expect(
        await screen.findByText(
          /couldn't save a record of this change on this device/i,
          {},
          { timeout: 4000 },
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();
      expect((await db().backups.toArray())[0]).toMatchObject({ status: 'prepared' });
    } finally {
      update.mockRestore();
    }
  });

  it("says plainly when the last step of a change didn't finish (C2)", async () => {
    useSession.setState({
      request: {
        kind: 'apply',
        car: MONTE_CARLO,
        feature: {
          id: 'beats-audio',
          name: 'Sound preset',
          tier: 'experimental',
          statusLabel: 'AVAILABLE FOR YOUR CAR',
          settings: [{ id: 'small', label: 'Small preset', value: 0 }],
        },
        settingId: 'small',
      },
      progress: {
        ...useSession.getState().progress,
        result: {
          kind: 'success',
          acknowledged: true,
          sequenceIncomplete: { step: '1102', reason: 'refused', nrc: '22' },
        },
      },
    });
    mount('/done');
    const body = await screen.findByText(/done and checked with your car/i);
    expect(body).toHaveTextContent(/the last step didn't finish/i);
    expect(body).not.toHaveTextContent(INTERNAL);
  });

  it('runs a scalar/CRC feature from Connect, then restores it from the backup (C3.6)', async () => {
    const user = userEvent.setup();
    adapterFor('video-in-motion-through-pen-drive', 'always-on');
    mount('/connect?feature=video-in-motion-through-pen-drive&setting=always-on');
    await user.click(await connectButton());
    expect(
      await screen.findByText(/done and checked with your car/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    const [applied] = await db().backups.toArray();
    expect(applied).toMatchObject({
      recipeId: 'csmqb-vim-mib3-speed-threshold',
      status: 'verified',
      linkMode: 'live',
    });
    cleanup();
    await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 5000 });
    useSession.getState().reset();
    useConnection.setState({ status: 'idle' });
    if (!applied) throw new Error('no backup');
    adapterForBackup(applied);
    mount(`/connect?backup=${applied.id}&action=restore`);
    await user.click(await connectButton());
    expect(await screen.findByText(/is back how it was/i, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await db().backups.get(applied.id)).toMatchObject({ status: 'restored' });
  });

  it('keeps a module-side change out of sight on Done, while the background record still flags it', async () => {
    connectSim({ write: { kind: 'ack-stores', bytes: '3E00A00000' } });
    armBlinks();
    mount('/coding');
    await screen.findByRole('heading', { name: /is set to 5 blinks/i }, { timeout: 4000 });
    expect(screen.queryByRole('region', { name: /evidence/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/byte|flagged for review|acknowledgement|read-back/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /notes/i })).not.toBeInTheDocument();
    await waitFor(async () => expect((await db().experiments.toArray())[0]?.needsAttention).toBe(true));
  });

  it('"check again" keeps working after a recheck (it checks the same record again)', async () => {
    const user = userEvent.setup();
    const car = connectSim({ write: { kind: 'ack-stores', bytes: '3C00000000' } });
    armBlinks();
    const router = mount('/coding');
    await screen.findByText(/we couldn't confirm the result/i, {}, { timeout: 4000 });
    const [record] = await db().backups.toArray();
    let checks = 0;
    const read = car.readDid.bind(car);
    car.readDid = async (module, did) => {
      if (did === '0A5E') checks++;
      return read(module, did);
    };
    for (const round of [1, 2]) {
      await waitFor(() => expect(useSession.getState().running).toBe(false));
      await user.click(screen.getByRole('button', { name: /check again/i }));
      await waitFor(() => expect(checks).toBe(round), { timeout: 4000 });
      await screen.findByText(/we couldn't confirm the result/i, {}, { timeout: 4000 });
      expect(useSession.getState().request).toMatchObject({ kind: 'recheck', backup: { id: record?.id } });
      expect(router.state.location.pathname).toBe('/done');
    }
    // Undo is still offered after a recheck, and puts back the same change.
    await user.click(screen.getByRole('button', { name: /undo this change/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /undo this change/i });
    await user.click(within(dialog).getByRole('button', { name: /undo this change/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/connect'));
    expect(router.state.location.search).toMatchObject({ backup: record?.id, action: 'restore' });
    // The apply's read-backs are 1.5 s apart, so this flow takes several seconds of real time.
  }, 20_000);

  it('codes a different car than the paired one, and says so as a warning', async () => {
    useCarStore.setState({ pairing: { fingerprint: 'b'.repeat(64), masked: 'MEXK…1234' } });
    const car = connectSim({ mode: 'live', banner: 'LIVE' });
    armBlinks();
    mount('/coding');
    expect(await screen.findByRole('list', { name: /warnings/i }, { timeout: 8000 })).toHaveTextContent(
      /isn't the car you set up/i,
    );
    await waitFor(() => expect(car.writes.length).toBeGreaterThan(0), { timeout: 8000 });
  }, 20_000);
});

describe('coding screen — nobody leaves while a change may be landing', () => {
  it('blocks in-app navigation until there is a result, then moves on to Done by itself', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    connectSim({ latencyMs: 1, sleep: () => gate });
    armBlinks();
    const router = mount('/coding');
    await waitFor(() => expect(useSession.getState().running).toBe(true));
    void router.navigate({ to: '/features' }); // a blocked navigation never settles
    await new Promise((r) => setTimeout(r, 300));
    try {
      expect(router.state.location.pathname).toBe('/coding');
    } finally {
      release();
    }
    await waitFor(() => expect(router.state.location.pathname).toBe('/done'), { timeout: 8000 });
  }, 20_000);
});

describe('coding screen — the process, live', () => {
  it('lists every step in plain words, shows the one in progress with its time, and moves on', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    connectSim({ latencyMs: 1, sleep: () => gate });
    armBlinks();
    const router = mount('/coding');
    try {
      const list = await screen.findByRole('list', { name: /progress/i });
      const items = within(list).getAllByRole('listitem');
      expect(items.map((li) => li.querySelector('[data-part="title"]')?.firstChild?.textContent)).toEqual([
        "Checking it's your car",
        'Checking your car is ready',
        'Saving your original setting',
        'Unlocking the central electrics',
        'Writing the new setting',
        'Confirming it worked',
        'Done',
      ]);
      await waitFor(() => expect(items[0]).toHaveAttribute('data-state', 'active'));
      expect(items[0]).toHaveTextContent(/connecting to your car/i);
      expect(items[0]).toHaveTextContent(/\d+ s/);
      expect(items[1]).toHaveAttribute('data-state', 'pending');
      expect(list).not.toHaveTextContent(INTERNAL);
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    } finally {
      release();
    }
    await waitFor(() => expect(router.state.location.pathname).toBe('/done'), { timeout: 8000 });
  }, 20_000);
});

describe('connect screen — back', () => {
  it("goes back to the feature's page for an undo or a check", async () => {
    connectSim({ write: { kind: 'ack-stores', bytes: '3C00000000' } });
    armBlinks();
    mount('/coding');
    await screen.findByText(/we couldn't confirm the result/i, {}, { timeout: 8000 });
    const [record] = await db().backups.toArray();
    await waitFor(() => expect(useSession.getState().running).toBe(false));
    cleanup();
    mount(`/connect?backup=${record?.id}&action=restore`);
    // The backup names the old feature id; back opens its catalogue card.
    const back = await screen.findByRole('link', { name: /back/i });
    await waitFor(() => expect(back).toHaveAttribute('href', '/features?f=comfort-turn-signals'));
  }, 20_000);

  it("goes back to the feature's page for a new change", async () => {
    mount(`/connect?feature=${BLINKS}&setting=value-5`);
    const back = await screen.findByRole('link', { name: /back/i });
    await waitFor(() => expect(back).toHaveAttribute('href', '/features?f=comfort-turn-signals'));
  });
});

describe('connect screen — what an existing connection may do', () => {
  const connectUrl = `/connect?feature=${BLINKS}&setting=value-5`;

  it('never starts a change on a connection that was already there: it waits for Start', async () => {
    const user = userEvent.setup();
    const car = connectSim({ mode: 'live', banner: 'LIVE' });
    const router = mount(connectUrl);
    expect(await screen.findByText(/your car is connected/i)).toBeInTheDocument();
    expect(useSession.getState().armed).toBeUndefined();
    expect(router.state.location.pathname).toBe('/connect');
    await user.click(screen.getByRole('button', { name: /^start$/i }));
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/connect'));
    expect(car.closed).toBe(false);
  });

  it('offers only the adapter: no simulated car, and a connection made here starts the change', async () => {
    const user = userEvent.setup();
    adapterFor(BLINKS, 'value-5');
    const router = mount(connectUrl);
    expect(await connectButton()).toBeEnabled();
    expect(screen.queryByText(/demo|simulat/i)).not.toBeInTheDocument();
    await user.click(await connectButton());
    await waitFor(() => expect(router.state.location.pathname).not.toBe('/connect'), { timeout: 4000 });
    await screen.findByRole('heading', { name: /is set to 5 blinks/i }, { timeout: 4000 });
  });

  it('says the last change is still finishing instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    // A session that is still running on the car: every reply waits until we release it, so the session
    // is held in its first step (checking the car) for as long as the assertions need.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    connectSim({ latencyMs: 1, sleep: () => gate, mode: 'live', banner: 'LIVE' });
    armBlinks();
    useSession.getState().begin();
    await waitFor(() => expect(useSession.getState().running).toBe(true));
    mount(connectUrl);
    expect(await screen.findByRole('button', { name: /^start$/i })).toBeDisabled();
    // Pulling the link out from under a write is not offered either.
    expect(screen.getByRole('button', { name: /disconnect/i })).toBeDisabled();
    const feature = findFeature(MONTE_CARLO, BLINKS);
    if (!feature) throw new Error('fixture');
    expect(
      useSession.getState().arm({ kind: 'apply', car: MONTE_CARLO, feature, settingId: 'value-5' }),
    ).toBe(false);
    // Once it has finished, Start works.
    release();
    await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 8000 });
    await user.click(await screen.findByRole('button', { name: /^start$/i }));
    await waitFor(() => expect(useSession.getState().running || useSession.getState().request).toBeTruthy());
  }, 20_000);
});

describe('no backups screen', () => {
  it('sends an old /backups link to the features, with no Backups tab anywhere', async () => {
    const router = mount('/backups');
    await waitFor(() => expect(router.state.location.pathname).toBe('/features'));
    await screen.findByRole('heading', { level: 1, name: /things/i });
    expect(screen.queryByRole('link', { name: /^backups$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no backups yet/i)).not.toBeInTheDocument();
  });
});

describe('app chrome', () => {
  it('shows no build or log banner on any screen', async () => {
    for (const path of ['/car', '/features']) {
      mount(path);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByText(/build|private log|own risk|nothing is uploaded/i)).not.toBeInTheDocument();
      cleanup();
    }
  });

  it('never shows a demo banner, whatever is connected', async () => {
    connectSim({ mode: 'live', banner: 'LIVE · connected to your car' });
    mount('/car');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/LIVE/)).not.toBeInTheDocument();
    cleanup();
    connectSim({});
    mount('/car');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/demo|simulat/i)).not.toBeInTheDocument();
  });
});

describe('undo and restore — only in context', () => {
  it('"Undo this change" on Done, after a success, puts the original back', async () => {
    const user = userEvent.setup();
    adapterFor(BLINKS, 'value-5');
    mount(`/connect?feature=${BLINKS}&setting=value-5`);
    await user.click(await connectButton());
    await screen.findByRole('heading', { name: /is set to 5 blinks/i }, { timeout: 4000 });
    const [applied] = await db().backups.toArray();
    await user.click(screen.getByRole('button', { name: /undo this change/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /undo this change/i });
    expect(dialog).toHaveTextContent(/put your original setting back/i);
    await user.click(within(dialog).getByRole('button', { name: /undo this change/i }));
    // Connect says what will happen; the adapter is still connected, so the undo waits for Start.
    expect(await screen.findByRole('region', { name: /what will change/i })).toHaveTextContent(/will undo/i);
    await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 5000 });
    const start = await screen.findByRole('button', { name: /^start$/i });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    expect(await screen.findByText(/is back how it was/i, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await db().backups.get(applied?.id ?? '')).toMatchObject({ status: 'restored' });
  }, 20_000);

  it('offers "Restore original setting" on a feature\'s page only for this car\'s own backup of it', async () => {
    // A real (live-mode) change, recorded with the simulated car's VIN.
    connectSim({ mode: 'live', banner: 'LIVE' });
    armBlinks();
    const first = mount('/coding');
    await waitFor(() => expect(first.state.location.pathname).toBe('/done'), { timeout: 8000 });
    await waitFor(() => expect(useSession.getState().running).toBe(false), { timeout: 5000 });
    const [record] = await db().backups.toArray();
    if (!record) throw new Error('no backup');
    expect(record).toMatchObject({ linkMode: 'live', status: 'verified' });
    cleanup();
    useSession.getState().reset();
    useConnection.setState({ status: 'idle' });

    // Another car is set up: nothing to put back.
    useCarStore.setState({ pairing: { fingerprint: 'c'.repeat(64), masked: 'MEXK…0000' } });
    mount('/features?f=comfort-turn-signals');
    await screen.findByRole('heading', { level: 1, name: /lane change blinks/i });
    expect(screen.queryByRole('button', { name: /restore original setting/i })).not.toBeInTheDocument();
    cleanup();

    // This car, another feature: nothing to put back either.
    useCarStore.setState({ pairing: { fingerprint: record.vin.fingerprint, masked: record.vin.masked } });
    mount('/features?f=speed-warning-for-india');
    await screen.findByRole('heading', { level: 1, name: /india speed chime/i });
    expect(screen.queryByRole('button', { name: /restore original setting/i })).not.toBeInTheDocument();
    cleanup();

    // This car, this feature: offered, confirmed, then Connect runs the restore of that backup.
    const user = userEvent.setup();
    const router = mount('/features?f=comfort-turn-signals');
    // Cancelling the dialog stays on the page.
    await user.click(await screen.findByRole('button', { name: /restore original setting/i }));
    const cancel = await screen.findByRole('alertdialog', { name: /restore the original setting/i });
    await user.click(within(cancel).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/features');
    await user.click(screen.getByRole('button', { name: /restore original setting/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /restore the original setting/i });
    await user.click(within(dialog).getByRole('button', { name: /restore original setting/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/connect'));
    expect(router.state.location.search).toMatchObject({ backup: record.id, action: 'restore' });
  }, 30_000);
});

describe('done screen — next steps', () => {
  it('"Unlock another feature" goes to the feature list and clears the session', async () => {
    const user = userEvent.setup();
    connectSim({ write: { kind: 'ack' } });
    armBlinks();
    const router = mount('/coding');
    await user.click(
      await screen.findByRole('button', { name: /unlock another feature/i }, { timeout: 4000 }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/features'));
    await waitFor(() => expect(useSession.getState().progress.result).toBeUndefined());
    expect(router.state.location.pathname).toBe('/features');
  }, 20_000);
});

describe('done screen — plain words only', () => {
  it('never shows the technical detail of a refusal, an unconfirmed result or a stopped sequence', () => {
    const feature = findFeature(MONTE_CARLO, BLINKS);
    if (!feature) throw new Error('fixture');
    const request = { kind: 'apply', car: MONTE_CARLO, feature, settingId: 'value-5' } as const;
    const views = [
      viewFor(
        {
          kind: 'refused',
          reason: 'ecu-refused',
          detail: 'Your car said no (code 0x22). NRC 22 from the control unit.',
        },
        request,
      ),
      viewFor(
        { kind: 'refused', reason: 'unknown-module', detail: 'Not mapped for your control unit version.' },
        request,
      ),
      viewFor({ kind: 'wrong-car', detail: 'The backup records this car.' }, request),
      viewFor(
        { kind: 'unconfirmed', why: 'mismatch', detail: 'Read-back returned 3C00 bytes; markers F198.' },
        request,
      ),
      viewFor(
        { kind: 'unconfirmed', why: 'no-readback', detail: "We couldn't confirm the result." },
        request,
      ),
      viewFor(
        {
          kind: 'success',
          acknowledged: true,
          sequenceIncomplete: { step: '1102', reason: 'refused', nrc: '22' },
        },
        request,
      ),
      viewFor(
        { kind: 'success', acknowledged: true, sequenceIncomplete: { step: '1102', reason: 'link-lost' } },
        request,
      ),
    ];
    for (const v of views) expect(`${v.title} ${v.body} ${v.note ?? ''}`).not.toMatch(INTERNAL);
    expect(views[0]?.body).toBe("your car didn't accept the change. nothing was changed.");
    expect(views[3]?.note).toBe('your car saved a different value than expected.');
    expect(views[4]?.note).toBeUndefined();
  });
});

describe('coding screen — advisories are warnings, never stops', () => {
  it('shows each kind of warning once, in plain words, and keeps internal ones out of sight', () => {
    const events: CodingEvent[] = [
      { at: 't', type: 'verify-started' },
      { at: 't', type: 'warning', code: 'readiness', detail: 'Car check: the engine is running (900 rpm).' },
      { at: 't', type: 'warning', code: 'readiness', detail: 'Car check: the car is moving.' },
      { at: 't', type: 'warning', code: 'part', detail: 'Unrecorded control unit 5Q0937084.' },
      {
        at: 't',
        type: 'warning',
        code: 'identity',
        detail: "The control unit didn't report its part number.",
      },
      {
        at: 't',
        type: 'warning',
        code: 'other-car',
        detail: 'This is TMB…, not X. The backup records this car.',
      },
    ];
    for (const w of warningsOf(events)) expect(w).not.toMatch(INTERNAL);
    expect(warningsOf(events)).toEqual([
      'For best results, keep the car parked with the engine off and the ignition on.',
      "This isn't the car you set up.",
    ]);
  });
});
