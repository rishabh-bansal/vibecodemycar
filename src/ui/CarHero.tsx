import { RadioGroup } from 'radix-ui';
import { cn } from './cn.ts';

/** Neutral stand-in used wherever licensed imagery is not available. */
export function Silhouette({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 320 110"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinejoin="round"
    >
      <path d="M18 80 L30 58 Q38 44 56 40 L100 34 Q120 14 152 12 L200 12 Q232 14 250 36 L286 44 Q304 50 306 66 L306 80 Z" />
      <path d="M112 36 L134 20 L200 20 L226 36 Z" />
      <circle cx="82" cy="82" r="18" fill="var(--color-bg)" />
      <circle cx="244" cy="82" r="18" fill="var(--color-bg)" />
    </svg>
  );
}

/** CarHero: surface card, car bottom-aligned below the labels (never under them), model micro-label top-left, yellow serif count top-right. */
export function CarHero({
  label,
  count,
  image,
  alt,
  className,
}: {
  label: string;
  count?: number;
  image?: string;
  alt: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'plunk relative flex h-[100px] items-end justify-center overflow-hidden border border-line bg-surface [--edge:var(--color-card-edge)] [--plunk:5px]',
        className,
      )}
    >
      <span className="micro absolute top-3 left-3.5">{label}</span>
      {count !== undefined && (
        <span className="absolute top-2.5 right-3 font-display text-[22px] text-yellow">
          {count}
          <span className="sr-only"> {count === 1 ? 'feature' : 'features'} available for this car</span>
        </span>
      )}
      {image ? (
        <img
          src={image}
          alt={alt}
          className="mb-2 h-auto max-h-[70px] w-[160px] max-w-[55%] object-contain"
        />
      ) : (
        <Silhouette className="mb-3 w-[170px] max-w-[60%] text-ink-off" />
      )}
    </div>
  );
}

/**
 * ModelCard group: one card per model with its photo (or the neutral silhouette) and name. Same tile states as
 * ChoiceTile — selected = white fill + black text + plunk — on a Radix RadioGroup (arrow keys, roving focus).
 */
export function ModelCards({
  models,
  value,
  onValueChange,
  className,
}: {
  models: readonly { id: string; label: string; image?: string }[];
  value: string;
  onValueChange: (id: string) => void;
  className?: string;
}) {
  return (
    <RadioGroup.Root
      aria-label="Model"
      value={value}
      onValueChange={onValueChange}
      className={cn('grid grid-cols-4 gap-1.5', className)}
    >
      {models.map((m) => (
        <RadioGroup.Item
          key={m.id}
          value={m.id}
          aria-label={m.label}
          className={cn(
            'pressable flex min-h-[68px] flex-col justify-between gap-1 border border-line bg-surface px-1.5 pt-2 pb-1.5 text-center text-ink',
            'data-[state=checked]:plunk data-[state=checked]:border-transparent data-[state=checked]:bg-ink data-[state=checked]:text-bg data-[state=checked]:[--edge:var(--color-ink-4)] data-[state=checked]:[--plunk:4px]',
          )}
        >
          <span className="flex h-[32px] items-end justify-center" aria-hidden="true">
            {m.image ? (
              // Same length for every car on a shared ground line: an SUV stands taller than a sedan, as it does on the road.
              <img src={m.image} alt="" className="h-auto max-h-[32px] w-[70px] max-w-full object-contain" />
            ) : (
              <Silhouette className="w-[64px] max-w-full text-ink-off" />
            )}
          </span>
          <span className="font-extrabold text-[12px] leading-tight">{m.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
