import type { FeatureItem } from '../../domain/catalog/types.ts';

/**
 * Settings default: "On" (the recipe's `enabled` choice) for a toggle, otherwise the first choice in the
 * recipe's own order — never the highest raw value, which on a multi-level setting is often an extreme.
 * A free-value scalar without presets has no default: the user types the value.
 */
export function defaultSetting(item: FeatureItem): string {
  const on = item.settings.find((s) => s.id === 'enabled') ?? item.settings.find((s) => s.label === 'On');
  return on?.id ?? item.settings[0]?.id ?? '';
}
