import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export type StepState = 'done' | 'active' | 'pending' | 'failed' | 'warning';

const STATE_WORDS: Record<StepState, string> = {
  done: 'done',
  active: 'in progress',
  pending: 'waiting',
  failed: 'stopped',
  warning: 'needs attention',
};

/**
 * StepCard: done = green ✓; active = white card + hollow square spinner; pending = faint; warning = yellow !
 * on a yellow outline; failed = yellow ✕. `meta` sits on the right (e.g. the time a step took).
 */
export function StepCard({
  state,
  title,
  detail,
  meta,
}: {
  state: StepState;
  title: string;
  detail?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <li
      aria-current={state === 'active' ? 'step' : undefined}
      data-state={state}
      className={cn(
        'flex items-center gap-3.5 p-3.5',
        state === 'active' && 'plunk bg-ink text-bg [--edge:var(--color-ink-4)] [--plunk:5px]',
        state === 'done' && 'border border-line bg-surface',
        (state === 'failed' || state === 'warning') && 'border border-yellow bg-surface',
        state === 'pending' && 'border border-line-faint text-ink-off',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-8 flex-none items-center justify-center font-extrabold',
          state === 'done' && 'bg-green text-bg',
          (state === 'failed' || state === 'warning') && 'bg-yellow text-bg',
          state === 'active' && 'box-border border-2 border-bg',
          state === 'pending' && 'box-border border border-line',
        )}
      >
        {state === 'done' && '✓'}
        {state === 'failed' && '✕'}
        {state === 'warning' && '!'}
        {state === 'active' && (
          <span className="size-2.5 animate-[obd-pulse_1.2s_ease-in-out_infinite] bg-bg" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          data-part="title"
          className={cn('text-[15px]', state === 'active' ? 'font-extrabold' : 'font-bold')}
        >
          {title}
          <span className="sr-only">, {STATE_WORDS[state]}</span>
        </span>
        {detail && (
          <span
            className={cn(
              'font-semibold text-xs',
              state === 'active' ? 'text-ink-on-light' : state === 'done' ? 'text-ink-3' : 'text-ink-2',
            )}
          >
            {detail}
          </span>
        )}
      </span>
      {meta !== undefined && (
        <span
          className={cn(
            'flex-none font-bold text-xs tabular-nums',
            state === 'active' ? 'text-ink-on-light' : 'text-ink-3',
          )}
        >
          {meta}
        </span>
      )}
    </li>
  );
}
