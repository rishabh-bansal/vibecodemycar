import { Dialog } from 'radix-ui';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  chipText,
  displayName,
  otherHint,
  type ScannedDevice,
  type SignalBars,
  signalBars,
  subline,
} from '../../domain/adapters/likely.ts';
import { type LastAdapter, type ScanRow, topMatch } from '../../domain/adapters/scan-list.ts';
import { ScanSession, type ScanSessionOptions } from '../../infra/ble/scan-session.ts';
import type { BleScanner } from '../../infra/ble/scanner.ts';
import { Button } from '../../ui/Button.tsx';
import { cn } from '../../ui/cn.ts';
import { InfoCard } from '../../ui/Panels.tsx';
import { SetupSteps } from './SetupSteps.tsx';

/** Why a tapped device did not connect. */
export type PickProblem =
  | 'not-an-adapter'
  | 'unreachable'
  | 'car-silent'
  | 'bluetooth-off'
  | 'permission-denied';
export type PickResult = { ok: true } | { ok: false; problem: PickProblem };

const PICK_COPY: Record<PickProblem, string> = {
  'not-an-adapter': "this doesn't answer like an OBD adapter — try another one",
  unreachable: "couldn't reach it. Check it's plugged in and its light is on, then tap it again.",
  'car-silent':
    "the adapter answered, but the car didn't. Switch the ignition on (engine off) and try again.",
  'bluetooth-off': 'Bluetooth went off. Turn it on, then tap the adapter again.',
  'permission-denied': 'Bluetooth permission was refused. Allow it, then tap the adapter again.',
};

export interface AdapterSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  scanner: BleScanner;
  /** Runs the existing connect path (ELM327 handshake) on the tapped device. */
  connect(device: ScannedDevice): Promise<PickResult>;
  /** Called once a device connected; the Connect screen moves on. */
  onConnected(): void;
  lastUsed?: LastAdapter;
  /**
   * The web build's picker lists the adapters the browser remembers, not a scan. A new adapter goes through the
   * browser's chooser: this opens it (from the user's tap).
   */
  onFindNew?(): void;
  /** Tests shorten the scan or drive its timers. */
  session?: Pick<ScanSessionOptions, 'durationMs' | 'setTimeout' | 'clearTimeout'>;
}

/**
 * The Bluetooth adapter picker: a NeoPOP bottom sheet over the Connect screen. It lists what the scanner finds —
 * likely adapters first, everything else greyed but tappable — and connects the tapped one through the normal
 * connect path. Where the app scans itself (a native build, or `?scanner=fake` in development) it lists what is
 * nearby. On the web it lists the adapters the browser remembers for this site (`onFindNew` set): a tap connects
 * without the browser's chooser, and "Find a new adapter" opens that chooser for one not used here before.
 */
