import { cn } from './cn.ts';

/** The four strokes of the "Gauge O" (design/DESIGN.md §5). Shared by the app icon and the wordmark's O. */
function GaugeStrokes() {
  return (
    <>
      <path d="M21.7 78.3 A40 40 0 1 1 78.3 78.3" fill="none" stroke="#fff" strokeWidth="13" />
      <path d="M84.6 30 A40 40 0 0 1 78.3 78.3" fill="none" stroke="#ffe24d" strokeWidth="13" />
      <path d="M50 50 L77 31" stroke="#ffe24d" strokeWidth="9" />
      <rect x="43" y="43" width="14" height="14" fill="#ffe24d" />
    </>
  );
}

/** "Gauge O": a speedometer, the yellow arc is the "unlocked" zone. Also the app icon (favicon), on its own. */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <GaugeStrokes />
    </svg>
  );
}

/**
 * The O inside the wordmark. Same drawing, framed to the dial's painted extent (outer edge of the 13-wide
 * arc: 3.5 to 96.5 across, 3.5 to ~83 down) so its height can equal Manrope's cap height (0.72em) and it
 * sits on the baseline like a letter. 1px margin on each side.
 */
function GaugeO() {
  return (
    <svg
      viewBox="3.5 3.5 93 79.5"
      aria-hidden="true"
      className="mx-px inline-block h-[0.72em] w-auto shrink-0 self-baseline"
      data-logo-o=""
    >
      <GaugeStrokes />
    </svg>
  );
}

/** VIBEC + gauge O + DE: the first word of the wordmark. */
function Vibecode() {
  return (
    <span aria-hidden="true" className="inline-flex items-baseline whitespace-nowrap">
      VIBEC
      <GaugeO />
      DE
    </span>
  );
}

/**
 * Wordmark "VIBECODE MY CAR" (Manrope 800; size from the caller's font size). The O of VIBECODE is the
 * gauge dial, "MY CAR" is yellow, 0.3em after it.
 * `stacked`: VIBECODE over a widely spaced MY CAR, for a splash screen or other large uses.
 * `collapsible`: below 360px wide only the dial is shown (`size` px), so a mobile header still fits its chip.
 */
export function Logo({
  size = 20,
  stacked = false,
  collapsible = false,
  className,
}: {
  size?: number;
  stacked?: boolean;
  collapsible?: boolean;
  className?: string;
}) {
  if (stacked) {
    return (
      <span
        role="img"
        aria-label="Vibecode my car"
        className={cn(
          'inline-flex flex-col items-start font-extrabold leading-none tracking-[0.5px]',
          className,
        )}
      >
        <Vibecode />
        <span
          aria-hidden="true"
          className="mt-[0.15em] whitespace-nowrap text-[0.55em] text-yellow tracking-[0.45em]"
        >
          MY CAR
        </span>
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label="Vibecode my car"
      className={cn(
        'inline-flex items-baseline whitespace-nowrap font-extrabold tracking-[0.5px]',
        className,
      )}
    >
      {collapsible && <LogoMark size={size} className="self-center min-[360px]:hidden" />}
      <span className={cn('inline-flex items-baseline gap-[0.3em]', collapsible && 'max-[360px]:hidden')}>
        <Vibecode />
        <span aria-hidden="true" className="text-yellow">
          MY CAR
        </span>
      </span>
    </span>
  );
}
