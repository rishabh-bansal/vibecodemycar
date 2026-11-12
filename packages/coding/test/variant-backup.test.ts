import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  deriveVariantRef, rankCandidateName, bestVariants, settleVariant, resolutionSummary,
  buildReadPlan, newPolicyState, stepPolicy, stepPolicyBound, nextDispatch, DEFAULT_ABORT_POLICY,
  parseBackupDidLists, buildBackupPlan, beginCapture, recordAttempted,
  recordResponded, recordDecoded, recordFailed, recordSkipped, recordOutcome, abortCapture,
  parseBackupCapture,
  type VariantRef, type ReadOutcome, type BackupCaptureEntry,
} from '../src/index.ts';

// The backup DID lists are third-party data kept out of the public repo; the backup-plan tests run where they exist.
const LISTS_FILE = new URL('../data/carscanner-backup-did-lists.json', import.meta.url);
const HAS_LISTS = existsSync(LISTS_FILE);
const LISTS = HAS_LISTS ? parseBackupDidLists(readFileSync(LISTS_FILE, 'utf8')) : {};

const ref: VariantRef = deriveVariantRef({ odxFile: 'EV_BCMHellaMQBA0', odxVersion: '001008' }, 'SK37')!;

describe('variant ref + rank (G1)', () => {
  it('preserves full F19E/F1A2 and derives the 3-char version key', () => {
    expect(ref.odxName).toBe('EV_BCMHellaMQBA0');
    expect(ref.odxVersion).toBe('001008');
    expect(ref.odxVersion3).toBe('001');
    expect(ref.project).toBe('SK37');
  });
  it('refuses to derive a ref without F19E or F1A2', () => {
    expect(deriveVariantRef({ odxFile: null, odxVersion: '001008' })).toBeNull();
    expect(deriveVariantRef({ odxFile: 'EV_X', odxVersion: null })).toBeNull();
    expect(deriveVariantRef({ odxFile: 'EV_X', odxVersion: '' })).toBeNull();
  });
  it('ranks all six candidate shapes against the ref', () => {
    expect(rankCandidateName('EV_BCMHellaMQBA0_001_SK37', ref)).toBe('VersionProject');
    expect(rankCandidateName('EV_BCMHellaMQBA0_001', ref)).toBe('Version');
    expect(rankCandidateName('EV_BCMHellaMQBA0_SK37', ref)).toBe('Project');
    expect(rankCandidateName('EV_BCMHellaMQBA0', ref)).toBe('Exact');
    expect(rankCandidateName('EV_BCMHellaMQBA0_001_MQB', ref)).toBe('Localised');
    expect(rankCandidateName('EV_BCMHellaMQBA0_999', ref)).toBe('Family');
    expect(rankCandidateName('EV_BCMHellaMQBA0.rod', ref)).toBe('Exact'); // suffix stripped
    expect(rankCandidateName('EV_OtherUnit_001', ref)).toBeNull();
  });
  it('bestVariants keeps every candidate at the best rank — ties retained', () => {
    const best = bestVariants(['EV_BCMHellaMQBA0_001', 'EV_BCMHellaMQBA0_001_SK37', 'EV_BCMHellaMQBA0_XX'], ref);
    expect(best).toEqual({ rank: 'VersionProject', names: ['EV_BCMHellaMQBA0_001_SK37'] });
    const tied = bestVariants(['EV_BCMHellaMQBA0_001', 'EV_BCMHellaMQBA0_001', 'EV_BCMHellaMQBA0_XX'], ref);
    expect(tied).toEqual({ rank: 'Version', names: ['EV_BCMHellaMQBA0_001'] });
  });
  it('settleVariant settles a unique best-rank name', () => {
    const res = settleVariant(['EV_BCMHellaMQBA0_001', 'EV_BCMHellaMQBA0', 'EV_BCMHellaMQBA0_001_SK37'], ref);
    expect(res).toEqual({ status: 'settled', rank: 'VersionProject', name: 'EV_BCMHellaMQBA0_001_SK37' });
  });
  it('settleVariant retains equally ranked matches — never auto-picks', () => {
    // At VCDS ranks each slot is an exact match, so distinct ties surface at
    // Localised/Family — two same-version files for other markets. Strict
    // lookup refuses; relaxed lookup keeps BOTH as exploratory candidates —
    // a tie is explicit, never a silent pick or a settled variant.
    const stems = ['EV_BCMHellaMQBA0_001_MQBA', 'EV_BCMHellaMQBA0_001_MQBB'];
    expect(settleVariant(stems, ref).status).toBe('refused');
    const res = settleVariant(stems, ref, { vcdsLookup: false });
    expect(res).toEqual({ status: 'candidate', rank: 'Localised', names: ['EV_BCMHellaMQBA0_001_MQBA', 'EV_BCMHellaMQBA0_001_MQBB'] });
  });
  it('settleVariant refuses missing identity and insufficient rank', () => {
    expect(settleVariant(['EV_BCMHellaMQBA0'], null).status).toBe('refused');
    const fam = settleVariant(['EV_BCMHellaMQBA0_999', 'EV_BCMHellaMQBA0_888'], ref);
    expect(fam).toMatchObject({ status: 'refused', reason: 'rank-insufficient', rank: 'Family' });
    const loc = settleVariant(['EV_BCMHellaMQBA0_001_MQB'], ref);
    expect(loc).toMatchObject({ status: 'refused', reason: 'rank-insufficient', rank: 'Localised' });
    expect(settleVariant(['EV_Whatever_1'], ref).status).toBe('refused');
  });
  it('settleVariant honors ReDir redirects at the source rank; EMPTY means nothing', () => {
    // The redirect target must itself be an available dataset.
    const res = settleVariant(['EV_BCMHellaMQBA0_001', 'EV_BCMHellaMQBA0_002'], ref, { redirects: { EV_BCMHellaMQBA0_001: 'EV_BCMHellaMQBA0_002' } });
    expect(res).toEqual({ status: 'settled', rank: 'Version', name: 'EV_BCMHellaMQBA0_002' });
    const empty = settleVariant(['EV_BCMHellaMQBA0_001'], ref, { redirects: { EV_BCMHellaMQBA0_001: 'EMPTY' } });
    expect(empty).toMatchObject({ status: 'nothing', reason: 'redirect-empty', source: 'EV_BCMHellaMQBA0_001' });
  });
  it('settleVariant with vcdsLookup=false surfaces Family only as exploratory candidate', () => {
    const res = settleVariant(['EV_BCMHellaMQBA0_999'], ref, { vcdsLookup: false });
    expect(res).toEqual({ status: 'candidate', rank: 'Family', names: ['EV_BCMHellaMQBA0_999'] });
    expect(res.status).not.toBe('settled');
  });
  it('settleVariant resolves ReDir targets present in the list; refuses dangling and cyclic', () => {
    const res = settleVariant(['EV_TARGET_001'], ref, { redirects: { EV_BCMHellaMQBA0_001: 'EV_TARGET_001' } });
    expect(res).toEqual({ status: 'settled', rank: 'Version', name: 'EV_TARGET_001' });
    const dangling = settleVariant(['EV_BCMHellaMQBA0_001'], ref, { redirects: { EV_BCMHellaMQBA0_001: 'EV_MISSING_001' } });
    expect(dangling.status).toBe('refused');
    const cyclic = settleVariant(['EV_BCMHellaMQBA0_001'], ref, { redirects: { EV_BCMHellaMQBA0_001: 'EV_X', EV_X: 'EV_BCMHellaMQBA0_001' } });
    expect(cyclic.status).toBe('refused');
  });
  it('resolutionSummary keeps outcomes explicit', () => {
    expect(resolutionSummary({ status: 'ambiguous', rank: 'Version', names: ['A', 'B'] })).toContain('ambiguous');
    expect(resolutionSummary({ status: 'refused', reason: 'identity-incomplete' })).toContain('refused');
  });
});

