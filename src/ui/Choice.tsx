import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

/**
 * ChoiceTile family: selected = white fill + black text + plunk; unselected = surface + line.
 * Built on Radix RadioGroup, so arrow-key navigation, roving tabindex and screen-reader
 * semantics come for free.
 */
export interface ChoiceOption {
  value: string;
  label: ReactNode;
}

interface GroupProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ChoiceOption[];
  /** Layout classes for the group container. */
  className?: string;
  /** `row`: tiles with trailing radio dot (settings). `tile`: centred label (brand, cluster). */
  variant?: 'tile' | 'row';
}

export function ChoiceGroup({
  label,
  value,
  onValueChange,
  options,
  className,
  variant = 'tile',
}: GroupProps) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={onValueChange}
      className={cn('grid gap-3', className)}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            'pressable flex min-h-[54px] items-center border border-line bg-surface px-4 font-bold text-ink text-sm',
            'data-[state=checked]:plunk data-[state=checked]:border-transparent data-[state=checked]:bg-ink data-[state=checked]:text-bg data-[state=checked]:[--edge:var(--color-ink-4)] data-[state=checked]:[--plunk:4px]',
            variant === 'tile'
              ? 'justify-center font-extrabold tracking-[1px] uppercase'
              : 'justify-between text-left',
          )}
        >
          <span>{o.label}</span>
          {variant === 'row' && (
            <span
              aria-hidden="true"
              className="grid size-[18px] place-items-center rounded-full border-2 border-current"
            >
              <RadioGroup.Indicator className="size-2 rounded-full bg-current" />
            </span>
          )}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
