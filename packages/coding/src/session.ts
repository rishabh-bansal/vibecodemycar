import { buildCommand, clearPrecheck, decodeInfoItem, exchangeUds, makeContext, toHex, type OBDCraftEngine, type RequestRecord } from '@obdcraft/obd-core';
import { patchCodingBlock, patchScalarBlock, readCodingValue, readScalarValue, validateCodingBlock, validateCodingRestore, type ByteChange, type CodingBlock } from './blocks.ts';
import type { EcuDefinitionIdentity } from './definitions.ts';

export interface CodingRecipe {
  id: string; featureId: string; featureName: string;
  target: string; responseId: string; part: string; software: string;
  did: number; enabled: string; disabled: string; demoOnly: boolean;
  evidence: string; needsSecurityAccess: boolean;
  block?: CodingBlock;
  identity?: EcuDefinitionIdentity;
  session?: 'default' | 'extended';
  definitionId?: string;
  sourceDigest?: string;
  /** Documented VAG seed&key unlock performed locally under the coding permit. */
  securityAccess?: { kind: 'vag-seedkey-add32'; password: string };
  /** Echo `2EF199<date>` / `2EF198<sequence>` marker writes before the block write. */
  prelude?: 'vag-mqb-coding-markers';
  /** Advisory only, e.g. '1102' ECU reset. Never executed by this workflow. */
  postWriteNote?: string;
}

export interface PreparedCoding {
  id: string; recipeId: string; featureName: string; target: string; responseId: string;
  did: number;
  vehicleHash: string;
  part: string; software: string; deviceId: string; before: string; after: string;
  at: number; voltage: number; demo: boolean; restoring: boolean;
  choiceId?: string;
  choiceLabel?: string;
  changes?: ByteChange[];
  identity?: EcuDefinitionIdentity;
  definitionId?: string;
  sourceDigest?: string;
  note?: string;
}

export interface CodingJournal extends Omit<PreparedCoding, 'voltage' | 'restoring'> {
  status: 'prepared' | 'applied' | 'failed' | 'restored' | 'uncertain';
  error: string | null;
}

