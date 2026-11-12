import { AlertDialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { Button } from './Button.tsx';

/** Accessible confirmation for the few actions that should not be one tap (restore). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-bg/80" />
        <AlertDialog.Content className="plunk fixed top-1/2 left-1/2 w-[min(92vw,420px)] -translate-x-1/2 -translate-y-1/2 border border-line bg-surface p-5 [--edge:var(--color-card-edge)] [--plunk:5px]">
          <AlertDialog.Title className="display m-0 text-3xl">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-3 mb-5 text-[14px] text-ink-2 leading-[1.55]">
            {children}
          </AlertDialog.Description>
          <div className="flex flex-col gap-3">
            <AlertDialog.Action asChild>
              <Button variant="primary" block onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
            <AlertDialog.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
