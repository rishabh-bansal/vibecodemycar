import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { canRestore } from '../app/hooks.ts';
import { Shell } from '../app/layout.tsx';
import type { CodingResult } from '../domain/coding/progress.ts';
import type { CodingRequest, RefusalReason, SequenceIncomplete } from '../domain/coding/types.ts';
import '../domain/diagnostics.ts';
import { useConnection } from '../state/connection-store.ts';
import { backupStore, useSession } from '../state/session-store.ts';
import { Button } from '../ui/Button.tsx';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { cn } from '../ui/cn.ts';
import { BottomNav } from '../ui/Nav.tsx';
import { InfoCard, WarningBar } from '../ui/Panels.tsx';
import { Warnings } from './CodingScreen.tsx';
import { requestLabel, requestSettingLabel } from './request.ts';

interface View {
  tone: 'success' | 'neutral' | 'warn';
  title: string;
  body: string;
  /** A second, plain line under an unconfirmed result's warning. */
  note?: string;
}

/**
 * Why a change didn't go ahead, in plain words. The technical detail behind each reason is kept in the
 * background log, never shown.
 */
const REFUSAL_COPY: Record<RefusalReason, string> = {
  'wrong-car': "this isn't the car this change belongs to.",
  'no-vin': "we couldn't read your car's details. reconnect and try again.",
  'unknown-module': "this setting isn't available on your car's version.",
  'module-silent': "your car didn't respond. check the ignition is on and try again.",
  'variant-unsettled': "we couldn't work out the right setting for your car.",
  'already-set': 'it was already set that way.',
  'backup-failed': "we couldn't save your original setting first, so we didn't go ahead. try again.",
  'live-writes-disabled': 'changes are paused right now. please try again later.',
  'ecu-refused': "your car didn't accept the change.",
  'invalid-plan': 'something went wrong preparing this change. try again.',
  'not-eligible': "this setting isn't available for your car.",
  'target-changed':
    "this feature has been updated since your original was saved, so it can't be put back automatically.",
  'needs-requalification':
    "this saved original is from an older version of the app, so it can't be put back automatically.",
  'restore-conflict': 'this setting has been changed since, so we left it as it is.',
  'link-quarantined': 'the connection needs a fresh start. reconnect your adapter and try again.',
  'not-ready': "your car wasn't ready. keep it parked, engine off and ignition on, then try again.",
  'not-checkable': "there's nothing left to check for this change.",
  'backup-inconsistent': "your saved original doesn't look right, so we didn't use it.",
  'value-changed': 'the setting changed while we were working, so we stopped. try again.',
};

const UNCONFIRMED_NOTE: Record<Extract<CodingResult, { kind: 'unconfirmed' }>['why'], string | undefined> = {
  mismatch: 'your car saved a different value than expected.',
  'link-lost': 'the connection dropped before we could check.',
  'no-readback': undefined,
};

/** After a confirmed change, what the last step of a multi-step change leaves to do, in plain words. */
function afterSuccess(incomplete: SequenceIncomplete | undefined): string {
  if (!incomplete) return ' switch the ignition off and on to see it.';
  return incomplete.reason === 'refused' || incomplete.reason === 'not-ready'
    ? " the last step didn't finish, so switch the ignition off and on before using it."
    : " switch the ignition off and on to see it. we couldn't confirm the last step.";
}

/** Exported for tests: the words on the final screen come from the result alone. */
export function viewFor(result: CodingResult, request: CodingRequest | undefined): View {
  const name = (request ? requestLabel(request) : 'it').toLowerCase();
  const setting = request ? requestSettingLabel(request)?.toLowerCase() : undefined;
  switch (result.kind) {
    case 'success': {
      if (request?.kind === 'inspect')
        return {
          tone: 'success',
          title: 'scan complete.',
          body: "we've read your car's settings.",
        };
      const phrase =
        request?.kind === 'restore'
          ? 'is back how it was.'
          : request?.kind === 'recheck' || !setting
            ? 'is set.'
            : setting === 'on'
              ? 'is on.'
              : setting === 'off'
                ? 'is off.'
                : `is set to ${setting}.`;
      return {
        tone: 'success',
        title: `${name} ${phrase}`,
        // Acknowledgement and anything the module changed on its own are kept in the background log.
        body: `${
          request?.kind === 'restore' ? 'checked with your car.' : 'done and checked with your car.'
        }${afterSuccess(result.sequenceIncomplete)}`,
      };
    }
    case 'unchanged':
      return {
        tone: 'neutral',
        title: 'already set.',
        body: 'it was already set that way. nothing needed changing.',
      };
    case 'refused':
      // The control unit stored something while it was prepared: never say "nothing changed" then.
      if (result.markersStored?.length)
        return { tone: 'neutral', title: 'setting not changed.', body: REFUSAL_COPY[result.reason] };
      return {
        tone: 'neutral',
        title: 'nothing changed.',
        body: `${REFUSAL_COPY[result.reason]} nothing was changed.`,
      };
    case 'wrong-car':
      return {
        tone: 'neutral',
        title: 'wrong car.',
        body: "this isn't the car you set up. nothing was changed.",
      };
    case 'unconfirmed':
      return {
        tone: 'warn',
        title: "we couldn't confirm it.",
        body: "we couldn't confirm the result. tap check again before doing anything else.",
        note: UNCONFIRMED_NOTE[result.why],
      };
    case 'cancelled':
      return {
        tone: 'neutral',
        title: 'cancelled.',
        body: result.markersStored?.length ? "the setting wasn't changed." : 'nothing was sent to your car.',
      };
  }
}

