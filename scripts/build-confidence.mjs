#!/usr/bin/env node
/**
 * Scores every app feature against the two live-verified writes (unit 09 blink count,
 * unit 17 speed chime). Reproducible: `node scripts/build-confidence.mjs`.
 *
 *   46  unit proven on-car (09 central electrics / 17 cluster)
 *   +5  password provenance live-proven (09: 31347, 17: 47115)
 *   +30 executable field path (direct field or variant carrying one)
 *   +5  bit positions verified against decompiled delegates
 *   -50 refuses: same-flag variants collide on different DIDs (ambiguous selector)
 *   -5  shares its DID container with sibling recipes
 *  100  the feature itself is live-verified
 *
 * A >= 80 · B 60-79 · C 40-59 · D < 40
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(root, 'src/data/app-data.json'), 'utf8'));
const recipes = JSON.parse(readFileSync(resolve(root, 'data/source/feature-recipes.json'), 'utf8')).recipes;

const LIVE_UNITS = new Set(['09', '17']);
const PROVEN_PW = { '09': '31347', '17': '47115' };
/** Field positions verified bit-exact against the decompiled CarScanner delegates. */
const DELEGATE_VERIFIED = new Set([
  'csmqb-lock-auto-unlock',
  'csmqb-lock-unlock-doors-variants',
  'csmqb-alarm-activate-anti-theft-alarm',
  'csmqb-turn-off-drlwhen-parking-brake-on',
  'csmqb-emergency-braking-lights-with-turn-signals',
  'csmqb-mirrors-funk-spiegelanklappen',
]);

const hasFieldPath = (r) =>
  r.kind === 'field' || (r.variants ?? []).some((v) => v.kind === 'field' && v.field && v.choices?.length);

const rows = [];
for (const f of Object.values(data.features)) {
  const recipe = f.recipeId ? (data.recipes[f.recipeId] ?? recipes[f.recipeId]) : undefined;
  const src = f.recipeId ? recipes[f.recipeId] : undefined;
  const unit = recipe?.unit ?? src?.unit ?? null;
  const evidence = [];
  let score = 0;

  if (f.liveProof?.length) {
    score = 100;
    evidence.push('VERIFIED ON-CAR');
  } else if (!recipe) {
    evidence.push('no corpus recipe');
  } else {
    if (LIVE_UNITS.has(unit)) {
      score += 46;
      evidence.push(`unit ${unit} live-proven`);
    } else if (unit) {
      score += 20;
      evidence.push(`unit ${unit} corpus-only`);
    }
    if (PROVEN_PW[unit] && (src?.password ?? recipe.password) === PROVEN_PW[unit]) score += 5;
    if (hasFieldPath(src ?? recipe)) {
      score += 30;
      evidence.push(recipe.kind === 'field' ? 'field write' : 'variant field');
    } else {
      evidence.push('no field path');
    }
    if (DELEGATE_VERIFIED.has(f.recipeId)) score += 5;
    // Ambiguous only when two variants carry the same selector AND the same generation flag —
    // differing requiresNewBcm splits normalize to new-bcm/old-bcm at build time and resolve.
    const seen = new Set();
    const colliding = (src?.variants ?? []).some((v) => {
      const k = `${v.selector}|${v.requiresNewBcm}`;
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    if (colliding) {
      score -= 50;
      evidence.push('refuses: ambiguous selector');
    }
  }
  const tier = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  rows.push({ id: f.id, name: f.name, unit, recipeId: f.recipeId ?? null, score, tier, evidence: evidence.join('; ') });
}
rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

writeFileSync(
  resolve(root, 'docs/research/2026-10-25/feature-confidence.json'),
  `${JSON.stringify({ schema: 'obdcraft.confidence/2', features: rows }, null, 1)}\n`,
);
const md = [
  '# Feature confidence ranking (scored vs the 2 live successes)',
  '',
  'A>=80 · B 60-79 · C 40-59 · D<40 — regenerate: `node scripts/build-confidence.mjs`',
  '',
  '|Tier|Score|Feature|Unit|Evidence|',
  '|---|---|---|---|---|',
  ...rows.map((r) => `|${r.tier}|${r.score}|${r.name}|${r.unit ?? '-'}|${r.evidence}|`),
  '',
].join('\n');
writeFileSync(resolve(root, 'docs/research/2026-10-25/FEATURE_CONFIDENCE.md'), md);
console.log(`${rows.length} features scored — A:${rows.filter((r) => r.tier === 'A').length} B:${rows.filter((r) => r.tier === 'B').length} C:${rows.filter((r) => r.tier === 'C').length} D:${rows.filter((r) => r.tier === 'D').length}`);
