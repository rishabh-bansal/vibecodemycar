import { CATALOGUE } from './catalogue.ts';
import { validateCodingBlock, type CodingBlock } from './blocks.ts';
import type { CodingRecipe } from './session.ts';

export interface EcuDefinitionIdentity {
  part: string; software: string; hardware: string;
  odxFile: string; odxVersion: string;
}
/**
 * Documented VAG seed&key access: `2703` returns a 4-byte seed, the key reply
 * `2704` sends `(seed + password) mod 2^32` as big-endian bytes — the algorithm
 * recovered from the reviewed artifact source. `password` is the decimal access
 * code carried by the candidate data (e.g. 31347 on MQB BCM 09).
 */
export interface SecurityAccess { kind: 'vag-seedkey-add32'; password: string }
export interface CodingDefinition {
  id: string; featureId: string; featureName?: string; target: string; responseId: string;
  identity: EcuDefinitionIdentity;
  did: number; block: CodingBlock;
  session: 'default' | 'extended';
  authorization: 'none' | 'external' | 'vag-seedkey';
  securityAccess?: SecurityAccess;
  /** VAG coding-marker prelude: echo 2EF199<date> and 2EF198<sequence> before the block write. */
  prelude?: 'vag-mqb-coding-markers';
  /** Advisory commands the source tool runs after the write (e.g. `1102` ECU reset). Never executed — shown to the user only. */
  postWriteNote?: string;
  demoOnly: boolean;
}
export interface DefinitionPack {
  schema: 'obdcraft.coding-definitions/1';
  id: string; name: string;
  source: { title: string; reference: string; sha256: string; notes: string };
  definitions: readonly CodingDefinition[];
}
const reviewed = new WeakSet<DefinitionPack>();
const parsed = new WeakSet<DefinitionPack>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^[0-7][0-9A-F]{2}$/.test(value) && value !== '7DF';
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Data import is not approval. No scripts, service numbers, authentication keys or arbitrary commands are accepted. */
export function parseDefinitionPack(json: string): DefinitionPack {
  if (json.length > 2_000_000) throw new Error('The definition file exceeds 2 MB.');
  const p: unknown = JSON.parse(json);
  if (!object(p) || p.schema !== 'obdcraft.coding-definitions/1' || !identifier(p.id) || !text(p.name) ||
    !keys(p, ['schema', 'id', 'name', 'source', 'definitions']) ||
    !object(p.source) || !text(p.source.title) || !text(p.source.reference, 2048) ||
    !keys(p.source, ['title', 'reference', 'sha256', 'notes']) ||
    typeof p.source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.source.sha256) ||
    !text(p.source.notes, 4000) || !Array.isArray(p.definitions) || !p.definitions.length || p.definitions.length > 1000) throw new Error('Invalid coding-definition package or missing source provenance.');
  const ids = new Set<string>(), features = new Set(CATALOGUE.features.map(f => f.id));
  const aux = (a: unknown): a is { byteOffset: number; bitOffset: number; bitLength: 1 | 8; value: number } =>
    !!a && typeof a === 'object' && Object.keys(a as object).every(k => ['byteOffset', 'bitOffset', 'bitLength', 'value'].includes(k)) &&
    Number.isInteger((a as { byteOffset: number }).byteOffset) && Number.isInteger((a as { value: number }).value);
  for (const d of p.definitions) {
    const knownFeature = typeof d.featureId === 'string' && features.has(d.featureId);
    if (!object(d) || !identifier(d.id) || ids.has(d.id) || typeof d.featureId !== 'string' ||
      (!knownFeature && !text(d.featureName, 160)) ||
      !keys(d, ['id', 'featureId', 'featureName', 'target', 'responseId', 'identity', 'did', 'block', 'session', 'authorization', 'securityAccess', 'prelude', 'postWriteNote', 'demoOnly']) ||
      !address(d.target) || !address(d.responseId) || d.target === d.responseId || !object(d.identity) ||
      !['part', 'software', 'hardware', 'odxFile', 'odxVersion'].every(key => text(d.identity && (d.identity as Record<string, unknown>)[key], 100)) ||
      Object.keys(d.identity).some(key => !['part', 'software', 'hardware', 'odxFile', 'odxVersion'].includes(key)) ||
      Object.values(d.identity).some(v => typeof v !== 'string' || /[*?]/.test(v)) ||
      typeof d.did !== 'number' || !Number.isInteger(d.did) || d.did < 0 || d.did > 65535 ||
      (d.did >= 0xf180 && d.did <= 0xf1ff) ||
      !['default', 'extended'].includes(String(d.session)) || !['none', 'external', 'vag-seedkey'].includes(String(d.authorization)) ||
      (d.authorization === 'vag-seedkey' && (!object(d.securityAccess) || d.securityAccess.kind !== 'vag-seedkey-add32' ||
        typeof d.securityAccess.password !== 'string' || !/^\d{1,10}$/.test(d.securityAccess.password))) ||
      (d.authorization !== 'vag-seedkey' && d.securityAccess !== undefined) ||
      (d.prelude !== undefined && d.prelude !== 'vag-mqb-coding-markers') ||
      (d.postWriteNote !== undefined && !text(d.postWriteNote, 300)) ||
      typeof d.demoOnly !== 'boolean' || !object(d.block) ||
      !keys(d.block, ['length', 'field', 'auxWrites', 'scalar']) ||
      !(object(d.block.field) !== object(d.block.scalar)) ||
      (object(d.block.field) && (!keys(d.block.field, ['byteOffset', 'bitOffset', 'bitLength', 'byteOrder', 'choices']) ||
        !Array.isArray(d.block.field.choices) || d.block.field.choices.some((c: unknown) => !object(c) || !keys(c, ['id', 'label', 'value', 'aux']) || !text(c.id, 80) || !text(c.label, 200) ||
          ((c as { aux?: unknown }).aux !== undefined && (!Array.isArray((c as { aux: unknown }).aux) || !(c as { aux: unknown[] }).aux.every(aux)))))) ||
      (object(d.block.scalar) && (!keys(d.block.scalar, ['byteOffset', 'dataLength', 'multiplier', 'offset', 'signed', 'reverseOrder']) ||
        !Number.isInteger((d.block.scalar as { byteOffset: number }).byteOffset))) ||
      (d.block.auxWrites !== undefined && (!Array.isArray(d.block.auxWrites) || !d.block.auxWrites.every(aux)))) throw new Error('An ECU definition has an invalid identity, field or operation.');
    validateCodingBlock(d.block as unknown as CodingBlock);
    ids.add(d.id);
  }
  const pack = freeze(p as unknown as DefinitionPack);
  parsed.add(pack);
  return pack;
}

