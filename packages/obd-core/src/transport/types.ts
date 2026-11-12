/**
 * Byte pipe to an ELM327-class adapter. Web Bluetooth today; a Capacitor BLE
 * plugin, Web Serial or a replay file later. Nothing above this interface knows
 * which one is in use.
 */
export interface Transport {
  readonly kind: 'ble' | 'serial' | 'wifi' | 'emulator' | 'replay';
  /** Human-readable adapter name (BLE device name, "Emulator", file name). */
  readonly name: string;
  /** Stable identity used to remember tuned settings per adapter. */
  readonly id: string;
  /** Largest single write the link accepts. */
  readonly maxWrite: number;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** Registers a data listener; returns an unsubscribe function. */
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onClose(cb: (reason: string) => void): () => void;
  readonly isOpen: boolean;
}

export class TransportError extends Error {
  /** `denied`: the browser or the user blocked Bluetooth for this site. */
  readonly code: 'not_supported' | 'not_found' | 'cancelled' | 'denied' | 'gatt' | 'closed' | 'write_failed';

  constructor(message: string, code: TransportError['code']) {
    super(message);
    this.code = code;
    this.name = 'TransportError';
  }
}
