#!/usr/bin/env node
/**
 * Verifies a public build carries no leftover research scaffolding.
 *
 *   node scripts/check-public-build.mjs [dist]
 *
 * The full feature catalogue — names, descriptions, photos — ships publicly (owner
 * decision: all features browseable with their original text). The raw
 * research-catalogue folder remains build-time only and must not ship.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? join(repo, 'dist'));

if (existsSync(join(root, 'research-catalogue')))
  throw Error('Research-only assets in public output: research-catalogue');

// Every catalogue feature has a photo, and both sizes of it ship as real WebP images: a missing file would be
// answered with the app's HTML (the SPA fallback) and show as an icon.
const catalogue = JSON.parse(readFileSync(join(repo, 'src/data/catalogue.json'), 'utf8'));
const missing = [];
let features = 0;
for (const model of catalogue.models)
  for (const feature of model.features) {
    features++;
    if (!feature.image) {
      missing.push(`${model.model}/${feature.slug}: no photo`);
      continue;
    }
    for (const size of ['sm', 'lg']) {
      const file = join(root, 'f', size, `${feature.image}.webp`);
      const head = existsSync(file) ? readFileSync(file).subarray(0, 12) : null;
      if (!head || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP')
        missing.push(`${model.model}/${feature.slug}: f/${size}/${feature.image}.webp`);
    }
  }
if (missing.length) throw Error(`Feature photos missing or not WebP (${missing.length}):\n${missing.slice(0, 20).join('\n')}`);
if (!statSync(join(root, 'index.html')).size) throw Error('index.html missing or empty');
console.log(`Public artifact boundary verified (full catalogue; all ${features} features have both photo sizes).`);
