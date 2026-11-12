import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(`s:${k}`) ?? null,
  setItem: (k: string, v: string) => void store.set(`s:${k}`, v),
});

const { clearDiagnostics, diagnostics, exportDiagnostics, feedCodingEvent, recordDiag } = await import(
  './diagnostics.ts'
);

beforeEach(() => {
  store.clear();
  clearDiagnostics();
});

describe('diagnostics log', () => {
  it('records stage, kind and detail with a session stamp', () => {
    recordDiag('ble', 'connect-started');
    recordDiag('adapter', 'init-failed', { code: 'car-silent' });
    const [a, b] = diagnostics();
    expect(a?.stage).toBe('ble');
    expect(a?.kind).toBe('connect-started');
    expect(a?.at).toBeTruthy();
    expect(b?.detail?.code).toBe('car-silent');
    expect(a?.session).toBe(b?.session);
  });

  it('persists to storage', () => {
    recordDiag('link', 'disconnected');
    expect(JSON.parse(store.get('vibecode-my-car.diagnostics.v1') ?? '[]')).toHaveLength(1);
  });

  it('feeds coding events through with outcome + phase fields', () => {
    feedCodingEvent({
      type: 'outcome',
      outcome: 'pending-uncertain',
      phase: 'no final acknowledgement',
      at: new Date().toISOString(),
    });
    const [e] = diagnostics();
    expect(e?.stage).toBe('coding');
    expect(e?.detail?.outcome).toBe('pending-uncertain');
  });

  it('exports a self-describing json payload', () => {
    recordDiag('app', 'boot');
    const parsed = JSON.parse(exportDiagnostics());
    expect(parsed.app).toBe('Vibecode my car');
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].kind).toBe('boot');
  });

  it('bounds the ring', () => {
    for (let i = 0; i < 900; i++) recordDiag('app', 'tick', { i });
    expect(diagnostics().length).toBeLessThanOrEqual(800);
    expect(diagnostics().at(-1)?.detail?.i).toBe(899);
  });
});