describe('read plan + abort policy (G8)', () => {
  const mod = { request: '70E', response: '778' };
  it('builds identity-gated plan with deduped candidates in source order', () => {
    const plan = buildReadPlan(mod, ['0600', '0A5E', '0600', 'F187'], 'vag.mqb.backup.09 (candidate list)');
    expect(plan.identity.map(e => e.did)).toEqual(['F187', 'F189', 'F191', 'F19E', 'F1A2']);
    expect(plan.candidates.map(e => e.did)).toEqual(['0600', '0A5E']);
    expect(plan.candidates[0]!.request).toBe('220600');
    expect(plan.candidates.every(e => e.source.includes('candidate'))).toBe(true);
  });
  it('rejects malformed DIDs, functional addressing and non-physical module IDs', () => {
    expect(() => buildReadPlan(mod, ['06Z0'], 'x')).toThrow();
    expect(() => buildReadPlan({ request: '7DF', response: '7E8' }, ['0600'], 'x')).toThrow();
    expect(() => buildReadPlan({ request: 'xyz', response: '778' }, ['0600'], 'x')).toThrow();
  });
  // Helper: open the identity gate first — candidate outcomes before a bound
  // identity reply abort the sweep outright.
  const st = (outcomes: ReadOutcome[], policy = DEFAULT_ABORT_POLICY) => {
    let s = stepPolicy(newPolicyState(), 'identity', { kind: 'reply', serviceEcho: 0x62, data: [1] }, policy);
    for (const o of outcomes) s = stepPolicy(s, 'candidate', o, policy);
    return s;
  };
  it('an NRC is an answer — resets the silent streak but counts toward total', () => {
    const s = st([{ kind: 'no-reply' }, { kind: 'nrc', nrc: 0x31 }, { kind: 'no-reply' }]);
    expect(s.consecutiveSilent).toBe(1);
    expect(s.totalFailures).toBe(3);
    expect(s.aborted).toBe(false);
  });
  it('aborts on consecutive silence at the bound', () => {
    const s = st([{ kind: 'no-reply' }, { kind: 'no-reply' }, { kind: 'no-reply' }]);
    expect(s.aborted).toBe(true);
    expect(s.reason).toContain('consecutive silent');
  });
  it('aborts on the total failure bound even with replies between', () => {
    const p = { ...DEFAULT_ABORT_POLICY, maxTotalFailures: 3 };
    const s = st([{ kind: 'nrc', nrc: 0x31 }, { kind: 'nrc', nrc: 0x31 }, { kind: 'nrc', nrc: 0x31 }], p);
    expect(s.aborted).toBe(true);
    expect(s.reason).toContain('candidate list');
  });
  it('an unanswered or refused identity gate aborts before the sweep', () => {
    let s = stepPolicy(newPolicyState(), 'identity', { kind: 'no-reply' }, DEFAULT_ABORT_POLICY);
    expect(s.aborted).toBe(true);
    s = stepPolicy(newPolicyState(), 'identity', { kind: 'nrc', nrc: 0x22 }, DEFAULT_ABORT_POLICY);
    expect(s.aborted).toBe(true);
    s = stepPolicy(newPolicyState(), 'identity', { kind: 'reply', serviceEcho: 0x62, data: [1] }, DEFAULT_ABORT_POLICY);
    expect(s.aborted).toBe(false);
    expect(s.identityAnswered).toBe(true);
  });
  it('an aborted state stays aborted', () => {
    const s = st([{ kind: 'no-reply' }, { kind: 'no-reply' }, { kind: 'no-reply' }, { kind: 'reply', serviceEcho: 0x62, data: [] }]);
    expect(s.aborted).toBe(true);
  });
  it('nextDispatch is the real pre-dispatch eligibility guard (C5)', () => {
    const plan = buildReadPlan(mod, ['0600'], 'x');
    let s = newPolicyState();
    // One outstanding request at a time; every required identity must answer.
    for (let i = 0; i < 5; i += 1) {
      const d = nextDispatch(plan, s);
      expect(d.action.kind).toBe('dispatch');
      if (d.action.kind !== 'dispatch') throw new Error('identity not dispatched');
      expect(d.action.entry.role).toBe('identity');
      s = d.state;
      expect(nextDispatch(plan, s).action.kind).toBe('await-response');
      s = stepPolicyBound(s, d.action.entry, { kind: 'reply', serviceEcho: 0x62, did: d.action.entry.did, data: [1] }, plan.policy);
    }
    // A synthetic advanced cursor or legacy one-reply flag cannot bypass the set.
    const withheld = nextDispatch(plan, { ...newPolicyState(), dispatchedCount: 5, identityAnswered: true });
    expect(withheld.action.kind).toBe('await-identity');
    const d2 = nextDispatch(plan, s);
    expect(d2.action.kind).toBe('dispatch');
    if (d2.action.kind !== 'dispatch') throw new Error('candidate not dispatched');
    expect(d2.action.entry.did).toBe('0600');
    s = d2.state;
    expect(nextDispatch(plan, s).action.kind).toBe('await-response');
    s = stepPolicyBound(s, d2.action.entry, { kind: 'reply', serviceEcho: 0x62, did: '0600', data: [1] }, plan.policy);
    expect(nextDispatch(plan, s).action.kind).toBe('done');
    // an aborted plan dispatches nothing more
    const dead = stepPolicy(newPolicyState(), 'identity', { kind: 'nrc', nrc: 0x22 }, DEFAULT_ABORT_POLICY);
    expect(nextDispatch(plan, dead).action.kind).toBe('aborted');
  });
  it('stepPolicyBound rejects wrong/missing DID echoes (C5)', () => {
    const entry = buildReadPlan(mod, ['0600'], 'x').identity[0]!;
    const outstanding = () => nextDispatch(buildReadPlan(mod, ['0600'], 'x'), newPolicyState()).state;
    // wrong DID echo: a 62 reply for a different DID is not this entry's evidence
    const wrong = stepPolicyBound(outstanding(), entry, { kind: 'reply', serviceEcho: 0x62, did: 'F190', data: [1] }, DEFAULT_ABORT_POLICY);
    expect(wrong.aborted).toBe(true);
    expect(wrong.identityAnswered).toBe(false);
    // absent DID echo cannot bind the request either
    const absent = stepPolicyBound(outstanding(), entry, { kind: 'reply', serviceEcho: 0x62, data: [1] }, DEFAULT_ABORT_POLICY);
    expect(absent.aborted).toBe(true);
    // the matching DID binds and answers identity
    const ok = stepPolicyBound(outstanding(), entry, { kind: 'reply', serviceEcho: 0x62, did: 'F187', data: [1] }, DEFAULT_ABORT_POLICY);
    expect(ok.identityAnswered).toBe(true);
    expect(ok.aborted).toBe(false);
    // malformed DID echo is rejected as a failure, not accepted
    const bad = stepPolicyBound(outstanding(), entry, { kind: 'reply', serviceEcho: 0x62, did: 'ZZZZ', data: [1] }, DEFAULT_ABORT_POLICY);
    expect(bad.aborted).toBe(true);
  });
});