/** Explicit review is a separate user action. An imported `approved` field cannot grant this capability. */
export function reviewDefinitionPack(pack: DefinitionPack, confirmation: string): void {
  if (!parsed.has(pack)) throw new Error('Load the definition through the validated importer first.');
  if (confirmation !== pack.id) throw new Error('Type the exact package ID after checking its source, module identities and fields.');
  // Re-validate even when a caller bypasses parseDefinitionPack.
  parseDefinitionPack(JSON.stringify(pack));
  reviewed.add(pack);
}

export function recipesFromDefinitionPack(pack: DefinitionPack): readonly CodingRecipe[] {
  if (!reviewed.has(pack)) throw new Error('Review the imported definition package before preparing a vehicle change.');
  return pack.definitions.map(d => ({
    id: `${pack.id}:${d.id}`, featureId: d.featureId,
    featureName: CATALOGUE.features.find(f => f.id === d.featureId)?.name ?? d.featureName ?? d.featureId,
    target: d.target, responseId: d.responseId, ...d.identity,
    identity: d.identity, did: d.did, block: d.block, session: d.session,
    // 'vag-seedkey' is implemented locally as the documented bounded 2703/2704 exchange;
    // 'external' still requires a provider this build does not ship.
    needsSecurityAccess: d.authorization === 'external',
    securityAccess: d.authorization === 'vag-seedkey' ? d.securityAccess : undefined,
    prelude: d.prelude, postWriteNote: d.postWriteNote,
    enabled: '01', disabled: '00', demoOnly: d.demoOnly,
    evidence: `${pack.source.title}: ${pack.source.reference}; ${pack.source.notes}`,
    definitionId: pack.id, sourceDigest: pack.source.sha256,
  }));
}
