import { describe, expect, it } from 'vitest';
import { APP_DATA } from '../catalog/data.ts';
import {
  buildApplyPlan,
  buildRestorePlan,
  compareReadback,
  crc32Trailer,
  freeValueOf,
  groupStepsOf,
  PlanError,
  planGroupStep,
  recipeDigest,
  resolveRecipe,
  scalarRange,
  stepActionFor,
  strayBytes,
  trustedOwnedMask,
} from './plan.ts';
import type { CodingRecipe as Recipe } from './types.ts';
import { selectVariant } from './variant-select.ts';

const blinks = APP_DATA.recipes['live-bcm-polite-blinks'];
if (!blinks) throw new Error('fixture recipe missing from app-data');

/** A minimal recipe with a BCM-generation split, to exercise selector settlement. */
const split: Recipe = {
  id: 'synthetic-split',
  name: 'Synthetic split',
  kind: 'alt',
  requestId: '70E',
  responseId: '778',
  password: '31347',
  variants: [
    {
      selector: 'new-bcm',
      requiresNewBcm: false,
      did: '0A59',
      password: '31347',
      kind: 'field',
      field: { byteOffset: 0, bitOffset: 2, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'Enabled', value: 1 },
        { id: 'disabled', label: 'Disabled', value: 0 },
      ],
    },
    {
      selector: 'old-bcm',
      requiresNewBcm: true,
      did: '0D0C',
      password: '31347',
      kind: 'field',
      field: { byteOffset: 0, bitOffset: 0, bitLength: 1, byteOrder: 'big' },
      choices: [
        { id: 'enabled', label: 'Enabled', value: 1 },
        { id: 'disabled', label: 'Disabled', value: 0 },
      ],
    },
  ],
};

describe('buildApplyPlan — regression against the live-verified write', () => {
  it('turns the car’s real 3A00000000 into the 3E00000000 that produced five blinks', () => {
    const plan = buildApplyPlan(blinks, 'value-5', '3A00000000');
    expect(plan.after).toBe('3E00000000');
    expect(plan.did).toBe('0A5E');
    expect(plan.module).toEqual({ request: '70E', response: '778' });
    expect(plan.password).toBe('31347');
    expect(plan.noop).toBe(false);
    expect(plan.changes).toHaveLength(1);
  });

  it('only touches the declared bits and preserves every other byte', () => {
    const plan = buildApplyPlan(blinks, 'value-2', '3AA5C3F0FF');
    expect(plan.after.slice(2)).toBe('A5C3F0FF');
  });

  it('reports a no-op when the car already holds the value', () => {
    expect(buildApplyPlan(blinks, 'value-5', '3E00000000').noop).toBe(true);
  });

  it('refuses a setting the recipe does not offer', () => {
    expect(() => buildApplyPlan(blinks, 'value-9', '3A00000000')).toThrow(PlanError);
    try {
      buildApplyPlan(blinks, 'value-9', '3A00000000');
    } catch (e) {
      expect((e as PlanError).code).toBe('unknown-setting');
    }
  });

  it('refuses unreadable car data instead of guessing', () => {
    expect(() => buildApplyPlan(blinks, 'value-5', 'ZZ')).toThrow(PlanError);
    expect(() => buildApplyPlan(blinks, 'value-5', '3A0')).toThrow(PlanError);
  });

  it('refuses a block too short to hold the field', () => {
    expect(() => buildApplyPlan(blinks, 'value-5', '')).toThrow(PlanError);
  });
});

