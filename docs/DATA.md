# Data

The app ships two generated files. Never edit them by hand.

| File | Built by | Holds |
|---|---|---|
| `src/data/app-data.json` | `npm run data` (`scripts/build-data.mjs`) | 43 vehicles, 253 features, 129 recipes (41 alt, 38 field, 30 group, 10 scalar, 9 ops, 1 dataset), backup DIDs |
| `src/data/catalogue.json` | `npm run catalogue` (`scripts/build-catalogue.mjs`) | the browsable catalogue: 8 models, 194 slugs, 491 listings, with feature photos |

## Recipe pipeline (`app-data.json`)

```
data/source/feature-recipes.json     extracted recipe corpus (with provenance; never shipped)
data/source/overlays/*.json          hand-authored fixes per group: { newRecipes, recipes, steps, notes }
data/source/catalogue-map/*.json     catalogue slug → recipe id, or { byPlatform: { MQB-A0-IN, MQB, PQ } }
data/source/feature-matrix.json      vehicles, and the 59 legacy matrix features (kept so old backups resolve)
data/source/feature-copy.json        consumer copy: display name, description, a label per setting
data/source/legacy/*.json            earlier shipped definitions → `legacyDigests` when the write is unchanged
packages/coding/data/catalogue.json  legacy feature names and categories
src/data/catalogue.json              the slugs the app shows
        └── node scripts/build-data.mjs ──► src/data/app-data.json
```

- **Overlays.** `newRecipes` are applied first, across all files, then recipe patches, then step patches.
  Files apply in alphabetical order, and when two files set the same key the later one wins, with a warning.
  The raw recipe bytes (bit ops, variants, group steps) were re-derived from the vendor code into the
  overlays. Each overlay's `notes` record where they came from.
- **Catalogue map.** Each catalogue slug becomes its own app feature, mapped to a recipe for each platform.
  A slug with no map entry falls back to its `aliasOf` legacy feature or to `CATALOGUE_ALIASES`
  (`domain/catalogue/status.ts`).
- **Passwords.**
  - The recipe's own password is used when it has one (`passwordSource: 'recipe'`).
  - Otherwise the build fills in the unit's default code (`passwordSource: 'unit-default'`).
- **Executability.** A recipe is executable when it has byte-level instructions. A raw block that nobody has
  decoded ships as `executable: false, reason: 'no-bytes'`.
- **Determinism.** The output has a stable key order and no timestamps of its own.

Flags: `--check` (CI) fails when the committed file differs from what the sources generate. `--strict` fails
on a map entry that points at a missing recipe, or on missing copy. `--verbose` lists the informational
assertions.

`src/domain/catalog/data.contract.test.ts` and `app-data.contract.test.ts` check the file against `schema.ts`.
They also check that it carries no provenance paths or VINs, and that every codable feature has copy and
setting labels.

`data/source/datasets/` holds the vendor dataset blobs (`.dat`/`.bin`) that dataset recipes were derived
from. The build does not read them.

## Catalogue pipeline (`catalogue.json`)

```
../VAGCoder/docs/features/<make>/<model>/features.json + img/
        └── node scripts/build-catalogue.mjs ──► src/data/catalogue.json
                                              ──► public/f/sm, public/f/lg  (feature photos, WebP)
                                              ──► public/f/hero              (car hero images)
```

The JSON is cleaned when it loads (`domain/catalogue/normalize.ts`), not when it is built. The full catalogue
text and photos ship publicly. `npm run check:public` (`scripts/check-public-build.mjs`) fails the build if
any listed feature is missing either photo size, or if `research-catalogue/` reaches `dist/`.
`src/data/catalogue-public.json` is a byte-identical copy kept for external consumers. The app does not read
it.

## Coverage

112 of 194 slugs are codable (268 of 491 listings). By recipe kind, the codable slugs are 36 alt, 29 field,
28 group, 9 scalar and 9 ops, plus comfort-turn-signals (field on MQB-A0-IN, alt on MQB). The other 82 slugs have no byte-level implementation in any available source.
The per-slug table is in [FEATURE_COVERAGE.md](FEATURE_COVERAGE.md).

## Adding a feature

1. Add or fix the recipe in `data/source/overlays/<group>.json`. Use `newRecipes` for a new recipe and
   `recipes`/`steps` for patches. Record the source in `notes`.
2. Map the slug in `data/source/catalogue-map/<group>.json`, with `byPlatform` when MQB and MQB-A0-IN differ.
3. Add consumer copy and setting labels in `data/source/feature-copy.json`.
4. Run `npm run data`, then `npm run check`. Commit the sources and the regenerated `app-data.json` together.
   CI runs `check:data`.

Changing a shipped recipe changes its digest. When the change does not alter what is written (for example
copy, labels or metadata), add the old definition to `data/source/legacy/`. Its digest is then accepted as a
`legacyDigests` entry, and backups made with it still restore. When the change does alter what is written,
the build warns, and those backups refuse with `target-changed`.

## Provenance

The recipe corpus and the catalogue text and photos come from third-party material: published feature lists,
and mappings extracted from other coding tools. Confirm the rights to redistribute them before a wider
launch. The car photos (`public/cars/`, `public/f/hero/`) are the owner's own. `VITE_CAR_IMAGES=0` drops
them from a build.
