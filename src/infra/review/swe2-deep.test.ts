/**
 * Promoted unchanged from docs/reviews/2026-10-25/swe2-deep/regressions.test.ts (independent review of d9fe994):
 * only the import paths differ. Each case asserts the desired behaviour of a reproduced defect.
 */
import { expect, it } from 'vitest';
import { APP_DATA } from '../../domain/catalog/data.ts';
import { buildApplyPlan, trustedOwnedMask } from '../../domain/coding/plan.ts';
import { reassemble } from '../../../packages/obd-core/src/can/isotp.ts';
import { parseFrameLine } from '../../../packages/obd-core/src/can/frames.ts';
import { SimulatedCar } from '../../infra/link/simulator.ts';
import { runSession } from '../../domain/coding/run.ts';
import { findFeature } from '../../domain/catalog/features.ts';
import { statusFor } from '../../domain/catalogue/status.ts';
import { BackupSchema } from '../../domain/backups/schema.ts';
import { segmentDiagnosticPdu, exchangeUds } from '../../../packages/obd-core/src/elm/uds.ts';
import { createDemoCar } from '../../infra/link/demo.ts';
import { scriptedRig } from '../../../packages/obd-core/test/scripted.ts';
import { buildCatalogue } from '../../domain/catalogue/data.ts';
import rawCatalogue from '../../data/catalogue.json';

it('dataset trusted mask should equal its apply mask', () => {
  const recipe = APP_DATA.recipes['csmqb-mib3-sound-signature']!;
  const p = buildApplyPlan(recipe, recipe.choices![0]!.id, 'FF'.repeat(2052));
  expect(trustedOwnedMask(recipe, 2052)).toEqual(p.owned);
});

it('CRC trusted mask should include its checksum trailer', () => {
  const recipe = APP_DATA.recipes['csmqb-vim-mib3-speed-threshold']!;
  const p = buildApplyPlan(recipe, recipe.choices![0]!.id, '00'.repeat(34));
  expect(trustedOwnedMask(recipe, 34)).toEqual(p.owned);
});

it('conflicting duplicate CF must not produce a complete response', () => {
  const raw = ['778 10 14 62 06 00 01 02 03', '778 21 04 05 06 07 08 09 0A',
    '778 21 FF FF FF FF FF FF FF', '778 22 0B 0C 0D 0E 0F 10 11'];
  const frames = raw.map(line => parseFrameLine(line, {family:'can11', headers:true})!);
  expect(reassemble(frames, 'can11').some(m => m.complete)).toBe(false);
});

it('a module snapshot should not consume the readiness window and prevent coding', async () => {
  let t = Date.UTC(2026, 9, 25);
  const now = () => new Date(t);
  const car = {brand:'skoda', model:'kushaq', variant:'monte-carlo', year:2023, cluster:'digital'} as const;
  const feature = findFeature(car, 'comfort-lane-change-indicator-5-flashes')!;
  const link = new SimulatedCar({now, parts:{'70E':'2Q0937089D'}, values:{'70E:0A5E':'3A00000000'}});
  const read = link.readDid.bind(link);
  let scanReads = 0;
  link.readDid = async (mod, did) => { if(did !== 'F187' && did !== '0A5E'){t += 150; scanReads++;} return read(mod,did); };
  const events = [];
  for await (const e of runSession({kind:'apply', car, feature, settingId:'value-5'}, {
    link, now, backups:{save:async()=>{}, update:async()=>{}}, signal:new AbortController().signal,
    readbackDelayMs:0, sleep:async()=>{},
  })) events.push(e);
  expect(scanReads).toBeGreaterThan(200);
  expect(events.find(e=>e.type==='outcome')).toMatchObject({outcome:'verified'});
});

it('unmapped catalogue items must not claim codability', () => {
  const result = statusFor({slug:'missing-recipe',name:'Missing recipe'} as any,
    {isUsersCar:true,items:new Map()} as any);
  expect(result.kind).not.toBe('codable');
});

it('the journal must accept the TX frames of its bundled dataset', () => {
  const r = APP_DATA.recipes['csmqb-mib3-sound-signature']!;
  const hex = '2E' + r.did + r.choices![0]!.payload;
  const bytes = hex.match(/../g)!.map(b=>parseInt(b,16));
  const frames = segmentDiagnosticPdu(bytes).map(f=>f.map(b=>b.toString(16).toUpperCase().padStart(2,'0')).join(''));
  expect(frames.length).toBe(294);
  expect(BackupSchema.shape.txFrames.safeParse(frames).success).toBe(true);
});

it('new dataset recipe should work in the advertised demo flow', () => {
  const recipe = APP_DATA.recipes['csmqb-mib3-sound-signature']!;
  expect(()=>createDemoCar({id:'sound', name:'Sound', tier:'experimental', statusLabel:'Experimental',
    recipeId:recipe.id,settings:[]} as any, recipe.choices![0]!.id)).not.toThrow();
});

it('positive control: existing blink plan retains its trusted mask', () => {
  const r = APP_DATA.recipes['live-bcm-polite-blinks']!;
  expect(trustedOwnedMask(r,5)).toEqual(buildApplyPlan(r,'value-5','3A00000000').owned);
});

it('the shipped catalogue must load', () => {
  expect(()=>buildCatalogue(rawCatalogue)).not.toThrow();
});

it('a request that reached the transport must not vanish from failure evidence', async () => {
  const r = scriptedRig(()=> '');
  const original = r.elm.write.bind(r.elm);
  r.elm.write = async bytes => {
    await original(bytes);
    if(new TextDecoder().decode(bytes).startsWith('042E060001')) throw new Error('link lost after submission');
  };
  const token = r.link.policy.issueCodingToken('2E060001','746');
  let caught:any;
  try { await r.run(exchangeUds(r.link,[0x2e,6,0,1],{target:'746',responseId:'7B0',codingToken:token})); }
  catch(e){caught=e;}
  expect(r.elm.sentTo('746')).toContain('042E060001000000');
  expect(caught.requestStarted).toBe(true);
  expect(caught.txFrames).not.toHaveLength(0);
});