const fromHex = (hex: string): number[] => hex.match(/../g)!.map(byte => parseInt(byte, 16));
const ascii = (bytes: number[]) => String.fromCharCode(...bytes).replace(/\0/g, '').trim();
function frozenRecipe(recipe: CodingRecipe): CodingRecipe {
  const copy = structuredClone(recipe);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
async function fingerprintVin(vin: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('A secure context is required to bind a coding backup to this vehicle.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(vin.trim().toUpperCase()));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Only compiled recipes or explicitly reviewed, validated definitions enter the registry. Import alone adds no permission. */
export class CodingSession {
  private prepared = new Map<string, { change: PreparedCoding; recipe: CodingRecipe; vin: string }>();
  private busy = false;
  readonly engine: OBDCraftEngine;
  readonly recipes: readonly CodingRecipe[];
  readonly persist: (journal: CodingJournal) => Promise<void>;
  private readonly fingerprint: (vin: string) => Promise<string>;
  private extendedSession: CodingRecipe | null = null;
  private responseTimeoutMs = 15000;

  constructor(engine: OBDCraftEngine, recipes: readonly CodingRecipe[], persist: (journal: CodingJournal) => Promise<void>, fingerprint: (vin: string) => Promise<string> = fingerprintVin) {
    this.engine = engine; this.recipes = Object.freeze(recipes.map(frozenRecipe)); this.persist = persist;
    this.fingerprint = fingerprint;
  }

  private recipe(id: string): CodingRecipe {
    const recipe = this.recipes.find(r => r.id === id);
    if (!recipe) throw new Error('No reviewed coding recipe is installed for this feature and control unit.');
    if (recipe.demoOnly && this.engine.transport?.kind !== 'emulator') throw new Error('This recipe is for the simulator only. It cannot be sent to a real adapter.');
    if (recipe.needsSecurityAccess) throw new Error('This definition requires an authorized diagnostic provider. This build has no SFD or security-access integration for it.');
    if (!recipe.demoOnly && (!recipe.identity || !recipe.block || !recipe.sourceDigest || !recipe.definitionId)) throw new Error('Production changes require an exact ECU definition, reviewed source and bounded field.');
    if (!recipe.part || !recipe.software || !recipe.evidence || !/^[0-7][0-9A-F]{2}$/.test(recipe.target) || recipe.target === '7DF' || !/^[0-7][0-9A-F]{2}$/.test(recipe.responseId) || !Number.isInteger(recipe.did) || recipe.did < 0 || recipe.did > 65535 ||
      !/^(?:[0-9A-F]{2}){1,4092}$/.test(recipe.enabled) || recipe.enabled.length !== recipe.disabled.length || !/^(?:[0-9A-F]{2}){1,4092}$/.test(recipe.disabled)) throw new Error('This recipe does not describe a supported, bounded data write.');
    if (recipe.block) validateCodingBlock(recipe.block);
    return recipe;
  }

  private async request(service: number, params: number[], ecu: string, token?: string, onTransmit?: () => void): Promise<number[]> {
    const runner = this.engine.runner;
    if (!runner || !this.engine.transport?.isOpen) throw new Error('The adapter disconnected.');
    if ([0x22, 0x2e, 0x10, 0x27].includes(service)) {
      const link = this.engine.link!;
      return (await exchangeUds(link, [service, ...params], {
        target: link.config.target, responseId: ecu, codingToken: token, onTransmit, timeoutMs: this.responseTimeoutMs,
      })).response;
    }
    const record: RequestRecord = await runner.execute({ service, params, purpose: 'manual', expectEcus: [ecu], maxAttempts: 1, timeoutMs: 2500, codingToken: token });
    const result = record.ecus[ecu];
    if (result?.status !== 'ok' || result.payload[0] !== service + 0x40) throw new Error(record.note ?? (result?.nrc ? `The control unit refused the request (response ${result.nrc.toString(16).toUpperCase()}).` : `No complete matching reply from ${ecu}.`));
    if ((service === 0x22 || service === 0x2e) && (result.payload[1] !== params[0] || result.payload[2] !== params[1])) throw new Error('Reply identifier did not match the requested setting.');
    return result.payload;
  }

  private async did(recipe: CodingRecipe, did: number): Promise<number[]> {
    return (await this.request(0x22, [did >> 8, did & 255], recipe.responseId)).slice(3);
  }

  private async endExtendedSession(): Promise<void> {
    const recipe = this.extendedSession;
    this.extendedSession = null;
    if (!recipe) return;
    if (this.engine.session?.isClosed) throw new Error('The connection closed before the default ECU diagnostic session could be restored.');
    try {
      await this.engine.link!.apply({ target: recipe.target });
      await this.request(0x10, [1], recipe.responseId);
    } catch {
      await this.engine.transport?.close();
      throw new Error('The default ECU diagnostic session could not be restored. The adapter connection was closed.');
    }
  }

  private async preflight(recipe: CodingRecipe): Promise<{ voltage: number; vin: string }> {
    const { engine } = this;
    const link = engine.link;
    if (!link || !engine.runner || link.protocol.family !== 'can11' || !engine.transport?.isOpen) throw new Error('This workflow needs a connected CAN 11-bit adapter and an identified car.');
    if (engine.state === 'scanning') throw new Error('Wait for the scan to finish.');
    await engine.stopLive();
    await link.apply({ target: 'functional', spaces: true, headers: true, adaptiveTiming: 1 });
    if (link.config.target !== 'functional') throw new Error('Could not select the engine precheck address.');
    const ctx = makeContext(link, engine.runner);
    for (const ecu of engine.ecus) ctx.ecus.set(ecu.id, ecu);
    const parked = await clearPrecheck(ctx);
    if (!parked.ok) throw new Error(parked.reasons.join('; '));
    const voltageReply = await link.at('ATRV');
    const voltage = Number.parseFloat(voltageReply.reply.lines.join(' '));
    if (!voltageReply.ok || !Number.isFinite(voltage) || voltage < 12.2 || voltage > 15.2) throw new Error('A stable 12.2–15.2 V supply is required. Use an appropriate battery support supply.');
    const engineId = engine.engineId();
    if (!engineId) throw new Error('The engine control unit has not been identified.');
    const identity = await this.request(0x09, [0x02], engineId);
    const vin = decodeInfoItem(0x02, identity.slice(2), true).text ?? '';
    if (vin.length !== 17) throw new Error('A fresh, complete VIN is required to bind this change to the car.');
    const applied = await link.apply({ target: recipe.target });
    if (applied.failed.length || link.config.target !== recipe.target) throw new Error('The adapter could not address the requested control unit.');
    this.responseTimeoutMs = 15000;
    const part = ascii(await this.did(recipe, 0xf187)), software = ascii(await this.did(recipe, 0xf189));
    if (part !== recipe.part || software !== recipe.software) throw new Error(`Control-unit identity mismatch: received ${part} / ${software}. No change was sent.`);
    if (recipe.identity) {
      const hardware = ascii(await this.did(recipe, 0xf191));
      const odxFile = ascii(await this.did(recipe, 0xf19e));
      const odxVersion = ascii(await this.did(recipe, 0xf1a2));
      if (hardware !== recipe.identity.hardware || odxFile !== recipe.identity.odxFile || odxVersion !== recipe.identity.odxVersion) throw new Error('Hardware or ODX definition/version does not match this control unit. No change was sent.');
    }
    if (recipe.session === 'extended') {
      this.extendedSession = recipe;
      const response = await this.request(0x10, [3], recipe.responseId);
      if (response.length >= 6) {
        const pendingTimeout = ((response[4]! << 8) | response[5]!) * 10 + 1000;
        if (pendingTimeout > 60000) throw new Error('The ECU requires a response window longer than this coding workflow supports.');
        this.responseTimeoutMs = Math.max(this.responseTimeoutMs, pendingTimeout);
      }
    }
    return { voltage, vin };
  }

  /**
   * Documented VAG seed&key: `2703` returns a 4-byte seed (big-endian); the key is
   * `(seed + decimal password) mod 2^32` sent big-endian in `2704`. A zero seed
   * means the ECU is already unlocked — the vendor then sends tester-present only.
   * Succeeds only when the ECU answers `6704`; anything else is a wrong-key refusal.
   */
  private async securityUnlock(recipe: CodingRecipe, permit: string): Promise<void> {
    const access = recipe.securityAccess!;
    if (!/^\d{1,10}$/.test(access.password)) throw new Error('The security-access code in this definition is not a valid decimal key.');
    const seedReply = await this.request(0x27, [0x03], recipe.responseId, permit);
    if (seedReply[0] !== 0x67 || seedReply[1] !== 0x03 || seedReply.length < 6) throw new Error('The control unit did not return a security-access seed.');
    const seedBytes = seedReply.slice(2, 6);
    const seed = seedBytes.reduce((value, byte) => (value * 256 + byte) >>> 0, 0);
    if (seed === 0) return; // already unlocked — no key exchange needed
    const key = (seed + (parseInt(access.password, 10) >>> 0)) >>> 0;
    const keyBytes = [(key >>> 24) & 255, (key >>> 16) & 255, (key >>> 8) & 255, key & 255];
    const keyReply = await this.request(0x27, [0x04, ...keyBytes], recipe.responseId, permit);
    if (keyReply[0] !== 0x67 || keyReply[1] !== 0x04) throw new Error('The control unit refused the security-access key.');
  }

  /**
   * VAG coding markers written before a DID block change (mirrors the reviewed tool):
   * echo `F199` (or today's date YY MM DD) back via `2EF199`; echo `F1A5` via `2EF198`
   * when it returns more than 3 non-zero bytes, else `0181C8F63039`. Echo data comes
   * from live reads, so the permit covers these two prefixes rather than exact bytes.
   */
  private async codingMarkers(recipe: CodingRecipe, permit: string): Promise<void> {
    let date: number[] | null = null;
    try { const d = await this.did(recipe, 0xf199); if (d.length >= 3) date = d.slice(0, 3); } catch { date = null; }
    if (!date) { const now = new Date(); date = [now.getFullYear() - 2000, now.getMonth() + 1, now.getDate()]; }
    await this.request(0x2e, [0xf1, 0x99, ...date], recipe.responseId, permit);
    let sequence: number[] | null = null;
    try { const s = await this.did(recipe, 0xf1a5); if (s.length > 3 && s.some(b => b !== 0)) sequence = s; } catch { sequence = null; }
    await this.request(0x2e, [0xf1, 0x98, ...(sequence ?? fromHex('0181C8F63039'))], recipe.responseId, permit);
  }

  async prepare(recipeId: string, selection: boolean | string, restore?: CodingJournal): Promise<PreparedCoding> {
    if (this.busy) throw new Error('Another coding operation is running.');
    this.busy = true;
    try {
      const recipe = this.recipe(recipeId);
      const check = await this.preflight(recipe);
      const vehicleHash = await this.fingerprint(check.vin);
      if (!/^[a-f0-9]{64}$/.test(vehicleHash)) throw new Error('Vehicle fingerprinting did not return a valid private identifier.');
      const before = toHex(await this.did(recipe, recipe.did), '');
      if (!recipe.block && before !== recipe.enabled && before !== recipe.disabled) throw new Error('The current setting is not a value covered by this recipe. No change was sent.');
      if (restore && (restore.vehicleHash !== vehicleHash || restore.recipeId !== recipe.id || restore.did !== recipe.did || restore.target !== recipe.target || restore.responseId !== recipe.responseId || restore.deviceId !== this.engine.transport!.id || restore.part !== recipe.part || restore.software !== recipe.software || (restore.after !== before && restore.before !== before) || !['applied', 'restored', 'uncertain', 'prepared'].includes(restore.status) || restore.sourceDigest !== recipe.sourceDigest || restore.definitionId !== recipe.definitionId)) throw new Error('This backup does not match the vehicle, adapter, definition, control unit, setting identifier or current value.');
      if (restore && recipe.identity && (!restore.identity || Object.entries(recipe.identity).some(([key, value]) => restore.identity?.[key as keyof EcuDefinitionIdentity] !== value))) throw new Error('The backup hardware or ODX identity differs from this definition.');
      let choiceId = typeof selection === 'boolean' ? (selection ? 'enabled' : 'disabled') : selection;
      if (!recipe.block && !['enabled', 'disabled'].includes(choiceId)) throw new Error('This recipe accepts only enabled or disabled.');
      if (restore && recipe.block) {
        validateCodingRestore(before, restore.before, recipe.block);
        if (recipe.block.field) choiceId = recipe.block.field.choices.find(c => c.value === readCodingValue(restore.before, recipe.block!))!.id;
        else choiceId = `value-${readScalarValue(restore.before, recipe.block)}`;
      }
      if (restore && !recipe.block && ![recipe.enabled, recipe.disabled].includes(restore.before)) throw new Error('The backup value is outside this recipe.');
      const scalarValue = recipe.block?.scalar ? Number(selection) : NaN;
      if (recipe.block?.scalar && (typeof selection === 'boolean' || !Number.isFinite(scalarValue))) throw new Error('This setting takes a numeric value.');
      const patch = recipe.block?.field ? patchCodingBlock(before, recipe.block, choiceId)
        : recipe.block?.scalar ? patchScalarBlock(before, recipe.block, scalarValue) : null;
      const after = restore?.before ?? patch?.after ?? (selection === true || selection === 'enabled' ? recipe.enabled : recipe.disabled);
      const change: PreparedCoding = {
        id: `coding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, recipeId, featureName: recipe.featureName,
        target: recipe.target, responseId: recipe.responseId, did: recipe.did, vehicleHash, part: recipe.part, software: recipe.software,
        deviceId: this.engine.transport!.id, before, after, at: Date.now(), voltage: check.voltage, demo: this.engine.transport!.kind === 'emulator', restoring: !!restore,
        choiceId, choiceLabel: recipe.block?.field?.choices.find(c => c.id === choiceId)?.label ?? (recipe.block?.scalar ? String(scalarValue) : undefined),
        changes: patch?.changes, identity: recipe.identity, definitionId: recipe.definitionId, sourceDigest: recipe.sourceDigest,
        note: recipe.postWriteNote,
      };
      this.prepared.clear();
      this.prepared.set(change.id, { change: structuredClone(change), recipe, vin: check.vin });
      return change;
    } finally {
      try { await this.endExtendedSession(); }
      finally { await this.engine.link?.apply({ target: 'functional' }).catch(() => {}); this.busy = false; }
    }
  }

  async apply(preparedId: string, confirmation: string, acknowledged: boolean): Promise<CodingJournal> {
    const saved = this.prepared.get(preparedId);
    if (!saved || this.busy) throw new Error('Read the setting again before applying a change.');
    const { change, recipe, vin } = saved;
    if (!acknowledged || confirmation.trim().toUpperCase() !== (change.restoring ? 'RESTORE' : 'APPLY')) throw new Error(`Type ${change.restoring ? 'RESTORE' : 'APPLY'} and acknowledge the backup/verification step.`);
    this.prepared.delete(preparedId);
    this.busy = true;
    const { voltage: _voltage, restoring: _restoring, ...record } = change;
    let journal: CodingJournal = { ...record, status: 'prepared', error: null };
    let sent = false;
    try {
      this.recipe(recipe.id);
      if (Date.now() - change.at > 120000 || change.deviceId !== this.engine.transport?.id) throw new Error('This preview expired or the adapter changed. Read the setting again.');
      const check = await this.preflight(recipe);
      if (check.vin !== vin) throw new Error('The connected vehicle changed after the preview.');
      if (toHex(await this.did(recipe, recipe.did), '') !== change.before) throw new Error('The setting changed after the preview. Read it again.');
      await this.persist(journal); // A failed durable backup stops execution here, before any write.
      if (change.before !== change.after) {
        const params = [recipe.did >> 8, recipe.did & 255, ...fromHex(change.after)];
        const writeCommand = buildCommand(0x2e, params);
        if (recipe.securityAccess || recipe.prelude) {
          const permit = this.engine.link!.policy.issueCodingPermit(recipe.target, {
            writes: [writeCommand],
            writePrefixes: recipe.prelude ? ['2EF199', '2EF198'] : [],
            securityAccess: !!recipe.securityAccess,
          });
          if (recipe.securityAccess) await this.securityUnlock(recipe, permit);
          if (recipe.prelude) await this.codingMarkers(recipe, permit);
          await this.request(0x2e, params, recipe.responseId, permit, () => { sent = true; });
        } else {
          const token = this.engine.link!.policy.issueCodingToken(writeCommand, recipe.target);
          await this.request(0x2e, params, recipe.responseId, token, () => { sent = true; });
        }
      }
      const verified = toHex(await this.did(recipe, recipe.did), '');
      if (verified !== change.after) throw new Error('Read-back did not confirm the requested value. Stop and inspect the saved record; no automatic retry was made.');
      await this.endExtendedSession();
      journal = { ...journal, status: change.restoring ? 'restored' : 'applied' };
      await this.persist(journal);
      return journal;
    } catch (error) {
      journal = { ...journal, status: sent ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : String(error) };
      await this.persist(journal).catch(() => {});
      throw new Error(journal.error!);
    } finally {
      try { await this.endExtendedSession(); }
      finally { await this.engine.link?.apply({ target: 'functional' }).catch(() => {}); this.busy = false; }
    }
  }
}
