import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { OBDCraftEngine, Elm327Emulator, SafetyPolicy, VirtualClock, classify, runVirtual } from '@obdcraft/obd-core';
import { CATALOGUE, CodingBenchEcu, CodingSession, DEMO_RECIPES, DEMO_BLOCK_PACK, codingBenchEcus, compatibility, featuresFor, probeModule, readModuleCodingBackup, parseDefinitionPack, reviewDefinitionPack, recipesFromDefinitionPack, ownedMask, ownedMaskOps, opsHold, patchCodingBlock, patchOpsBlock, patchScalarBlock, validateCodingBlock, validateCodingRestore, readModuleDid, type CodingJournal } from '../src/index.ts';

async function rig(persist?: (journal: CodingJournal) => Promise<void>) {
  const clock = new VirtualClock(), module = new CodingBenchEcu(), transport = new Elm327Emulator({ clock, ecus: codingBenchEcus(module), protocol: 6, voltage: () => 13.2, id: 'coding-test' });
  const engine = new OBDCraftEngine({ clock }), run = <T>(task: Promise<T>) => runVirtual(clock, task);
  await run(engine.connect(transport));
  const journal: CodingJournal[] = [];
  const session = new CodingSession(engine, DEMO_RECIPES, persist ?? (async record => { journal.push({ ...record }); }), async vin => createHash('sha256').update(vin).digest('hex'));
  return { clock, module, transport, engine, run, journal, session, recipe: DEMO_RECIPES[0]! };
}

describe('readModuleDid', () => {
  it('says it is not connected instead of crashing on a missing link', async () => {
    await expect(readModuleDid(new OBDCraftEngine(), '70E', '778', 0x0a5e)).rejects.toThrow('Not connected');
  });
});

describe('source catalogue', () => {
  it('covers all published feature pages and keeps build hardware separate from executable recipes', () => {
    expect(CATALOGUE.features).toHaveLength(59);
    expect(CATALOGUE.builds).toHaveLength(66);
    expect(new Set(CATALOGUE.features.map(f => f.id)).size).toBe(59);
    expect(DEMO_RECIPES.every(r => r.demoOnly)).toBe(true);
    for (const build of CATALOGUE.builds) expect(featuresFor(build.id).length).toBe(build.features.length);
    const before = CATALOGUE.builds.find(b => b.model === 'kushaq' && b.hardware.Manufactured === 'Before April 2024')!;
    expect(compatibility(before, { make: 'Skoda', model: 'Kushaq', buildMonth: '2025-01' })).toHaveLength(1);
  });
});

describe('exact-command permits', () => {
  it('refuses unguarded writes, wrong targets, reuse, flashing and security access', () => {
    const policy = new SafetyPolicy();
    expect(() => policy.check('2EF50001', { family: 'can11', target: '7A0' })).toThrow();
    const token = policy.issueCodingToken('2EF50001', '7A0');
    expect(() => policy.check('2EF50001', { family: 'can11', target: '7E0' }, undefined, token)).toThrow();
    expect(() => policy.check('2EF50001', { family: 'can11', target: '7A0' }, undefined, token)).toThrow();
    const valid = policy.issueCodingToken('2EF50001', '7A0');
    expect(() => policy.check('2EF50001', { family: 'can11', target: '7A0' }, undefined, valid)).not.toThrow();
    expect(() => policy.check('2EF50001', { family: 'can11', target: '7A0' }, undefined, valid)).toThrow();
    for (const command of ['2701', '31010100', '3400', '360001']) expect(() => policy.check(command, { family: 'can11', target: '7A0' })).toThrow();
    expect(() => policy.issueCodingToken('2EF50001', '7DF')).toThrow();
    expect(() => policy.issueCodingToken('2EF500' + '01'.repeat(4093), '7A0')).toThrow();
  });
  it('does not accept a reply for a different data identifier', () => {
    expect(classify({ service: 0x22, params: [0xf5, 0] }, { ecu: '7A8', bytes: [0x62, 0xf5, 1, 0], complete: true } as Parameters<typeof classify>[1]).kind).toBe('foreign');
  });
});

