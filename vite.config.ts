import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig, type Plugin } from 'vitest/config';

const repo = fileURLToPath(new URL('.', import.meta.url));
const src = resolve(repo, 'src');
const dist = resolve(repo, 'dist');

/** Never part of a build: dependencies, output, VCS and OS noise. */
const NOT_SOURCE = new Set(['node_modules', 'dist', '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => !NOT_SOURCE.has(e.name) && !e.name.startsWith('._'))
    .flatMap((e) => (e.isDirectory() ? sourceFiles(resolve(dir, e.name)) : [resolve(dir, e.name)]));

/**
 * Identifies what a build was made from: every input that shapes the output, plus the VITE_* flags
 * it was built with. Recorded with every experiment, so it must change exactly when the build can.
 */
function buildIdFor(mode: string): string {
  const hash = createHash('sha256');
  const inputs = [
    ...['src', 'packages', 'public'].flatMap((d) => sourceFiles(resolve(repo, d))),
    ...[
      'index.html',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.base.json',
      'vite.config.ts',
    ].map((f) => resolve(repo, f)),
  ].sort();
  for (const path of inputs) {
    hash.update(relative(repo, path));
    hash.update(readFileSync(path));
  }
  const flags = loadEnv(mode, repo, 'VITE_');
  for (const key of Object.keys(flags).sort()) hash.update(`${key}=${flags[key]}`);
  return hash.digest('hex').slice(0, 20);
}

/**
 * The commit a build was made from: `git rev-parse --short HEAD`, with `-dirty` when the working tree had
 * uncommitted changes (the build then differs from that commit), or `unknown` without git. Recorded with every
 * log item next to `buildId` so a log can be traced to the code that produced it.
 */
function gitShaOf(): string {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
      .toString()
      .trim();
  let sha: string;
  try {
    sha = git('rev-parse', '--short', 'HEAD');
  } catch {
    return 'unknown';
  }
  if (!sha) return 'unknown';
  try {
    return git('status', '--porcelain') ? `${sha}-dirty` : sha;
  } catch {
    // The SHA is known; whether the tree was clean is not.
    return `${sha}-dirty?`;
  }
}

const appVersion = (): string => {
  try {
    return String(JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8')).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
};

/**
 * Keeps research-only assets out of public builds. Car photos (`cars/`, `f/hero/`) are the owner's
 * own pictures and ship unless VITE_CAR_IMAGES=0 (owner decision D4, docs/reviews/2026-10-25/FIXES.md).
 * Feature photos (`f/sm`, `f/lg`) and the research catalogue only ship with VITE_RESEARCH_CATALOGUE=1:
 * the public catalogue never references them.
 *
 * Flags come from `config.env` — the same values (process env and .env files) the app reads through
 * import.meta.env — so a flag set in .env.local means the same thing to the app and to this step.
 */
const stripResearchAssets = (): Plugin => {
  let out = dist;
  let env: Record<string, string> = {};
  return {
    name: 'obdcraft:strip-research-assets',
    apply: 'build',
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
      env = config.env;
    },
    closeBundle() {
      if (env.VITE_RESEARCH_CATALOGUE !== '1') {
        rmSync(`${out}/research-catalogue`, { recursive: true, force: true });
      }
      if (env.VITE_CAR_IMAGES === '0') {
        for (const dir of ['cars', 'f/hero']) rmSync(`${out}/${dir}`, { recursive: true, force: true });
      }
      if (existsSync(`${out}/f`) && readdirSync(`${out}/f`).length === 0)
        rmSync(`${out}/f`, { recursive: true });
    },
  };
};

export default defineConfig(({ mode }) => ({
  define: {
    'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildIdFor(mode)),
    'import.meta.env.VITE_GIT_SHA': JSON.stringify(gitShaOf()),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()),
  },
  plugins: [react(), tailwindcss(), stripResearchAssets()],
  resolve: { alias: { '@': src } },
  // assetsInlineLimit 0: no data: URIs, so the CSP can stay `font-src 'self'`.
  build: { target: 'es2023', outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  test: {
    // Tests never reach the private log Worker: no endpoint (so nothing enrolls or uploads), and every
    // project's setup replaces `fetch` with one that refuses anything but localhost.
    env: { VITE_LOG_ENDPOINT: '' },
    projects: [
      {
        // Pure logic: domain rules, transport/ISO-TP packages, the simulator.
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/*/test/**/*.test.ts',
            'workers/*/test/**/*.test.ts',
            'src/{domain,infra,config}/**/*.test.ts',
          ],
          exclude: ['src/infra/storage/**'],
          setupFiles: ['./src/test/setup-network.ts'],
        },
      },
      {
        // Browser-facing code: components, screens, IndexedDB-backed storage.
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/{ui,screens,app,state}/**/*.test.{ts,tsx}', 'src/infra/storage/**/*.test.ts'],
          setupFiles: ['./src/test/setup-network.ts', './src/test/setup-dom.ts'],
        },
      },
    ],
  },
}));
