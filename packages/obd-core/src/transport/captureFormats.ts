import type { RecordedExchange } from './replay.ts';

/**
 * Readers for recorded adapter sessions, so a capture can be replayed through
 * the engine (regression tests, demo, desktop "import a scan file").
 *  - v1 browser export: { schema: "elm327.capture/1", raw_exchanges: [...] }
 *  - benchmark raw.jsonl: one { exchange: {...} } object per line
 */
interface RawExchange {
  cmd: string;
  rx_text?: string;
  status?: string;
  latency_ms?: number;
  t_start?: number;
  t_end?: number;
  prompt?: boolean;
}

function toRecorded(e: RawExchange, unit: 'ms' | 's'): RecordedExchange {
  const rx = e.rx_text ?? '';
  const dur = e.latency_ms ?? (e.t_end !== undefined && e.t_start !== undefined ? (e.t_end - e.t_start) * (unit === 's' ? 1000 : 1) : undefined);
  const hang = e.status === 'timeout' || (e.prompt === false && !rx.includes('>'));
  return { cmd: e.cmd, rx, ...(dur !== undefined ? { durationMs: dur } : {}), ...(hang ? { hang: true } : {}) };
}

export function exchangesFromBrowserCapture(json: { raw_exchanges?: RawExchange[] }): RecordedExchange[] {
  return (json.raw_exchanges ?? []).filter((e) => typeof e.cmd === 'string').map((e) => toRecorded(e, 'ms'));
}

export function exchangesFromJsonl(text: string): RecordedExchange[] {
  const out: RecordedExchange[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const ex = JSON.parse(line).exchange as RawExchange | undefined;
    if (ex?.cmd) out.push(toRecorded(ex, 's'));
  }
  return out;
}

/** Accepts either format; throws on anything else. */
export function exchangesFromAny(text: string): RecordedExchange[] {
  const t = text.trimStart();
  if (t.startsWith('{"schema"') || (t.startsWith('{') && t.includes('"raw_exchanges"'))) {
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j.raw_exchanges)) return exchangesFromBrowserCapture(j);
    } catch {
      // fall through to JSONL
    }
  }
  let lines: RecordedExchange[] = [];
  try {
    lines = exchangesFromJsonl(t);
  } catch {
    // a line that is not JSON: not a capture we know
  }
  if (lines.length) return lines;
  throw new Error('not a recognised capture file');
}
