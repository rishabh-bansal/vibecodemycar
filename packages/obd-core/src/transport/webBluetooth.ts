import { TransportError, type Transport } from './types.ts';
import { realClock } from '../util/clock.ts';
import { BLE_LAYOUTS, BLE_SERVICES, classifyBleName, pickCharacteristics, type BleLayout, type NameInfo } from '../adapters/catalog.ts';

// Minimal structural types so this module needs no DOM typings.
interface GattCharacteristic {
  uuid: string;
  properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean; indicate: boolean };
  value?: DataView | null;
  writeValueWithoutResponse?(v: BufferSource): Promise<void>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue?(v: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
  stopNotifications(): Promise<GattCharacteristic>;
  addEventListener(type: 'characteristicvaluechanged', cb: (e: { target: unknown }) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', cb: (e: { target: unknown }) => void): void;
}
interface GattService {
  uuid: string;
  getCharacteristics(): Promise<GattCharacteristic[]>;
}
interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<GattService[]>;
}
export interface BleDevice {
  id: string;
  name?: string;
  gatt?: GattServer;
  addEventListener(type: 'gattserverdisconnected', cb: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', cb: () => void): void;
}
/** Web Bluetooth `requestDevice` filters: a device is listed when it matches any one filter. */
export interface ChooserFilters {
  filters: ({ services: string[] } | { namePrefix: string })[];
  optionalServices?: string[];
}
export interface BluetoothApi {
  requestDevice(opts: unknown): Promise<BleDevice>;
}
type BufferSource = ArrayBuffer | ArrayBufferView;

/** Host-side observations only: a completed GATT call is not an ECU acknowledgement. No payload or device ID. */
export interface BleObservation {
  at: string;
  monoMs: number;
  kind: string;
  details: Record<string, string | number | boolean>;
}

const sameUuid = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Web Bluetooth transport for BLE ELM327 adapters. Must be opened from a user
 * gesture (browser rule). Writes are chunked to 20 bytes; no automatic reconnect.
 */
export class WebBluetoothTransport implements Transport {
  readonly kind = 'ble' as const;
  readonly maxWrite = 20;
  name = 'Bluetooth adapter';
  id = 'ble';
  isOpen = false;
  /** The GATT layout in use, and whether its characteristics were known or found by their properties. */
  profile: BleLayout | null = null;
  profileVia: 'known' | 'by-properties' | null = null;
  /** What the advertised name suggests (vendor, STN-likely, app-only). */
  nameInfo: NameInfo | undefined;
  private device: BleDevice | null = null;
  private writeChar: GattCharacteristic | null = null;
  private notifyChar: GattCharacteristic | null = null;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();
  private readonly onValue = (e: { target: unknown }) => {
    const v = (e.target as GattCharacteristic).value;
    if (!v) return;
    const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    this.observe('notification', { bytes: bytes.length });
    for (const cb of this.dataCbs) cb(bytes);
  };
  private readonly onGattDisconnect = () => this.handleClose('the adapter disconnected');

  private readonly bluetooth: BluetoothApi | undefined;
  private readonly chooser: string | ChooserFilters | undefined;
  private readonly observer: ((event: BleObservation) => void) | undefined;
  private writeNumber = 0;

  /**
   * `chooser` decides what the browser's device chooser lists: a name prefix, a set of filters (only matching
   * devices), or nothing (every nearby device). The adapter services are always declared as optional services.
   */
  constructor(bluetooth: BluetoothApi | undefined, chooser?: string | ChooserFilters, observer?: (event: BleObservation) => void, device?: BleDevice) {
    this.bluetooth = bluetooth;
    this.chooser = chooser;
    this.observer = observer;
    if (device) this.device = device;
  }

  /**
   * The device this transport was granted (by the chooser or injection). Reusing it lets a fresh
   * transport `gatt.connect()` without opening the device chooser again — the grant belongs to
   * the page session, not to one connection.
   */
  get reusableDevice(): BleDevice | undefined {
    return this.device ?? undefined;
  }

  private observe(kind: string, details: BleObservation['details'] = {}): void {
    try { this.observer?.({ at: new Date().toISOString(), monoMs: realClock.now(), kind, details }); }
    catch { /* A recorder cannot affect the transport. */ }
  }

  static available(nav: unknown): nav is { bluetooth: BluetoothApi } {
    return !!nav && typeof (nav as { bluetooth?: unknown }).bluetooth === 'object';
  }

