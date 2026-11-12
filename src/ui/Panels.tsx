import type { ReactNode } from 'react';
import { cn } from './cn.ts';

/** StatGrid: three columns with 1px gaps, micro-label over value (TIME / BACKUP / UNDO). */
export function StatGrid({
  stats,
  className,
}: {
  stats: readonly { label: string; value: string }[];
  className?: string;
}) {
  return (
    <dl className={cn('m-0 grid grid-cols-3 gap-px border border-line bg-line', className)}>
      {stats.map((s) => (
        <div key={s.label} className="flex flex-col gap-1 bg-bg px-3 py-3.5 lg:bg-surface-2">
          <dt className="micro">{s.label}</dt>
          <dd className="m-0 font-bold text-sm">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** WarningBar: yellow fill, black 800 uppercase. */
export function WarningBar({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="plunk bg-yellow p-4 font-extrabold text-[13px] tracking-[1px] text-bg uppercase [--edge:var(--color-yellow-edge)] [--plunk:5px]"
    >
      ⚠ {children}
    </div>
  );
}

/** Neutral explanatory card (e.g. "your car said no — nothing was changed"). */
export function InfoCard({
  title,
  children,
  tone = 'neutral',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'neutral' | 'warn';
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-2 border p-4',
        tone === 'warn' ? 'border-yellow bg-surface' : 'border-line bg-surface',
      )}
    >
      <h2 className="m-0 font-extrabold text-[15px]">{title}</h2>
      {children && <div className="text-[14px] text-ink-2 leading-[1.55]">{children}</div>}
    </section>
  );
}

export function Micro({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('micro', className)}>{children}</span>;
}
