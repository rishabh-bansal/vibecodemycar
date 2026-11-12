import type { BackupRecord } from '../domain/backups/schema.ts';
import {
  type CodableItem,
  featureDisplayName,
  featureSettingLabel,
  isFreeValue,
  parseFreeValue,
  settingLabel,
} from '../domain/catalog/features.ts';
import { SCAN_TARGETS, scannableUnits } from '../domain/catalog/modules.ts';
import type { CarSelection, FeatureItem } from '../domain/catalog/types.ts';
import { canRecheck } from '../domain/coding/run.ts';
import type { CodingRequest } from '../domain/coding/types.ts';

export interface RequestSearch {
  feature?: string;
  setting?: string;
  backup?: string;
  action?: 'restore' | 'recheck';
  /** Read-only module inventory: `?inspect=09` scans that unit's identifier list. */
  inspect?: string;
}

/**
 * Turns the URL into the one request a session may run, or says why it can't.
 * Anything missing, unavailable or unknown yields `undefined` — never a guess.
 */
export function buildRequest(
  search: RequestSearch,
  ctx: { car: CarSelection; features: readonly FeatureItem[]; backups: readonly BackupRecord[] | undefined },
): CodingRequest | undefined {
  if (search.backup) {
    const backup = ctx.backups?.find((b) => b.id === search.backup);
    if (!backup || !search.action) return undefined;
    if (search.action === 'recheck' && !canRecheck(backup)) return undefined;
    return { kind: search.action, backup };
  }
  if (search.inspect) {
    if (search.inspect === 'all') {
      const first = scannableUnits()[0];
      const target = first ? SCAN_TARGETS[first] : undefined;
      if (!target) return undefined;
      return {
        kind: 'inspect',
        car: ctx.car,
        unit: 'all',
        module: target.module,
        label: 'car',
      };
    }
    const target = SCAN_TARGETS[search.inspect];
    if (!target || !scannableUnits().includes(search.inspect)) return undefined;
    return { kind: 'inspect', car: ctx.car, unit: search.inspect, ...target };
  }
  const feature: CodableItem | undefined = ctx.features.find((f) => f.id === search.feature);
  if (!feature || feature.tier === 'unavailable' || !search.setting) return undefined;
  // A free scalar value: `value:<n>`, inside the recipe's range and on its step grid.
  if (isFreeValue(search.setting)) {
    const n = parseFreeValue(feature, search.setting);
    return n === undefined ? undefined : { kind: 'apply', car: ctx.car, feature, settingId: `value:${n}` };
  }
  const setting = feature.settings.find((s) => s.id === search.setting);
  return setting ? { kind: 'apply', car: ctx.car, feature, settingId: setting.id } : undefined;
}

/** The feature's name in plain words: its friendly name from the app data when it has one. */
export function requestLabel(req: CodingRequest): string {
  if (req.kind === 'apply') return featureDisplayName(req.feature.id, req.feature.name);
  return req.kind === 'inspect'
    ? req.label
    : featureDisplayName(req.backup.featureId, req.backup.featureName);
}

/** The setting in plain words: the feature's friendly label for it when the app data has one. */
export function requestSettingLabel(req: CodingRequest): string | undefined {
  if (req.kind === 'apply')
    return featureSettingLabel(req.feature.id, req.settingId) ?? settingLabel(req.feature, req.settingId);
  if (req.kind === 'inspect') return undefined;
  return featureSettingLabel(req.backup.featureId, req.backup.settingId) ?? req.backup.settingLabel;
}
