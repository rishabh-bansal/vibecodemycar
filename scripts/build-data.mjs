#!/usr/bin/env node
/**
 * Distils the full generated datasets in data/source/ into the slim runtime
 * file the app bundles (src/data/app-data.json).
 *
 *   node scripts/build-data.mjs            write src/data/app-data.json and print stats + assertion report
 *   node scripts/build-data.mjs --check    CI: fail if the committed file differs from what the sources generate
 *   node scripts/build-data.mjs --verbose  also list every informational assertion (value/optValue differences)
 *   node scripts/build-data.mjs --strict   exit non-zero when a catalogue map points at a missing recipe or the
 *                                          feature copy has gaps (codable feature without copy, unlabelled setting)
 *
 * Inputs:
 *   data/source/feature-recipes.json          the extracted recipe corpus
 *   data/source/overlays/*.json               hand-authored fixes: { recipes, steps, newRecipes, notes }
 *   data/source/catalogue-map/*.json          catalogue slug -> recipe (single or per platform)
 *   data/source/feature-matrix.json           vehicles + the 59 legacy matrix features (kept for old backups)
 *   src/data/catalogue.json                   the 194-slug model catalogue the app shows
 *   data/source/legacy/*.json                 earlier shipped recipe definitions (stored backups carry their digests)
 *   data/source/feature-copy.json             consumer copy per feature: { displayName, description, settingLabels }
 *
 * Why a build step: the source recipe bank carries provenance (file paths into the research repo, extraction
 * notes) that must not ship to browsers. The runtime only needs vehicles, features and the recipes they map to.
 *
 * The output is deterministic (stable key order, no timestamps of its own) so a re-run on unchanged sources
 * produces a byte-identical file. Overlay and catalogue-map files merge in alphabetical file order.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const VERBOSE = args.has('--verbose');
const STRICT = args.has('--strict');

const warnings = [];
const warn = (msg) => warnings.push(msg);

const matrix = read('data/source/feature-matrix.json');
const recipeFile = read('data/source/feature-recipes.json');
const legacyCatalogue = read('packages/coding/data/catalogue.json');
const modelCatalogue = read('src/data/catalogue.json');

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] != null).map((k) => [k, obj[k]]));
const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
const clone = (v) => structuredClone(v);

/** Every *.json in a source folder, alphabetically. A file that does not parse (mid-write) is skipped with a warning. */
function loadDir(rel) {
  const dir = resolve(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      try {
        return [{ file: `${rel}/${f}`, json: JSON.parse(readFileSync(resolve(dir, f), 'utf8')) }];
      } catch (e) {
        warn(`${rel}/${f}: not valid JSON, skipped (${e.message})`);
        return [];
      }
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Overlays: newRecipes first (all files), then recipe patches, then step patches — each in file order. A key set
// for the same id by two files is an override: the later file wins and a warning names both.

const recipes = clone(recipeFile.recipes);
const overlays = loadDir('data/source/overlays');
const touched = new Map(); // `${section}:${id}:${key}` -> file

function noteTouch(section, id, key, file) {
  const k = `${section}:${id}:${key}`;
  const prev = touched.get(k);
  if (prev && prev !== file) warn(`overlay override: ${section} ${id}.${key} from ${prev} replaced by ${file}`);
  touched.set(k, file);
}

/** Replace keys; a null value removes the key. */
function applyPatch(target, patch, section, id, file) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id') continue;
    noteTouch(section, id, k, file);
    if (v === null) delete target[k];
    else target[k] = clone(v);
  }
}

const corpusIds = new Set(Object.keys(recipes));
for (const { file, json } of overlays) {
  for (const [id, rec] of Object.entries(json.newRecipes ?? {})) {
    if (corpusIds.has(id)) warn(`overlay ${file}: newRecipes.${id} replaces the corpus recipe of that id`);
    noteTouch('newRecipes', id, '*', file);
    recipes[id] = { ...clone(rec), id };
  }
}

/** stepId -> every step object with that id (a step id can recur across groups). */
function indexSteps() {
  const index = new Map();
  for (const r of Object.values(recipes)) {
    for (const s of r.steps ?? []) {
      if (!s?.id) continue;
      if (!index.has(s.id)) index.set(s.id, []);
      index.get(s.id).push(s);
    }
  }
  return index;
}

