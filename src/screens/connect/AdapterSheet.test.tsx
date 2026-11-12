import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScannedDevice } from '../../domain/adapters/likely.ts';
import { type BleScanner, ScanError } from '../../infra/ble/scanner.ts';
import { AdapterSheet, type PickResult } from './AdapterSheet.tsx';

/** A scanner the test drives: sightings and errors are pushed by hand. */
function testScanner(opts: { settings?: boolean } = {}) {
  const runs: { seen: (d: ScannedDevice) => void; fail: (e: ScanError) => void; stopped: boolean }[] = [];
  const scanner: BleScanner = {
    ui: 'in-app',
    scan(onSeen, onError) {
      const run = { seen: onSeen, fail: onError, stopped: false };
      runs.push(run);
      return {
        stop() {
          run.stopped = true;
        },
      };
    },
    transport() {
      throw new Error('the sheet never opens a transport itself');
    },
    ...(opts.settings ? { openSettings: vi.fn() } : {}),
  };
  const current = () => {
    const run = runs.at(-1);
    if (!run) throw new Error('not scanning');
    return run;
  };
  return {
    scanner,
    runs,
    see: (...devices: (Partial<ScannedDevice> & { id: string })[]) =>
      act(() => {
        for (const d of devices) current().seen({ serviceUuids: [], ...d });
      }),
    fail: (e: ScanError) => act(() => current().fail(e)),
  };
}

const OBDBLE = { id: 'obd', name: 'OBDBLE', rssi: -58, serviceUuids: ['fff0'] };
const VLINKER = { id: 'vl', name: 'vLinker MC', rssi: -72, serviceUuids: ['18f0'] };
const CLONE = { id: 'clone', name: 'OBDII', rssi: -86, serviceUuids: ['ffe0'] };
const BUDS = { id: 'buds', name: 'boAt Airdopes', rssi: -45, deviceClass: 'audio' as const };
const UNNAMED = { id: 'anon', rssi: -70 };

function mount(props: Partial<Parameters<typeof AdapterSheet>[0]> & { scanner: BleScanner }): {
  connect: ReturnType<typeof vi.fn>;
  onConnected: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const connect = vi.fn<(d: ScannedDevice) => Promise<PickResult>>(async () => ({ ok: true }));
  const onConnected = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <AdapterSheet open onOpenChange={onOpenChange} connect={connect} onConnected={onConnected} {...props} />,
  );
  return { connect: (props.connect as never) ?? connect, onConnected, onOpenChange };
}

const card = (name: RegExp) => screen.getByRole('button', { name });

