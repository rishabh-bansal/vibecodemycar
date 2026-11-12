import { Link } from '@tanstack/react-router';
import { ToggleGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { GROUP_LABELS } from '../../domain/catalogue/groups.ts';
import type { CatalogueStatus } from '../../domain/catalogue/status.ts';
import type { CatalogueFeature, GroupId } from '../../domain/catalogue/types.ts';
import { cn } from '../../ui/cn.ts';
import { Photo } from './Photo.tsx';

/** Colour of a status label — the status itself comes from the support data (see domain/catalogue/status.ts). */
export function tone(s: CatalogueStatus): string {
  if (s.kind === 'codable') return '[--micro-color:var(--color-green)]';
  return '[--micro-color:var(--color-ink-off)]';
}

const openFeature = (slug: string) => ({
  to: '/features' as const,
  search: (prev: Record<string, unknown>) => ({ ...prev, f: slug }),
});

/** Photo row (88×44 thumb, 8px padding): Lights / Locks / Assist / Comfort / Service. */
export function PhotoRow({ feature, status }: { feature: CatalogueFeature; status: CatalogueStatus }) {
  return (
    <li>
      <Link
        {...openFeature(feature.slug)}
        data-card
        className="plunk flex min-h-14 items-center gap-3 border border-line bg-surface p-2 text-ink no-underline [--edge:var(--color-card-edge)] [--plunk:4px]"
      >
        <Photo id={feature.image} group={feature.group} size="sm" className="w-[88px] flex-none" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-bold text-sm leading-snug">{feature.name}</span>
          <span className={cn('micro', tone(status))}>{status.label}</span>
        </span>
        <span aria-hidden="true" className="pr-2 font-extrabold">
          →
        </span>
      </Link>
    </li>
  );
}

/** Photo card (2:1 image, name below): Dashboard on mobile, every section on desktop. */
export function PhotoCard({
  feature,
  status,
  selected = false,
}: {
  feature: CatalogueFeature;
  status: CatalogueStatus;
  selected?: boolean;
}) {
  return (
    <li>
      <Link
        {...openFeature(feature.slug)}
        data-card
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'plunk flex h-full flex-col gap-2 border p-2 no-underline',
          selected
            ? 'border-transparent bg-ink text-bg [--edge:var(--color-yellow)] [--plunk:6px]'
            : 'border-line bg-surface text-ink [--edge:var(--color-card-edge)] [--plunk:4px]',
        )}
      >
        <Photo id={feature.image} group={feature.group} size="sm" />
        <span className="flex flex-col gap-0.5 px-0.5 pb-0.5">
          <span className="font-bold text-[13px] leading-snug">{feature.name}</span>
          <span className={cn('micro', tone(status), selected && '[--micro-color:var(--color-bg)]')}>
            {status.label}
          </span>
        </span>
      </Link>
    </li>
  );
}

/** "Most loved" hero: 176px, photo cover, gradient into the page, yellow tag, white arrow tile. */
export function HeroCard({ feature }: { feature: CatalogueFeature }) {
  return (
    <Link
      {...openFeature(feature.slug)}
      data-card
      className="plunk relative block h-44 overflow-hidden border border-line bg-surface text-ink no-underline [--edge:var(--color-yellow)] [--plunk:6px]"
    >
      <Photo
        id={feature.image}
        group={feature.group}
        size="lg"
        ratio="h-full"
        eager
        className="absolute inset-0"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-bg via-bg/60 to-transparent"
      />
      <span className="absolute top-3 left-3 bg-yellow px-2 py-1 font-extrabold text-[10px] text-bg tracking-[1.5px]">
        MOST LOVED
      </span>
      <span className="absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="display text-[26px]">{feature.name.toLowerCase().replace(/\.+$/, '')}.</span>
          {feature.intro && (
            <span className="line-clamp-1 font-semibold text-ink-2 text-xs">{feature.intro}</span>
          )}
        </span>
        <span
          aria-hidden="true"
          className="grid size-10 flex-none place-items-center bg-ink font-extrabold text-bg"
        >
          →
        </span>
      </span>
    </Link>
  );
}

/** UNLOCKS · 33 | SERVICE TOOLS · 22 — selected = white. */
export function SegmentedTabs<T extends string>({
  value,
  onValueChange,
  options,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: readonly { value: T; label: string; count: number }[];
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label="Catalogue section"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      className="grid grid-cols-2 gap-px border border-line bg-line"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="min-h-11 bg-surface px-2 font-extrabold text-[11px] text-ink tracking-[1px] data-[state=on]:bg-ink data-[state=on]:text-bg"
        >
          {o.label} · {o.count}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** Desktop chips: multi-select; ALL clears. Selected = yellow + plunk. */
export function MultiChips({
  value,
  onChange,
  options,
}: {
  value: readonly GroupId[];
  onChange: (groups: GroupId[]) => void;
  options: readonly { group: GroupId; count: number }[];
}) {
  const chip = 'pressable flex-none border px-3.5 py-2.5 font-bold text-[12px] tracking-[1px] uppercase';
  const on =
    'plunk border-transparent bg-yellow font-extrabold text-bg [--edge:var(--color-yellow-edge)] [--plunk:3px]';
  return (
    <div className="flex flex-wrap gap-2.5" role="group" aria-label="Groups">
      <button
        type="button"
        aria-pressed={value.length === 0}
        onClick={() => onChange([])}
        className={cn(chip, value.length === 0 ? on : 'border-line bg-tile text-ink')}
      >
        All
      </button>
      <ToggleGroup.Root
        type="multiple"
        value={[...value]}
        onValueChange={(v) => onChange(v as GroupId[])}
        className="contents"
      >
        {options.map((o) => (
          <ToggleGroup.Item
            key={o.group}
            value={o.group}
            className={cn(
              chip,
              'border-line bg-tile text-ink data-[state=on]:plunk data-[state=on]:border-transparent data-[state=on]:bg-yellow data-[state=on]:text-bg data-[state=on]:[--edge:var(--color-yellow-edge)] data-[state=on]:[--plunk:3px]',
            )}
          >
            {GROUP_LABELS[o.group].desktopChip} · {o.count}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  );
}

export function SectionHeader({
  title,
  count,
  action,
}: {
  title: string;
  count: number;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="micro m-0">
        {title} · {count}
      </h2>
      {action}
    </div>
  );
}

/** Surface blocks the same size as the real rows, shown only on first boot. */
export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading features" className="flex flex-col gap-3.5">
      <div className="h-44 animate-pulse bg-surface" />
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="h-14 animate-pulse bg-surface" />
      ))}
    </div>
  );
}
