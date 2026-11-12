import { cn } from '../../ui/cn.ts';

export const SETUP_STEPS = ['Plug the adapter in', 'Ignition on, engine off', 'Bluetooth on'] as const;

/** The three setup steps as a 3-column grid (Connect screen, and the picker's "nothing found"). */
export function SetupSteps({ className }: { className?: string }) {
  return (
    <ol className={cn('m-0 grid list-none grid-cols-3 gap-px border border-line bg-line p-0', className)}>
      {SETUP_STEPS.map((t, i) => (
        <li key={t} className="flex flex-col gap-1.5 bg-bg px-2.5 py-3.5">
          <span className="font-display text-2xl text-yellow">{i + 1}</span>
          <span className="font-bold text-xs leading-[1.3]">{t}</span>
        </li>
      ))}
    </ol>
  );
}
