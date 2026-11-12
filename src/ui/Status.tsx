import type { Tier } from '../domain/catalog/types.ts';
import { cn } from './cn.ts';

/** 40px status tile: available for your car = solid green ✓; unavailable = outlined –. */
export function StatusTile({ tier, size = 40 }: { tier: Tier; size?: number }) {
  const base = 'flex flex-none items-center justify-center font-extrabold';
  const style = { width: size, height: size };
  if (tier !== 'unavailable') {
    return (
      <span aria-hidden="true" className={cn(base, 'bg-green text-bg')} style={style}>
        ✓
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn(base, 'box-border border border-line text-ink-off')} style={style}>
      –
    </span>
  );
}

/** Inline pill version of the status, e.g. "✓ AVAILABLE FOR YOUR CAR". */
export function StatusBadge({ tier, children }: { tier: Tier; children: string }) {
  const available = tier !== 'unavailable';
  return (
    <span
      className={cn(
        'inline-block self-start px-2.5 py-1.5 font-extrabold text-[11px] tracking-[1.5px] uppercase',
        available ? 'bg-green text-bg' : 'border border-line text-ink-off',
      )}
    >
      {available ? `✓ ${children}` : children}
    </span>
  );
}
