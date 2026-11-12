import type { BuildInfo } from '../domain/logs/contract.ts';

/**
 * What this build was made from, stamped by vite.config.ts: the commit (`<sha>` or `<sha>-dirty` when the
 * tree had uncommitted changes; `unknown` without git) and the package version. `buildId` (the content hash
 * of every input) stays the exact identity; these say which commit to look at.
 */
export const BUILD_INFO: BuildInfo = {
  gitSha: import.meta.env?.VITE_GIT_SHA ?? 'unknown',
  version: import.meta.env?.VITE_APP_VERSION ?? 'unknown',
};
