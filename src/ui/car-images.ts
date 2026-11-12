import imagesJson from '../data/car-images.json' with { type: 'json' };

/**
 * Car imagery is on unless VITE_CAR_IMAGES=0. The photos are the owner's own (owner decision D4,
 * docs/reviews/2026-10-25/FIXES.md). With the flag off the build drops them (vite.config.ts) and the
 * UI neither references them nor shows a broken image.
 *
 * One picture per model (`icon`). A sporty or special edition with a signature look (Kushaq Monte Carlo in
 * Tornado Red, Taigun GT Plus…) has its own picture under `editions`, shown once the car's edition is known.
 */
export interface CarImageEntry {
  icon: string;
  /** Edition id (the trim slug prefix used in the catalogue, e.g. `monte-carlo`, `gt-line`) → picture. */
  editions?: Record<string, string>;
}

const enabled = import.meta.env.VITE_CAR_IMAGES !== '0';
const images = imagesJson as unknown as Record<string, CarImageEntry>;

/** The model's image entry, or undefined when car images are off or the model has none. */
export function carImages(brand: string, model: string): CarImageEntry | undefined {
  if (!enabled) return undefined;
  return images[`${brand}-${model}`];
}

/**
 * Which of `editions` a trim or listing slug names: the longest edition id the slug equals or starts with
 * (followed by `-`). `monte-carlo-manufactured-post-april` → `monte-carlo`, `gt-line-with-digital-mid` →
 * `gt-line`, `gt-manufactured-before-april` → `gt`. Undefined when none matches.
 */
export function resolveEdition(editions: readonly string[], slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const s = slug.toLowerCase();
  let best: string | undefined;
  for (const e of editions) {
    if ((s === e || s.startsWith(`${e}-`)) && (!best || e.length > best.length)) best = e;
  }
  return best;
}

/**
 * The picture for a model: its edition's picture when `edition` (an edition id or any trim/listing slug that
 * starts with one) names an edition that has one, otherwise the model's icon. Undefined when images are off.
 */
export function modelImage(brand: string, model: string, edition?: string): string | undefined {
  const entry = carImages(brand, model);
  if (!entry) return undefined;
  const editions = entry.editions ?? {};
  // A listing id (`skoda-kushaq-monte-carlo-…`) carries the brand and model in front of the trim.
  const prefix = `${brand}-${model}-`;
  const slug = edition?.toLowerCase().startsWith(prefix) ? edition.slice(prefix.length) : edition;
  const key = resolveEdition(Object.keys(editions), slug);
  return (key && editions[key]) || entry.icon;
}

/** The editions with their own picture for a model (e.g. `['monte-carlo']`), in file order. */
export function modelEditions(brand: string, model: string): string[] {
  return Object.keys(carImages(brand, model)?.editions ?? {});
}

/** `monte-carlo` → `Monte Carlo`, `gt-line` → `GT Line`, `gt` → `GT`. */
export const editionLabel = (id: string): string =>
  id
    .split('-')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');

/** The model's hero photo (`public/f/hero/<make>-<model>.webp`), or undefined when car images are off. */
export const heroImage = (key: string): string | undefined => (enabled ? `/f/hero/${key}.webp` : undefined);
