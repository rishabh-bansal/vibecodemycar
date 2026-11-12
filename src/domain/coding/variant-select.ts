import type { CodingRecipe, RecipeVariantSpec } from './types.ts';

/**
 * What the session read from the module before choosing a variant. Reads are harmless; anything that
 * could not be read is simply absent.
 *  - `reads`            DID → bytes (upper-case hex) for every variant DID; absent/'' when it did not answer
 *  - `read0600Unit09`   the BCM's 0600 coding block (unit 09 generation rule)
 *  - `isMib3`           the infotainment's ASAM/F19E names an MIB3 dataset (EV_MUOIMQB / EV_MUCNSMQB)
 *  - `part`             the module's F187 part number ('Device' in the vendor's CheckDevice)
 *  - `hardware`         the module's F191 hardware number ('ECU' in the vendor's CheckDevice)
 */
export interface VariantProbe {
  reads: Record<string, string | undefined>;
  read0600Unit09?: string;
  isMib3?: boolean;
  part?: string;
  hardware?: string;
}

export type VariantSelection =
  | { ok: true; index: number; variant: RecipeVariantSpec; why: string }
  | { ok: false; detail: string };

/** ASAM / F19E dataset names that mean MIB3 (`IsMIB3()` in the vendor code). */
export const MIB3_MARKERS = ['EV_MUOIMQB', 'EV_MUCNSMQB'] as const;

/** `IsMIB3()` from an F19E/ASAM read (hex or text); undefined when nothing was read. */
export function isMib3Identity(asam: string | undefined): boolean | undefined {
  if (!asam) return undefined;
  const text = /^(?:[0-9A-Fa-f]{2})+$/.test(asam)
    ? (asam.match(/../g) ?? []).map((b) => String.fromCharCode(Number.parseInt(b, 16))).join('')
    : asam;
  return MIB3_MARKERS.some((m) => text.toUpperCase().includes(m));
}

/**
 * The unit-09 generation rule (`MQBAlternativeContainerForUnit09`): the new-generation BCM answers 0600 with
 * (almost) all zero bytes — at least `len - 1` of them — or does not host it at all.
 */
export function isNewGenBcm(read0600: string | undefined): boolean {
  if (!read0600) return true;
  const bytes = read0600.match(/../g) ?? [];
  if (!bytes.length) return true;
  const zeros = bytes.filter((b) => b === '00').length;
  return zeros >= bytes.length - 1;
}

const UNIT09 = /unit0?9|(?:^|-)(?:new|old)-bcm$/i;
const MIB = /mib\s*-?(?:3|25|2\.5)/i;

/** How a variant's precondition is decided. */
type Rule =
  | { kind: 'unit09'; wantsNew: boolean }
  | { kind: 'mib'; wantsMib3: boolean }
  | { kind: 'device'; pattern: string }
  | { kind: 'did' };

export function variantRule(v: RecipeVariantSpec): Rule {
  if (v.devicePattern) return { kind: 'device', pattern: v.devicePattern };
  const sel = v.selector;
  // The selector name is authoritative: the extractor wrote `requiresNewBcm:false` on `new-bcm` variants.
  if (/new-bcm/i.test(sel)) return { kind: 'unit09', wantsNew: true };
  if (/old-bcm/i.test(sel)) return { kind: 'unit09', wantsNew: false };
  if (UNIT09.test(sel)) return { kind: 'unit09', wantsNew: v.requiresNewBcm === true };
  if (MIB.test(sel))
    return { kind: 'mib', wantsMib3: /mib\s*-?3(?!\d)/i.test(sel) && !/mib\s*-?25/i.test(sel) };
  return { kind: 'did' };
}

