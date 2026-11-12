import { Armchair, Gauge, Lightbulb, Lock, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { GroupId } from '../../domain/catalogue/types.ts';
import { cn } from '../../ui/cn.ts';

const ICONS = {
  'exterior-lighting': Lightbulb,
  dashboard: Gauge,
  'windows-locks': Lock,
  assistance: ShieldCheck,
  comfort: Armchair,
  service: Wrench,
} satisfies Record<GroupId, typeof Lightbulb>;

export function GroupIcon({ group, className }: { group: GroupId; className?: string }) {
  const Icon = ICONS[group];
  return <Icon aria-hidden="true" className={className} strokeWidth={1.75} />;
}

/**
 * A fixed-aspect photo box (no layout shift). The photo is decorative (empty alt): it always sits next to the
 * feature's name, which screen readers would otherwise hear twice.
 *
 * A failed load is retried once, bypassing the browser cache: an older deploy that did not ship a photo answered
 * its URL with the app's HTML page (the SPA fallback), and browsers may still hold that cached response. Only a
 * second failure shows the group icon. The state belongs to one photo id: another feature in the same box
 * (the detail panel reuses it) starts afresh.
 */
export function Photo({
  id,
  group,
  size,
  className,
  ratio = 'aspect-[2/1]',
  eager = false,
}: {
  id?: string;
  group: GroupId;
  size: 'sm' | 'lg';
  className?: string;
  ratio?: string;
  eager?: boolean;
}) {
  const [load, setLoad] = useState<{ id?: string; attempt: 0 | 1 | 2 }>({ id, attempt: 0 });
  const attempt = load.id === id ? load.attempt : 0;
  const src = id ? `/f/${size}/${id}.webp${attempt === 1 ? '?reload=1' : ''}` : undefined;
  return (
    <div className={cn('relative overflow-hidden bg-surface', ratio, className)}>
      {src && attempt < 2 ? (
        <img
          key={src}
          src={src}
          alt=""
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setLoad({ id, attempt: attempt === 0 ? 1 : 2 })}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-ink-off">
          <GroupIcon group={group} className="size-1/4 min-w-5 max-w-10" />
        </div>
      )}
    </div>
  );
}
