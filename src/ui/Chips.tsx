import { ToggleGroup } from 'radix-ui';
import { cn } from './cn.ts';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/** FilterChip: compact ChoiceTile; the selected chip is yellow. Single-select, cannot be emptied. */
export function FilterChips<T extends string>({
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onValueChange: (v: T) => void;
  options: readonly ChipOption<T>[];
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      // Radix emits '' when the active chip is pressed again; a filter must always have one value.
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn('flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none]', className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            'pressable flex-none border border-line bg-tile px-3.5 py-2.5 font-bold text-[12px] tracking-[1px] text-ink uppercase',
            'data-[state=on]:plunk data-[state=on]:border-transparent data-[state=on]:bg-yellow data-[state=on]:font-extrabold data-[state=on]:text-bg data-[state=on]:[--edge:var(--color-yellow-edge)] data-[state=on]:[--plunk:3px]',
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
