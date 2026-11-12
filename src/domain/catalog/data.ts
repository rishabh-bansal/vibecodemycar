import raw from '../../data/app-data.json' with { type: 'json' };
import type { AppData } from './schema.ts';
import type { FeatureRecord, PlatformKey } from './types.ts';

/**
 * The bundled dataset. It is a build artefact of scripts/build-data.mjs and is
 * validated against AppDataSchema by data.contract.test.ts, so a plain cast is
 * safe here (the JSON import infers `string` where the schema has enums).
 */
export const APP_DATA = raw as unknown as AppData;

/**
 * Vehicle.platform ('MQB-A0-IN', 'MQB-37', 'MQB-B', 'PQ26', …) → its platform family, the key features use in
 * recipeByPlatform (re-exported as `platformFamily` by ./platform.ts).
 */
export function platformKeyOf(platform: string | null | undefined): PlatformKey | null {
  if (!platform) return null;
  if (platform.startsWith('MQB-A0')) return 'MQB-A0-IN';
  if (platform.startsWith('MQB')) return 'MQB';
  if (platform.startsWith('PQ')) return 'PQ';
  return null;
}

/**
 * The recipe a feature runs on a car of this platform: the per-platform entry, or the default recipe when the
 * platform is unknown. Null when the feature has no recipe for that platform (not codable there).
 */
export function recipeIdFor(feature: FeatureRecord, platform: string | null | undefined): string | null {
  const key = platformKeyOf(platform);
  if (!key) return feature.recipeId;
  return feature.recipeByPlatform[key] ?? null;
}
