# Adding or fixing a feature

A feature is two things:

- a **catalogue card** — what people see: name, description, photo, the choices (`src/data/catalogue.json`);
- a **recipe** — what the app writes: which control unit, which data identifier (DID), which bytes or bits, and
  the value for each choice (`data/source/overlays/*.json`).

A card without a recipe is shown as "not available yet". [docs/FEATURE_COVERAGE.md](../FEATURE_COVERAGE.md)
lists every card and whether it has a recipe — the "Not codable" lists are the best place to start.

## What a recipe needs

You need to know, ideally from your own car:

| | Example (lane change blinks, Kushaq) |
|---|---|
| Control unit and its CAN ids | `09` body computer, request `70E`, response `778` |
| Data identifier (DID) holding the setting | `0A5E` (a coding block) |
| Where the setting is | byte 0, bits 0–3 |
| Value per choice | 3 blinks → `3`, 5 blinks → `5` |
| What it was before you changed it | `3A00000000` |
| Part numbers it was tested on | `2Q0937089D` |

Recipe kinds (`field`, `scalar`, `ops`, `alt`, `group`, `dataset`) are described in
[docs/ARCHITECTURE.md](../ARCHITECTURE.md#recipe-kinds-domaincatalogtypests-validated-by-schemats).
Look at a similar feature in the same overlay file and copy its shape.

## Steps

1. **Recipe:** add it to `data/source/overlays/<group>.json` — `newRecipes` for a new one, `recipes` / `steps` to
   patch an existing one. Say where it comes from in `notes` ("coded and read back on 2023 Kushaq,
   2Q0937089D"). Groups: `exterior-lighting`, `dashboard`, `comfort`, `windows-locks`, `assistance`, `service`.
2. **Map the card to the recipe** in `data/source/catalogue-map/<group>.json`. Use `byPlatform` when MQB and
   MQB-A0-IN need different recipes.
3. **Words people see:** add the display name, a one-line description and a label for each setting to
   `data/source/feature-copy.json`. Plain words, no jargon ("5 blinks", not "0x05").
4. **New card?** Add it to the model's `features` in `src/data/catalogue.json` (copy a neighbour's shape) and
   put its photo at `public/f/sm/<image>.webp` (480×240) and `public/f/lg/<image>.webp` (1024×512). Then run
   `npm run catalogue:public`.
5. **Build and test:**

   ```bash
   npm run data
   npm run check
   ```

6. **Try it without a car:** `npm run dev`, open the feature, then follow
   [docs/LIVE_TESTING.md → Rehearsing without the car](../LIVE_TESTING.md#rehearsing-without-the-car).
7. **Open a PR.** Say whether it was **tested on a real car** (which car, which part number, before and after
   bytes) or **untested**. Untested recipes are welcome, and are marked as such until someone confirms them.

## Changing a recipe that already shipped

Backups made with the old recipe must still restore. If your change does not alter the bytes written (labels,
copy, notes), copy the old definition into `data/source/legacy/` so its digest stays accepted. If it does alter
the bytes, the build warns: explain why in the PR.