describe('guarded prepare, backup, write, verification and restoration', () => {
  it('reads explicitly addressed identity without sending a write or security request', async () => {
    const r = await rig();
    const identity = await r.run(probeModule(r.engine, '7a0', '7a8'));
    expect(identity).toMatchObject({ part: 'OBDCRAFT-DEMO', softwareNumber: 'DEMO-SW-1', software: 'SIM-1', hardware: 'DEMO-HW-1', odxFile: 'EV_OBDCraftBench_001', odxVersion: '001001' });
    expect(identity.notes).toHaveLength(0);
    expect(r.module.writes).toBe(0);
    expect(r.transport.log.some(entry => /^(27|2E|31)/.test(entry.cmd))).toBe(false);
    expect(r.transport.log.some(entry => entry.cmd.startsWith('0322F19E'))).toBe(true);
    expect(r.transport.log.some(entry => entry.cmd.startsWith('0322F1A2'))).toBe(true);
    expect(r.engine.link!.config.target).toBe('functional');
    await r.run(r.engine.disconnect());
  });
  it('saves original bytes before the write, reads back the result, then restores on explicit confirmation', async () => {
    const r = await rig();
    const preview = await r.run(r.session.prepare(r.recipe.id, true));
    expect(preview).toMatchObject({ before: '00', after: '01', part: 'OBDCRAFT-DEMO', voltage: 13.2, demo: true });
    expect(r.module.writes).toBe(0);
    await expect(r.run(r.session.apply(preview.id, 'wrong', true))).rejects.toThrow('Type APPLY');
    const result = await r.run(r.session.apply(preview.id, 'APPLY', true));
    expect(r.journal.map(j => j.status)).toEqual(['prepared', 'applied']);
    expect(result.status).toBe('applied'); expect(r.module.writes).toBe(1);
    await expect(r.run(r.session.prepare(r.recipe.id, false, { ...result, did: result.did + 1 }))).rejects.toThrow('setting identifier');
    expect(r.module.writes).toBe(1);
    await expect(r.run(r.session.prepare(r.recipe.id, false, { ...result, vehicleHash: '0'.repeat(64) }))).rejects.toThrow('vehicle');
    expect(JSON.stringify(result)).not.toContain('TMBDEMO0OBDCRAFT1');
    const restored = await r.run(r.session.prepare(r.recipe.id, false, result));
    expect((await r.run(r.session.apply(restored.id, 'RESTORE', true))).status).toBe('restored');
    expect(r.module.values.get(r.recipe.did)).toBe(0);
    expect(r.engine.link!.config.target).toBe('functional');
    await r.run(r.engine.disconnect());
  });
  it('a failed durable backup prevents every write', async () => {
    const r = await rig(async () => { throw new Error('quota exceeded'); });
    const preview = await r.run(r.session.prepare(r.recipe.id, true));
    await expect(r.run(r.session.apply(preview.id, 'APPLY', true))).rejects.toThrow('quota exceeded');
    expect(r.module.writes).toBe(0);
    await r.run(r.engine.disconnect());
  });
  it('does not retry or claim success after a read-back mismatch', async () => {
    const r = await rig();
    const preview = await r.run(r.session.prepare(r.recipe.id, true)); r.module.failReadback = true;
    await expect(r.run(r.session.apply(preview.id, 'APPLY', true))).rejects.toThrow('Read-back');
    expect(r.module.writes).toBe(1); expect(r.journal.at(-1)!.status).toBe('uncertain');
    await r.run(r.engine.disconnect());
  });
  it('rechecks settings and rejects stale previews instead of overwriting another change', async () => {
    const r = await rig();
    const preview = await r.run(r.session.prepare(r.recipe.id, true));
    r.module.values.set(r.recipe.did, 1);
    await expect(r.run(r.session.apply(preview.id, 'APPLY', true))).rejects.toThrow('setting changed');
    expect(r.module.writes).toBe(0);
    await r.run(r.engine.disconnect());
  });
  it('a simulation recipe can never run on a real-transport type', async () => {
    const r = await rig();
    Object.defineProperty(r.transport, 'kind', { value: 'ble' });
    await expect(r.run(r.session.prepare(r.recipe.id, true))).rejects.toThrow('simulator only');
    expect(r.module.writes).toBe(0);
    await r.run(r.engine.disconnect());
  });
});