  async open(): Promise<void> {
    if (!this.bluetooth) throw new TransportError('Web Bluetooth is not available in this browser', 'not_supported');
    // A previously granted device skips the chooser entirely — reconnecting after a drop does
    // not need another user gesture.
    let device = this.device;
    if (!device) {
      try {
        const filters = typeof this.chooser === 'string' ? [{ namePrefix: this.chooser }] : this.chooser?.filters;
        device = await this.bluetooth.requestDevice({
          ...(filters?.length ? { filters } : { acceptAllDevices: true }),
          optionalServices: [...new Set([...BLE_SERVICES, ...(typeof this.chooser === 'object' ? this.chooser.optionalServices ?? [] : [])])],
        });
      } catch (e) {
        const { name, message } = e as Error;
        // Blocked by the user's site settings or by policy ("Bluetooth permission has been blocked.").
        if (name === 'SecurityError' || name === 'NotAllowedError') throw new TransportError(message, 'denied');
        // Chrome raises NotFoundError both when the picker is dismissed and when the radio is off
        // ("Bluetooth adapter not available."); only the message tells them apart.
        if (name === 'NotFoundError' && /adapter (is )?not available|powered off|bluetooth is off/i.test(message))
          throw new TransportError(message, 'not_found');
        if (name === 'NotFoundError') throw new TransportError('no adapter chosen or found', 'cancelled');
        throw new TransportError(message, 'not_found');
      }
      this.device = device;
    }
    this.name = device.name ?? 'Bluetooth adapter';
    this.id = device.id;
    this.nameInfo = classifyBleName(device.name);
    if (!device.gatt) throw new TransportError('this device has no GATT server', 'gatt');
    const gatt = device.gatt;
    try {
      this.observe('connect-start');
      const server = await gatt.connect();
      this.observe('connected');
      await this.attach(device, server);
    } catch (e) {
      // Never leave a half-set-up GATT connection behind a failed open.
      gatt.disconnect();
      throw e instanceof TransportError ? e : new TransportError(`could not set up the adapter: ${(e as Error).message}`, 'gatt');
    }
    this.isOpen = true;
  }

  private async attach(device: BleDevice, server: GattServer): Promise<void> {
    const services = await server.getPrimaryServices();
    for (const layout of BLE_LAYOUTS) {
      const svc = services.find((s) => sameUuid(s.uuid, layout.service));
      if (!svc) continue;
      const picked = pickCharacteristics(layout, await svc.getCharacteristics());
      if (picked) {
        this.profile = layout;
        this.profileVia = picked.via;
        this.writeChar = picked.write;
        this.notifyChar = picked.notify;
        break;
      }
    }
    if (!this.writeChar || !this.notifyChar) {
      const appOnly = this.nameInfo && !this.nameInfo.elmCompatible ? ` ("${this.name}" looks like a ${this.nameInfo.vendor} adapter, which only works with its own app)` : '';
      throw new TransportError(`this device does not offer a known ELM327 serial service${appOnly}`, 'gatt');
    }
    await this.notifyChar.startNotifications();
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
    device.addEventListener('gattserverdisconnected', this.onGattDisconnect);
    this.observe('profile', {
      service: this.profile?.service ?? '', write: this.writeChar.uuid, notify: this.notifyChar.uuid,
      via: this.profileVia ?? '', maxWrite: this.maxWrite,
      withoutResponse: this.writeChar.properties.writeWithoutResponse && !!this.writeChar.writeValueWithoutResponse,
    });
    this.observe('notifications-ready');
  }

  async write(data: Uint8Array): Promise<void> {
    const c = this.writeChar;
    if (!c || !this.isOpen) throw new TransportError('not connected', 'closed');
    const id = ++this.writeNumber;
    const started = realClock.now();
    const mode = c.properties.writeWithoutResponse && c.writeValueWithoutResponse ? 'without-response'
      : c.writeValueWithResponse ? 'with-response' : 'legacy';
    this.observe('write-submit', { id, bytes: data.length, mode });
    try {
      if (c.properties.writeWithoutResponse && c.writeValueWithoutResponse) await c.writeValueWithoutResponse(data);
      else if (c.writeValueWithResponse) await c.writeValueWithResponse(data);
      else await c.writeValue!(data);
      this.observe('write-resolved', { id, bytes: data.length, mode, durationMs: realClock.now() - started });
    } catch (e) {
      this.observe('write-failed', { id, bytes: data.length, mode, durationMs: realClock.now() - started });
      throw new TransportError(`write failed: ${(e as Error).message}`, 'write_failed');
    }
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }

  private handleClose(reason: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.observe('disconnected', { intentional: reason === 'closed by the app' });
    for (const cb of this.closeCbs) cb(reason);
  }

  async close(): Promise<void> {
    try {
      this.notifyChar?.removeEventListener('characteristicvaluechanged', this.onValue);
      this.device?.removeEventListener('gattserverdisconnected', this.onGattDisconnect);
      this.device?.gatt?.disconnect();
    } finally {
      this.handleClose('closed by the app');
    }
  }
}
