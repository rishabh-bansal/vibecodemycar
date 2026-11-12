import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBackups, useFeatures } from '../app/hooks.ts';
import { Shell } from '../app/layout.tsx';
import { POLICY } from '../config/policy.ts';
import '../domain/diagnostics.ts';
import type { ScannedDevice } from '../domain/adapters/likely.ts';
import type { LastAdapter } from '../domain/adapters/scan-list.ts';
import { clusterPhrase } from '../domain/catalog/copy.ts';
import { clusterMismatch } from '../domain/catalog/features.ts';
import { carSummary } from '../domain/catalog/vehicles.ts';
import { catalogueSlugFor } from '../domain/catalogue/status.ts';
import type { CodingRequest } from '../domain/coding/types.ts';
import { loadLastAdapter } from '../infra/ble/last-adapter.ts';
import type { BleScanner } from '../infra/ble/scanner.ts';
import { selectScanner } from '../infra/ble/select.ts';
import { rememberedAdapters, webRememberedScanner } from '../infra/ble/web-remembered.ts';
import { useCarStore } from '../state/car-store.ts';
import { type ConnectProblem, useConnection } from '../state/connection-store.ts';
import { useSession } from '../state/session-store.ts';
import { BackButton } from '../ui/BackButton.tsx';
import { Button } from '../ui/Button.tsx';
import { InfoCard, Micro } from '../ui/Panels.tsx';
import { AdapterSheet, type PickResult } from './connect/AdapterSheet.tsx';
import { SetupSteps } from './connect/SetupSteps.tsx';
import { buildRequest, requestLabel, requestSettingLabel } from './request.ts';

const PROBLEM_COPY: Record<Exclude<ConnectProblem['code'], 'wrong-car'>, { title: string; body: string }> = {
  'not-supported': {
    title: "this browser can't use Bluetooth.",
    body: "Open Vibecode my car in Chrome on Android or on a computer. iPhone and Safari don't support it yet.",
  },
  'bluetooth-off': {
    title: 'turn on Bluetooth.',
    body: 'Bluetooth looks switched off. Turn it on, then try again.',
  },
  'permission-denied': {
    title: 'Bluetooth is blocked for this site.',
    body: "Vibecode my car needs Bluetooth to reach the adapter plugged into your car; it only connects to the one you pick. Allow Bluetooth in the browser's site settings (the icon next to the address), then try again.",
  },
  'no-adapter': {
    title: 'no adapter found.',
    body: "Check the three steps above, then try again. If your adapter still isn't listed, show every Bluetooth device and pick it there.",
  },
  'car-silent': {
    title: "the car isn't answering.",
    body: 'Switch the ignition on (engine off), wait a few seconds, then try again.',
  },
  'adapter-failed': {
    title: "couldn't talk to the adapter.",
    body: 'Unplug it, plug it back in, and try again.',
  },
};

/**
 * Says exactly what will change before anything starts: the feature and the setting (or, for an undo, the
 * original setting saved before the change). Connecting here starts it, so this is the last look.
 */
function WhatWillRun({ request }: { request: Exclude<CodingRequest, { kind: 'inspect' }> }) {
  const setting =
    request.kind === 'apply'
      ? (requestSettingLabel(request) ?? request.settingId)
      : request.kind === 'restore'
        ? request.backup.settingLabel
          ? `Your original setting (undoes “${request.backup.settingLabel}”)`
          : 'Your original setting'
        : 'Check only — nothing will be changed';
  return (
    <section
      aria-label="What will change"
      className="mt-[26px] flex flex-col gap-1 border border-line bg-surface px-3.5 py-3"
    >
      <span className="micro">
        {request.kind === 'apply' ? 'Will change' : request.kind === 'restore' ? 'Will undo' : 'Will check'}
      </span>
      <span className="font-bold text-base">{requestLabel(request)}</span>
      <span className="font-semibold text-ink-2 text-sm">
        {request.kind === 'apply' ? 'New setting: ' : ''}
        {setting}
      </span>
    </section>
  );
}