/** CheckDevice strips every non-alphanumeric character from the identity before matching. */
export const normaliseIdent = (s: string | undefined): string =>
  (s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

/**
 * `*` any run, `?` one character; case-insensitive, whole part. Matches the vendor's CheckDevice: the
 * pattern is wrapped as `*P*` and tested against the identity with every non-alphanumeric removed.
 */
export function matchesDevicePattern(pattern: string, part: string): boolean {
  const ident = normaliseIdent(part);
  if (!ident) return false;
  const core = pattern.trim().replace(/[^0-9A-Za-z*?]/g, '');
  const wrapped = `*${core}*`.replace(/\*+/g, '*');
  const re = new RegExp(
    `^${wrapped
      .split('')
      .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
    'i',
  );
  return re.test(ident);
}

/** Variants whose DID is only hosted by that infotainment generation (MIB3's 0556 block). */
const MIB_UNIQUE_DIDS: Record<'mib3' | 'mib25', readonly string[]> = { mib3: ['0556'], mib25: [] };

/** Reads the session must make before `selectVariant` can decide (all are harmless reads). */
export function variantProbePlan(recipe: Pick<CodingRecipe, 'variants'>): {
  dids: string[];
  needs0600Unit09: boolean;
  needsIdentity: boolean;
  needsPart: boolean;
} {
  const variants = recipe.variants ?? [];
  const rules = variants.map(variantRule);
  return {
    dids: [...new Set(variants.map((v) => v.did.toUpperCase()))],
    needs0600Unit09: rules.some((r) => r.kind === 'unit09'),
    needsIdentity: rules.some((r) => r.kind === 'mib'),
    needsPart: rules.some((r) => r.kind === 'device'),
  };
}

/**
 * Picks the variant of an `alt` recipe the vendor would use: ORDERED FIRST MATCH over the variants, each
 * decided by its container's own precondition:
 *  - unit-09 / new-bcm / old-bcm: new generation iff 0600 has >= len-1 zero bytes or is unreadable;
 *  - MIB2.5 / MIB3: by `isMib3`; when the generation is unknown, only a variant whose DID is unique to
 *    its generation (MIB3 0556) and answered is used, and only when exactly one such variant answered;
 *  - `devicePattern`: the module's F187 part or F191 hardware number matches `*pattern*` (CheckDevice);
 *  - otherwise: the variant's DID answered with at least one byte.
 * Pure. Only a genuine no-match refuses.
 */
export function selectVariant(recipe: Pick<CodingRecipe, 'variants'>, probe: VariantProbe): VariantSelection {
  const variants = recipe.variants ?? [];
  if (!variants.length)
    return { ok: false, detail: 'This feature has no control-unit versions to choose from.' };
  const answered = (did: string) => !!probe.reads[did.toUpperCase()] || !!probe.reads[did];
  // Generation unknown: a shared DID (0600 is on every head unit) proves nothing. Only a DID unique to its
  // generation that answered decides, and only when exactly one such variant answered.
  let mibFallback: number | undefined;
  if (probe.isMib3 === undefined) {
    const unique = variants
      .map((v, i) => ({ v, i, rule: variantRule(v) }))
      .filter(({ v, rule }) => {
        if (rule.kind !== 'mib') return false;
        const own = MIB_UNIQUE_DIDS[rule.wantsMib3 ? 'mib3' : 'mib25'];
        return own.includes(v.did.toUpperCase()) && answered(v.did);
      });
    if (unique.length === 1) mibFallback = unique[0]?.i;
  }
  for (const [index, variant] of variants.entries()) {
    const rule = variantRule(variant);
    switch (rule.kind) {
      case 'unit09': {
        const newGen = isNewGenBcm(probe.read0600Unit09);
        if (newGen === rule.wantsNew)
          return {
            ok: true,
            index,
            variant,
            why: `${newGen ? 'new' : 'old'}-generation body control module (0600 ${probe.read0600Unit09 ? 'read' : 'not hosted'})`,
          };
        break;
      }
      case 'mib':
        if (probe.isMib3 === undefined ? mibFallback === index : probe.isMib3 === rule.wantsMib3)
          return {
            ok: true,
            index,
            variant,
            why:
              probe.isMib3 === undefined
                ? `infotainment generation unknown; ${variant.did} (only hosted by that generation) answered`
                : `infotainment is ${probe.isMib3 ? 'MIB3' : 'MIB2.5'}`,
          };
        break;
      case 'device': {
        const hit = [probe.part, probe.hardware].find((id) => !!id && matchesDevicePattern(rule.pattern, id));
        if (hit) return { ok: true, index, variant, why: `${hit} matches ${rule.pattern}` };
        break;
      }
      case 'did':
        if (answered(variant.did)) return { ok: true, index, variant, why: `${variant.did} answered` };
        break;
    }
  }
  if (probe.isMib3 === undefined && variants.some((v) => variantRule(v).kind === 'mib'))
    return {
      ok: false,
      detail:
        "We couldn't tell the infotainment generation (MIB2.5 or MIB3), so we stopped rather than write the wrong layout. Nothing was changed.",
    };
  return {
    ok: false,
    detail:
      "Your control unit doesn't host this feature's setting in any known version, so we stopped. Nothing was changed.",
  };
}
