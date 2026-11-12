import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { CarSelection } from '../domain/catalog/types.ts';
import { modelLabel } from '../domain/catalog/vehicles.ts';
import { useCarStore } from '../state/car-store.ts';
import { useConnection } from '../state/connection-store.ts';
import { modelImage } from '../ui/car-images.ts';
import { cn } from '../ui/cn.ts';
import { TopBar } from '../ui/Nav.tsx';

export function ConnectedBadge() {
  const status = useConnection((s) => s.status);
  if (status !== 'connected') return null;
  return (
    <span className="bg-green px-3 py-2.5 font-extrabold text-[11px] text-bg tracking-[1.5px]">
      ● CONNECTED
    </span>
  );
}

/** Desktop top-bar car chip: tap to change the car. Year and cluster appear once the car has reported them. */
function CarChip() {
  const sel = useCarStore((s) => s.selection);
  const image = carImageOf(sel);
  return (
    <Link
      to="/car"
      className="flex items-center gap-2.5 border border-line py-1 pr-3 pl-1.5 font-bold text-ink text-xs no-underline"
    >
      {image && <img src={image} alt="" className="h-auto w-16" />}
      {[
        modelLabel(sel.model),
        sel.detected?.modelYear,
        sel.detected?.cluster && (sel.detected.cluster === 'digital' ? 'Digital' : 'Analogue'),
      ]
        .filter(Boolean)
        .join(' · ')}
    </Link>
  );
}

/**
 * Page chrome. Mobile: a single centred column. Desktop: top bar + content.
 * `wide` lets the features layout use the full width for its three columns.
 */
export function Shell({
  children,
  wide = false,
  nav = true,
}: {
  children: ReactNode;
  wide?: boolean;
  nav?: boolean;
}) {
  return (
    // The build id stays out of sight: support can still read it from the page.
    <div className="flex min-h-dvh flex-col" data-build={import.meta.env.VITE_BUILD_ID ?? 'development'}>
      {nav && (
        <TopBar
          right={
            <>
              <CarChip />
              <ConnectedBadge />
            </>
          }
        />
      )}
      <div
        className={cn(
          'mx-auto flex w-full flex-1 flex-col',
          // Below the desktop breakpoint every screen keeps the mobile column the bottom nav is sized to.
          wide ? 'max-w-[480px] lg:max-w-none' : 'max-w-[480px] lg:max-w-[560px] lg:pt-8',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** The car's picture: one per model. */
export function carImageOf(sel: Pick<CarSelection, 'brand' | 'model'>): string | undefined {
  return modelImage(sel.brand, sel.model);
}

export function useCarImage(): string | undefined {
  return carImageOf(useCarStore((s) => s.selection));
}