/** Screen 4 · Connect. Hidden nav: nobody should wander off mid-flow. */
export function ConnectScreen() {
  const search = useSearch({ from: '/connect' });
  const navigate = useNavigate();
  const car = useCarStore((s) => s.selection);
  const features = useFeatures();
  const backups = useBackups();
  const conn = useConnection();
  const arm = useSession((s) => s.arm);
  const running = useSession((s) => s.running);
  /** "Your last change is still finishing": arming was refused because a session is still running. */
  const [busy, setBusy] = useState(false);
  // The browser's chooser on the web; the in-app picker where the app scans itself (native, or the dev fake).
  const [scanner, setScanner] = useState<BleScanner>();
  const [picking, setPicking] = useState(false);
  const [lastUsed, setLastUsed] = useState<LastAdapter | undefined>();
  useEffect(() => {
    let live = true;
    void selectScanner().then((s) => {
      if (live) setScanner(s);
    });
    return () => {
      live = false;
    };
  }, []);
  // On the web: the adapters this site can open without the browser's chooser (granted on this page, or kept by
  // the browser across visits). With one, the app's own picker lists it; the chooser is only for a new adapter.
  const [saved] = useState(() => webRememberedScanner());
  const [savedOpen, setSavedOpen] = useState(false);
  const picker = scanner?.ui === 'in-app' ? scanner : savedOpen ? saved : undefined;

  const openPicker = async () => {
    if (scanner?.ui === 'in-app') {
      setLastUsed(loadLastAdapter());
      setPicking(true);
      return;
    }
    // Answers at once (a lookup, no radio), so the chooser below still opens from this tap.
    if ((await rememberedAdapters()).length > 0) {
      setLastUsed(loadLastAdapter());
      setSavedOpen(true);
      setPicking(true);
    } else void conn.connectBluetooth();
  };
  /** The picker's "Find a new adapter": the browser's chooser, from the same tap. */
  const findNew = () => {
    setPicking(false);
    setSavedOpen(false);
    void conn.connectBluetooth();
  };

  /** The picker's tap: the normal connect path on that device, its outcome in words the sheet shows. */
  const connectDevice = useCallback(
    async (device: ScannedDevice): Promise<PickResult> => {
      if (!picker) return { ok: false, problem: 'not-an-adapter' };
      await useConnection.getState().connectBluetooth({ scanner: picker, device });
      const s = useConnection.getState();
      if (s.status === 'connected') return { ok: true };
      const code = s.status === 'error' ? s.problem.code : 'adapter-failed';
      // The sheet explains it in the card; the screen behind it stays clean.
      useConnection.getState().clearError();
      if (code === 'car-silent') return { ok: false, problem: 'car-silent' };
      if (code === 'bluetooth-off') return { ok: false, problem: 'bluetooth-off' };
      if (code === 'permission-denied') return { ok: false, problem: 'permission-denied' };
      // A saved adapter has answered before: failing now means it is unplugged, off or out of range.
      return { ok: false, problem: picker === saved ? 'unreachable' : 'not-an-adapter' };
    },
    [picker, saved],
  );

  const request = useMemo(
    () => buildRequest(search, { car, features, backups }),
    [search, car, features, backups],
  );

  // A connection that already existed when this screen opened is NOT a request to start: the user
  // confirms with Start. Only a connection made here hands the request on by itself.
  const connectedOnArrival = useRef(conn.status === 'connected');
  if (conn.status !== 'connected') connectedOnArrival.current = false;

  const start = useMemo(
    () => () => {
      if (!request) return;
      if (!arm(request)) {
        setBusy(true);
        return;
      }
      setBusy(false);
      void navigate({ to: '/coding', replace: true });
    },
    [request, arm, navigate],
  );

  // Once a car is connected here, hand the request to the Coding screen — exactly once, by explicit arming.
  useEffect(() => {
    if (conn.status === 'connected' && request && !connectedOnArrival.current) start();
  }, [conn.status, request, start]);

  // Checked against the cluster the car reported on connect: say so plainly when that is why.
  const needs = !request && search.feature ? clusterMismatch(car, search.feature) : undefined;

  if (backups !== undefined && !request) {
    return (
      <Shell nav={false}>
        <div className="flex flex-col gap-4 px-5 pt-6">
          <BackButton to="/features" />
          <InfoCard title="we can't start that one.">
            {needs
              ? `Your car has ${clusterPhrase(needs === 'analogue' ? 'digital' : 'analogue')}, and this feature needs ${clusterPhrase(needs)}. Nothing was sent.`
              : "That feature or setting isn't available for your car."}
          </InfoCard>
        </div>
      </Shell>
    );
  }

  const connecting = conn.status === 'connecting' || running;
  const waiting = conn.status === 'connected' && connectedOnArrival.current;
  const problem = conn.status === 'error' ? conn.problem : undefined;
  // Back goes where the request came from: a change, an undo or a check belongs to its feature's page.
  const backFeature =
    request?.kind === 'apply'
      ? request.feature.id
      : request && request.kind !== 'inspect'
        ? request.backup.featureId
        : undefined;
  const back = backFeature
    ? ({ to: '/features', search: { f: catalogueSlugFor(backFeature) } } as const)
    : ({ to: '/features' } as const);

  return (
    <Shell nav={false}>
      <div className="flex flex-1 flex-col px-5 pt-6 pb-[30px]">
        <div className="flex items-center justify-between">
          <BackButton {...back} />
          <Micro className="min-w-0 truncate pl-3 text-right">
            Step 1 / 2{request ? ` · ${requestLabel(request)}` : ''}
          </Micro>
        </div>

        <div className="mt-[34px] grid size-[132px] place-items-center self-center bg-blue plunk [--edge:var(--color-blue-edge)] [--plunk:6px]">
          <svg
            width="52"
            height="52"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#0d0d0d"
            strokeWidth="2.2"
            strokeLinecap="square"
            aria-hidden="true"
          >
            <path d="M7 7l10 10-5 5V2l5 5L7 17" />
          </svg>
        </div>

        <h1 className="display mt-[34px] mb-0 text-center text-[40px]">
          plug in.
          <br />
          pair up.
        </h1>
        <p className="mt-3 mb-0 text-center font-semibold text-sm text-ink-3">
          OBD port is under the steering wheel.
        </p>

        {request && request.kind !== 'inspect' && <WhatWillRun request={request} />}

        <SetupSteps className="mt-[26px]" />

        {problem && (
          <div className="mt-5" role="alert">
            {problem.code === 'wrong-car' ? (
              <InfoCard title="this isn't the car you set up." tone="warn">
                You set up <strong className="text-ink">{problem.expected}</strong>. This one is{' '}
                <strong className="text-ink">{problem.got}</strong>. Nothing was sent.
                <div className="mt-3 flex flex-col gap-2.5">
                  <Button variant="invert" onClick={() => conn.acceptNewCar(problem.pending)}>
                    This is my new car
                  </Button>
                  <Button variant="secondary" onClick={conn.clearError}>
                    Disconnect
                  </Button>
                </div>
              </InfoCard>
            ) : (
              <InfoCard title={PROBLEM_COPY[problem.code].title} tone="warn">
                {PROBLEM_COPY[problem.code].body}
                {problem.code === 'no-adapter' && (
                  <div className="mt-3 flex flex-col gap-2.5">
                    {/* Clones that advertise neither a known name nor a known service: the old, unfiltered list. */}
                    <Button
                      variant="secondary"
                      onClick={() => void conn.connectBluetooth({ chooser: 'all' })}
                    >
                      Show all Bluetooth devices
                    </Button>
                  </div>
                )}
              </InfoCard>
            )}
          </div>
        )}

        {busy && (
          <div className="mt-5" role="status">
            <InfoCard title="your last change is still finishing.">
              Wait until it has been checked, then start this one.
            </InfoCard>
          </div>
        )}

        {waiting && conn.status === 'connected' && (
          <div className="mt-5">
            <InfoCard title="your car is connected.">
              {carSummary(car)}. Start when you're ready. Nothing is sent until you do.
              <div className="mt-3 flex flex-col gap-2.5">
                <Button variant="invert" disabled={running} onClick={start}>
                  Start
                </Button>
                <Button variant="secondary" disabled={running} onClick={() => void conn.disconnect()}>
                  Disconnect
                </Button>
              </div>
            </InfoCard>
          </div>
        )}

        <div className="mt-auto flex flex-col gap-3.5 pt-6">
          {/* A hint, not a gate: the adapter takes one client, so another app left connected makes this fail. */}
          <p className="m-0 text-ink-3 text-xs">Close any other car app that's using the adapter first.</p>
          <Button disabled={connecting} onClick={() => void openPicker()}>
            {conn.status === 'connecting' ? 'Connecting…' : 'Connect via Bluetooth'}
          </Button>
          <Button asChild variant="secondary">
            <a href={POLICY.adapterShopUrl} target="_blank" rel="noopener noreferrer sponsored">
              No adapter? Buy on Amazon ↗
            </a>
          </Button>
        </div>
      </div>
      {picker && (
        <AdapterSheet
          open={picking}
          onOpenChange={(open) => {
            setPicking(open);
            if (!open) setSavedOpen(false);
          }}
          scanner={picker}
          lastUsed={lastUsed}
          connect={connectDevice}
          onConnected={() => setPicking(false)}
          {...(picker === saved ? { onFindNew: findNew } : {})}
        />
      )}
    </Shell>
  );
}