/** Screen 6 · Done. Success is shown only for a result the reducer derived from a matching read-back. */
export function DoneScreen() {
  const navigate = useNavigate();
  const { progress, events, request, reset, arm, armed } = useSession();
  const connected = useConnection((s) => s.status === 'connected');
  const [confirmUndo, setConfirmUndo] = useState(false);
  /** Set while leaving for the feature list: the cleared session must not bounce this screen back there. */
  const [leaving, setLeaving] = useState(false);
  const result = progress.result;
  // "Check again" arms a recheck (which clears the result) and then navigates to /coding: while a
  // session is armed, stay put rather than redirect to the features and strand it.
  if (!result) return armed || leaving ? null : <Navigate to="/features" replace />;

  const view = viewFor(result, request);
  const unconfirmed = result.kind === 'unconfirmed';

  const audit = progress.auditFailure;
  // A recheck makes no new record: "check again" checks the same one.
  const backupId = progress.backupId ?? (request?.kind === 'recheck' ? request.backup.id : undefined);
  // The backup this change made can be put back — after a confirmed change and after an unconfirmed one,
  // including when "check again" re-checked that same change.
  const canUndo =
    !!backupId &&
    (result.kind === 'success' || result.kind === 'unconfirmed') &&
    ((request?.kind === 'apply' && !!progress.backupId) ||
      (request?.kind === 'recheck' && canRestore(request.backup)));
  const checkAgain = async () => {
    if (!backupId) return;
    // After an ambiguous write the old link is retired: the check must run on a fresh connection.
    if (!connected) {
      void navigate({ to: '/connect', search: { backup: backupId, action: 'recheck' } });
      return;
    }
    const backup = await backupStore.get(backupId);
    if (!backup) return;
    arm({ kind: 'recheck', backup });
    void navigate({ to: '/coding', replace: true });
  };

  return (
    <Shell>
      <div className="flex flex-1 flex-col gap-7 px-5 pt-10 lg:pt-0">
        <div className="flex flex-col gap-3.5">
          {view.tone === 'success' ? (
            <span
              aria-hidden="true"
              className="plunk grid size-14 place-items-center bg-green font-extrabold text-2xl text-bg [--edge:var(--color-green-edge)] [--plunk:4px]"
            >
              ✓
            </span>
          ) : null}
          <h1 className={cn('display mt-1.5 mb-0 text-[40px]')}>{view.title}</h1>
          {unconfirmed ? (
            <>
              <WarningBar>{view.body}</WarningBar>
              {view.note && <p className="m-0 text-sm text-ink-3 leading-normal">{view.note}</p>}
            </>
          ) : view.tone === 'neutral' ? (
            <InfoCard title={view.body} />
          ) : (
            <p className="m-0 font-semibold text-ink-3 text-sm leading-normal">{view.body}</p>
          )}
        </div>

        <Warnings events={events} />

        {audit && (
          // Local storage failed: the change stands on the car, but this device may not be able to undo it.
          <WarningBar>
            We couldn't save a record of this change on this device, so undoing it from here may not work.
          </WarningBar>
        )}

        {unconfirmed && <Button onClick={() => void checkAgain()}>Check again</Button>}

        {canUndo && (
          <>
            <Button variant="secondary" onClick={() => setConfirmUndo(true)}>
              Undo this change
            </Button>
            <ConfirmDialog
              open={confirmUndo}
              onOpenChange={setConfirmUndo}
              title="undo this change?"
              confirmLabel="Undo this change"
              onConfirm={() => {
                if (backupId)
                  void navigate({ to: '/connect', search: { backup: backupId, action: 'restore' } });
              }}
            >
              We'll put your original setting back. Keep the adapter plugged in and the ignition on.
            </ConfirmDialog>
          </>
        )}

        {!unconfirmed && (
          <div className="mt-auto">
            <Button
              onClick={() => {
                // Leave first, then clear: clearing first drops the result and this screen redirects by itself.
                setLeaving(true);
                void navigate({ to: '/features' }).then(reset);
              }}
            >
              Unlock another feature →
            </Button>
          </div>
        )}
      </div>
      <div className="pt-4 lg:hidden">
        <BottomNav />
      </div>
    </Shell>
  );
}
