import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ElmSession } from '../src/elm/session.ts';
import { TcpTransport } from '../src/transport/tcp.ts';
import { TransportError } from '../src/transport/types.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A local server; `onSocket` gets each accepted connection. Resolves to its port. */
async function serve(onSocket: (s: Socket) => void): Promise<number> {
  const server = createServer(onSocket);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('TCP transport', () => {
  it('passes bytes both ways unmodified through an echo server', async () => {
    const port = await serve((s) => s.pipe(s));
    const t = new TcpTransport({ port });
    expect(t.kind).toBe('wifi');
    await t.open();
    expect(t.isOpen).toBe(true);
    const got: number[] = [];
    const done = new Promise<void>((r) => t.onData((c) => {
      got.push(...c);
      if (got.length >= 6) r();
    }));
    const sent = Uint8Array.from([0x41, 0x54, 0x49, 0x0d, 0x00, 0xff]);
    await t.write(sent);
    await done;
    expect(got).toEqual([...sent]);
    await t.close();
    expect(t.isOpen).toBe(false);
  });

  it('frames an ELM reply through ElmSession', async () => {
    const port = await serve((s) => {
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString('latin1');
        if (!buf.includes('\r')) return;
        const cmd = buf.trim();
        buf = '';
        // split across writes, as a BLE bridge forwards notifications
        s.write(`${cmd}\r`);
        setTimeout(() => s.write('ELM327 v2.1\r\r>'), 5);
      });
    });
    const t = new TcpTransport({ port });
    await t.open();
    const session = new ElmSession(t);
    const r = await session.send('ATI', 1000);
    expect(r.status).toBe('ok');
    expect(r.lines).toEqual(['ELM327 v2.1']);
    session.dispose();
    await t.close();
  });

  it('reports the peer closing, once, and refuses later writes', async () => {
    const port = await serve((s) => setTimeout(() => s.end(), 10));
    const t = new TcpTransport({ port });
    const reasons: string[] = [];
    t.onClose((r) => reasons.push(r));
    await t.open();
    await new Promise((r) => setTimeout(r, 60));
    expect(reasons).toEqual(['the peer closed the connection']);
    expect(t.isOpen).toBe(false);
    await expect(t.write(Uint8Array.of(0x58))).rejects.toBeInstanceOf(TransportError);
    await t.close();
    expect(reasons).toHaveLength(1);
    await expect(t.open()).rejects.toMatchObject({ code: 'closed' });
  });

  it('fails to open when nothing listens', async () => {
    const port = await serve(() => {});
    servers.pop()?.close();
    await new Promise((r) => setTimeout(r, 20));
    const t = new TcpTransport({ port, connectTimeoutMs: 1000 });
    await expect(t.open()).rejects.toMatchObject({ code: 'not_found' });
    expect(t.isOpen).toBe(false);
  });

  it('a local close reports "closed" to listeners', async () => {
    const port = await serve(() => {});
    const t = new TcpTransport({ port });
    const reasons: string[] = [];
    t.onClose((r) => reasons.push(r));
    await t.open();
    await t.close();
    expect(reasons).toEqual(['closed']);
  });
});
