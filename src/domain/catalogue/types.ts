/** The browsable feature catalogue (spec: design/feature-catalogue/FEATURE-CATALOGUE.md). */

export const GROUP_IDS = [
  'exterior-lighting',
  'dashboard',
  'windows-locks',
  'assistance',
  'comfort',
  'service',
] as const;
export type GroupId = (typeof GROUP_IDS)[number];

/** A record exactly as it appears in the generated data file. Section arrays are usually EMPTY. */
export interface RawFeature {
  slug: string;
  name: string;
  group: GroupId;
  category: string;
  /** Photo id (file stem), not a path. */
  image?: string;
  intro: string;
  Functions: string[];
  Requirements: string[];
  Attention: string[];
  'In-Car procedure': string[];
  Notes: string[];
}

export interface RawModel {
  make: 'skoda' | 'volkswagen';
  model: string;
  title: string;
  features: RawFeature[];
}

/** A feature after `normalizeFeature()`: the real intro plus its parsed sections. */
export interface CatalogueFeature {
  slug: string;
  name: string;
  group: GroupId;
  category: string;
  image?: string;
  /** The real intro only — never contains section text. May be empty. */
  intro: string;
  functions: string[];
  requirements: string[];
  attention: string[];
  procedure: string[];
  notes: string[];
  /** An Attention item mentions the law. Needs an extra tap and is never the "most loved" hero. */
  legal: boolean;
  /** The catalogue's own name and intro, kept when the app's friendlier copy replaces them (search uses both). */
  original?: { name: string; intro: string };
}

export interface CatalogueModel {
  make: 'skoda' | 'volkswagen';
  model: string;
  /** `skoda-kushaq` — also the hero image key. */
  key: string;
  title: string;
  features: CatalogueFeature[];
  unlocks: CatalogueFeature[];
  service: CatalogueFeature[];
}
