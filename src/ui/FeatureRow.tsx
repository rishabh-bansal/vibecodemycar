import type { FeatureItem } from '../domain/catalog/types.ts';
import { cn } from './cn.ts';
import { StatusTile } from './Status.tsx';

const LABEL_COLOUR = {
  tested: 'text-green',
  experimental: 'text-green',
  unavailable: 'text-ink-off',
} as const;

/** A non-interactive feature summary (landing-page sample). Browsing lives in screens/catalogue. */
/** `label` replaces the car-specific status (e.g. on a sample where no car has been picked). */
export function FeatureRow({ feature, label }: { feature: FeatureItem; label?: string }) {
  const unavailable = feature.tier === 'unavailable';
  return (
    <li
      className={cn(
        'flex items-center gap-3.5 border p-4',
        unavailable
          ? 'border-line-faint text-ink-off'
          : 'plunk border-line bg-surface text-ink [--edge:var(--color-card-edge)] [--plunk:4px]',
      )}
    >
      <StatusTile tier={feature.tier} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="font-bold text-[15px]">{feature.name}</span>
        <span className={cn('font-bold text-[11px] uppercase tracking-[1px]', LABEL_COLOUR[feature.tier])}>
          {label ?? feature.statusLabel}
        </span>
      </span>
    </li>
  );
}