describe('AdapterSheet', () => {
  it('scanning: title, close button, live "SCANNING · N FOUND"', async () => {
    const t = testScanner();
    mount({ scanner: t.scanner });
    expect(screen.getByRole('dialog', { name: 'pick your adapter.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Scanning · 0 found');
    t.see(OBDBLE, BUDS);
    expect(screen.getByRole('status')).toHaveTextContent('Scanning · 2 found');
  });

  it('results: likely adapters first with a LIKELY badge and the top match drawn white; others greyed with a hint', () => {
    const t = testScanner();
    mount({ scanner: t.scanner });
    t.see(BUDS, UNNAMED, VLINKER, CLONE, OBDBLE);

    const likely = screen.getByRole('region', { name: 'Looks like an OBD adapter' });
    const names = within(likely)
      .getAllByRole('button')
      .map((b) => b.querySelector('span span span')?.textContent);
    expect(names).toEqual(['OBDBLE', 'vLinker MC', 'OBDII']); // then by signal
    expect(within(likely).getAllByText('Likely')).toHaveLength(3);
    expect(card(/OBDBLE/)).toHaveAttribute('data-top', 'true');
    expect(card(/OBDBLE/)).toHaveClass('bg-ink');
    expect(card(/vLinker/)).toHaveClass('bg-surface');
    expect(card(/OBDBLE/)).toHaveTextContent('ELM327 · BLE · strong signal');
    expect(card(/OBDII/)).toHaveTextContent('weak signal · move closer');
    expect(within(card(/OBDBLE/)).getByRole('img', { name: /Signal 3 of 3/ })).toBeInTheDocument();
    expect(within(card(/vLinker/)).getByRole('img', { name: /Signal 2 of 3/ })).toBeInTheDocument();

    const other = screen.getByRole('region', { name: 'Other devices' });
    expect(within(other).getAllByRole('button')).toHaveLength(2);
    expect(card(/boAt Airdopes/)).toHaveTextContent('not an adapter');
    expect(card(/Unnamed device/)).toHaveTextContent('try only if nothing above works');
    expect(card(/boAt Airdopes/)).toHaveClass('text-ink-off');
    expect(card(/boAt Airdopes/)).toBeEnabled(); // greyed but tappable
  });

  it('pins the last adapter that connected as LAST USED, with LIKELY when it qualifies', () => {
    const t = testScanner();
    mount({ scanner: t.scanner, lastUsed: { id: 'vl', name: 'vLinker MC' } });
    t.see(OBDBLE, VLINKER);
    const pinned = card(/vLinker/);
    expect(pinned).toHaveAttribute('data-top', 'true');
    expect(within(pinned).getByText('Last used')).toBeInTheDocument();
    expect(within(pinned).getByText('Likely')).toBeInTheDocument();
    expect(card(/OBDBLE/)).not.toHaveAttribute('data-top');
  });

  it('keeps rows in place while a finger is on the list', () => {
    const t = testScanner();
    mount({ scanner: t.scanner });
    t.see({ id: 'a', name: 'OBD A', rssi: -60 }, { id: 'b', name: 'OBD B', rssi: -70 });
    const order = () => screen.getAllByRole('button', { name: /OBD [AB]/ }).map((b) => b.dataset.device);
    expect(order()).toEqual(['a', 'b']);
    fireEvent.pointerDown(card(/OBD B/));
    t.see({ id: 'b', rssi: -40 });
    expect(order()).toEqual(['a', 'b']);
    expect(within(card(/OBD B/)).getByRole('img', { name: /Signal 3 of 3/ })).toBeInTheDocument(); // live signal
    fireEvent.pointerUp(window);
    expect(order()).toEqual(['b', 'a']);
  });

  it('connecting: CONNECTING… inside the tapped card, scanning stops, other cards wait; success hands on', async () => {
    const t = testScanner();
    let finish: (r: PickResult) => void = () => {};
    const connect = vi.fn(() => new Promise<PickResult>((r) => (finish = r)));
    const { onConnected } = mount({ scanner: t.scanner, connect });
    t.see(OBDBLE, VLINKER);
    await userEvent.click(card(/OBDBLE/));
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'obd' }));
    expect(card(/OBDBLE/)).toHaveTextContent('Connecting…');
    expect(card(/OBDBLE/)).toHaveAttribute('aria-busy', 'true');
    expect(card(/vLinker/)).toBeDisabled();
    expect(t.runs[0]?.stopped).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent(/^2 found$/);
    await act(async () => finish({ ok: true }));
    expect(onConnected).toHaveBeenCalledOnce();
  });

  it('handshake fail: says so in that card, stays on the sheet, and another device can be tried', async () => {
    const t = testScanner();
    const connect = vi
      .fn<(d: ScannedDevice) => Promise<PickResult>>()
      .mockResolvedValueOnce({ ok: false, problem: 'not-an-adapter' })
      .mockResolvedValueOnce({ ok: true });
    const { onConnected } = mount({ scanner: t.scanner, connect });
    t.see(OBDBLE, BUDS);
    await userEvent.click(card(/boAt Airdopes/));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "this doesn't answer like an OBD adapter — try another one",
    );
    expect(card(/boAt Airdopes/).closest('li')).toContainElement(screen.getByRole('alert'));
    expect(onConnected).not.toHaveBeenCalled();
    expect(card(/OBDBLE/)).toBeEnabled();
    await userEvent.click(card(/OBDBLE/));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a connect that throws is a failure too, never a stuck CONNECTING…', async () => {
    const t = testScanner();
    mount({ scanner: t.scanner, connect: vi.fn(async () => Promise.reject(new Error('boom'))) });
    t.see(OBDBLE);
    await userEvent.click(card(/OBDBLE/));
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't answer like an OBD adapter");
    expect(card(/OBDBLE/)).not.toHaveTextContent('Connecting…');
  });

  it('bluetooth off: "turn on Bluetooth" with OPEN SETTINGS, and TRY AGAIN scans again', async () => {
    const t = testScanner({ settings: true });
    mount({ scanner: t.scanner });
    t.fail(new ScanError('bluetooth-off'));
    expect(screen.getByRole('heading', { name: 'turn on Bluetooth.' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(t.scanner.openSettings).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(t.runs).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('Scanning · 0 found');
  });

  it('bluetooth off without a settings shortcut (the web) shows TRY AGAIN only', () => {
    const t = testScanner();
    mount({ scanner: t.scanner });
    t.fail(new ScanError('bluetooth-off'));
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('permission denied: explains why and offers a retry', async () => {
    const t = testScanner();
    mount({ scanner: t.scanner });
    t.fail(new ScanError('permission-denied'));
    expect(screen.getByRole('heading', { name: /allow Bluetooth/ })).toBeInTheDocument();
    expect(screen.getByText(/needs Bluetooth permission to see the adapter/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(t.runs).toHaveLength(2);
  });

  it('empty after the scan: the three setup steps again, the footer hint and RESCAN', async () => {
    const t = testScanner();
    mount({ scanner: t.scanner, session: { durationMs: 30 } });
    expect(await screen.findByRole('heading', { name: 'no adapter found.' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^0 found$/);
    const steps = within(screen.getByRole('region', { name: 'Nothing found' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual([
      '1Plug the adapter in',
      '2Ignition on, engine off',
      '3Bluetooth on',
    ]);
    expect(screen.getByText("Don't see yours? Check the adapter's light.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '↻ Rescan' }));
    expect(t.runs).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'no adapter found.' })).not.toBeInTheDocument();
  });

  it('the close button asks to close the sheet', async () => {
    const t = testScanner();
    const { onOpenChange } = mount({ scanner: t.scanner });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
