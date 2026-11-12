/**
 * Side-effect module: imported first by main.tsx, so the old-name storage keys are moved before any store
 * module loads (ES modules run in import order).
 */
import { migrateLegacyKeys } from '../../domain/storage-keys.ts';

migrateLegacyKeys();
