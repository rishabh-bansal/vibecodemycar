import { describe, expect, it } from 'vitest';
import type { CodingRecipe, RecipeVariantSpec } from './types.ts';
import {
  isMib3Identity,
  isNewGenBcm,
  matchesDevicePattern,
  selectVariant,
  variantProbePlan,
} from './variant-select.ts';

const field = { byteOffset: 0, bitOffset: 0, bitLength: 1, byteOrder: 'big' as const };
const choices = [
  { id: 'enabled', label: 'On', value: 1 },
  { id: 'disabled', label: 'Off', value: 0 },
];
const v = (selector: string, did: string, extra: Partial<RecipeVariantSpec> = {}): RecipeVariantSpec => ({
  selector,
  did,
  kind: 'field',
  field,
  choices,
  ...extra,
});
const recipe = (...variants: RecipeVariantSpec[]): Pick<CodingRecipe, 'variants'> => ({ variants });
const ascii = (s: string) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');

describe('unit-09 generation (MQBAlternativeContainerForUnit09, new-bcm / old-bcm)', () => {
  it('is new generation when 0600 has at least len-1 zero bytes, or is not hosted', () => {
    expect(isNewGenBcm(undefined)).toBe(true);
    expect(isNewGenBcm('')).toBe(true);
    expect(isNewGenBcm('00000000')).toBe(true);
    expect(isNewGenBcm('00000100')).toBe(true);
    expect(isNewGenBcm('00010100')).toBe(false);
    expect(isNewGenBcm('4600C0000001')).toBe(false);
  });

  it('decides a same-DID pair by the zero-run rule (the pairs probeVariant always refused)', () => {
    const r = recipe(
      v('MQBAlternativeContainerForUnit09', '0600', {
        requiresNewBcm: true,
        field: { ...field, byteOffset: 3 },
      }),
      v('MQBAlternativeContainerForUnit09', '0600', {
        requiresNewBcm: false,
        field: { ...field, byteOffset: 12 },
      }),
    );
    const reads = { '0600': '4600C0000001' };
    expect(selectVariant(r, { reads, read0600Unit09: '4600C0000001' })).toMatchObject({ ok: true, index: 1 });
    expect(selectVariant(r, { reads, read0600Unit09: '000000000000' })).toMatchObject({ ok: true, index: 0 });
    expect(selectVariant(r, { reads: {} })).toMatchObject({ ok: true, index: 0 });
  });

  it('trusts the selector name over the extractor’s requiresNewBcm:false on new-bcm', () => {
    const r = recipe(
      v('new-bcm', '0D07', { requiresNewBcm: false }),
      v('old-bcm', '0600', { requiresNewBcm: false }),
    );
    // Both DIDs answer — old probeVariant refused this; the generation decides.
    const reads = { '0D07': '0000', '0600': '4600C0000001' };
    expect(selectVariant(r, { reads, read0600Unit09: '4600C0000001' })).toMatchObject({ ok: true, index: 1 });
    expect(selectVariant(r, { reads, read0600Unit09: '0000000000' })).toMatchObject({ ok: true, index: 0 });
  });
});

describe('MIB2.5 / MIB3', () => {
  it('reads IsMIB3 from the ASAM / F19E dataset name', () => {
    expect(isMib3Identity(ascii('EV_MUOIMQB 001'))).toBe(true);
    expect(isMib3Identity('EV_MUCNSMQB')).toBe(true);
    expect(isMib3Identity(ascii('EV_MUStd4CPA'))).toBe(false);
    expect(isMib3Identity(undefined)).toBeUndefined();
  });
  it('selects by generation, first match in order', () => {
    const r = recipe(v('mib25', '7201'), v('mib3', '7201'));
    expect(selectVariant(r, { reads: {}, isMib3: true })).toMatchObject({ ok: true, index: 1 });
    expect(selectVariant(r, { reads: {}, isMib3: false })).toMatchObject({ ok: true, index: 0 });
  });
  it('with the generation unknown, a shared DID that answered decides nothing', () => {
    // 0600 answers on every head unit: picking the MIB2.5 layout on a MIB3 would mis-write its coding.
    const r = recipe(v('mib25', '0600'), v('mib3', '0556'));
    expect(selectVariant(r, { reads: { '0600': '01' } })).toMatchObject({ ok: false });
    expect(selectVariant(r, { reads: { '0600': '01' } })).toMatchObject({
      detail: expect.stringContaining('infotainment generation'),
    });
  });
  it('with the generation unknown, a DID only that generation hosts decides', () => {
    const r = recipe(v('mib25', '0600'), v('mib3', '0556'));
    expect(selectVariant(r, { reads: { '0600': '01', '0556': '02' } })).toMatchObject({ ok: true, index: 1 });
  });
});

describe('device patterns and plain alternatives', () => {
  it('matches F187 part patterns with * and ?', () => {
    expect(matchesDevicePattern('2Q0937089?', '2Q0937089D')).toBe(true);
    expect(matchesDevicePattern('5Q0*', '5QR909144C')).toBe(false);
    expect(matchesDevicePattern('5Q*', '5QR909144C')).toBe(true);
    const r = recipe(v('x', '0574', { devicePattern: '6JM*' }), v('y', '1304'));
    expect(selectVariant(r, { reads: { '1304': '01' }, part: '6JM920310' })).toMatchObject({ index: 0 });
    expect(selectVariant(r, { reads: { '1304': '01' }, part: '2Q0937089D' })).toMatchObject({ index: 1 });
  });
  it('matches like CheckDevice: *pattern* against F187 or F191, punctuation and spaces stripped', () => {
    expect(matchesDevicePattern('*2Q*980653*', '2Q0 980 653 B')).toBe(true);
    expect(matchesDevicePattern('3Q*980654', 'X3Q0980654A')).toBe(true);
    const r = recipe(
      v('device', '0600', { devicePattern: '*3Q*980654*' }),
      v('device', '0600', { devicePattern: '*2Q*980653*' }),
    );
    // A 2Q0 camera reports its software part 2Q0980654x in F187; its hardware number 2Q0980653 is in F191.
    expect(
      selectVariant(r, { reads: { '0600': '00' }, part: '2Q0 980 654 E', hardware: '2Q0 980 653 B' }),
    ).toMatchObject({ ok: true, index: 1 });
    expect(selectVariant(r, { reads: { '0600': '00' }, part: '2Q0980654E' })).toMatchObject({ ok: false });
  });
  it('takes the FIRST variant whose DID answers (ordered first match, never "matches more than one")', () => {
    const r = recipe(v('MQBAlternativeContainer', '0574'), v('MQBAlternativeContainer', '1304'));
    expect(selectVariant(r, { reads: { '0574': '07', '1304': '07' } })).toMatchObject({ ok: true, index: 0 });
    expect(selectVariant(r, { reads: { '1304': '07' } })).toMatchObject({ ok: true, index: 1 });
  });
  it('refuses only a genuine no-match', () => {
    const r = recipe(v('mqb-alt-0574', '0574'), v('mqb-alt-1304', '1304'));
    expect(selectVariant(r, { reads: {} })).toMatchObject({ ok: false });
  });
  it('says which reads it needs', () => {
    expect(
      variantProbePlan(
        recipe(
          v('new-bcm', '0D07'),
          v('old-bcm', '0600'),
          v('mib3', '7201'),
          v('z', '0574', { devicePattern: '1*' }),
        ),
      ),
    ).toEqual({
      dids: ['0D07', '0600', '7201', '0574'],
      needs0600Unit09: true,
      needsIdentity: true,
      needsPart: true,
    });
  });
});
