import { Navigate, useBlocker, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useNow } from '../app/hooks.ts';
import { ConnectedBadge, Shell } from '../app/layout.tsx';
import type { CodingEvent, CodingRequest, WarningCode } from '../domain/coding/types.ts';
import { useConnection } from '../state/connection-store.ts';
import { useSession } from '../state/session-store.ts';
import { Button } from '../ui/Button.tsx';
import { Micro, WarningBar } from '../ui/Panels.tsx';
import { StepCard } from '../ui/StepCard.tsx';
import { buildTimeline, formatSeconds, stepSeconds } from './coding-timeline.ts';
import { requestLabel } from './request.ts';

/**
 * Plain words for each advisory the session raised and kept going past. The technical detail stays in the
 * background log; codes with nothing the driver can act on (`undefined`) are not shown.
 */
const WARNING_COPY: Record<WarningCode, string | undefined> = {
  readiness: 'For best results, keep the car parked with the engine off and the ignition on.',
  'other-car': "This isn't the car you set up.",
  group: "Part of this change didn't apply to your car, so that part was left as it was.",
  repair: 'We also fixed a setting that an earlier change had left wrong.',
  part: undefined,
  identity: undefined,
  password: undefined,
};

/**
 * Advisories the session raised and kept going past — readiness (engine running, moving, supply voltage),
 * another car than the paired one. Shown as warnings, once each; none stops the change.
 */
export function warningsOf(events: readonly CodingEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const text = e.type === 'warning' ? WARNING_COPY[e.code] : undefined;
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** The session's advisories as warning bars; nothing when there are none. */
export function Warnings({ events, className }: { events: readonly CodingEvent[]; className?: string }) {
  const warnings = warningsOf(events);
  if (!warnings.length) return null;
  return (
    <ul className={`m-0 flex list-none flex-col gap-2 p-0 ${className ?? ''}`} aria-label="Warnings">
      {warnings.map((w) => (
        <li key={w}>
          <WarningBar>{w}</WarningBar>
        </li>
      ))}
    </ul>
  );
}

/**
 * The live step list: every stage of the session, each with its state, a plain line on what is happening,
 * and how long it took (or has taken so far). Moves only on real events — no fake progress.
 */
function Steps({
  request,
  events,
  running,
}: {
  request: CodingRequest;
  events: readonly CodingEvent[];
  running: boolean;
}) {
  const timeline = useMemo(() => buildTimeline(request, events), [request, events]);
  const now = useNow(running);
  const active = timeline.steps.find((s) => s.state === 'active');
  return (
    <>
      {timeline.part && (
        <p className="micro m-0 mt-6" aria-label="Part">
          Part {timeline.part.n} of {timeline.part.of} · {timeline.part.module}
        </p>
      )}
      <ol
        className={`m-0 ${timeline.part ? 'mt-3' : 'mt-7'} flex list-none flex-col gap-2.5 p-0`}
        aria-label="Progress"
      >
        {timeline.steps.map((step) => {
          const seconds = stepSeconds(step, now);
          return (
            <StepCard
              key={step.key}
              state={step.state}
              title={step.title}
              detail={step.detail}
              meta={seconds === undefined || step.key === 'outcome' ? undefined : formatSeconds(seconds)}
            />
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        {active ? `${active.title}${active.detail ? `: ${active.detail}` : ''}` : ''}
      </p>
    </>
  );
}

/** Screen 5 · Save the original & make the change. No fake progress bar: steps move only on real events. No Back while a write is in flight. */
export function CodingScreen() {
  const navigate = useNavigate();
  const conn = useConnection((s) => s.status);
  const { request, armed, progress, events, running, begin, cancel } = useSession();

  // Start the session this screen was armed with. Re-visits via history start nothing.
  useEffect(() => {
    begin();
  }, [begin]);

  // While a change may be landing nobody leaves by accident: in-app navigation is blocked and closing or
  // reloading the tab asks first. The move to Done happens once there is a result, so it is never blocked.
  const inFlight = running && !progress.result;
  useBlocker({ shouldBlockFn: () => inFlight, enableBeforeUnload: () => inFlight, disabled: !inFlight });

  const done = Boolean(progress.result);
  useEffect(() => {
    if (done) void navigate({ to: '/done', replace: true });
  }, [done, navigate]);

  // Nothing armed, nothing running, nothing finished: this URL was reached by history, not by the flow.
  if (!request && !armed && !running) {
    return conn === 'connected' ? <Navigate to="/features" replace /> : <Navigate to="/car" replace />;
  }

  const title = !request ? '' : requestLabel(request).toLowerCase();
  const headline =
    request?.kind === 'restore'
      ? 'undoing your'
      : request?.kind === 'recheck'
        ? 'checking your'
        : request?.kind === 'inspect'
          ? 'reading your'
          : 'setting up your';

  return (
    <Shell nav={false}>
      <div className="flex flex-1 flex-col px-5 pt-8 pb-[30px]">
        <div className="flex items-center justify-between">
          <ConnectedBadge />
          <Micro>Step 2 / 2</Micro>
        </div>

        <h1 className="display mt-[34px] mb-0 text-[40px]">
          {headline}
          <br />
          {title}.
        </h1>
        <p className="mt-3 mb-0 font-semibold text-sm text-ink-3">keep the ignition on. stay close.</p>

        {request && <Steps request={request} events={events} running={running && !done} />}

        <Warnings events={events} className="mt-5" />

        <div className="mt-auto flex flex-col gap-3.5 pt-8">
          <WarningBar>Don't unplug or close the app</WarningBar>
          {!progress.sent && !done && (
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    </Shell>
  );
}
