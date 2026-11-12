/**
 * Light rewrite of source text for display (spec §3). Done here, never by editing the data.
 * "hood" → "bonnet", SHOUTED words down to sentence case, and a trailing "this feature" → "it".
 */
const SHOUTED = /\b(ON|OFF|LAW|ABS|ESC)\b/g;

function matchCase(source: string, replacement: string): string {
  return source[0] === source[0]?.toUpperCase()
    ? replacement.charAt(0).toUpperCase() + replacement.slice(1)
    : replacement;
}

export function displayCopy(text: string): string {
  let out = text.trim();
  out = out.replace(/\bhoods?\b/gi, (m) =>
    matchCase(m, m.toLowerCase().endsWith('s') ? 'bonnets' : 'bonnet'),
  );
  out = out.replace(SHOUTED, (m) => (m === 'ABS' || m === 'ESC' ? m : m.toLowerCase()));
  out = out.replace(/\bthis (?:feature|function|application|modification)(?=[.!]?$)/i, 'it');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Serif headline form: lowercase with a full stop ("gauge test - needle sweep."). */
export function displayTitle(name: string): string {
  return `${name.trim().toLowerCase().replace(/\.+$/, '')}.`;
}
