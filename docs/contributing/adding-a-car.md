# Adding a car

A "car" in the app is a **brand + model** (`skoda-kushaq`). Each model belongs to a **platform family**, and
features are offered per family: a feature that works on one car of a family is offered on all of them, and the
engine still checks the exact control unit's part number before it writes.

| Family | Cars today | Body computer (unit 09) part prefix |
|---|---|---|
| `MQB-A0-IN` (India 2.0) | Škoda Kushaq, Slavia, Kylaq · VW Taigun, Virtus | `2Q0` |
| `MQB` | Škoda Kodiaq, Octavia RS, Superb · VW Tiguan, Tayron, Golf GTI | `5Q0`, `3Q0`, `5WA` |

## Before you start: is it already covered?

Any Škoda or VW can be used today as **Other model**. On connect the app reads the body computer's part number
and picks the family. If your car is on one of the families above, adding it as its own model mostly gives it its
own name and picture — useful, but the features come from the family either way.

If your car is on a **new platform** (for example PQ26 Polo/Vento/Rapid, or MQB-Evo), it needs recipes of its
own: see [adding-a-feature.md](adding-a-feature.md) and start by [sharing a finding](sharing-a-finding.md) with
your car's control-unit part numbers.

## Steps

1. **Add the vehicle** to `vehicles` in [`data/source/feature-matrix.json`](../../data/source/feature-matrix.json):

   ```json
   {
     "brand": "volkswagen",
     "model": "polo",
     "variant": "gt",
     "label": "GT",
     "powertrains": ["1.0 TSI AT (6-sp)"],
     "mid": "unknown",
     "platform": "PQ26",
     "codemyvagBuilds": [],
     "evidence": "owner-report"
   }
   ```

   - `model` is a lowercase slug (`octavia-rs`); it is shown as "Octavia RS".
   - `platform` decides the family. Use the tag of the sister cars when you know it.
   - `mid` is the instrument cluster: `Analogue`, `Digital` or `unknown`.
   - `evidence` says how you know: `owner-report`, `market-table`, `catalogue`.

2. **If it's a new body computer**, add its part prefix to `BCM_FAMILIES` in
   [`src/domain/catalog/platform.ts`](../../src/domain/catalog/platform.ts), so "Other model" recognises it.

3. **Add a picture (optional but nice).** A side or 3/4 view of the car on a transparent background, at most
   640×300, as WebP:
   - save it as `public/cars/icons/<brand>-<model>.webp`
   - add `"<brand>-<model>": { "icon": "/cars/icons/<brand>-<model>.webp" }` to
     [`src/data/car-images.json`](../../src/data/car-images.json)

   Use a photo you took or are allowed to share. Not one copied from a manufacturer's or dealer's site.

4. **Rebuild and check:**

   ```bash
   npm run data     # regenerates src/data/app-data.json
   npm run check
   npm run dev      # the car appears under its brand on the "which car" screen
   ```

5. **Open a PR** with the vehicle entry, the regenerated `app-data.json`, and (if you have one) the picture.
   Add a page for the car under [`cars/`](../../cars/) with what you know about it — see
   [sharing-a-finding.md](sharing-a-finding.md).