describe('definition review and complete-block transactions', () => {
  it('collects an identified complete coding block without executing a write', async () => {
    const r = await rig();
    const backup = await r.run(readModuleCodingBackup(r.engine, '7A0', '7A8'));
    expect(backup).toMatchObject({ schema: 'obdcraft.module-coding-backup/1', did: 0x0600, byteLength: 32, executable: false });
    expect(backup.codingHex).toHaveLength(64);
    expect(r.module.writes).toBe(0);
    expect(r.engine.link!.config.target).toBe('functional');
    await r.run(r.engine.disconnect());
  });
  it('requires a separate review, rejects identity overrides, reserved identifier writes and invalid field bounds', () => {
    const pack = parseDefinitionPack(JSON.stringify(DEMO_BLOCK_PACK));
    expect(() => recipesFromDefinitionPack(pack)).toThrow('Review');
    expect(() => reviewDefinitionPack(pack, 'yes')).toThrow('exact package ID');
    reviewDefinitionPack(pack, pack.id);
    expect(recipesFromDefinitionPack(pack)[0]?.block?.length).toBe(32);
    for (const mutate of [
      (p: typeof DEMO_BLOCK_PACK) => Object.assign(p.definitions[0]!.identity, { target: '713' }),
      (p: typeof DEMO_BLOCK_PACK) => { p.definitions[0]!.did = 0xf190; },
      (p: typeof DEMO_BLOCK_PACK) => { p.definitions[0]!.block.field!.byteOffset = 32; },
    ]) {
      const invalid = structuredClone(DEMO_BLOCK_PACK); mutate(invalid);
      expect(() => parseDefinitionPack(JSON.stringify(invalid))).toThrow();
    }
  });

  it('patches only selected bits, supports fields across bytes and refuses unrelated restore bytes', () => {
    const block = DEMO_BLOCK_PACK.definitions[0]!.block;
    const before = Array.from({ length: 32 }, (_, i) => i === 11 ? '00' : 'A5').join('');
    const changed = patchCodingBlock(before, block, 'enabled');
    expect(changed.changes).toEqual([{ offset: 11, before: 0, after: 64, mask: 64 }]);
    expect(patchCodingBlock(changed.after, block, 'disabled').after).toBe(before);
    expect(() => validateCodingRestore(changed.after, 'FF' + before.slice(2), block)).toThrow();
    const wide = { length: 3, field: { byteOffset: 0, bitOffset: 4, bitLength: 8, byteOrder: 'little' as const, choices: [
      { id: 'old', label: 'Old', value: 0 }, { id: 'new', label: 'New', value: 0xab },
    ] } };
    expect(patchCodingBlock('05F077', wide, 'new').after).toBe('B5FA77');
    expect(patchCodingBlock('05F077', { ...wide, field: { ...wide.field, byteOrder: 'big', choices: [
      { id: 'old', label: 'Old', value: 0x5f }, { id: 'new', label: 'New', value: 0xab },
    ] } }, 'new').after).toBe('0AB077');
    expect(() => patchCodingBlock('05F077', { ...wide, length: 4 }, 'new')).toThrow('length');
  });

  it('applies a constant write that shares bits with the field after the field value, inside the owned mask', () => {
    // BE field: byte 0 bits 0–3 + byte 1 bits 4–7. A constant at byte 1 bit 5 sits inside it and wins.
    const field = { byteOffset: 0, bitOffset: 4, bitLength: 8, byteOrder: 'big' as const, choices: [
      { id: 'a', label: 'A', value: 0 }, { id: 'b', label: 'B', value: 0xff },
    ] };
    const block = { length: 2, field, auxWrites: [{ byteOffset: 1, bitOffset: 5, bitLength: 1, value: 0 }] };
    expect(() => validateCodingBlock(block)).not.toThrow();
    expect(patchCodingBlock('0000', block, 'b').after).toBe('0FD0');
  });

  it('accepts constant writes of any width inside one byte, and refuses one that crosses a byte', () => {
    const field = { byteOffset: 0, bitOffset: 0, bitLength: 1, byteOrder: 'big' as const, choices: [
      { id: 'off', label: 'Off', value: 0 }, { id: 'on', label: 'On', value: 1 },
    ] };
    const block = { length: 2, field, auxWrites: [{ byteOffset: 1, bitOffset: 2, bitLength: 3, value: 5 }] };
    expect(patchCodingBlock('00FF', block, 'on').after).toBe('01F7');
    expect(ownedMask(block)).toEqual([0x01, 0x1c]);
    expect(() => validateCodingBlock({ ...block, auxWrites: [{ byteOffset: 1, bitOffset: 6, bitLength: 3, value: 0 }] })).toThrow('constant write');
  });

  it('writes over an undeclared current value and restores an undeclared original inside the mask', () => {
    const block = { length: 1, field: { byteOffset: 0, bitOffset: 0, bitLength: 2, byteOrder: 'big' as const, choices: [
      { id: 'on', label: 'On', value: 1 },
    ] } };
    // Single-choice field: an "apply" action. Current value 3 is declared by no choice.
    expect(patchCodingBlock('F3', block, 'on').after).toBe('F1');
    expect(() => validateCodingRestore('F1', 'F2', block)).not.toThrow();
    expect(() => validateCodingRestore('F1', '02', block)).toThrow('outside');
  });

  it('applies ops in order, owns the union of every choice, and spans bytes big-endian', () => {
    const on = [{ byte: 0, bit: 3, len: 1, value: 1 }, { byte: 1, bit: 0, len: 8, value: 0x2a }];
    const off = [{ byte: 0, bit: 3, len: 1, value: 0 }, { byte: 2, bit: 4, len: 2, value: 2 }];
    expect(patchOpsBlock('000000', on)).toEqual({
      after: '082A00',
      changes: [{ offset: 0, before: 0, after: 8, mask: 8 }, { offset: 1, before: 0, after: 0x2a, mask: 0xff }],
    });
    expect(patchOpsBlock('FFFFFF', off).after).toBe('F7FFEF');
    expect(ownedMaskOps(3, [on, off])).toEqual([0x08, 0xff, 0x30]);
    // A 12-bit op from byte 0 bit 4 is a big-endian span: the value shifted left by 4 across bytes 0–1.
    expect(patchOpsBlock('0000', [{ byte: 0, bit: 4, len: 12, value: 0xabc }]).after).toBe('ABC0');
    expect(ownedMaskOps(2, [[{ byte: 0, bit: 4, len: 12, value: 0 }]])).toEqual([0xff, 0xf0]);
    // Later ops win where they overlap.
    expect(patchOpsBlock('00', [{ byte: 0, bit: 0, len: 8, value: 0xff }, { byte: 0, bit: 1, len: 1, value: 0 }]).after).toBe('FD');
    expect(opsHold('082A00', on)).toBe(true);
    expect(opsHold('002A00', on)).toBe(false);
    expect(() => patchOpsBlock('00', [{ byte: 1, bit: 0, len: 1, value: 1 }])).toThrow('does not fit');
    expect(() => patchOpsBlock('00', [{ byte: 0, bit: 0, len: 1, value: 2 }])).toThrow('does not fit');
  });

  it('refuses to patch a scalar into a block of the wrong length, and states the range in order', () => {
    const block = { length: 4, scalar: { byteOffset: 2, dataLength: 2 as const, multiplier: 1, offset: 0 } };
    expect(() => patchScalarBlock('0011', block, 5)).toThrow('length');
    expect(patchScalarBlock('00110000', block, 5).after).toBe('00110005');
    const negative = { length: 1, scalar: { byteOffset: 0, dataLength: 1 as const, multiplier: -1, offset: 0 } };
    expect(() => patchScalarBlock('00', negative, 5)).toThrow('[-255, 0]');
  });

  it('reports every bit a definition can write, per byte, honouring byte order and every choice', () => {
    const wide = { length: 3, field: { byteOffset: 0, bitOffset: 4, bitLength: 8, byteOrder: 'little' as const, choices: [
      { id: 'old', label: 'Old', value: 0 }, { id: 'new', label: 'New', value: 0xab, aux: [{ byteOffset: 2, bitOffset: 3, bitLength: 1 as const, value: 1 }] },
    ] }, auxWrites: [{ byteOffset: 2, bitOffset: 0, bitLength: 8 as const, value: 0 }] };
    expect(ownedMask(wide)).toEqual([0xf0, 0x0f, 0xff]);
    expect(ownedMask({ ...wide, field: { ...wide.field, byteOrder: 'big' } })).toEqual([0x0f, 0xf0, 0xff]);
    expect(ownedMask({ length: 4, scalar: { byteOffset: 1, dataLength: 2, multiplier: 1, offset: 0 } })).toEqual([0, 0xff, 0xff, 0]);
  });

  it('backs up, segments, verifies and restores a 32-byte block while preserving every unrelated byte', async () => {
    const r = await rig(), pack = parseDefinitionPack(JSON.stringify(DEMO_BLOCK_PACK));
    reviewDefinitionPack(pack, pack.id);
    const journal: CodingJournal[] = [];
    const session = new CodingSession(r.engine, recipesFromDefinitionPack(pack), async record => { journal.push(record); }, async vin => createHash('sha256').update(vin).digest('hex'));
    const recipe = session.recipes[0]!, original = [...r.module.blocks.get(0x0600)!];
    const preview = await r.run(session.prepare(recipe.id, 'enabled'));
    expect(preview.before).toHaveLength(64);
    expect(preview.changes).toEqual([{ offset: 11, before: 0, after: 64, mask: 64 }]);
    const applied = await r.run(session.apply(preview.id, 'APPLY', true));
    expect(r.module.blocks.get(0x0600)).toEqual(original.map((value, i) => i === 11 ? 64 : value));
    expect(journal.map(record => record.status)).toEqual(['prepared', 'applied']);
    expect(r.transport.log.some(entry => entry.cmd.startsWith('10232E0600'))).toBe(true);
    await expect(r.run(session.prepare(recipe.id, 'disabled', { ...applied, identity: { ...applied.identity!, odxVersion: '999999' } }))).rejects.toThrow('ODX identity');
    const restored = await r.run(session.prepare(recipe.id, 'disabled', applied));
    await r.run(session.apply(restored.id, 'RESTORE', true));
    expect(r.module.blocks.get(0x0600)).toEqual(original);
    expect(r.module.writes).toBe(2);
    expect(r.transport.log.some(entry => entry.cmd === '0210010000000000')).toBe(true);
    await r.run(r.engine.disconnect());
  });

  it('resolves an uncertain change whose original block is still present without another write', async () => {
    const r = await rig(), pack = parseDefinitionPack(JSON.stringify(DEMO_BLOCK_PACK));
    reviewDefinitionPack(pack, pack.id);
    const records: CodingJournal[] = [];
    const session = new CodingSession(r.engine, recipesFromDefinitionPack(pack), async record => { records.push(record); }, async vin => createHash('sha256').update(vin).digest('hex'));
    const recipe = session.recipes[0]!;
    const preview = await r.run(session.prepare(recipe.id, 'enabled'));
    r.module.failReadback = true;
    await expect(r.run(session.apply(preview.id, 'APPLY', true))).rejects.toThrow('Read-back');
    const uncertain = records.at(-1)!;
    expect(uncertain.status).toBe('uncertain');
    const restore = await r.run(session.prepare(recipe.id, 'disabled', uncertain));
    expect(restore.before).toBe(restore.after);
    const result = await r.run(session.apply(restore.id, 'RESTORE', true));
    expect(result.status).toBe('restored');
    expect(r.module.writes).toBe(1);
    await r.run(r.engine.disconnect());
  });
});
