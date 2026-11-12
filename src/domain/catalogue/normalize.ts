import type { CatalogueFeature, RawFeature } from './types.ts';

type Section = 'functions' | 'requirements' | 'attention' | 'procedure' | 'notes';

/**
 * Section headings found in `intro` text. `⚙` and `⚠` markers are what the data actually uses
 * (`⚙Functions`, `⚙ Functions`, `⚙ Options`, `⚠ Attention`); the plain headings are accepted for
 * Requirements / In-car procedure / Notes if they ever appear.
 */
const HEADINGS: ReadonlyArray<readonly [RegExp, Section]> = [
  [/^(?:[⚙⚠ℹ]️?\s*)?requirements?\s*:?$/i, 'requirements'],
  [/^(?:[⚙⚠ℹ]️?\s*)?in-?car\s+procedure\s*:?$/i, 'procedure'],
  [/^(?:[⚙⚠ℹ]️?\s*)?notes?\s*:?$/i, 'notes'],
];

/** `⚙…` → Functions (Options are folded in); `⚠…` → Attention. Returns undefined for ordinary text. */
function markerSection(line: string): Section | undefined {
  if (line.startsWith('⚠')) return 'attention';
  if (line.startsWith('⚙')) return 'functions';
  const plain = HEADINGS.find(([re]) => re.test(line));
  return plain?.[1];
}

/** Drop list decoration: `• x`, `•x`, `- x`, `1. x`, `2) x`. */
const stripListMark = (line: string): string => line.replace(/^(?:[•\-–*]|\d+[.)])\s*/, '').trim();
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = collapse(item);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** Warnings about the law need a deliberate extra tap (spec §1 "Legal warnings"). Attention text only. */
export const mentionsLaw = (text: string): boolean => /\blaw\b|\blegal(?:ly)?\b|\billegal\b/i.test(text);

/**
 * The one place that turns a raw record into something displayable.
 *
 *  - Text before the first marker is the real intro. Lines are joined, because the source hard-wraps
 *    them ("DRL - Daytime Running⏎Lights When the hand brake…"); taking only line one would cut titles.
 *  - Marker lines open a section; their following lines are its items (list decoration stripped).
 *  - Parsed lists merge with any arrays already in the record, de-duplicated.
 *  - A marker with no items (the data repeats `⚙ Functions` with nothing under it) yields nothing.
 */
export function normalizeFeature(raw: RawFeature): CatalogueFeature {
  const sections: Record<Section, string[]> = {
    functions: [...(raw.Functions ?? [])],
    requirements: [...(raw.Requirements ?? [])],
    attention: [...(raw.Attention ?? [])],
    procedure: [...(raw['In-Car procedure'] ?? [])],
    notes: [...(raw.Notes ?? [])],
  };

  const introLines: string[] = [];
  let current: Section | undefined;
  for (const original of (raw.intro ?? '').split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    const opens = markerSection(line);
    if (opens) {
      current = opens;
      // `⚙ Functions: do x` — text on the marker line itself belongs to the section.
      const inline = line.replace(
        /^[⚙⚠ℹ]️?\s*(?:functions?|options?|attention|requirements?|notes?|in-?car\s+procedure)?\s*:?\s*/i,
        '',
      );
      if (inline && !markerSection(inline)) sections[opens].push(stripListMark(inline));
      continue;
    }
    if (current) sections[current].push(stripListMark(line));
    else introLines.push(line);
  }

  const attention = dedupe(sections.attention);
  return {
    slug: raw.slug,
    name: raw.name,
    group: raw.group,
    category: raw.category,
    ...(raw.image ? { image: raw.image } : {}),
    intro: collapse(introLines.join(' ')),
    functions: dedupe(sections.functions),
    requirements: dedupe(sections.requirements),
    attention,
    procedure: dedupe(sections.procedure),
    notes: dedupe(sections.notes),
    legal: attention.some(mentionsLaw),
  };
}
