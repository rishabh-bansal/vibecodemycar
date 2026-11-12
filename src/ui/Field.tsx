import { type ReactNode, useId } from 'react';

/** Labelled native <select>: best mobile UX and free accessibility. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="micro">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[54px] w-full appearance-none border border-line bg-surface bg-[length:12px] bg-[position:right_14px_center] bg-no-repeat px-3.5 pr-9 font-bold text-base text-ink disabled:opacity-40"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23a3a3a3' stroke-width='2'/%3E%3C/svg%3E\")",
        }}
      >
        {children}
      </select>
    </div>
  );
}