describe('resolveRecipe — variant settlement fails closed', () => {
  it('refuses an absent selector', () => {
    expect(() => resolveRecipe(split)).toThrow(/couldn't tell/);
  });
  it('refuses an unknown selector', () => {
    expect(() => resolveRecipe(split, 'mystery-bcm')).toThrow(PlanError);
  });
  it('picks exactly the matching variant', () => {
    expect(resolveRecipe(split, 'new-bcm').did).toBe('0A59');
    expect(buildApplyPlan(split, 'enabled', '00', 'new-bcm').after).toBe('04');
  });
  it('goes by the selector, never by the generation flag (the fixture flags each variant the other way)', () => {
    expect(resolveRecipe(split, 'old-bcm').did).toBe('0D0C');
  });
  it('refuses when two variants claim the same selector', () => {
    const [first] = split.variants ?? [];
    if (!first) throw new Error('fixture');
    const twice: Recipe = { ...split, variants: [first, { ...first, did: '0A5A' }] };
    expect(() => resolveRecipe(twice, 'new-bcm')).toThrow(/more than one mapping/);
  });
});

describe('encoding semantics (shared with the native writer)', () => {
  const wide: Recipe = {
    id: 'wide',
    name: 'wide',
    kind: 'field',
    requestId: '714',
    responseId: '77E',
    did: '0600',
    field: { byteOffset: 0, bitOffset: 0, bitLength: 16, byteOrder: 'big' },
    choices: [
      { id: 'a', label: 'a', value: 0x1234 },
      { id: 'b', label: 'b', value: 0 },
    ],
  };
  it('keeps big-endian multi-byte values in wire order', () => {
    expect(buildApplyPlan(wide, 'a', '0000FF').after).toBe('1234FF');
  });
  it('little-endian reverses byte order, not bit order', () => {
    const wideField = wide.field;
    if (!wideField) throw new Error('fixture');
    const le: Recipe = { ...wide, field: { ...wideField, byteOrder: 'little' } };
    expect(buildApplyPlan(le, 'a', '0000FF').after).toBe('3412FF');
  });
});

describe('buildRestorePlan', () => {
  it('writes the saved original back verbatim', () => {
    const plan = buildRestorePlan(blinks, '3E00000000', '3A00000000');
    expect(plan.after).toBe('3A00000000');
    expect(plan.noop).toBe(false);
  });

  it('refuses a backup of a different length', () => {
    expect(() => buildRestorePlan(blinks, '3E00000000', '3A0000')).toThrow(PlanError);
  });

  it('never writes bytes outside the recipe, whatever the backup holds there', () => {
    expect(buildRestorePlan(blinks, '3E00000000', '3A00FF0000').after).toBe('3A00000000');
  });

  it('keeps bits the module set since, and puts back only the recipe bits', () => {
    const plan = buildRestorePlan(blinks, '3E00A00000', '3A00000000');
    expect(plan.after).toBe('3A00A00000');
    expect(plan.owned).toEqual([0x16, 0, 0, 0, 0]);
  });
});

describe('compareReadback', () => {
  const plan = buildApplyPlan(blinks, 'value-5', '3A00000000');

  it('owns byte 0 bits 1–2 (count) and bit 4 (constant) for polite blinks', () => {
    expect(plan.owned).toEqual([0x16, 0, 0, 0, 0]);
  });
  it('is exact for the bytes written', () => {
    expect(compareReadback(plan, '3E00000000')).toEqual({ kind: 'exact' });
    expect(compareReadback(plan, '3e00000000')).toEqual({ kind: 'exact' });
  });
  it('reports a change outside the recipe as module-managed only when it is a recorded observation', () => {
    expect(compareReadback({ ...plan, known: ['3E00A00000'] }, '3E00A00000')).toEqual({
      kind: 'owned-match',
      moduleManaged: [{ offset: 2, wrote: '00', stored: 'A0' }],
    });
  });
  it.each([
    ['without any recorded observation', undefined, '3E00A00000'],
    ['that differs from the recorded one (independent review R2)', ['3E00A00000'], '3EDEADBEEF'],
  ])('reports a change outside the recipe as unexplained %s', (_why, known, observed) => {
    const verdict = compareReadback({ ...plan, ...(known ? { known } : {}) }, observed);
    expect(verdict.kind).toBe('mismatch');
    expect(verdict).toHaveProperty('unexplained');
  });
  it.each([
    ['an owned bit differs', '3C00000000'],
    ['an unowned bit differs in a byte the recipe writes into', '3F00000000'],
    ['the length differs', '3E000000'],
    ['it is not hex', '3E00ZZ0000'],
  ])('is a mismatch when %s', (_why, observed) => {
    expect(compareReadback(plan, observed)).toEqual({ kind: 'mismatch' });
  });
});

describe('crc32-trailer recipes (VIM MIB3)', () => {
  const vim: Recipe = {
    id: 'csmqb-vim-mib3-speed-threshold',
    name: 'Video In Motion Speed Threshold (MIB3)',
    kind: 'scalar',
    unit: '5F',
    requestId: '773',
    responseId: '7DD',
    password: '20103',
    did: '720D',
    scalar: { byteOffset: 4, dataLength: 1, multiplier: 1, offset: 0 },
    choices: [
      { id: 'always-on', label: 'Never disable', value: 255 },
      { id: 'kmh-180', label: 'Disable above 180 km/h', value: 180 },
    ],
    checksum: 'crc32-trailer',
    readBytes: 34,
  };
  // 30-byte payload + its CRC-32 trailer, as the module holds it
  const payload = `0011223344${'00'}${'AA'.repeat(24)}`;
  const before = `${payload}${crc32Trailer(payload)}`;

  it('owns the field bits and the whole trailer, the same in the plan and the trusted mask', () => {
    const plan = buildApplyPlan(vim, 'kmh-180', before);
    expect(plan.owned).toEqual([0, 0, 0, 0, 0xff, ...new Array(25).fill(0), 0xff, 0xff, 0xff, 0xff]);
    expect(trustedOwnedMask(vim, 34)).toEqual(plan.owned);
    expect(buildRestorePlan(vim, plan.after, before).owned).toEqual(plan.owned);
  });

  it('rewrites the trailer as CRC32 of the patched payload', () => {
    const plan = buildApplyPlan(vim, 'always-on', before);
    expect(plan.after).toHaveLength(68);
    expect(plan.after.slice(8, 10)).toBe('FF'); // byte 4 patched
    // trailer = crc32(payload with byte4=FF), independent recompute:
    const bytes = Array.from({ length: 30 }, (_, i) =>
      Number.parseInt(plan.after.slice(i * 2, i * 2 + 2), 16),
    );
    let c = 0xffffffff;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const v = c ^ 0xffffffff;
    expect(plan.after.slice(60)).toBe(
      [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join(''),
    );
    expect(plan.noop).toBe(false);
  });

  it('refuses a non-34-byte block — the delegate support gate', () => {
    expect(() => buildApplyPlan(vim, 'always-on', 'AA'.repeat(33).toUpperCase())).toThrow(PlanError);
    expect(() => buildApplyPlan(vim, 'always-on', 'AA'.repeat(35).toUpperCase())).toThrow(PlanError);
  });

  it('read-back compares the whole block including the fresh trailer', () => {
    const plan = buildApplyPlan(vim, 'kmh-180', before);
    expect(compareReadback(plan, plan.after)).toEqual({ kind: 'exact' });
    expect(compareReadback(plan, `${plan.after.slice(0, 66)}00`)).toEqual({ kind: 'mismatch' });
  });

  it('restores with a recomputed trailer, preserving unrelated payload bytes changed since', () => {
    const applied = buildApplyPlan(vim, 'kmh-180', before);
    // Something else changed byte 10 after our change (another feature, the module itself).
    const changed = `${applied.after.slice(0, 20)}77${applied.after.slice(22, 60)}`;
    const current = `${changed}${crc32Trailer(changed)}`;
    const restore = buildRestorePlan(vim, current, before, undefined);
    expect(restore.after.slice(8, 10)).toBe(before.slice(8, 10)); // our byte back to the original
    expect(restore.after.slice(20, 22)).toBe('77'); // theirs kept
    expect(restore.after.slice(60)).toBe(crc32Trailer(restore.after.slice(0, 60)));
  });
});

describe('dataset recipes (MIB3 sound presets)', () => {
  const ds: Recipe = {
    id: 'csmqb-mib3-sound-signature',
    name: 'Sound Processing Preset (MIB3)',
    kind: 'dataset',
    unit: '5F',
    requestId: '773',
    responseId: '7DD',
    password: '20103',
    did: '7201',
    choices: [
      { id: 'variant-001', label: 'Preset 001', value: 0, payload: 'AABBCCDD' },
      { id: 'variant-002', label: 'Preset 002', value: 0, payload: '11223344' },
    ],
    sequence: { pre: ['1003', '1040', '2704'], post: ['1102'] },
  };
  it('writes the option payload verbatim; owned mask covers the whole block', () => {
    const p = buildApplyPlan(ds, 'variant-002', 'FFFFFFFF');
    expect(p.after).toBe('11223344');
    expect(p.owned).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(compareReadback(p, '11223344')).toEqual({ kind: 'exact' });
    expect(compareReadback(p, '11223345').kind).toBe('mismatch');
  });
  it('restores the recorded original bytes verbatim', () => {
    const p = buildRestorePlan(ds, '11223344', 'FFFFFFFF', undefined);
    expect(p.after).toBe('FFFFFFFF');
  });
  it('carries the declared sequence in both plans', () => {
    expect(buildApplyPlan(ds, 'variant-002', 'FFFFFFFF').sequence?.pre).toEqual(['1003', '1040', '2704']);
    expect(buildRestorePlan(ds, '11223344', 'FFFFFFFF').sequence?.post).toEqual(['1102']);
  });
  it('plans a dataset without a declared sequence as a plain verbatim write (no ritual to run)', () => {
    const { sequence: _lost, ...bare } = ds;
    const p = buildApplyPlan(bare, 'variant-002', 'FFFFFFFF');
    expect(p.after).toBe('11223344');
    expect(p.sequence).toBeUndefined();
    expect(buildRestorePlan(bare, '11223344', 'FFFFFFFF').after).toBe('FFFFFFFF');
  });
  it('refuses options without payloads and unknown settings', () => {
    const bad: Recipe = { ...ds, choices: [{ id: 'x', label: 'x', value: 0 }] };
    expect(() => buildApplyPlan(bad, 'x', 'FFFFFFFF')).toThrow(PlanError);
    expect(() => buildApplyPlan(ds, 'nope', 'FFFFFFFF')).toThrow(PlanError);
  });
});

describe('field recipes: no "declared value" gate, any-width constants, single-choice actions', () => {
  const f: Recipe = {
    id: 'f',
    name: 'f',
    kind: 'field',
    requestId: '70E',
    responseId: '778',
    password: null,
    did: '0A00',
    field: { byteOffset: 0, bitOffset: 0, bitLength: 2, byteOrder: 'big' },
    choices: [{ id: 'enabled', label: 'On', value: 1, aux: [{ byte: 1, bit: 4, len: 3, value: 5 }] }],
    auxWrites: [{ byteOffset: 0, bitOffset: 6, bitLength: 2, value: 2 }],
  };
  it('overwrites a current value no choice declares, with block and choice constants of any width', () => {
    const p = buildApplyPlan(f, 'enabled', '0300');
    expect(p.after).toBe('8150');
    expect(p.owned).toEqual([0xc3, 0x70]);
  });
  it('restores an undeclared original value inside the owned bits only', () => {
    const p = buildRestorePlan(f, '81FF', '03AA');
    // byte 0: owned C3 from 03 → 03; byte 1: owned 70 from AA (=20) on FF → 8F|20 = AF
    expect(p.after).toBe('03AF');
  });
});

describe('scalar recipes: presets and free values (`value:<n>`)', () => {
  const sc: Recipe = {
    id: 'idle',
    name: 'idle',
    kind: 'scalar',
    requestId: '7E0',
    responseId: '7E8',
    password: '27971',
    did: '0310',
    scalar: { byteOffset: 1, dataLength: 1, multiplier: 10, offset: -100 },
  };
  it('writes a free physical value as raw = (value - offset) / multiplier', () => {
    expect(buildApplyPlan(sc, 'value:150', '000000').after).toBe('001900');
    expect(scalarRange(sc.scalar as NonNullable<Recipe['scalar']>)).toEqual({
      min: -100,
      max: 2450,
      step: 10,
    });
  });
  it('honours declared bounds and refuses a non-number', () => {
    const bounded: Recipe = {
      ...sc,
      scalar: { ...(sc.scalar as NonNullable<Recipe['scalar']>), min: 0, max: 200 },
    };
    expect(() => buildApplyPlan(bounded, 'value:300', '000000')).toThrow(/between 0 and 200/);
    expect(() => buildApplyPlan(sc, 'value:abc', '000000')).toThrow(PlanError);
    expect(freeValueOf('value:-5.5')).toBe(-5.5);
    expect(freeValueOf('enabled')).toBeUndefined();
  });
  it('still takes presets by id', () => {
    const presets: Recipe = { ...sc, choices: [{ id: 'low', label: 'Low', value: 0 }] };
    expect(buildApplyPlan(presets, 'low', '00FF00').after).toBe('000A00');
  });
});

describe('ops recipes', () => {
  const ops: Recipe = {
    id: 'acc-wait',
    name: 'ACC wait time',
    kind: 'ops',
    requestId: '757',
    responseId: '7C1',
    password: '20103',
    did: '0600',
    choices: [
      { id: 'short', label: 'Short', ops: [{ byte: 1, bit: 0, len: 1, value: 1 }] },
      {
        id: 'long',
        label: 'Long',
        ops: [
          { byte: 1, bit: 0, len: 1, value: 0 },
          { byte: 2, bit: 0, len: 8, value: 0x42 },
        ],
      },
      { id: 'mib', label: 'MIB', when: { mib3: true }, ops: [{ byte: 0, bit: 7, len: 1, value: 1 }] },
      { id: 'mib', label: 'MIB', when: { mib3: false }, ops: [{ byte: 0, bit: 6, len: 1, value: 1 }] },
    ],
  };
  it('applies the chosen ops and owns the union of every choice', () => {
    const p = buildApplyPlan(ops, 'long', '00FF00');
    expect(p.after).toBe('00FE42');
    expect(p.owned).toEqual([0xc0, 0x01, 0xff]);
    expect(buildApplyPlan(ops, 'short', '000100').noop).toBe(true);
  });
  it('picks the when.mib3 branch from the infotainment generation, refusing when it is unknown', () => {
    expect(buildApplyPlan(ops, 'mib', '000000', { isMib3: true }).after).toBe('800000');
    expect(buildApplyPlan(ops, 'mib', '000000', { isMib3: false }).after).toBe('400000');
    expect(() => buildApplyPlan(ops, 'mib', '000000')).toThrow(/infotainment generation/);
  });
  it('restores only the owned bits', () => {
    // owned C0 01 FF: byte 0 C1 → 01, byte 1 FF → FE, byte 2 → 00.
    expect(buildRestorePlan(ops, 'C1FF7E', '000000').after).toBe('01FE00');
  });
  it('refuses an op that does not fit the block', () => {
    expect(() => buildApplyPlan(ops, 'long', '00FF')).toThrow(PlanError);
  });
});

describe('alt recipes: variants by index (from selectVariant), any encoding', () => {
  const alt: Recipe = {
    id: 'alt',
    name: 'alt',
    kind: 'alt',
    requestId: '70E',
    responseId: '778',
    password: '31347',
    variants: [
      {
        selector: 'MQBAlternativeContainerForUnit09',
        requiresNewBcm: true,
        did: '0600',
        kind: 'ops',
        choices: [{ id: 'on', label: 'On', ops: [{ byte: 0, bit: 0, len: 1, value: 1 }] }],
      },
      {
        selector: 'MQBAlternativeContainerForUnit09',
        requiresNewBcm: false,
        did: '0600',
        kind: 'scalar',
        scalar: { byteOffset: 1, dataLength: 1, multiplier: 1, offset: 0 },
        password: '20103',
      },
    ],
  };
  it('resolves two variants sharing a DID and a selector by index', () => {
    expect(buildApplyPlan(alt, 'on', '0000', { index: 0 })).toMatchObject({
      after: '0100',
      variantIndex: 0,
      password: '31347',
    });
    expect(buildApplyPlan(alt, 'value:7', '0000', { index: 1 })).toMatchObject({
      after: '0007',
      variantIndex: 1,
      password: '20103',
    });
    expect(() => resolveRecipe(alt, 'MQBAlternativeContainerForUnit09')).toThrow(/more than one mapping/);
  });
});

describe('group recipes: per-step actions', () => {
  it('applies the step choice with the group id, or the only choice; "off" restores a single-choice step', () => {
    expect(stepActionFor([{ id: 'enabled' }, { id: 'disabled' }], 'disabled')).toEqual({
      kind: 'apply',
      settingId: 'disabled',
    });
    expect(stepActionFor([{ id: 'apply' }], 'enabled')).toEqual({ kind: 'apply', settingId: 'apply' });
    expect(stepActionFor([{ id: 'apply' }], 'disabled')).toEqual({ kind: 'restore' });
    expect(() => stepActionFor([{ id: 'a' }, { id: 'b' }], 'enabled')).toThrow(PlanError);
  });
  it('plans a single-choice "off" step from the earlier original, or as a no-op without one', () => {
    const step: Recipe = {
      id: 's',
      name: 's',
      kind: 'ops',
      requestId: '714',
      responseId: '77E',
      password: null,
      did: '6001',
      choices: [{ id: 'apply', label: 'Apply', ops: [{ byte: 0, bit: 5, len: 1, value: 1 }] }],
    };
    expect(planGroupStep(step, 'enabled', '00', undefined)).toMatchObject({ action: 'apply', after: '20' });
    expect(planGroupStep(step, 'disabled', 'FF', undefined, '00')).toMatchObject({
      action: 'restore',
      after: 'DF',
    });
    expect(planGroupStep(step, 'disabled', 'FF', undefined)).toMatchObject({ action: 'restore', noop: true });
  });
  it('refuses to plan a group as a single recipe', () => {
    const group: Recipe = {
      id: 'g',
      name: 'g',
      kind: 'group',
      requestId: null,
      responseId: null,
      password: null,
      steps: [],
    };
    expect(() => resolveRecipe(group)).toThrow(PlanError);
    expect(() => groupStepsOf(group)).toThrow(/no parts/);
  });
});

describe('recipe digest', () => {
  it('ignores provenance-only keys, so new metadata never orphans existing backups', async () => {
    expect(await recipeDigest({ ...blinks, passwordSource: 'recipe' } as Recipe)).toBe(
      await recipeDigest(blinks),
    );
    expect(await recipeDigest({ ...blinks, password: '1' } as Recipe)).not.toBe(await recipeDigest(blinks));
  });
});

describe('ops choices conditioned on the block as read (when.bytes) and fill ops', () => {
  const op = (byte: number, value: number) => ({ byte, bit: 0, len: 7, value });
  const slotC = (byte: number, values: number[]) => ({ byte, bit: 0, len: 7, in: values });
  const drl: Recipe = {
    id: 'drl',
    name: 'rear lights with DRL',
    kind: 'ops',
    unit: '09',
    requestId: '70E',
    responseId: '778',
    password: '31347',
    did: '0567',
    choices: [
      {
        id: 'enabled',
        label: 'Enabled',
        ops: [op(7, 0x14), op(9, 70)],
        when: { bytes: [slotC(7, [0, 0x14])] },
      },
      {
        id: 'disabled',
        label: 'Disabled',
        ops: [op(7, 0), op(9, 0)],
        when: { bytes: [slotC(7, [0x14]), slotC(8, [0])] },
      },
      { id: 'disabled', label: 'Disabled', ops: [op(7, 0)], when: { bytes: [slotC(7, [0x14])] } },
      { id: 'disabled', label: 'Disabled', ops: [op(7, 0)], when: { bytes: [slotC(7, [0])] } },
    ],
  };
  const block = (b7: number, b8: number, b9: number) =>
    `2D0A0029080900${[b7, b8, b9].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')}00`;

  it('writes slot C only when it is free or already DRL', () => {
    expect(buildApplyPlan(drl, 'enabled', block(0, 0, 0)).after).toBe(block(0x14, 0, 70));
    expect(() => buildApplyPlan(drl, 'enabled', block(0x05, 0, 0x30))).toThrow(PlanError);
  });

  it('clears DimmwertCD on disable only when FunctionD is free', () => {
    expect(buildApplyPlan(drl, 'disabled', block(0x14, 0, 70)).after).toBe(block(0, 0, 70 & 0x80));
    expect(buildApplyPlan(drl, 'disabled', block(0x14, 0x07, 70)).after).toBe(block(0, 0x07, 70));
    expect(buildApplyPlan(drl, 'disabled', block(0, 0x07, 70)).noop).toBe(true);
    expect(() => buildApplyPlan(drl, 'disabled', block(0x05, 0, 70))).toThrow(PlanError);
  });

  it('a fill op zeroes the whole record, whatever length the module returns', () => {
    const reset: Recipe = {
      id: 'oil',
      name: 'oil reset',
      kind: 'ops',
      unit: '17',
      requestId: '714',
      responseId: '77E',
      password: '47115',
      did: '2243',
      choices: [{ id: 'start', label: 'Reset', ops: [{ byte: 0, bit: 0, len: 8, value: 0, fill: true }] }],
    };
    expect(buildApplyPlan(reset, 'start', '0102030405').after).toBe('0000000000');
    expect(buildApplyPlan(reset, 'start', 'AB').after).toBe('00');
    expect(buildApplyPlan(reset, 'start', '0102030405').owned).toEqual([255, 255, 255, 255, 255]);
  });
});

describe('stray bytes our own write left behind', () => {
  it('flags bytes the module stored differently from what we sent, while the car still holds them', () => {
    // Live 2026-11-02, BCM 055C: we sent 00 at bytes 2 and 9; a truncated frame left 30 and A0 there.
    const before = '0A380022121664000000000000000000';
    const intended = '0A380022121664000000000000000D64'.slice(0, 32);
    const observed = '0A3830221216640000A0000000000D64'.slice(0, 32);
    expect(strayBytes(before, intended, observed, observed)).toEqual([2, 9]);
    // Once the car no longer holds the stray value, nothing is touched.
    expect(strayBytes(before, intended, observed, before)).toEqual([]);
    // Bytes the module stored exactly as sent are never strays.
    expect(strayBytes(before, intended, intended, intended)).toEqual([]);
    expect(strayBytes(before, intended, undefined, observed)).toEqual([]);
  });
});

describe('fog lights as DRL (lamp records 055C/055D, slot C)', () => {
  const group = APP_DATA.recipes['el-drl-with-fog-lights'];
  const left = group?.steps?.[0];
  // Live Kushaq 2Q0937089D: function C (byte 7) and D (byte 8) are free.
  const live055C = '0A380022121664000000000000000000';

  it('sets function C to DRL at full brightness, keeping every other byte', () => {
    if (!left) throw new Error('recipe missing');
    const plan = buildApplyPlan(left, 'enabled', live055C);
    expect(plan.after).toBe('0A380022121664140064000000000000');
  });

  it('turns it off again, and refuses to overwrite a slot C that holds another lamp function', () => {
    if (!left) throw new Error('recipe missing');
    expect(buildApplyPlan(left, 'disabled', '0A380022121664140064000000000000').after).toBe(live055C);
    expect(() => buildApplyPlan(left, 'enabled', '0A380022121664080064000000000000')).toThrow();
  });

  it('keeps bit 7 of the function and brightness bytes', () => {
    if (!left) throw new Error('recipe missing');
    expect(buildApplyPlan(left, 'enabled', '0A380022121664800080000000000000').after).toBe(
      '0A3800221216649400E4000000000000',
    );
  });
});

/**
 * New lamp-record recipes (MQB-A0-IN, BCM 09). Each is planned step by step like 'fog lights as DRL'. Records
 * marked "live" are the Kushaq 2Q0937089D dump (docs/research/REMAINING_FEATURES.md); 0564/0566/0569 have not
 * been read on the car yet, so those fixtures follow the read records' shape with the brake/position function
 * in A (the recipes check A where they rely on it).
 */
describe('new lamp-record recipes', () => {
  const step = (id: string, i?: number) => {
    const r = APP_DATA.recipes[id];
    if (!r) throw new Error(`${id} missing`);
    const s = i === undefined ? r : groupStepsOf(r)[i];
    if (!s) throw new Error(`${id} step ${i} missing`);
    return s;
  };
  const refuses = (r: Recipe, setting: string, before: string) =>
    expect(() => buildApplyPlan(r, setting, before)).toThrow(/already used for something else/);

  describe('third brake light (0566)', () => {
    const rec0566 = '2D0C002B18007F000000000000000000';

    it('when the tailgate is open: slot C = 0x21 at 100%, and back', () => {
      const r = step('el-third-brake-light-trunk-open');
      expect(buildApplyPlan(r, 'enabled', rec0566).after).toBe('2D0C002B18007F210064000000000000');
      expect(buildApplyPlan(r, 'enabled', '2D0C002B18007F210064000000000000').after).toBe(
        '2D0C002B18007F210064000000000000',
      );
      expect(buildApplyPlan(r, 'disabled', '2D0C002B18007F210064000000000000').after).toBe(rec0566);
      // Function A is not the brake light: not the lamp the recipe expects.
      refuses(r, 'enabled', '2D0C002B08007F000000000000000000');
      // Slot D taken.
      refuses(r, 'enabled', '2D0C002B18007F000900000000000000');
    });

    it('with DRL: slot E = 0x14 at 10%, and back; refuses an occupied slot E', () => {
      const r = step('el-third-brake-light-drl');
      expect(buildApplyPlan(r, 'enabled', rec0566).after).toBe('2D0C002B18007F00000014000A000000');
      expect(buildApplyPlan(r, 'disabled', '2D0C002B18007F00000014000A000000').after).toBe(rec0566);
      refuses(r, 'enabled', '2D0C002B18007F00000006009C000000');
    });

    it('with coming/leaving home: slot G = 0x1E at 100%, and back; refuses an occupied slot G', () => {
      const r = step('el-third-brake-light-ch-lh');
      expect(buildApplyPlan(r, 'enabled', rec0566).after).toBe('2D0C002B18007F0000000000001E0064');
      expect(buildApplyPlan(r, 'disabled', '2D0C002B18007F0000000000001E0064').after).toBe(rec0566);
      refuses(r, 'enabled', '2D0C002B18007F000000000000000D00');
    });
  });

  it('brake lights when the tailgate is open (0564/0565): slot C on each lamp, and back', () => {
    const rec0564 = '2D0B002A18007F000000000000000000';
    expect(groupStepsOf(APP_DATA.recipes['el-brake-lights-trunk-open'] as Recipe).map((s) => s.did)).toEqual([
      '0564',
      '0565',
    ]);
    const left = step('el-brake-lights-trunk-open', 0);
    const right = step('el-brake-lights-trunk-open', 1);
    expect(buildApplyPlan(left, 'enabled', rec0564).after).toBe('2D0B002A18007F210064000000000000');
    expect(buildApplyPlan(right, 'disabled', '2D0B002A18007F210064000000000000').after).toBe(rec0564);
    refuses(left, 'enabled', '2D0B002A18007F000900000000000000');
    refuses(right, 'enabled', '2D0B002A08007F000000000000000000');
  });

  it('tail lights when the tailgate is open (live 0567): slot E, leaving A/B and slot C alone', () => {
    const live0567 = '2D0A002908097F000000000000000000';
    const left = step('el-taillights-trunk-open', 0);
    expect(buildApplyPlan(left, 'enabled', live0567).after).toBe('2D0A002908097F000000210064000000');
    // Scandinavian DRL in slot C stays.
    expect(buildApplyPlan(left, 'enabled', '2D0A002908097F140064000000000000').after).toBe(
      '2D0A002908097F140064210064000000',
    );
    expect(buildApplyPlan(left, 'disabled', '2D0A002908097F000000210064000000').after).toBe(live0567);
    // A is not the tail light function.
    refuses(left, 'enabled', '2D0A002918097F000000000000000000');
  });

  it('number plate light when the tailgate is open (0569): on, off-when-open and default', () => {
    const rec0569 = '2D0E002D08007F000000000000000000';
    const r = step('el-license-plate-trunk-open');
    expect(buildApplyPlan(r, 'enabled', rec0569).after).toBe('2D0E002D08007F210064000000000000');
    expect(buildApplyPlan(r, 'off-when-open', rec0569).after).toBe('2D0E002D08007F210080000000000000');
    expect(buildApplyPlan(r, 'off-when-open', '2D0E002D08007F210064000000000000').after).toBe(
      '2D0E002D08007F210080000000000000',
    );
    expect(buildApplyPlan(r, 'disabled', '2D0E002D08007F210080000000000000').after).toBe(rec0569);
    // Slot C holds a door-exit function.
    refuses(r, 'enabled', '2D0E002D08007F380064000000000000');
  });

  it('number plate light with DRL (0569): slot E = 0x14 at 100%, and back', () => {
    const rec0569 = '2D0E002D08007F000000000000000000';
    const r = step('el-license-plate-drl');
    expect(buildApplyPlan(r, 'enabled', rec0569).after).toBe('2D0E002D08007F000000140064000000');
    expect(buildApplyPlan(r, 'disabled', '2D0E002D08007F000000140064000000').after).toBe(rec0569);
    refuses(r, 'enabled', '2D0E002D08007F000000000600000000');
  });

  it('front indicators with coming home (live 0550): slot G = 0x1E, and back; checks it is the left lamp', () => {
    const live0550 = '0C340014020064000000000000000000';
    const left = step('el-turn-signals-ch-lh', 0);
    expect(buildApplyPlan(left, 'enabled', live0550).after).toBe('0C3400140200640000000000001E0064');
    expect(buildApplyPlan(left, 'disabled', '0C3400140200640000000000001E0064').after).toBe(live0550);
    expect(
      buildApplyPlan(step('el-turn-signals-ch-lh', 1), 'enabled', '0C350015040064000000000000000000').after,
    ).toBe('0C3500150400640000000000001E0064');
    // The right-hand function (0x04) in the left record.
    refuses(left, 'enabled', '0C340014040064000000000000000000');
  });

  it('fog lights off with high beam (live 055C/055D): slot G = high beam at 0%, minimise, and back', () => {
    const live055C = '0A380022121664000000000000000000';
    const left = step('el-fogs-off-with-high-beam', 0);
    expect(buildApplyPlan(left, 'enabled', live055C).after).toBe('0A3800221216640000000000000D0080');
    expect(buildApplyPlan(left, 'enabled', '0A3800221216640000000000000D0080').after).toBe(
      '0A3800221216640000000000000D0080',
    );
    expect(buildApplyPlan(left, 'disabled', '0A3800221216640000000000000D0080').after).toBe(live055C);
    expect(
      buildApplyPlan(step('el-fogs-off-with-high-beam', 1), 'enabled', '0A420023131764000000000000000000')
        .after,
    ).toBe('0A4200231317640000000000000E0080');
    // Fog Lights with High Beam (G = 0x0D at 100%) or flash-to-pass (H) already set: refuse both ways.
    refuses(left, 'enabled', '0A3800221216640000000000000D0064');
    refuses(left, 'disabled', '0A3800221216640000000000000D0064');
    refuses(left, 'enabled', '0A380022121664000000000000000F64');
  });

  it('full-bright side lights (live 0552/0553): dim CD 0x1C -> 0x64, and back; refuses an unknown record', () => {
    const live0552 = '0448004A14006408091C06009C000000';
    const left = step('el-drl-with-parking-lights', 0);
    expect(buildApplyPlan(left, 'enabled', live0552).after).toBe('0448004A14006408096406009C000000');
    expect(buildApplyPlan(left, 'disabled', '0448004A14006408096406009C000000').after).toBe(live0552);
    expect(
      buildApplyPlan(step('el-drl-with-parking-lights', 1), 'enabled', '044C004C140064080A1C07009C000000')
        .after,
    ).toBe('044C004C140064080A6407009C000000');
    // Another dim value, or slot C not the position light.
    refuses(left, 'enabled', '0448004A14006408093206009C000000');
    refuses(left, 'enabled', '0448004A14006400091C06009C000000');
  });
});

describe('comfort turn signals on the MQB family (el-comfort-turn-signals)', () => {
  const r = APP_DATA.recipes['el-comfort-turn-signals'];

  it('writes 0A5E on a new BCM and 0D00 (bit 7 set) on an old one', () => {
    if (!r) throw new Error('recipe missing');
    const newBcm = selectVariant(r, { reads: {}, read0600Unit09: '000000000000' });
    const oldBcm = selectVariant(r, { reads: {}, read0600Unit09: '4600C0000001' });
    if (!newBcm.ok || !oldBcm.ok) throw new Error('variant not settled');
    expect(newBcm.variant.did).toBe('0A5E');
    expect(oldBcm.variant.did).toBe('0D00');
    expect(buildApplyPlan(r, 'value-3', '0000000000', { index: newBcm.index }).after).toBe('1200000000');
    expect(buildApplyPlan(r, 'value-3', '0000000000', { index: oldBcm.index }).after).toBe('8200000000');
  });

  it('refuses when the BCM generation is not settled', () => {
    if (!r) throw new Error('recipe missing');
    expect(() => buildApplyPlan(r, 'value-3', '0000000000')).toThrow(PlanError);
  });
});

describe('audit guards on changed recipes', () => {
  it('car settings while moving (csadapt-10335) writes only on MIB3', () => {
    const r = APP_DATA.recipes['csadapt-10335'];
    if (!r) throw new Error('recipe missing');
    const mib3 = selectVariant(r, { reads: { '0B1B': '00'.repeat(30) }, isMib3: true });
    if (!mib3.ok) throw new Error('MIB3 not settled');
    expect(buildApplyPlan(r, 'res-enable', '00'.repeat(30), { index: mib3.index }).after).toBe(
      `${'00'.repeat(23)}20${'00'.repeat(6)}`,
    );
    expect(selectVariant(r, { reads: { '0B1B': '00'.repeat(30) }, isMib3: false }).ok).toBe(false);
    expect(selectVariant(r, { reads: { '0B1B': '00'.repeat(30) } }).ok).toBe(false);
  });

  it('anti-theft alarm (wl-anti-theft-alarm) refuses "on" when a siren is set', () => {
    const first = groupStepsOf(APP_DATA.recipes['wl-anti-theft-alarm'] as Recipe)[0];
    if (!first) throw new Error('step missing');
    const newBcm = selectVariant(first, { reads: {}, read0600Unit09: '000000000000' });
    if (!newBcm.ok) throw new Error('variant not settled');
    expect(buildApplyPlan(first, 'enabled', '0000', { index: newBcm.index }).after).toBe('0012');
    expect(() => buildApplyPlan(first, 'enabled', '0020', { index: newBcm.index })).toThrow(PlanError);
  });
});
