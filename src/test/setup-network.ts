/**
 * Tests never reach the network. Code under test that calls the global `fetch` (the cloud log's enrollment and
 * upload, for one) gets a refusal for anything but localhost — a test run must never put simulator runs into
 * the production log. Tests that need HTTP pass their own `fetchImpl` or stub `fetch`; both keep working.
 */
const realFetch: typeof fetch | undefined = globalThis.fetch?.bind(globalThis);
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // a relative or malformed URL: refused below unless it resolves to localhost
  }
  if (!LOCAL.has(host) || !realFetch)
    return Promise.reject(new Error(`Tests may not reach the network (fetch ${url} refused).`));
  return realFetch(input, init);
};
