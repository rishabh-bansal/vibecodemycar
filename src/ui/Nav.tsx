import { Link } from '@tanstack/react-router';
import { cn } from './cn.ts';
import { Logo } from './Logo.tsx';

const TABS = [
  { to: '/features', label: 'Features' },
  { to: '/car', label: 'My car' },
] as const;

/** BottomNav (mobile): white block, 4px plunk, two equal tabs; the active tab is a black inset tile. */
export function BottomNav({ active }: { active?: (typeof TABS)[number]['to'] }) {
  return (
    <nav
      aria-label="Main"
      className="plunk mx-5 mb-[30px] flex bg-ink [--edge:var(--color-ink-4)] [--plunk:4px] lg:hidden"
    >
      {TABS.map((t) => (
        <Link
          key={t.to}
          to={t.to}
          // `active` lets a screen that belongs to a tab (e.g. a screen reached from Features) light it up.
          // The forced-active styles go through className itself: a spread className would be overwritten.
          {...(active === t.to
            ? { 'aria-current': 'page' as const }
            : {
                activeProps: { 'aria-current': 'page' as const, className: 'm-1 bg-bg text-ink' },
                inactiveProps: { className: 'text-bg' },
              })}
          className={cn(
            'flex min-h-14 flex-1 items-center justify-center font-extrabold text-[11px] tracking-[1.5px] uppercase no-underline',
            active === t.to && 'm-1 bg-bg text-ink',
            active && active !== t.to && 'text-bg',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Desktop top bar: logo, nav tiles, then whatever the caller puts on the right (car chip, connection badge). */
export function TopBar({ right }: { right?: React.ReactNode }) {
  return (
    <header className="hidden items-center justify-between gap-4 border-line border-b px-8 py-5 lg:flex">
      <div className="flex items-center gap-9">
        <Link to="/" aria-label="Vibecode my car home" className="text-ink no-underline">
          <Logo size={22} className="text-lg" />
        </Link>
        <nav aria-label="Main" className="flex gap-2">
          {TABS.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              activeProps={{
                'aria-current': 'page',
                className:
                  'plunk border-transparent bg-ink text-bg [--edge:var(--color-ink-4)] [--plunk:3px]',
              }}
              inactiveProps={{ className: 'border-line text-ink' }}
              className={cn(
                'border px-3.5 py-2.5 font-extrabold text-[11px] tracking-[1.5px] uppercase no-underline',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-2.5">{right}</div>
    </header>
  );
}