let stepIndex = indexSteps();
for (const { file, json } of overlays) {
  for (const [id, patch] of Object.entries(json.recipes ?? {})) {
    if (recipes[id]) applyPatch(recipes[id], patch, 'recipes', id, file);
    else if (stepIndex.has(id)) {
      warn(`overlay ${file}: recipes.${id} is a step id — applied as a step patch`);
      for (const s of stepIndex.get(id)) applyPatch(s, patch, 'steps', id, file);
    } else warn(`overlay ${file}: recipes.${id} matches no recipe — ignored`);
  }
}
stepIndex = indexSteps(); // recipe patches may have replaced whole `steps` arrays
for (const { file, json } of overlays) {
  for (const [id, patch] of Object.entries(json.steps ?? {})) {
    const targets = stepIndex.get(id);
    if (targets) for (const s of targets) applyPatch(s, patch, 'steps', id, file);
    else if (recipes[id]) {
      warn(`overlay ${file}: steps.${id} is a recipe id — applied as a recipe patch`);
      applyPatch(recipes[id], patch, 'recipes', id, file);
    } else warn(`overlay ${file}: steps.${id} matches no step — ignored`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Slim recipes: exactly the keys the runtime needs, per the data contract.

/** Unit-default security-access codes, used when a recipe carries none (passwordSource 'unit-default'). */
const UNIT_PASSWORDS = {
  '09': '31347', 17: '47115', '5F': '20103', B7: '20103', '03': '20103', 13: '20103', A5: '20103',
  44: '19249', '6D': '12345', '01': '27971', 10: '71679', 18: '80782',
};
const DEFAULT_PASSWORD = '20103';

function passwordOf(unit, own, inherited) {
  const p = own ?? inherited;
  if (p != null && p !== '') return { password: String(p), passwordSource: 'recipe' };
  if (!unit) return { password: null };
  return { password: UNIT_PASSWORDS[String(unit).toUpperCase()] ?? DEFAULT_PASSWORD, passwordSource: 'unit-default' };
}

const hexUpper = (s) => (typeof s === 'string' ? s.toUpperCase() : s);
const FIELD_KEYS = ['byteOffset', 'bitOffset', 'bitLength', 'byteOrder'];
const SCALAR_KEYS = ['byteOffset', 'dataLength', 'multiplier', 'offset', 'signed', 'reverseOrder', 'min', 'max', 'unit'];
const AUX_KEYS = ['byteOffset', 'bitOffset', 'bitLength', 'value'];

/** Accepts a BitOp or an AuxWrite-shaped object; returns a BitOp. */
const bitOp = (o) =>
  'byte' in o
    ? { byte: o.byte, bit: o.bit ?? 0, len: o.len ?? 1, value: o.value, ...(o.fill ? { fill: true } : {}) }
    : { byte: o.byteOffset, bit: o.bitOffset ?? 0, len: o.bitLength ?? 1, value: o.value };

/** Shape the source entry actually encodes (the corpus's `kind` is the extractor's guess; raw blocks become ops). */
function kindOf(e, allowGroup) {
  if (allowGroup && (e.kind === 'group' || e.steps?.length)) return 'group';
  if (e.variants?.length) return 'alt';
  if (e.kind === 'dataset') return 'dataset';
  if (e.kind === 'ops') return 'ops';
  if (e.kind === 'scalar' || (e.scalar && !e.field)) return 'scalar';
  if (e.field && e.kind !== 'block') return 'field';
  if (e.choices?.some((c) => Array.isArray(c.ops))) return 'ops';
  return 'ops'; // raw block: bytes only once an overlay supplies per-choice ops
}

/** Writes the kind's encoding keys onto `out`; returns whether the encoding carries any bytes to write. */
function encode(out, e, kind) {
  const choiceAux = e.choiceAux ?? {};
  switch (kind) {
    case 'field': {
      out.field = { ...pick(e.field ?? {}, FIELD_KEYS), byteOrder: e.field?.byteOrder ?? 'big' };
      out.choices = (e.choices ?? []).map((c) => {
        const aux = c.aux ?? choiceAux[c.id];
        const ch = pick(c, ['id', 'label', 'value']);
        if (aux?.length) ch.aux = aux.map(bitOp);
        return ch;
      });
      if (e.auxWrites?.length) out.auxWrites = e.auxWrites.map((a) => pick(a, AUX_KEYS));
      Object.assign(out, pick(e, ['sequence']));
      return !!e.field && out.choices.length > 0;
    }
    case 'scalar': {
      out.scalar = pick(e.scalar ?? {}, SCALAR_KEYS);
      if (e.choices?.length) out.choices = e.choices.map((c) => pick(c, ['id', 'label', 'value']));
      Object.assign(out, pick(e, ['checksum', 'readBytes', 'sequence']));
      return e.scalar != null;
    }
    case 'ops': {
      out.choices = (e.choices ?? []).map((c) => {
        const ch = pick(c, ['id', 'label']);
        ch.ops = (c.ops ?? []).map(bitOp);
        const aux = c.aux ?? choiceAux[c.id];
        if (aux?.length) ch.ops.push(...aux.map(bitOp));
        if (c.when) ch.when = pick(c.when, ['mib3', 'bytes']);
        return ch;
      });
      Object.assign(out, pick(e, ['sequence']));
      return out.choices.some((c) => c.ops.length > 0);
    }
    case 'dataset': {
      out.choices = (e.choices ?? []).map((c) => {
        const ch = pick(c, ['id', 'label', 'value', 'payload']);
        if (ch.payload) ch.payload = hexUpper(ch.payload);
        return ch;
      });
      Object.assign(out, pick(e, ['sequence', 'checksum', 'readBytes']));
      return out.choices.some((c) => c.payload);
    }
    default:
      throw new Error(`encode: unexpected kind ${kind}`);
  }
}

function finish(out, e, hasBytes) {
  if (e.toggle != null) out.toggle = e.toggle;
  if (e.stateBits?.length) out.stateBits = e.stateBits;
  if (!hasBytes) {
    out.executable = false;
    out.reason = 'no-bytes';
  }
  return out;
}

/** BCM-generation selectors carry their generation in the name; the extractor's flag is wrong on `new-bcm`. */
function requiresNewBcmOf(v) {
  if (v.selector === 'new-bcm') return true;
  if (v.selector === 'old-bcm') return false;
  return typeof v.requiresNewBcm === 'boolean' ? v.requiresNewBcm : undefined;
}

function slimVariant(v, parent) {
  const kind = kindOf(v, false);
  const out = { selector: v.selector };
  const rnb = requiresNewBcmOf(v);
  if (rnb !== undefined) out.requiresNewBcm = rnb;
  if (v.devicePattern) out.devicePattern = v.devicePattern;
  out.did = hexUpper(v.did ?? parent.did);
  Object.assign(out, passwordOf(parent.unit, v.password, parent.password));
  out.kind = kind === 'alt' ? 'ops' : kind; // nested alternatives are not part of the contract
  return { out: finish(out, v, encode(out, v, out.kind)), hasBytes: out.executable !== false };
}

const ID_SUFFIX = (i) => `#${i + 1}`;

/** Group-level choices: the overlay's own list, else the intersection of multi-choice steps (else their union). */
function groupChoices(e, steps) {
  if (e.choices?.length) return e.choices.map((c) => pick(c, ['id', 'label']));
  const sets = steps
    .map((s) => (s.kind === 'alt' ? (s.variants.find((v) => v.choices?.length)?.choices ?? []) : (s.choices ?? [])))
    .filter((cs) => cs.length > 0);
  const multi = sets.filter((cs) => cs.length > 1);
  const labels = new Map();
  for (const cs of sets) for (const c of cs) if (!labels.has(c.id)) labels.set(c.id, c.label);
  let ids;
  if (multi.length) {
    ids = multi[0].map((c) => c.id).filter((id) => multi.every((cs) => cs.some((c) => c.id === id)));
  } else ids = [...labels.keys()];
  return ids.map((id) => ({ id, label: labels.get(id) }));
}

/** Contract: per group choice, every step has that choice id or exactly one choice (applied for all but off). */
const groupIssues = [];
function checkGroup(r) {
  for (const gc of r.choices) {
    for (const s of r.steps) {
      const variants = s.kind === 'alt' ? s.variants : [s];
      for (const v of variants) {
        const cs = v.choices ?? [];
        if (v.kind === 'scalar' && !cs.length) continue; // free value, no choice set
        if (cs.length === 0 || cs.length === 1 || cs.some((c) => c.id === gc.id)) continue;
        groupIssues.push(`${r.id}: choice '${gc.id}' missing from step ${s.id}${s.kind === 'alt' ? ` (${v.selector})` : ''}`);
      }
    }
  }
}

function slimRecipe(e, { asStep = false, parent = null, index = 0 } = {}) {
  const kind = kindOf(e, !asStep);
  const id = e.id ?? (parent ? `${parent.id}${ID_SUFFIX(index)}` : undefined);
  const out = { id, name: e.name ?? parent?.name ?? id, kind };
  Object.assign(out, pick(e, ['category', 'domain']));

  if (kind === 'group') {
    const ordered = (e.steps ?? [])
      .map((s, i) => ({ s, i, part: s.groupedWith?.part ?? i + 1 }))
      .sort((a, b) => a.part - b.part || a.i - b.i);
    out.unit = null;
    out.requestId = null;
    out.responseId = null;
    out.password = null;
    out.steps = ordered.map(({ s, i }) => slimRecipe(s, { asStep: true, parent: e, index: i }));
    out.choices = groupChoices(e, out.steps);
    checkGroup(out);
    return finish(out, {}, out.steps.length > 0 && out.steps.every((s) => s.executable !== false));
  }

  out.unit = e.unit ?? null;
  out.requestId = e.requestId ?? null;
  out.responseId = e.responseId ?? null;
  Object.assign(out, passwordOf(out.unit, e.password, null));
  if (kind === 'alt') {
    if (e.did) out.did = hexUpper(e.did);
    const vs = e.variants.map((v) => slimVariant(v, e));
    out.variants = vs.map((v) => v.out);
    return finish(out, e, vs.some((v) => v.hasBytes));
  }
  if (e.did) out.did = hexUpper(e.did);
  return finish(out, e, encode(out, e, kind));
}

// ---------------------------------------------------------------------------------------------------------------
// Assertion report: choices whose `value` and vendor `optValue` disagree (report only, never a failure).

const choiceReport = { invertedToggle: [], outOfRange: [], mismatch: [] };
function auditChoices(e, path) {
  const width = e.field?.bitLength;
  for (const c of e.choices ?? []) {
    if (typeof c.value === 'number' && width && width < 32 && c.value >= 2 ** width) {
      choiceReport.outOfRange.push(`${path} ${c.id}: value ${c.value} does not fit ${width}-bit field`);
    }
    if (c.optValue == null || typeof c.value !== 'number') continue;
    const hex = Number.parseInt(String(c.optValue), 16);
    const dec = Number.parseInt(String(c.optValue), 10);
    if (hex === c.value || dec === c.value) continue;
    const toggleInverted =
      (c.id === 'enabled' && hex === 1 && c.value === 0) || (c.id === 'disabled' && hex === 0 && c.value === 1);
    const line = `${path} ${c.id}: value=${c.value} optValue=${c.optValue}`;
    if (toggleInverted) choiceReport.invertedToggle.push(line);
    else choiceReport.mismatch.push(line);
  }
  for (const v of e.variants ?? []) auditChoices(v, `${path}#${v.selector}`);
  for (const s of e.steps ?? []) auditChoices(s, `${path}>${s.id}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Features.

const PLATFORMS = ['MQB', 'MQB-A0-IN', 'PQ'];

/**
 * Catalogue slug -> legacy matrix feature id: hand-checked joins (snapshot of the catalogue screen's alias table
 * at the time slugs became feature ids). A slug without a catalogue-map entry inherits the aliased feature's
 * recipe, and its live proof travels with it when both point at the same recipe.
 */
const LEGACY_ALIASES = {
  'gauge-test-needle-sweep': 'instrument-cluster-needle-sweep',
  'comfort-turn-signals': 'comfort-lane-change-indicator-5-flashes',
  'speed-warning-for-india': '80kmph-and-120kmph-speed-chime-warning',
  'seat-belt-warning': 'seat-belt-warning-disable',
  'auto-folding-mirrors': 'auto-fold-orvms-on-long-press-of-lock-button',
  'lock-unlock-acoustic-confirmation': 'acoustic-confirmation-lock-unlock-sound',
  'anti-theft-alarm-system': 'anti-theft-alarm',
  'cornering-lights': 'cornering-lights-via-front-fog-lights',
  'drl-off-with-handbrake': 'turning-off-drl-using-hedlamp-control-switch-or-handbrake',
  'teardrop-wiping': 'tear-drop-wiping',
  'pulsation-of-start-button': 'engine-start-stop-button-pulsation',
  'hill-hold-assist': 'hill-hold-control',
  'emergency-braking-lights': 'emergency-stop-signal-flashing-panic-braking-lights',
  'oil-temperature-display': 'engine-oil-temperature-in-mid',
  'multimedia-startup-logo': 'change-startup-logo-of-infotainment-screen',
  'offroad-information-screen': 'display-offroad-menu-on-infotainment',
  'easy-entry': 'easy-convenient-entry-and-exit-for-driver-seat',
  'easy-entry-for-passenger': 'easy-convenient-entry-and-exit-for-driver-and-passenger-seats',
  'auto-unlock-with-ignition': 'disable-automatic-door-unlock-on-key-removal',
  'central-lock-with-ignition': 'turn-onoff-central-locking-using-remote-key-when-engine-ignition-on',
  'turn-signals-with-brake-lights': 'blink-tail-lamp-with-indicator',
  'fog-lights-with-high-beam': 'front-fog-lights-on-flash-along-with-headlights',
  'brake-lights-when-trunk-open': 'auto-turn-on-brake-light-when-boot-is-opened',
  'drl-settings-in-multimedia': 'drl-onoff-control-in-infotainment-settings',
  'fan-level-display-when-auto': 'display-automatic-climate-control-fan-blower-speed-in-ac-auto-mode',
  'headlight-notification': 'disable-please-switch-on-the-lights-popup',
  'refuel-quantity-in-dashboard': 'display-refuel-quantity-in-mid',
  'scandinavian-drls': 'scandinavian-rear-drl',
  'speedometer-scale-range': 'top-speed-display-on-speedometer-as-280kmph',
  'engine-speed-rpm-in-dashboard': 'display-of-rpm-bar-tachometer-in-virtual-cockpit',
  'interior-light-fading': 'interior-light-fadein-fade-out-function-theatre-dimming-effect',
  'throttle-pedal-response': 'enhanced-throttle-response',
  'increased-engine-responsiveness': 'enhanced-throttle-response',
  'air-recirculation-memory': 'ac-recirculation-memory',
  'steering-angle-display': 'display-wheel-angle-on-mid',
};

const shipped = {};
const unresolvedRefs = [];
/** Slims (once) and ships a referenced recipe; returns its id, or null when it does not exist. */
function ship(recipeId, who) {
  if (!recipeId) return null;
  if (shipped[recipeId]) return recipeId;
  const src = recipes[recipeId];
  if (!src) {
    unresolvedRefs.push(`${who} -> ${recipeId}`);
    return null;
  }
  auditChoices(src, recipeId);
  shipped[recipeId] = slimRecipe({ ...src, id: recipeId });
  return recipeId;
}

const allPlatforms = (id) => (id ? Object.fromEntries(PLATFORMS.map((p) => [p, id])) : {});

const features = {};
const legacyById = new Map(legacyCatalogue.features.map((f) => [f.id, f]));
for (const f of Object.values(matrix.features)) {
  const meta = legacyById.get(f.id);
  if (!meta) throw new Error(`feature ${f.id} is in the matrix but not in the catalogue`);
  const recipeId = ship(f.implementation?.candidateId ?? null, `matrix feature ${f.id}`);
  features[f.id] = {
    id: f.id,
    name: meta.name,
    category: meta.category,
    source: 'matrix',
    listedOn: [...f.listedOn].sort(),
    recipeId,
    recipeByPlatform: allPlatforms(recipeId),
    matchConfidence: f.implementation?.matchConfidence ?? null,
    liveProof: (f.liveProof ?? []).map((p) => ({
      vehicle: p.vehicle,
      module: pick(p.module, ['request', 'response', 'part', 'odx']),
      recipe: pick(p.recipe, ['did', 'byte', 'from', 'to']),
      readback: p.readback,
    })),
    refusals: (f.refusals ?? []).map((r) => ({ vehicle: r.vehicle, module: r.module, reason: r.reason })),
  };
}

// Catalogue map: later files override earlier ones per slug.
const catalogueMap = {};
const mapFiles = loadDir('data/source/catalogue-map');
for (const { file, json } of mapFiles) {
  for (const [slug, entry] of Object.entries(json)) {
    if (catalogueMap[slug]) warn(`catalogue-map override: ${slug} from ${catalogueMap[slug].file} replaced by ${file}`);
    catalogueMap[slug] = { ...entry, file };
  }
}

// Slug -> name, group and the builds of every vehicle whose model lists it. A model with no build list of its own
// (Kodiaq, Superb, Tiguan) is listed by its model id (`skoda-superb`), so its catalogue still reaches the app: the
// runtime offers a feature listed on any model of a platform family on every model of that family
// (src/domain/catalog/platform.ts).
const buildsOfModel = (make, model) => {
  const builds = matrix.vehicles
    .filter((v) => v.brand === make && v.model === model)
    .flatMap((v) => v.codemyvagBuilds ?? []);
  return builds.length ? builds : [`${make}-${model}`];
};
const slugInfo = new Map();
for (const m of modelCatalogue.models) {
  for (const cf of m.features) {
    if (!slugInfo.has(cf.slug)) slugInfo.set(cf.slug, { name: cf.name, group: cf.group, builds: new Set() });
    const info = slugInfo.get(cf.slug);
    for (const b of buildsOfModel(m.make, m.model)) info.builds.add(b);
  }
}
for (const slug of Object.keys(catalogueMap)) {
  if (!slugInfo.has(slug)) {
    warn(`catalogue-map ${catalogueMap[slug].file}: ${slug} is not a catalogue slug — shipped with no listing`);
    slugInfo.set(slug, { name: slug, group: 'other', builds: new Set() });
  }
}

/** Every choice id a recipe can be asked for (group-level, top-level, or any variant). */
function choiceIdsOf(r) {
  const ids = new Set((r.choices ?? []).map((c) => c.id));
  for (const v of r.variants ?? []) for (const c of v.choices ?? []) ids.add(c.id);
  return ids;
}
const settingIssues = [];

let mappedSlugs = 0;
let aliasedSlugs = 0;
for (const [slug, info] of [...slugInfo].sort(([a], [b]) => a.localeCompare(b))) {
  if (features[slug]) throw new Error(`catalogue slug ${slug} collides with a matrix feature id`);
  const entry = catalogueMap[slug];
  const aliasOf = LEGACY_ALIASES[slug];
  const legacy = aliasOf ? features[aliasOf] : undefined;
  let recipeByPlatform = {};
  let recipeId = null;
  let matchConfidence = null;
  if (entry) {
    if (entry.recipe) {
      recipeId = ship(entry.recipe, `catalogue ${slug}`);
      recipeByPlatform = allPlatforms(recipeId);
    } else if (entry.byPlatform) {
      for (const [p, id] of Object.entries(entry.byPlatform).sort(([a], [b]) => a.localeCompare(b))) {
        const ok = ship(id, `catalogue ${slug} [${p}]`);
        if (ok) recipeByPlatform[p] = ok;
      }
      recipeId = recipeByPlatform['MQB-A0-IN'] ?? Object.values(recipeByPlatform)[0] ?? null;
    } else warn(`catalogue-map ${entry.file}: ${slug} has neither recipe nor byPlatform`);
    if (recipeId) {
      matchConfidence = 'catalogue-map';
      mappedSlugs++;
    }
  } else if (legacy?.recipeId) {
    recipeId = legacy.recipeId;
    recipeByPlatform = allPlatforms(recipeId);
    matchConfidence = 'alias';
    aliasedSlugs++;
  }

  const feature = {
    id: slug,
    name: info.name,
    category: info.group,
    source: 'catalogue',
    listedOn: [...info.builds].sort(),
    recipeId,
    recipeByPlatform,
    matchConfidence,
    // Proof is about a recipe on a car: it only carries over when the slug runs the same recipe.
    liveProof: legacy && legacy.recipeId && legacy.recipeId === recipeId ? clone(legacy.liveProof) : [],
    refusals: legacy && legacy.recipeId && legacy.recipeId === recipeId ? clone(legacy.refusals) : [],
  };
  if (aliasOf) feature.aliasOf = aliasOf;
  if (entry?.settings && recipeId) {
    feature.settings = Object.entries(entry.settings).map(([label, id]) => ({ id, label }));
    for (const r of new Set(Object.values(recipeByPlatform))) {
      const ids = choiceIdsOf(shipped[r]);
      const scalar = shipped[r].kind === 'scalar' || shipped[r].variants?.some((v) => v.kind === 'scalar');
      for (const s of feature.settings) {
        if (!ids.has(s.id) && !(scalar && s.id.startsWith('value:'))) {
          settingIssues.push(`${slug}: setting '${s.label}' -> '${s.id}' is not a choice of ${r}`);
        }
      }
    }
  }
  features[slug] = feature;
}

// ---------------------------------------------------------------------------------------------------------------
// Consumer copy: a display name, a one-to-two sentence description and a label per setting id. The copy's labels
// also relabel the feature's display settings, so every screen reads the same words.

const featureCopy = read('data/source/feature-copy.json');
const copyIssues = [];
const COPY_KEYS = ['displayName', 'description', 'settingLabels'];
/** Setting ids a feature offers: its display settings, else every choice of every recipe it runs. */
function offeredIds(f) {
  if (f.settings) return new Set(f.settings.map((s) => s.id));
  const ids = new Set();
  for (const r of new Set(Object.values(f.recipeByPlatform))) for (const id of choiceIdsOf(shipped[r])) ids.add(id);
  return ids;
}
const isCodable = (f) => Object.values(f.recipeByPlatform).some((r) => shipped[r]?.executable !== false);
for (const [id, entry] of Object.entries(featureCopy)) {
  const f = features[id];
  if (!f) {
    copyIssues.push(`${id}: copy for a feature that does not exist`);
    continue;
  }
  const extra = Object.keys(entry).filter((k) => !COPY_KEYS.includes(k));
  if (extra.length) copyIssues.push(`${id}: unknown copy keys ${extra.join(', ')}`);
  if (!entry.displayName?.trim() || !entry.description?.trim()) copyIssues.push(`${id}: empty displayName or description`);
  const labels = entry.settingLabels ?? {};
  const offered = offeredIds(f);
  for (const s of Object.keys(labels)) if (!offered.has(s)) copyIssues.push(`${id}: label for '${s}', which it does not offer`);
  for (const s of offered) if (!labels[s]) copyIssues.push(`${id}: no label for setting '${s}'`);
  const { id: _id, name, ...rest } = f;
  features[id] = {
    id,
    name,
    displayName: entry.displayName,
    description: entry.description,
    settingLabels: Object.fromEntries(Object.entries(labels).filter(([s]) => offered.has(s))),
    ...rest,
  };
  if (rest.settings) features[id].settings = rest.settings.map((s) => ({ id: s.id, label: labels[s.id] ?? s.label }));
}
for (const f of Object.values(features)) if (isCodable(f) && !featureCopy[f.id]) copyIssues.push(`${f.id}: codable but has no copy`);

// ---------------------------------------------------------------------------------------------------------------
// Legacy digests: a stored backup records the SHA-256 of the recipe definition it was made with, and a restore
// refuses when that changed. An earlier definition that writes exactly the same bytes (only labels, provenance
// flags, the password backfill or an empty `auxWrites` changed) is listed so its backups still restore.

/** Must match `recipeDigest` in src/domain/coding/plan.ts (canonical key order, undefined and ignored keys out). */
const DIGEST_IGNORED = new Set(['passwordSource', 'legacyDigests']);
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined && !DIGEST_IGNORED.has(k))
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const digestOf = (r) => createHash('sha256').update(JSON.stringify(canonical(r))).digest('hex');

/** How a variant is chosen — mirrors `variantRule` in src/domain/coding/variant-select.ts (selector spellings vary). */
function variantRuleOf(v) {
  if (v.devicePattern) return `device:${v.devicePattern}`;
  const sel = v.selector;
  if (/new-bcm/i.test(sel)) return 'unit09:new';
  if (/old-bcm/i.test(sel)) return 'unit09:old';
  if (/unit0?9|(?:^|-)(?:new|old)-bcm$/i.test(sel)) return `unit09:${v.requiresNewBcm === true ? 'new' : 'old'}`;
  if (/mib\s*-?(?:3|25|2\.5)/i.test(sel))
    return `mib:${/mib\s*-?3(?!\d)/i.test(sel) && !/mib\s*-?25/i.test(sel) ? '3' : '25'}`;
  return 'did';
}

/** What a definition writes: module, DID, encoding, choice ids and values. Labels, passwords and flags are out. */
function writeSignature(r) {
  if (!r || typeof r !== 'object') return r;
  const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : undefined);
  const choice = (c) => ({
    id: c.id,
    value: c.value,
    payload: c.payload?.toUpperCase(),
    ops: nonEmpty(c.ops),
    aux: nonEmpty(c.aux),
    when: c.when,
  });
  return canonical({
    kind: r.kind,
    requestId: r.requestId,
    responseId: r.responseId,
    did: r.did?.toUpperCase(),
    field: r.field,
    scalar: r.scalar,
    choices: nonEmpty(r.choices)?.map(choice),
    auxWrites: nonEmpty(r.auxWrites),
    sequence: r.sequence,
    checksum: r.checksum,
    readBytes: r.readBytes,
    rule: r.selector === undefined ? undefined : variantRuleOf(r),
    variants: nonEmpty(r.variants)?.map(writeSignature),
    steps: nonEmpty(r.steps)?.map(writeSignature),
  });
}

const legacyIssues = [];
for (const { file, json } of loadDir('data/source/legacy')) {
  for (const [id, old] of Object.entries(json.recipes ?? {})) {
    const now = shipped[id];
    if (!now) continue;
    const before = digestOf(old);
    if (before === digestOf(now)) continue;
    if (JSON.stringify(writeSignature(old)) !== JSON.stringify(writeSignature(now))) {
      legacyIssues.push(`${id}: definition from ${file} writes differently now — its backups won't auto-restore`);
      continue;
    }
    now.legacyDigests = [...new Set([...(now.legacyDigests ?? []), before])].sort();
  }
}

const out = {
  schema: 'obdcraft.app-data/1',
  sourceGeneratedAt: matrix.generatedAt,
  vehicles: matrix.vehicles.map((v) => ({
    ...pick(v, ['brand', 'model', 'variant', 'label', 'powertrains', 'mid', 'platform']),
    listedBuilds: v.codemyvagBuilds,
  })),
  features: sortKeys(features),
  recipes: sortKeys(shipped),
  backupDids: read('data/source/ecu-backup-dids.json').units,
};

const target = resolve(root, 'src/data/app-data.json');
const text = `${JSON.stringify(out, null, 1)}\n`;

// ---------------------------------------------------------------------------------------------------------------
// Report.

function report() {
  const list = (title, items, all = true) => {
    if (!items.length) return;
    console.log(`  ${title}: ${items.length}`);
    for (const i of all ? items : items.slice(0, 10)) console.log(`    - ${i}`);
    if (!all && items.length > 10) console.log(`    … ${items.length - 10} more (--verbose)`);
  };
  console.log('build report (informational, never fails the build):');
  list('warnings', warnings);
  list('catalogue/matrix references to missing recipes', unresolvedRefs);
  list('choices with enabled/disabled value inverted vs optValue', choiceReport.invertedToggle);
  list('choices whose value does not fit the field', choiceReport.outOfRange);
  list('choices with value != optValue (enum vs wire; usually fine)', choiceReport.mismatch, VERBOSE);
  list('group choice coverage gaps', groupIssues);
  list('catalogue settings naming unknown choices', settingIssues);
  list('legacy definitions that no longer write the same bytes', legacyIssues);
  list('feature copy issues', copyIssues);

  const rs = Object.values(out.recipes);
  const byKind = {};
  for (const r of rs) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const all = [];
  const walk = (r) => {
    all.push(r);
    for (const s of r.steps ?? []) walk(s);
    for (const v of r.variants ?? []) all.push(v);
  };
  rs.forEach(walk);
  const fs = Object.values(out.features);
  const cat = fs.filter((f) => f.source === 'catalogue');
  const noBytes = rs.filter((r) => r.executable === false);
  console.log(
    `stats: overlays ${overlays.length} file(s), catalogue-map ${mapFiles.length} file(s); ` +
      `catalogue slugs ${cat.length} (${mappedSlugs} mapped, ${aliasedSlugs} via legacy alias, ` +
      `${cat.filter((f) => f.recipeId && shipped[f.recipeId].executable !== false).length} executable)`,
  );
  console.log(
    `       recipes by kind ${JSON.stringify(sortKeys(byKind))}; non-executable (no-bytes) ${noBytes.length}` +
      `${noBytes.length ? `: ${noBytes.map((r) => r.id).join(', ')}` : ''}`,
  );
  console.log(
    `       passwords: ${all.filter((r) => r.passwordSource === 'unit-default').length} unit-default, ` +
      `${all.filter((r) => r.passwordSource === 'recipe').length} from recipe`,
  );
  console.log(
    `app-data.json: ${out.vehicles.length} vehicles, ${fs.length} features ` +
      `(${fs.length - cat.length} matrix + ${cat.length} catalogue), ${rs.length} recipes`,
  );
  console.log(
    `feature copy: ${fs.filter((f) => f.displayName).length} features with copy ` +
      `(${cat.filter((f) => f.displayName).length} catalogue, ${fs.filter((f) => f.displayName && f.source === 'matrix').length} matrix); ` +
      `${fs.filter(isCodable).length} codable`,
  );
}

if (CHECK) {
  // CI: the committed runtime file must be exactly what the sources generate.
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== text) {
    console.error('src/data/app-data.json is out of date with data/source — run `node scripts/build-data.mjs`.');
    process.exit(1);
  }
  console.log('app-data.json matches its sources.');
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text);
report();
if (STRICT && (unresolvedRefs.length || copyIssues.length)) process.exit(1);
