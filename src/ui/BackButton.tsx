import { Link, type LinkProps } from '@tanstack/react-router';

/** Back button: 44×44 dark tile. Not rendered on screen 5 while a write is in progress. */
export function BackButton({
  label = 'Back',
  ...props
}: Pick<LinkProps, 'to' | 'params' | 'search'> & { label?: string }) {
  return (
    <Link
      {...props}
      aria-label={label}
      className="plunk flex size-11 items-center justify-center border border-line bg-tile font-extrabold text-ink no-underline [--edge:var(--color-card-edge)] [--plunk:3px]"
    >
      <span aria-hidden="true">←</span>
    </Link>
  );
}
