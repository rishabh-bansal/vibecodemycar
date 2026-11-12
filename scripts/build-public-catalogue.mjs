#!/usr/bin/env node
/**
 * Derives the shippable catalogue from the research one.
 *
 *   node scripts/build-public-catalogue.mjs
 *
 * Input : src/data/catalogue.json         (full feature text and photo refs)
 * Output: src/data/catalogue-public.json  (identical feature content — kept for compatibility)
 *
 * The app reads catalogue.json directly; this file stays a faithful copy so any
 * external consumer gets the same feature descriptions and image references.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const research = JSON.parse(readFileSync(resolve(root, 'src/data/catalogue.json'), 'utf8'));

writeFileSync(resolve(root, 'src/data/catalogue-public.json'), `${JSON.stringify(research)}\n`);
const total = research.models.reduce((n, m) => n + m.features.length, 0);
console.log(`catalogue-public.json: ${research.models.length} models, ${total} features (full text)`);
