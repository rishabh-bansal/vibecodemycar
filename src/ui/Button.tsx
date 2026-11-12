import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn.ts';

/**
 * PrimaryButton (yellow, large plunk — one per screen), SecondaryButton (surface + line, no plunk),
 * InvertButton (white, small plunk), ghost (text only). `asChild` lets a router <Link> wear the style.
 */
const button = cva(
  'pressable inline-flex items-center justify-center gap-2.5 font-extrabold uppercase select-none disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:opacity-40 aria-disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary:
          'plunk min-h-[60px] w-full bg-yellow px-5 text-[15px] tracking-[1.5px] text-bg [--edge:var(--color-yellow-edge)] [--plunk:5px] lg:w-auto lg:min-w-64',
        secondary:
          'min-h-[56px] w-full border border-line bg-surface px-5 text-[13px] tracking-[1.5px] text-ink',
        invert:
          'plunk min-h-11 bg-ink px-3 text-[11px] tracking-[1px] text-bg [--edge:var(--color-ink-4)] [--plunk:3px]',
        outline: 'min-h-11 min-w-11 border border-line bg-transparent px-2 text-[13px] text-ink',
        ghost: 'min-h-11 px-3 text-[12px] tracking-[1px] text-ink-4 hover:text-ink',
      },
      block: { true: 'w-full lg:w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', block: false },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({ variant, block, className, asChild, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp {...(asChild ? {} : { type })} className={cn(button({ variant, block }), className)} {...props} />
  );
}
