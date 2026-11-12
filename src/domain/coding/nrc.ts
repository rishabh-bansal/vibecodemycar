/**
 * Plain-language reading of a UDS negative-response code (ISO 14229). The code itself is never put in the text:
 * callers keep it in a structured field (the `refused` event's `code`). The hint is a pointer for the owner,
 * never a diagnosis.
 */
const HINTS: Record<string, string> = {
  '13': "This change doesn't fit your car's version of this setting.",
  '22': "The car isn't in the right state for this change.",
  '31': "This part of your car doesn't have this setting.",
  '33': 'This setting needs an access code.',
  '35': 'The access code was not accepted.',
  '36': 'Too many access attempts. Wait, then try again.',
  '37': 'Your car asked us to wait before trying again.',
  '72': "Your car couldn't save the change.",
  '7E': "Your car can't make this change right now.",
  '7F': "Your car can't make this change right now.",
  '83': 'The car reports the engine running. Switch the engine off, keep the ignition on, and try again.',
  '88': 'The car reports it is moving or the engine is running. Switch the engine off, keep the ignition on, and try again.',
  '92': "The battery charge is too high. Don't change settings with the engine running or a fast charger attached.",
  '93': 'The battery is too low. Connect a battery charger, then try again.',
};

export function explainNrc(code: string): string {
  const c = code.toUpperCase().padStart(2, '0');
  // The code stays out of the text on purpose; see the comment above.
  const hint = HINTS[c];
  return hint ? `Your car didn't accept the change. ${hint}` : "Your car didn't accept the change.";
}
