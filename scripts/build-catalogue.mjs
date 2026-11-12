#!/usr/bin/env node
/**
 * Builds the browsable feature catalogue for the 8 India models.
 *
 *   node scripts/build-catalogue.mjs [--from ../VAGCoder/docs/features] [--force]
 *
 * Inputs : <from>/<make>/<model>/features.json  and  <from>/img/*
 * Outputs: src/data/catalogue.json            (slim; cleaned at LOAD time, see domain/catalogue/normalize.ts)
 *          public/f/sm/<id>.webp  480×240     (list thumbnails)
 *          public/f/lg/<id>.webp  1024×512    (detail photos)
 *          public/f/hero/<make>-<model>.webp  (car hero images)
 *
 * The JSON is intentionally NOT cleaned here: the intro → Functions/Attention split is a runtime
 * concern with its own unit tests, and keeping the raw text means the rules can change without
 * re-running a data job. Images are re-encoded (never hot-linked) and skipped when already built.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const from = resolve(root, arg('--from') ?? '../VAGCoder/docs/features');
const force = process.argv.includes('--force');

/** The India line-up, in display order (spec §1). */
const MODELS = [
  ['skoda', 'kushaq'],
  ['skoda', 'slavia'],
  ['skoda', 'kylaq'],
  ['skoda', 'kodiaq'],
  ['skoda', 'superb'],
  ['volkswagen', 'taigun'],
  ['volkswagen', 'virtus'],
  ['volkswagen', 'tiguan'],
];
const HERO_EXT = { 'skoda-kushaq': 'webp', 'skoda-slavia': 'webp', 'skoda-kylaq': 'webp', 'skoda-kodiaq': 'webp', 'skoda-superb': 'webp', 'volkswagen-taigun': 'webp', 'volkswagen-virtus': 'png', 'volkswagen-tiguan': 'png' };

const FEATURE_KEYS = ['slug', 'name', 'group', 'category', 'intro', 'Functions', 'Requirements', 'Attention', 'In-Car procedure', 'Notes'];
const GROUPS = new Set(['exterior-lighting', 'windows-locks', 'dashboard', 'assistance', 'comfort', 'service']);

const out = (p) => resolve(root, p);
const ensure = (p) => mkdirSync(dirname(p), { recursive: true });
const fresh = (p) => !force && existsSync(p) && statSync(p).size > 0;

function encode(src, dst, resize) {
  if (fresh(dst)) return false;
  ensure(dst);
  execFileSync('cwebp', ['-quiet', '-q', '74', '-m', '6', '-resize', ...resize, src, '-o', dst]);
  return true;
}

const imageId = (ref) => ref.split('/').pop().replace(extname(ref), '');
let encoded = 0;
const seen = new Set();
const models = [];

for (const [make, model] of MODELS) {
  const data = JSON.parse(readFileSync(resolve(from, make, model, 'features.json'), 'utf8'));
  const features = data.features.map((f) => {
    if (!GROUPS.has(f.group)) throw new Error(`${make}/${model}/${f.slug}: unknown group ${f.group}`);
    const slim = Object.fromEntries(FEATURE_KEYS.map((k) => [k, f[k]]));
    if (f.image) {
      const id = imageId(f.image);
      const src = resolve(from, 'img', `${id}${extname(f.image)}`);
      if (!existsSync(src)) throw new Error(`${make}/${model}/${f.slug}: image missing: ${src}`);
      if (!seen.has(id)) {
        seen.add(id);
        encoded += encode(src, out(`public/f/sm/${id}.webp`), ['480', '240']) ? 1 : 0;
        encoded += encode(src, out(`public/f/lg/${id}.webp`), ['1024', '512']) ? 1 : 0;
      }
      slim.image = id;
    }
    return slim;
  });
  const key = `${make}-${model}`;
  const heroSrc = resolve(from, 'img', `hero-${key}.${HERO_EXT[key]}`);
  if (!existsSync(heroSrc)) throw new Error(`hero image missing: ${heroSrc}`);
  encoded += encode(heroSrc, out(`public/f/hero/${key}.webp`), ['960', '0']) ? 1 : 0;
  models.push({ make, model, title: data.title, features });
}

const dataset = { schema: 'obdcraft.catalogue/1', models };
writeFileSync(out('src/data/catalogue.json'), `${JSON.stringify(dataset)}\n`);
const total = models.reduce((n, m) => n + m.features.length, 0);
console.log(`catalogue.json: ${models.length} models, ${total} features, ${seen.size} unique photos (${encoded} files encoded this run)`);
