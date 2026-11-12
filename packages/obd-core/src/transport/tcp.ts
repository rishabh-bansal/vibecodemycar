import { Socket } from 'node:net';
import { TransportError, type Transport } from './types.ts';

/**
 * Node-only (imports node:net), so it is deliberately not re-exported from the package index, which the browser
 * build pulls in. Import it by path: `@obdcraft/obd-core/src/transport/tcp.ts` or a relative path.
 */
export interface TcpTransportOptions {
  host?: string;
  port?: number;
  /** Time allowed for the TCP connect. */
  connectTimeoutMs?: number;
  name?: string;
  id?: string;
  /** Largest single write handed to the socket; the session chunks to this. */
  maxWrite?: number;
}

/**
 * ELM327 over TCP: a Wi-Fi adapter (192.168.0.10:35000 on most clones) or the live kit's BLE bridge
 * (tools/live/elm-bridge on 127.0.0.1:35000). Bytes go both ways unmodified; Nagle is off so a short
 * command is not held back waiting for more. No automatic reconnect: a closed transport stays closed.
 */
export class TcpTransport implements Transport {
  readonly kind = 'wifi' as const;
  readonly name: string;
  readonly id: string;
  readonly maxWrite: number;
  readonly host: string;
  readonly port: number;
  isOpen = false;
  private socket: Socket | null = null;
  private closedOnce = false;
  private closing = false;
  private readonly connectTimeoutMs: number;
  private dataCbs = new Set<(c: Uint8Array) => void>();
  private closeCbs = new Set<(r: string) => void>();

  constructor(opts: TcpTransportOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 35000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.maxWrite = opts.maxWrite ?? 256;
    this.name = opts.name ?? `TCP ${this.host}:${this.port}`;
    this.id = opts.id ?? `tcp:${this.host}:${this.port}`;
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    if (this.closedOnce) throw new TransportError('this TCP transport was closed; create a new one', 'closed');
    const socket = new Socket();
    socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new TransportError(`no TCP connection to ${this.host}:${this.port} within ${this.connectTimeoutMs} ms`, 'not_found'));
      }, this.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', onError);
        resolve();
      });
      const onError = (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new TransportError(`could not connect to ${this.host}:${this.port}: ${e.code ?? e.message}`, 'not_found'));
      };
      socket.once('error', onError);
      socket.connect(this.port, this.host);
    });
    this.socket = socket;
    this.isOpen = true;
    socket.on('data', (buf: Buffer) => {
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
      for (const cb of this.dataCbs) cb(bytes);
    });
    let lastError = '';
    socket.on('error', (e: NodeJS.ErrnoException) => (lastError = e.code ?? e.message));
    socket.on('close', () =>
      this.handleClose(this.closing ? 'closed' : lastError ? `socket error: ${lastError}` : 'the peer closed the connection'),
    );
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      this.closedOnce = true;
      return;
    }
    this.closing = true;
    await new Promise<void>((resolve) => {
      if (socket.destroyed) return resolve();
      socket.once('close', () => resolve());
      socket.end();
      // A peer that never acknowledges the FIN must not hold close() open.
      setTimeout(() => socket.destroy(), 500).unref();
    });
    this.handleClose('closed');
  }

  private handleClose(reason: string): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.isOpen = false;
    this.socket = null;
    for (const cb of this.closeCbs) cb(reason);
  }

  async write(data: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!this.isOpen || !socket || socket.destroyed) throw new TransportError('the TCP link is closed', 'closed');
    await new Promise<void>((resolve, reject) => {
      socket.write(data, (e) => (e ? reject(new TransportError(`TCP write failed: ${e.message}`, 'write_failed')) : resolve()));
    });
  }

  onData(cb: (chunk: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    return () => this.dataCbs.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closeCbs.add(cb);
    return () => this.closeCbs.delete(cb);
  }
}