describe.skipIf(!HAS_LISTS)('backup plan + immutable capture (G9)', () => {
  const mod = { request: '70E', response: '778' };
  const variant = { status: 'settled' as const, rank: 'Version' as const, name: 'EV_BCMHellaMQBA0_001' };
  // Built only where the lists exist (a skipped block's body still runs when tests are collected).
  const plan = (HAS_LISTS ? buildBackupPlan(LISTS, 'mqb', '09', mod, variant) : undefined) as ReturnType<typeof buildBackupPlan>;
  it('bundled lists parse — 63 module templates, counts match lengths', () => {
    expect(Object.keys(LISTS)).toHaveLength(63);
    expect(LISTS['vag.mqb.backup.09']!.count).toBe(301);
    expect(LISTS['vag.mqb.backup.17']!.count).toBe(111);
    expect(() => parseBackupDidLists('{"vag.mqb.backup.09":{"platform":"mqb","unit":"09","count":1,"dids":["0600","0601"]}}')).toThrow();
  });
  it('plan marks every DID a candidate and preserves the variant resolution', () => {
    expect(plan.schema).toBe('obdcraft.backup-plan/1');
    expect(plan.entries.length).toBeGreaterThan(290);
    expect(plan.entries.every(e => e.status === 'candidate' && e.request.startsWith('22'))).toBe(true);
    expect(plan.variant.status).toBe('settled');
    expect(plan.notes.join(' ')).toContain('Candidate list only');
    expect(plan.counts.proposed).toBe(plan.entries.length);
    expect(() => buildBackupPlan(LISTS, 'mqb', '7F', mod, variant)).toThrow();
  });
  it('capture lifecycle: candidate → attempted → responded/failed/skipped; decoded only via decoder', () => {
    let c = beginCapture(plan, { part: '2Q0937089D' });
    expect(c.entries[0]!.status).toBe('candidate');
    expect(c.counts).toEqual({ proposed: plan.entries.length, attempted: 0, responding: 0, decoded: 0, failed: 0, skipped: 0 });
    c = recordAttempted(c, '0600');
    c = recordResponded(c, '0600', [0xAA, 0xBB]);
    c = recordDecoded(c, '0600', { decoder: 'test-decoder', fields: 2, values: { fieldA: 170, fieldB: 187 }, byteLength: 2 });
    c = recordOutcome(c, '0D07', { kind: 'nrc', nrc: 0x31 });
    c = recordOutcome(c, '04FE', { kind: 'reply', serviceEcho: 0x62, did: '04FE', data: [] });
    c = recordSkipped(c, '04FF', 'operator stop');
    const byDid = Object.fromEntries(c.entries.map(e => [e.did, e]));
    expect(byDid['0600']).toMatchObject({ status: 'decoded', attempted: true, decoded: { decoder: 'test-decoder', fields: 2 }, response: { serviceEcho: '620600' } });
    expect(byDid['0D07']).toMatchObject({ status: 'failed', attempted: true, failure: { kind: 'nrc', nrc: '31' } });
    expect(byDid['04FE']).toMatchObject({ status: 'responded', attempted: true });
    expect(byDid['04FF']).toMatchObject({ status: 'skipped', reason: 'operator stop' });
    // skipped-before-attempt keeps attempted=false — skips don't inflate attempts
    expect(byDid['04FF']!.attempted).toBeUndefined();
    expect(c.counts).toMatchObject({ attempted: 3, responding: 2, decoded: 1, failed: 1, skipped: 1 });
    // a wrong-service reply records failure, never a fabricated echo
    const wrong = recordOutcome(beginCapture(plan), '0600', { kind: 'reply', serviceEcho: 0x6E, data: [1] });
    expect(wrong.entries.find(e => e.did === '0600')).toMatchObject({ status: 'failed', failure: { kind: 'unexpected-reply' } });
    expect(wrong.counts.responding).toBe(0);
    // decode without a prior reply or without provenance is refused outright —
    // decode cannot be invented (C5)
    expect(() => recordDecoded(beginCapture(plan), '0600', { decoder: 'd', fields: 1, values: { fieldA: 1 } })).toThrow();
    expect(() => recordDecoded(recordResponded(beginCapture(plan), '0600', [1]), '0600', { byteLength: 5 } as never)).toThrow();
  });
  it('illegal transitions throw — evidence lifecycle is enforced, not advisory', () => {
    let c = beginCapture(plan);
    // responded is terminal except for decode; skipped is terminal outright
    const responded = recordResponded(c, '0600', [1]);
    expect(() => recordFailed(responded, '0600', { kind: 'nrc', detail: 'x' })).toThrow();
    expect(() => recordResponded(responded, '0600', [2])).toThrow();
    expect(() => recordSkipped(responded, '0600', 'x')).toThrow();
    const skipped = recordSkipped(c, '0A5E', 'done');
    expect(() => recordAttempted(skipped, '0A5E')).toThrow();
    // a failed entry may retry only through a fresh attempt
    const failed = recordFailed(c, '0D07', { kind: 'nrc', detail: 'x' });
    expect(() => recordResponded(failed, '0D07', [1])).toThrow();
    const retried = recordAttempted(failed, '0D07');
    expect(retried.entries.find(e => e.did === '0D07')!.status).toBe('attempted');
    expect(retried.entries.find(e => e.did === '0D07')!.failure).toBeUndefined();
    expect(() => parseBackupCapture(JSON.stringify(retried))).not.toThrow();
  });
  it('capture rejects an absent or foreign DID despite the correct positive SID', () => {
    for (const did of [undefined, 'F199']) {
      const c = recordOutcome(beginCapture(plan), '0600', { kind: 'reply', serviceEcho: 0x62, did, data: [1] });
      expect(c.counts.responding).toBe(0);
      expect(c.entries.find(e => e.did === '0600')).toMatchObject({ status: 'failed', failure: { kind: 'unexpected-reply' } });
    }
  });
  it('meaningful decode needs actual values and an accurate nonzero field count', () => {
    const c = recordResponded(beginCapture(plan), '0600', [1]);
    const bad: Array<NonNullable<BackupCaptureEntry['decoded']>> = [
      { decoder: 'd', fields: 0, values: {} },
      { decoder: 'd', fields: NaN, values: { x: 1 } },
      { decoder: 'd', fields: 2, values: { x: 1 } },
      { decoder: 'd', fields: 1, values: { x: NaN } },
      { decoder: 'd', fields: 1, values: { x: 1 }, byteLength: 5 },
    ];
    for (const decoded of bad) expect(() => recordDecoded(c, '0600', decoded)).toThrow();
    const decoded = recordDecoded(c, '0600', { decoder: 'd', fields: 1, values: { x: 1 }, byteLength: 1 });
    expect(parseBackupCapture(JSON.stringify(decoded)).entries[0]!.decoded!.values).toEqual({ x: 1 });
  });
  it('importer: frozen output, duplicate DIDs rejected, attempted required for evidence', () => {
    const c = recordOutcome(beginCapture(plan), '0600', { kind: 'reply', serviceEcho: 0x62, did: '0600', data: [1] });
    const back = parseBackupCapture(JSON.stringify(c));
    expect(() => (back.entries as BackupCaptureEntry[]).push({ did: 'FFFF' } as never)).toThrow();
    const dup = JSON.parse(JSON.stringify(c));
    dup.entries.push({ ...dup.entries[1], did: '0600' });
    expect(() => parseBackupCapture(JSON.stringify(dup))).toThrow();
    // retrieval without attempted state is a forged claim
    const noAttempt = JSON.parse(JSON.stringify(c));
    delete noAttempt.entries[0].attempted;
    expect(() => parseBackupCapture(JSON.stringify(noAttempt))).toThrow();
    // skipped with attempted state is a lifecycle contradiction
    const skipped = abortCapture(beginCapture(plan), 'stop');
    const badSkip = JSON.parse(JSON.stringify(skipped));
    badSkip.entries[0].attempted = true;
    expect(() => parseBackupCapture(JSON.stringify(badSkip))).toThrow();
  });
  it('abort leaves never-attempted entries as skipped candidates with reason', () => {
    let c = beginCapture(plan);
    c = recordOutcome(c, '0600', { kind: 'reply', serviceEcho: 0x62, did: '0600', data: [1] });
    c = abortCapture(c, 'module went silent');
    expect(c.aborted!.reason).toBe('module went silent');
    const pending = c.entries.filter(e => e.did !== '0600');
    expect(pending.every(e => e.status === 'skipped' && e.reason === 'module went silent')).toBe(true);
    expect(c.entries.find(e => e.did === '0600')!.status).toBe('responded');
    // attempted count = only the DID actually sent
    expect(c.counts.attempted).toBe(1);
    expect(c.counts.skipped).toBe(plan.entries.length - 1);
  });
  it('records exact failure reasons — never fabricated', () => {
    let c = beginCapture(plan);
    c = recordFailed(c, '0600', { kind: 'desync', detail: 'link desynchronized during the read' });
    const e = c.entries.find(x => x.did === '0600')!;
    expect(e.failure).toEqual({ kind: 'desync', detail: 'link desynchronized during the read' });
  });
  it('snapshots are deeply immutable — later captures cannot alter earlier raw bytes', () => {
    const c1 = recordResponded(beginCapture(plan), '0600', [0x25, 0x24]);
    const c2 = recordAttempted(c1, '0A5E');
    expect(() => (c2.entries.find(e => e.did === '0600')!.response!.raw as number[]).push(0x99)).toThrow();
    expect(c1.entries.find(e => e.did === '0600')!.response!.raw).toHaveLength(2);
  });
  it('parseBackupCapture round-trips and rejects malformed evidence', () => {
    const c = recordOutcome(beginCapture(plan, { part: 'X' }), '0600', { kind: 'nrc', nrc: 0x31 });
    const back = parseBackupCapture(JSON.stringify(c));
    expect(back.entries.find(e => e.did === '0600')!.failure!.nrc).toBe('31');
    expect(() => parseBackupCapture('{"schema":"obdcraft.backup-capture/1"}')).toThrow();
    const bad = JSON.parse(JSON.stringify(c));
    bad.entries[0].failure = { kind: 'made-up', detail: 'x' };
    expect(() => parseBackupCapture(JSON.stringify(bad))).toThrow();
    // forged counts and a mismatched echo never parse — metrics are recomputed
    const forged = JSON.parse(JSON.stringify(c));
    forged.counts.decoded = 999;
    expect(() => parseBackupCapture(JSON.stringify(forged))).toThrow();
    const echoBad = JSON.parse(JSON.stringify(c));
    echoBad.entries[0].response = { raw: [1], serviceEcho: '6EF199' };
    echoBad.entries[0].status = 'decoded';
    echoBad.entries[0].decoded = { byteLength: 1 };
    expect(() => parseBackupCapture(JSON.stringify(echoBad))).toThrow();
  });
});