export function AdapterSheet(props: AdapterSheetProps) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-bg/75" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-[520px] flex-col border-line border-t bg-surface-2 shadow-[0_-8px_0_var(--color-yellow)] outline-none motion-safe:animate-[sheet-up_.2s_ease-out]"
        >
          {props.open && <SheetBody {...props} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SheetBody({
  scanner,
  connect,
  onConnected,
  onOpenChange,
  lastUsed,
  onFindNew,
  session: timing,
}: AdapterSheetProps) {
  const saved = onFindNew !== undefined;
  const [session] = useState(
    () => new ScanSession(scanner, { ...timing, ...(lastUsed ? { lastUsed } : {}) }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const [connecting, setConnecting] = useState<string>();
  const [failed, setFailed] = useState<{ id: string; problem: PickProblem }>();
  const alive = useRef(true);
  /** Where a drag on the sheet's top started: pulled down far enough, the sheet closes. */
  const dragFrom = useRef<number | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    session.start();
    // A finger lifted anywhere (or the gesture cancelled) lets the list re-sort.
    const release = () => session.release();
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      alive.current = false;
      session.stop();
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [session]);

  const rescan = () => {
    setFailed(undefined);
    session.rescan();
  };

  const pick = async (device: ScannedDevice) => {
    if (connecting) return;
    session.stop();
    setFailed(undefined);
    setConnecting(device.id);
    let result: PickResult;
    try {
      result = await connect(device);
    } catch {
      result = { ok: false, problem: 'not-an-adapter' };
    }
    if (!alive.current) return;
    setConnecting(undefined);
    if (result.ok) onConnected();
    else setFailed({ id: device.id, problem: result.problem });
  };

  const { view, phase } = state;
  const top = topMatch(view);
  const scanning = phase === 'scanning';
  const status = saved
    ? `Your adapters · ${view.count}`
    : scanning
      ? `Scanning · ${view.count} found`
      : `${view.count} found`;
  const empty = phase === 'done' && view.count === 0;

  const card = (row: ScanRow) => (
    <DeviceCard
      key={row.device.id}
      row={row}
      top={row === top}
      connecting={connecting === row.device.id}
      disabled={connecting !== undefined && connecting !== row.device.id}
      problem={failed?.id === row.device.id ? failed.problem : undefined}
      saved={saved}
      onPick={() => void pick(row.device)}
    />
  );

  return (
    <>
      <div
        className="flex touch-none flex-col gap-3 px-5 pt-2.5 pb-4"
        onPointerDown={(e) => {
          dragFrom.current = e.clientY;
        }}
        onPointerUp={(e) => {
          if (dragFrom.current !== undefined && e.clientY - dragFrom.current > 60) onOpenChange(false);
          dragFrom.current = undefined;
        }}
      >
        <span aria-hidden="true" className="mx-auto block h-1 w-10 bg-line" data-part="handle" />
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title className="display m-0 text-[34px]">pick your adapter.</Dialog.Title>
          <Dialog.Close
            aria-label="Close"
            className="pressable plunk flex size-10 flex-none items-center justify-center border border-line bg-tile font-extrabold text-ink [--edge:var(--color-card-edge)] [--plunk:3px]"
          >
            <span aria-hidden="true">✕</span>
          </Dialog.Close>
        </div>
        {phase !== 'error' && (
          <p
            role="status"
            aria-live="polite"
            className="micro m-0 flex items-center gap-2 [--micro-color:var(--color-blue)]"
          >
            {scanning && !saved && (
              <span
                aria-hidden="true"
                className="size-2 bg-blue motion-safe:animate-[obd-pulse_1.2s_ease-in-out_infinite]"
              />
            )}
            {status}
          </p>
        )}
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 pb-4"
        onPointerDown={() => session.hold()}
        data-part="list"
      >
        {phase === 'error' && state.error === 'bluetooth-off' && (
          <InfoCard title="turn on Bluetooth." tone="warn">
            Your phone's Bluetooth is off, so we can't look for the adapter.
            <div className="mt-3 flex flex-col gap-2.5">
              {scanner.openSettings && (
                <Button variant="invert" onClick={() => scanner.openSettings?.()}>
                  Open settings
                </Button>
              )}
              <Button variant="secondary" onClick={rescan}>
                Try again
              </Button>
            </div>
          </InfoCard>
        )}
        {phase === 'error' && state.error === 'permission-denied' && (
          <InfoCard title="allow Bluetooth to find your adapter." tone="warn">
            Vibecode my car needs Bluetooth permission to see the adapter plugged into your car. It only
            connects to the adapter you tap, and nothing is sent to the car until you start.
            <div className="mt-3 flex flex-col gap-2.5">
              <Button variant="invert" onClick={rescan}>
                Try again
              </Button>
              {scanner.openSettings && (
                <Button variant="secondary" onClick={() => scanner.openSettings?.()}>
                  Open settings
                </Button>
              )}
            </div>
          </InfoCard>
        )}
        {phase === 'error' && state.error === 'not-supported' && (
          <InfoCard title="this device can't scan for Bluetooth." tone="warn">
            Open Vibecode my car in Chrome on Android or on a computer.
          </InfoCard>
        )}

        {empty && saved && (
          <InfoCard title="no saved adapter.">Find yours below — your browser lists what's nearby.</InfoCard>
        )}
        {empty && !saved && (
          <section aria-label="Nothing found" className="flex flex-col gap-3">
            <InfoCard title="no adapter found.">
              Nothing answered in 10 seconds. Check these three, then scan again.
            </InfoCard>
            <SetupSteps />
          </section>
        )}

        {phase !== 'error' && view.pinned && (
          <ul className="m-0 flex list-none flex-col p-0">{card(view.pinned)}</ul>
        )}

        {phase !== 'error' && view.likely.length > 0 && (
          <section aria-labelledby="likely-head" className="flex flex-col gap-2.5">
            <h3 id="likely-head" className="micro m-0">
              Looks like an OBD adapter
            </h3>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">{view.likely.map(card)}</ul>
          </section>
        )}

        {phase !== 'error' && view.other.length > 0 && (
          <section aria-labelledby="other-head" className="flex flex-col gap-2.5">
            <h3 id="other-head" className="micro m-0">
              Other devices
            </h3>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">{view.other.map(card)}</ul>
          </section>
        )}
      </div>

      {phase !== 'error' && (
        <div className="flex items-center justify-between gap-3 border-line border-t px-5 pt-3.5 pb-[max(16px,env(safe-area-inset-bottom))]">
          <p className="m-0 font-semibold text-ink-3 text-xs leading-[1.4]">
            {saved
              ? 'Using another adapter? Your browser lists it.'
              : "Don't see yours? Check the adapter's light."}
          </p>
          {saved ? (
            <Button
              variant="outline"
              className="flex-none px-3.5 text-[12px] tracking-[1.5px]"
              disabled={connecting !== undefined}
              onClick={onFindNew}
            >
              + Find a new adapter
            </Button>
          ) : (
            <Button
              variant="outline"
              className="flex-none px-3.5 text-[12px] tracking-[1.5px]"
              disabled={connecting !== undefined}
              onClick={rescan}
            >
              ↻ Rescan
            </Button>
          )}
        </div>
      )}
    </>
  );
}

function DeviceCard({
  row,
  top,
  connecting,
  disabled,
  problem,
  saved,
  onPick,
}: {
  row: ScanRow;
  top: boolean;
  connecting: boolean;
  disabled: boolean;
  problem?: PickProblem | undefined;
  /** Listed from the browser's memory: with no advertisement heard, say it is saved rather than "signal unknown". */
  saved: boolean;
  onPick(): void;
}) {
  const { device, likely, lastUsed } = row;
  const greyed = !likely && !lastUsed;
  const name = displayName(device);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={onPick}
        disabled={disabled || connecting}
        aria-busy={connecting || undefined}
        data-device={device.id}
        data-top={top || undefined}
        className={cn(
          'pressable flex w-full items-center gap-3 px-3.5 py-3 text-left disabled:cursor-not-allowed',
          top
            ? 'plunk bg-ink text-bg [--edge:var(--color-ink-4)] [--plunk:5px]'
            : greyed
              ? 'border border-line-faint bg-transparent text-ink-off'
              : 'border border-line bg-surface text-ink',
          disabled && 'opacity-40',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={cn('min-w-0 truncate font-extrabold', greyed ? 'text-[14px]' : 'text-[15px]')}>
              {name}
            </span>
            {lastUsed && (
              <Badge className={top ? 'bg-bg text-ink' : 'border border-ink text-ink'}>Last used</Badge>
            )}
            {likely && <Badge className="bg-yellow text-bg">Likely</Badge>}
          </span>
          {connecting ? (
            <span className="flex items-center gap-2 font-extrabold text-[11px] tracking-[1.5px] uppercase">
              <span
                aria-hidden="true"
                className={cn(
                  'size-2.5 motion-safe:animate-[obd-pulse_1.2s_ease-in-out_infinite]',
                  top ? 'bg-bg' : 'bg-ink',
                )}
              />
              Connecting…
            </span>
          ) : (
            <span
              className={cn(
                'font-semibold text-[12px] leading-[1.35]',
                top ? 'text-ink-on-light' : greyed ? 'text-ink-off' : 'text-ink-3',
              )}
            >
              {saved && device.rssi === undefined
                ? [chipText(device), 'BLE', 'used here before'].filter(Boolean).join(' · ')
                : subline(device)}
              {greyed && <span className="block">{otherHint(device)}</span>}
            </span>
          )}
        </span>
        {!(saved && device.rssi === undefined) && (
          <SignalMeter bars={signalBars(device.rssi)} rssi={device.rssi} />
        )}
      </button>
      {problem && (
        <p
          role="alert"
          className="m-0 border border-yellow border-t-0 bg-warn-bg px-3.5 py-2.5 font-bold text-[13px] text-yellow leading-[1.45]"
        >
          {PICK_COPY[problem]}
        </p>
      )}
    </li>
  );
}

function Badge({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        'px-1.5 py-[3px] font-extrabold text-[9px] leading-none tracking-[1.5px] uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Three bars; the unlit ones stay as faint outlines. */
export function SignalMeter({ bars, rssi }: { bars: SignalBars; rssi: number | undefined }) {
  return (
    <span
      role="img"
      aria-label={`Signal ${bars} of 3${rssi !== undefined ? ` (${rssi} dBm)` : ''}`}
      data-bars={bars}
      className="flex h-4 flex-none items-end gap-[3px]"
    >
      {[1, 2, 3].map((b) => (
        <span
          key={b}
          className={cn('w-[5px] bg-current', b > bars && 'opacity-20')}
          style={{ height: 4 + b * 4 }}
        />
      ))}
    </span>
  );
}
