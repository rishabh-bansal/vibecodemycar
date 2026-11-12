import { Link, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useRestorableBackup } from '../../app/hooks.ts';
import { type CodableItem, freeValueSetting, parseFreeValue } from '../../domain/catalog/features.ts';
import { displayCopy, displayTitle } from '../../domain/catalogue/display.ts';
import { GROUP_LABELS } from '../../domain/catalogue/groups.ts';
import { appFeatureIds, type CatalogueStatus } from '../../domain/catalogue/status.ts';
import type { CatalogueFeature } from '../../domain/catalogue/types.ts';
import { Button } from '../../ui/Button.tsx';
import { ChoiceGroup } from '../../ui/Choice.tsx';
import { ConfirmDialog } from '../../ui/ConfirmDialog.tsx';
import { StatGrid } from '../../ui/Panels.tsx';
import { StatusBadge } from '../../ui/Status.tsx';
import { defaultSetting } from './settings.ts';

/** One card per Attention item: yellow "!" tile, micro-label, 13px/600 text. */
export function AttentionCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 border border-warn-line bg-warn-bg p-3.5">
      <span
        aria-hidden="true"
        className="grid size-7 flex-none place-items-center bg-yellow font-extrabold text-bg"
      >
        !
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="micro [--micro-color:var(--color-yellow)]">Before you start</span>
        <p className="m-0 font-semibold text-[13px] text-ink leading-[1.5]">{children}</p>
      </div>
    </div>
  );
}

