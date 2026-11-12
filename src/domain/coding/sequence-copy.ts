import type { SequenceIncomplete, SequenceStep } from './types.ts';

/**
 * Words for a declared sequence's steps, shared by the session's phase text and the Done screen. Plain words
 * only: the commands, identifiers and codes are in the `sequence` event and the journal, never in this text.
 */

/** What a declared sequence's mutating step is, in words. */
export function stepName(cmd: string): string {
  if (cmd === 'adapter') return 'the adapter clean-up afterwards';
  if (cmd.startsWith('2E')) return "the restore of the part's identity details";
  if (cmd.startsWith('11')) return 'the restart of that part of the car';
  if (cmd.startsWith('14')) return 'the clearing of stored fault messages';
  if (cmd.startsWith('34')) return 'the start of the update';
  if (cmd.startsWith('37')) return 'the end of the update';
  return 'a follow-up step';
}

/** Names the sequence steps that changed (or may have changed) the car besides the setting. */
export function describeSteps(steps: readonly SequenceStep[]): string {
  const done = steps.filter((s) => s.outcome === 'acked').map((s) => stepName(s.cmd));
  const maybe = steps.filter((s) => s.outcome === 'no-answer').map((s) => stepName(s.cmd));
  const list = (names: string[]) => [...new Set(names)].join(', ');
  return `${done.length ? ` Your car also accepted ${list(done)}.` : ''}${
    maybe.length ? ` ${capital(list(maybe))} got no answer and may have taken effect.` : ''
  }`;
}

const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Why a sequence stopped after its accepted setting, and what that leaves to do. */
export function describeIncomplete(i: SequenceIncomplete): string {
  const step = stepName(i.step);
  switch (i.reason) {
    case 'refused':
      return ` Your car then didn't accept ${step}, so we stopped there and repeated nothing. Switch the ignition off and on before using the feature.`;
    case 'not-ready':
      return ` The car check ran out of time before ${step}, so it was not sent. Switch the ignition off and on before using the feature.`;
    case 'no-answer':
      return ` ${capital(step)} got no answer; it may or may not have happened.`;
    case 'link-lost':
      return ` The connection was lost during ${step}; it may or may not have happened.`;
  }
}
