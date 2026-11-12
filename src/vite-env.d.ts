/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  /** `git rev-parse --short HEAD`, `-dirty` when the tree had changes (`-dirty?` when that could not be checked); `unknown` without git (vite.config.ts). */
  readonly VITE_GIT_SHA?: string;
  /** package.json `version`. */
  readonly VITE_APP_VERSION?: string;
  readonly VITE_LOG_ENDPOINT?: string;
  readonly VITE_RESEARCH_CATALOGUE?: '0' | '1';
  readonly VITE_CAR_IMAGES?: '0' | '1';
  readonly VITE_ADAPTER_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