function List({
  label,
  items,
  ordered = false,
}: {
  label: string;
  items: readonly string[];
  ordered?: boolean;
}) {
  if (items.length === 0) return null; // never render an empty section or heading
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <section className="flex flex-col gap-2">
      <h3 className="micro m-0">{label}</h3>
      <Tag
        className={`m-0 flex flex-col gap-1.5 pl-5 text-[13px] text-ink-2 leading-[1.5] ${ordered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((t) => (
          <li key={t}>{displayCopy(t)}</li>
        ))}
      </Tag>
    </section>
  );
}

/**
 * A free value for a scalar recipe, in the recipe's physical units. Typing a value selects it (setting
 * `value:<n>`); picking a preset above clears the box.
 */
function ScalarInput({
  item,
  setting,
  onChange,
  name,
}: {
  item: CodableItem;
  setting: string;
  onChange: (setting: string) => void;
  name: string;
}) {
  const id = useId();
  const scalar = item.scalar;
  const [draft, setDraft] = useState('');
  // A preset picked above replaces whatever was typed.
  useEffect(() => {
    if (item.settings.some((s) => s.id === setting)) setDraft('');
  }, [setting, item.settings]);
  if (!scalar) return null;
  const unit = scalar.unit ? ` ${scalar.unit}` : '';
  const n = draft.trim() === '' ? undefined : Number(draft);
  const invalid =
    draft.trim() !== '' && (n === undefined || parseFreeValue(item, freeValueSetting(n)) === undefined);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="micro">
        {item.settings.length ? 'Or enter a value' : 'Value'} ({scalar.min}–{scalar.max}
        {unit}, step {scalar.step})
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        aria-label={`${name} value`}
        aria-invalid={invalid || undefined}
        min={scalar.min}
        max={scalar.max}
        step={scalar.step}
        value={draft}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          const v = Number(text);
          const next = text.trim() !== '' && Number.isFinite(v) ? freeValueSetting(v) : '';
          onChange(next && parseFreeValue(item, next) !== undefined ? next : '');
        }}
        className="min-h-[54px] w-full border border-line bg-surface px-3.5 font-bold text-base text-ink"
      />
      {invalid && (
        <p role="alert" className="m-0 text-[13px] text-yellow">
          Enter a value from {scalar.min} to {scalar.max}
          {unit} in steps of {scalar.step}.
        </p>
      )}
    </div>
  );
}

/** "Disable X" next to an On/Off control just repeats the control. */
const isObviousToggle = (text: string): boolean =>
  /^(turn (on|off)|enable|disable|activate|deactivate)\b/i.test(text);

function ctaCopy(status: CatalogueStatus): string {
  return status.kind === 'codable' ? 'Apply to my car →' : status.label;
}

/**
 * "Restore original setting": offered only when this browser holds a backup of this feature made on the car
 * it is set up for. It asks first, then goes to Connect to put the saved setting back.
 */
function RestoreOriginal({ feature, status }: { feature: CatalogueFeature; status: CatalogueStatus }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const itemId = status.kind === 'codable' ? status.item.id : undefined;
  const ids = useMemo(
    () => [...new Set([...(itemId ? [itemId] : []), ...appFeatureIds(feature.slug)])],
    [itemId, feature.slug],
  );
  const backup = useRestorableBackup(ids);
  // Only the user's own car: a model they are just browsing has nothing of theirs to put back.
  if (!backup || status.kind === 'other-car') return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setConfirm(true)}>
        Restore original setting
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="restore the original setting?"
        confirmLabel="Restore original setting"
        onConfirm={() => void navigate({ to: '/connect', search: { backup: backup.id, action: 'restore' } })}
      >
        We'll put <strong className="text-ink">{feature.name}</strong> back to how it was before your last
        change. You'll need your adapter connected.
      </ConfirmDialog>
    </>
  );
}

/**
 * Everything the detail view says about one feature, in the spec's order. Shared by the mobile page and
 * the desktop panel; the caller supplies the photo/close chrome and where the CTA sits.
 */
export function DetailContent({
  feature,
  status,
  onSetUpCar,
  cta = 'inline',
  heading: Heading = 'h1',
}: {
  feature: CatalogueFeature;
  status: CatalogueStatus;
  onSetUpCar: () => void;
  cta?: 'inline' | 'sticky';
  /** h2 where the page already has its own h1 (the desktop panel beside the list). */
  heading?: 'h1' | 'h2';
}) {
  const item: CodableItem | undefined = status.kind === 'codable' ? status.item : undefined;
  const [setting, setSetting] = useState(() => (item ? defaultSetting(item) : ''));

  // A different feature starts from its own default.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the feature changes
  useEffect(() => {
    setSetting(item ? defaultSetting(item) : '');
  }, [feature.slug]);

  const functions =
    item && feature.functions.length === 1 && isObviousToggle(feature.functions[0] ?? '')
      ? []
      : feature.functions;
  const tier = status.kind === 'codable' ? status.tier : 'unavailable';
  const valid =
    !!item && (item.settings.some((s) => s.id === setting) || parseFreeValue(item, setting) !== undefined);

  const action = (() => {
    if (status.kind === 'codable') {
      if (!valid) return <Button disabled>Pick a setting</Button>;
      return (
        <Button asChild>
          <Link to="/connect" search={{ feature: status.item.id, setting }}>
            {ctaCopy(status)}
          </Link>
        </Button>
      );
    }
    if (status.kind === 'other-car') return <Button onClick={onSetUpCar}>Select this car →</Button>;
    return <Button disabled>{ctaCopy(status)}</Button>;
  })();

  return (
    <div className="flex flex-1 flex-col gap-[18px]">
      <div className="flex flex-col gap-3">
        <StatusBadge tier={tier}>{status.label}</StatusBadge>
        <Heading className="display m-0 text-[38px]">{displayTitle(feature.name)}</Heading>
        {feature.intro && (
          <p className="m-0 text-sm text-ink-2 leading-[1.55]">{displayCopy(feature.intro)}</p>
        )}
      </div>

      {item && (item.settings.length > 0 || item.scalar) && (
        <section className="flex flex-col gap-2.5">
          <h3 className="micro m-0">Choose a setting</h3>
          {item.settings.length > 0 && (
            <ChoiceGroup
              label={`${feature.name} setting`}
              variant="row"
              className="grid-cols-1"
              value={setting}
              onValueChange={setSetting}
              options={item.settings.map((s) => ({ value: s.id, label: s.label }))}
            />
          )}
          {item.scalar && (
            <ScalarInput item={item} setting={setting} onChange={setSetting} name={feature.name} />
          )}
        </section>
      )}

      {feature.attention.map((t) => (
        <AttentionCard key={t}>{displayCopy(t)}</AttentionCard>
      ))}
      <List label="What it does" items={functions} />
      <List label="You'll need" items={feature.requirements} />
      <List label="In the car" items={feature.procedure} ordered />
      <List label="Good to know" items={feature.notes} />

      {item && (
        <StatGrid
          stats={[
            { label: 'Time', value: '~1 min' },
            { label: 'Backup', value: 'Auto' },
            { label: 'Undo', value: '1 tap' },
          ]}
        />
      )}

      <p className="micro m-0">{GROUP_LABELS[feature.group].section}</p>
      {cta === 'inline' ? (
        <div className="mt-auto flex flex-col gap-3 pt-2">
          {action}
          <RestoreOriginal feature={feature} status={status} />
        </div>
      ) : (
        <div className="sticky bottom-0 -mx-5 mt-auto flex flex-col gap-3 bg-gradient-to-t from-bg via-bg to-transparent px-5 pt-6 pb-5">
          {action}
          <RestoreOriginal feature={feature} status={status} />
        </div>
      )}
    </div>
  );
}
