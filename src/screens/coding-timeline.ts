import { APP_DATA } from '../domain/catalog/data.ts';
import { SCAN_TARGETS } from '../domain/catalog/modules.ts';
import type { Recipe } from '../domain/catalog/types.ts';
import type { CodingEvent, CodingRequest, RefusalReason, WriterStep } from '../domain/coding/types.ts';
import { scanUnits } from '../domain/scan/units.ts';

/**
 * The Writing screen's step list, folded from the session's events. Plain words only: no identifiers,
 * codes or bytes ever reach these titles and lines — the technical record stays in the background log.
 */

export type TimelineState = 'pending' | 'active' | 'done' | 'warning' | 'failed';

export type TimelineKey =
  | 'connect'
  | 'variant'
  | 'ready'
  | 'backup'
  | 'unlock'
  | 'write'
  | 'confirm'
  | 'outcome';

export interface TimelineStep {
  key: TimelineKey;
  title: string;
  state: TimelineState;
  /** One plain line under the title: what is happening now, or what was found. */
  detail?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface Timeline {
  steps: TimelineStep[];
  /** A multi-part change: the part being worked on (1-based) and how many there are. */
  part?: { n: number; of: number; module: string };
}

const FALLBACK_MODULE = 'module';

/** A diagnostic unit's name for the timeline ('central electrics', 'front camera (driver assistance)'). */
const unitLabel = (unit: string): string =>
  SCAN_TARGETS[unit]?.label ??
  scanUnits().find((u) => u.unit === unit || u.aliases.includes(unit))?.label ??
  FALLBACK_MODULE;

/**
 * Everyday names for modules the app codes but does not scan, by request CAN id. The scan table
 * (`SCAN_TARGETS`) is checked first; these fill in the rest so a title never falls back needlessly.
 */
const MORE_MODULES: Readonly<Record<string, string>> = {
  '757': 'cruise control',
  '74F': 'front camera',
  '70A': 'parking assistant',
  '74B': 'passenger door',
  '732': 'keyless entry',
  '769': 'parking camera',
  '7E0': 'engine',
  '76F': 'sound system',
  '723': 'tailgate',
  '76A': 'auxiliary heater',
  '767': 'navigation',
  '70B': 'tyre pressure monitor',
  '70F': 'all-wheel drive',
  '71B': 'head-up display',
};

/** A module's everyday name by its request CAN id ("central electrics"), else "module". */
export function moduleName(request: string | null | undefined): string {
  if (!request) return FALLBACK_MODULE;
  const id = request.toUpperCase();
  const target = Object.values(SCAN_TARGETS).find((t) => t.module.request.toUpperCase() === id);
  return target?.label ?? MORE_MODULES[id] ?? FALLBACK_MODULE;
}

/** Why a change stopped before anything was sent, in one plain line. */
const REFUSAL_LINES: Partial<Record<RefusalReason, string>> = {
  'wrong-car': "This isn't the car this change was made on",
  'no-vin': "We couldn't read which car this is",
  'unknown-module': "We couldn't find this part of your car",
  'module-silent': "That part of your car didn't answer",
  'variant-unsettled': "We couldn't tell which version your car has",
  'backup-failed': "We couldn't save your original setting, so we didn't go ahead",
  'ecu-refused': "Your car didn't allow the change",
  'not-eligible': "This change isn't available for your car",
  'target-changed': 'This setting has moved since your change, so we left it',
  'needs-requalification': "We can't undo this one automatically",
  'restore-conflict': 'The setting was changed since, so we left it',
  'link-quarantined': 'Please reconnect before trying again',
  'not-ready': 'Your car needs to be parked, engine off, ignition on',
  'backup-inconsistent': "This saved setting doesn't look right, so we left it",
  'value-changed': 'The setting changed while we were working, so we stopped',
};

/** Shown on "ready" while the original setting is read, until the readiness check reports. */
const READING_SETTING = 'Reading your current setting';

function recipeOfRequest(request: CodingRequest): Recipe | undefined {
  const id =
    request.kind === 'apply'
      ? request.feature.recipeId
      : request.kind === 'inspect'
        ? undefined
        : request.backup.recipeId;
  return id ? APP_DATA.recipes[id] : undefined;
}

/** The recipe picks one of several versions by asking the module first (an `alt`, or a group with one). */
function choosesVersion(recipe: Recipe | undefined): boolean {
  if (!recipe) return false;
  if (recipe.kind === 'alt') return true;
  return recipe.kind === 'group' && recipe.steps.some((s) => s.kind === 'alt');
}

/** What the writer is doing, in plain words. Unknown steps (and ones with nothing to say) are skipped. */
const UNLOCK_NOTES: Partial<Record<WriterStep, (module: string) => string>> = {
  retarget: (m) => `Talking to the ${m}`,
  rebind: (m) => `Talking to the ${m}`,
  settle: () => 'Letting the connection settle',
  'session-open': () => 'Opening a coding session',
  rearm: () => 'Opening a coding session',
  'session-stale-rearm': () => 'Opening a fresh coding session',
  probe: (m) => `Checking the ${m}`,
  seed: (m) => `Asking the ${m} for access`,
  key: () => 'Sending the access code',
  'key-reused-same-seed': () => 'Access code already sent',
  'security-refused-unit-default': () => 'Trying the standard access code',
  marker: () => 'Getting the change ready',
  'marker-gave-up': () => 'Getting the change ready',
  'nrc-session-lost-retry': () => 'Reopening the coding session',
  'not-ready': (m) => `The ${m} asked us to wait`,
};

const WRITE_NOTES: Partial<Record<WriterStep, string>> = {
  payload: 'Sending the new setting',
  pending: 'Your car is saving the change',
  resend: 'Sending it once more',
  step: 'Finishing the change',
};

const CONFIRM_NOTES: Partial<Record<WriterStep, string>> = {
  'proof-read': 'Reading the setting back',
  'end-session': 'Closing the coding session',
};

/** Readiness in plain words; `ok` false says what was off. */
function readinessDetail(e: Extract<CodingEvent, { type: 'readiness' }>): string {
  const battery = e.voltage === null ? undefined : `battery ${e.voltage.toFixed(1)} V`;
  if (e.ok) return ['Parked, engine off', battery].filter(Boolean).join(' · ');
  if (e.rpm !== null && e.rpm > 0) return 'The engine is running. Switch it off, keep the ignition on';
  if (e.speedKmh !== null && e.speedKmh > 0) return 'The car is moving. Park it first';
  if (battery) return `Battery is low (${battery.replace('battery ', '')}). Keep the engine off`;
  return "We couldn't read everything. Keep the car parked, engine off";
}

function titles(request: CodingRequest, module: string): Record<TimelineKey, string> {
  const restore = request.kind === 'restore';
  return {
    connect: "Checking it's your car",
    variant: 'Choosing the right version for your car',
    ready: 'Checking your car is ready',
    backup: restore ? 'Saving a record before the undo' : 'Saving your original setting',
    unlock: `Unlocking the ${module}`,
    write: restore ? 'Putting your original setting back' : 'Writing the new setting',
    confirm: request.kind === 'inspect' ? "Reading your car's settings" : 'Confirming it worked',
    outcome: 'Done',
  };
}

function keysFor(request: CodingRequest): TimelineKey[] {
  if (request.kind === 'inspect' || request.kind === 'recheck') return ['connect', 'confirm', 'outcome'];
  const keys: TimelineKey[] = ['connect'];
  if (request.kind === 'apply' && choosesVersion(recipeOfRequest(request))) keys.push('variant');
  keys.push('ready', 'backup', 'unlock', 'write', 'confirm', 'outcome');
  return keys;
}

const FINAL: readonly TimelineState[] = ['done', 'warning', 'failed'];

/** Folds the session's events into the step list. Pure: the same events always give the same list. */
export function buildTimeline(request: CodingRequest, events: readonly CodingEvent[]): Timeline {
  const recipe = recipeOfRequest(request);
  const baseModule = moduleName(
    request.kind === 'apply'
      ? recipe?.requestId
      : request.kind === 'inspect'
        ? request.module.request
        : request.backup.module.request,
  );
  let module = baseModule;
  let part: Timeline['part'];
  const keys = keysFor(request);
  const steps = new Map<TimelineKey, TimelineStep>(
    keys.map((key) => [key, { key, title: titles(request, module)[key], state: 'pending' }]),
  );
  const has = (key: TimelineKey) => steps.has(key);
  const get = (key: TimelineKey) => steps.get(key);
  const set = (key: TimelineKey, patch: Partial<TimelineStep>) => {
    const s = get(key);
    if (s) steps.set(key, { ...s, ...patch });
  };
  const activeKey = () => keys.find((k) => get(k)?.state === 'active');

  /** Finish `key` (keeping a warning it already has), stamped `at`. */
  const finish = (key: TimelineKey, at: string, state: TimelineState = 'done', detail?: string) => {
    const s = get(key);
    if (!s || (FINAL.includes(s.state) && state === 'done')) return;
    // A placeholder of work in progress never outlives the step (the readiness check never reported).
    const stale = detail === undefined && s.detail === READING_SETTING;
    set(key, {
      state: s.state === 'warning' && state === 'done' ? 'warning' : state,
      startedAt: s.startedAt ?? at,
      endedAt: at,
      ...(detail !== undefined ? { detail } : stale ? { detail: undefined } : {}),
    });
  };
  /** Make `key` the active step: every step before it is finished, as it has been passed. */
  const reach = (key: TimelineKey, at: string, detail?: string) => {
    if (!has(key)) return;
    for (const k of keys) {
      if (k === key) break;
      const s = get(k);
      if (s && !FINAL.includes(s.state)) finish(k, at);
    }
    const s = get(key);
    if (!s) return;
    if (s.state === 'pending') set(key, { state: 'active', startedAt: at });
    if (detail !== undefined && !FINAL.includes(get(key)?.state ?? 'pending')) set(key, { detail });
  };
  const note = (key: TimelineKey, detail: string) => {
    const s = get(key);
    if (s && !FINAL.includes(s.state)) set(key, { detail });
  };

  for (const e of events) {
    switch (e.type) {
      case 'verify-started':
        reach('connect', e.at, 'Connecting to your car');
        break;
      case 'car-verified':
        finish('connect', e.at, 'done', `It's your car · ${e.vinMasked}`);
        reach(has('variant') ? 'variant' : has('ready') ? 'ready' : 'confirm', e.at);
        if (has('variant')) note('variant', `Asking the ${module} which version it is`);
        else note('ready', READING_SETTING);
        break;
      case 'variant-selected':
        finish('variant', e.at, 'done', 'Found the right version for your car');
        reach('ready', e.at, READING_SETTING);
        break;
      case 'variant-refused':
        if (has('variant'))
          finish('variant', e.at, 'failed', 'None of the versions we know matches your car');
        break;
      case 'readiness': {
        if (!has('ready')) break;
        reach('ready', e.at);
        finish('ready', e.at, e.ok ? 'done' : 'warning', readinessDetail(e));
        reach('backup', e.at, 'Saving it on this device');
        break;
      }
      case 'warning':
        if (e.code === 'readiness' && has('ready')) {
          const s = get('ready');
          set('ready', {
            state: 'warning',
            ...(s?.detail ? {} : { detail: 'Keep the car parked, engine off, ignition on' }),
          });
        } else if (e.code === 'other-car') {
          set('connect', { state: 'warning', detail: "This isn't the car you set up" });
        }
        break;
      case 'backup-saved':
        reach('backup', e.at);
        finish('backup', e.at, 'done', 'Saved. You can undo this anytime');
        reach('unlock', e.at, `Getting the ${module} ready`);
        break;
      case 'group-step': {
        module = moduleName(e.module.request);
        part = { n: e.index + 1, of: e.of, module };
        const title = titles(request, module).unlock;
        if (e.index > 0) {
          for (const k of ['unlock', 'write', 'confirm'] as const) {
            const s = get(k);
            if (s && s.state !== 'warning')
              set(k, { state: 'pending', detail: undefined, startedAt: undefined, endedAt: undefined });
          }
        }
        set('unlock', { title });
        reach('unlock', e.at, `Part ${e.index + 1} of ${e.of}`);
        break;
      }
      case 'security-access':
        reach('unlock', e.at);
        if (!get('unlock')?.detail?.startsWith('Sending')) note('unlock', `Asking the ${module} for access`);
        break;
      case 'writer': {
        const unlock = UNLOCK_NOTES[e.step];
        const write = WRITE_NOTES[e.step];
        const confirm = CONFIRM_NOTES[e.step];
        if (unlock) {
          // Opening, access and re-tries belong to the unlock step until the setting is on its way.
          const current = activeKey();
          if (current === 'write' || current === 'confirm') break;
          reach('unlock', e.at, unlock(module));
        } else if (write) {
          reach('write', e.at, write);
        } else if (confirm) {
          if (e.step === 'end-session') {
            const current = activeKey();
            if (current) note(current, confirm);
          } else reach('confirm', e.at, confirm);
        }
        break;
      }
      case 'request-sent':
        reach('write', e.at, 'Sending the new setting');
        break;
      case 'response-pending':
        reach('write', e.at, 'Your car is saving the change');
        break;
      case 'write-acked':
        note('write', 'Your car accepted it');
        break;
      case 'check-started':
        reach(
          'confirm',
          e.at,
          request.kind === 'inspect' ? 'Reading each setting' : 'Reading the setting back',
        );
        break;
      case 'readback':
        if (e.matches)
          finish(
            'confirm',
            e.at,
            'done',
            part && part.n < part.of ? `Part ${part.n} confirmed` : 'Your car has the new setting',
          );
        else finish('confirm', e.at, 'warning', 'Your car shows a different value');
        break;
      case 'module-scan':
        note('confirm', `Read the ${unitLabel(e.unit)}`);
        break;
      case 'scan-progress': {
        const current = activeKey();
        if (!current) break;
        note(
          current,
          e.phase === 'discover'
            ? `Looking for each part of your car (${e.done} of ${e.total})`
            : `Reading the ${unitLabel(e.unit)} (${e.done} of ${e.total})`,
        );
        break;
      }
      case 'link-lost': {
        const current = activeKey();
        if (current) note(current, 'The connection dropped');
        break;
      }
      case 'relink': {
        const current = activeKey();
        if (current) note(current, 'Reconnected, carrying on');
        break;
      }
      case 'cancel-requested': {
        const current = activeKey();
        if (current) note(current, 'Cancelling…');
        break;
      }
      case 'outcome': {
        const at = e.at;
        const current = activeKey();
        const refusal = [...events].reverse().find((x) => x.type === 'refused');
        const alreadySet =
          e.outcome === 'not-sent' && refusal?.type === 'refused' && refusal.reason === 'already-set';
        if (e.outcome === 'verified' || e.outcome === 'observed-match' || alreadySet) {
          for (const k of keys) if (k !== 'outcome') finish(k, at);
          finish(
            'outcome',
            at,
            'done',
            alreadySet ? 'It was already set that way' : request.kind === 'inspect' ? 'All read' : 'All done',
          );
        } else if (e.outcome === 'mismatch' || e.outcome === 'pending-uncertain') {
          if (current && current !== 'outcome') finish(current, at, 'warning');
          finish('outcome', at, 'warning', "We couldn't confirm it");
        } else {
          if (current && current !== 'outcome') finish(current, at, 'failed');
          const why = refusal?.type === 'refused' ? REFUSAL_LINES[refusal.reason] : undefined;
          const detail =
            e.outcome === 'cancelled'
              ? 'Cancelled'
              : e.outcome === 'rejected'
                ? "Your car didn't accept the change"
                : why
                  ? `${why}. Nothing was changed`
                  : 'Stopped. Nothing was changed';
          finish('outcome', at, 'failed', detail);
        }
        break;
      }
      default:
        break;
    }
  }

  return { steps: keys.flatMap((k) => get(k) ?? []), ...(part ? { part } : {}) };
}

/** Whole seconds a step took (or has taken so far, against `nowMs`). Undefined before it starts. */
export function stepSeconds(step: TimelineStep, nowMs: number): number | undefined {
  if (!step.startedAt) return undefined;
  const end = step.endedAt ? Date.parse(step.endedAt) : nowMs;
  return Math.max(0, Math.floor((end - Date.parse(step.startedAt)) / 1000));
}

/** "8 s", "1 min 05 s". */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  return `${m} min ${String(seconds % 60).padStart(2, '0')} s`;
}
