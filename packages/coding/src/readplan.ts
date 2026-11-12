/**
 * Guarded read planning (G8) — a dry-run read plan with an explicit abort
 * policy. The plan is a REVIEWABLE artifact: it emits `22<DID>` requests in a
 * fixed order with per-DID candidate status, and the policy tells the
 * executor exactly when to stop. Nothing here performs I/O or authorizes a
 * write — every entry is a read, and every DID keeps its candidate status.
 *
 * Abort semantics mirror the vagcan sweep guard: a module that answered its
 * identity then goes silent is suspicious; an unanswered identity gate is a
 * hard stop; refusal bursts bound an unverified DID list.
 */

export const IDENTITY_DIDS = [0xf187, 0xf189, 0xf191, 0xf19e, 0xf1a2] as const;

export interface AbortPolicy {
  /** Silent-module bound: consecutive no-reply/timeout/desync outcomes. */
  maxConsecutiveSilent: number;
  /** Overall bound on refused+silent outcomes across the sweep. */
  maxTotalFailures: number;
  /** Identity reads must answer before any candidate sweep begins. */
  requireIdentityFirst: boolean;
}

export const DEFAULT_ABORT_POLICY: AbortPolicy = Object.freeze({
  maxConsecutiveSilent: 3,
  maxTotalFailures: 40,
  requireIdentityFirst: true,
});

const didHex = (v: string) => /^[0-9A-Fa-f]{4}$/.test(v);

export interface ReadPlanEntry {
  /** 4-hex DID, uppercase. */
  did: string;
  /** The exact on-wire request — always `22<DID>`, reads only. */
  request: string;
  /** 'identity' reads settle the unit; 'candidate' entries are unverified. */
  role: 'identity' | 'candidate';
  /** Provenance — e.g. 'vag.mqb.backup.09 (candidate list)'. */
  source: string;
}

export interface ReadPlan {
  schema: 'obdcraft.read-plan/1';
  module: { request: string; response: string };
  /** Identity gate runs first when the policy requires it. */
  identity: readonly ReadPlanEntry[];
  candidates: readonly ReadPlanEntry[];
  policy: AbortPolicy;
  /** True when the candidate list is unverified template data. */
  candidateOnly: true;
}

/**
 * Build the dry-run plan: identity DIDs (deduplicated, fixed order) then the
 * candidate list in source order, deduplicated and never including an
 * identity DID twice. Rejects malformed DIDs — a plan is refuse-not-guess.
 */
export function buildReadPlan(
  module: { request: string; response: string },
  candidateDids: readonly string[],
  source: string,
  policy: AbortPolicy = DEFAULT_ABORT_POLICY,
): ReadPlan {
  if (!/^[0-7][0-9A-Fa-f]{2}$/.test(module.request) || !/^[0-7][0-9A-Fa-f]{2}$/.test(module.response) ||
      module.request.toUpperCase() === '7DF') {
    throw new Error('Read plan requires physical 11-bit request/response CAN IDs — functional 7DF is not a module.');
  }
  if (!(policy.maxConsecutiveSilent > 0) || !(policy.maxTotalFailures > 0)) {
    throw new Error('Abort policy limits must be positive.');
  }
  const identityDids = policy.requireIdentityFirst ? IDENTITY_DIDS : [];
  const seen = new Set<string>(identityDids.map(d => d.toString(16).toUpperCase().padStart(4, '0')));
  const candidates: ReadPlanEntry[] = [];
  for (const raw of candidateDids) {
    const did = String(raw).trim().toUpperCase();
    if (!didHex(did)) throw new Error(`Malformed DID in candidate list: ${JSON.stringify(raw)}`);
    if (seen.has(did)) continue;
    seen.add(did);
    candidates.push({ did, request: `22${did}`, role: 'candidate', source });
  }
  return Object.freeze({
    schema: 'obdcraft.read-plan/1',
    module: Object.freeze({ request: module.request.toUpperCase(), response: module.response.toUpperCase() }),
    identity: identityDids.map(d => {
      const did = d.toString(16).toUpperCase().padStart(4, '0');
      return Object.freeze({ did, request: `22${did}`, role: 'identity' as const, source: 'uds-identity' });
    }),
    candidates: Object.freeze(candidates),
    policy,
    candidateOnly: true,
  });
}

export type ReadOutcome =
  | { kind: 'reply'; serviceEcho: number; data: number[]; did?: string }
  | { kind: 'nrc'; nrc: number }
  | { kind: 'no-reply' }
  | { kind: 'desync' }
  | { kind: 'error'; detail: string };

export interface PolicyState {
  consecutiveSilent: number;
  totalFailures: number;
  identityAnswered: boolean;
  aborted: boolean;
  reason: string | null;
  /** Entries already emitted in plan order (identity first, then candidates). */
  dispatchedCount: number;
  pendingDid: string | null;
  completedIdentityDids: string[];
}

export function newPolicyState(): PolicyState {
  return { consecutiveSilent: 0, totalFailures: 0, identityAnswered: false, aborted: false, reason: null, dispatchedCount: 0, pendingDid: null, completedIdentityDids: [] };
}

export type DispatchAction =
  | { kind: 'dispatch'; entry: ReadPlanEntry }
  | { kind: 'await-identity'; reason: string }
  | { kind: 'await-response'; did: string }
  | { kind: 'done' }
  | { kind: 'aborted'; reason: string | null };

/**
 * The pre-dispatch eligibility guard (C5): an executor asks for the NEXT legal
 * entry and the plan itself decides. Candidates can never be emitted before a
 * bound identity reply — an executor that only dispatches through this
 * function cannot violate the identity gate by construction. `stepPolicy`
 * remains the outcome transition; this is the emission side.
 */
export function nextDispatch(plan: ReadPlan, state: PolicyState): { state: PolicyState; action: DispatchAction } {
  if (state.aborted) return { state, action: { kind: 'aborted', reason: state.reason } };
  if (state.pendingDid) return { state, action: { kind: 'await-response', did: state.pendingDid } };
  const order = [...plan.identity, ...plan.candidates];
  const i = state.dispatchedCount;
  const entry = i < order.length ? order[i] : undefined;
  if (!entry) return { state, action: { kind: 'done' } };
  if (entry.role === 'candidate' && plan.policy.requireIdentityFirst &&
      !plan.identity.every(e => state.completedIdentityDids.includes(e.did))) {
    return {
      state,
      action: {
        kind: 'await-identity',
        reason: `identity gate unbound — ${plan.identity.length} identity reads dispatched without a bound reply; candidate ${entry.did} withheld`,
      },
    };
  }
  return { state: { ...state, dispatchedCount: i + 1, pendingDid: entry.did }, action: { kind: 'dispatch', entry } };
}

/**
 * Apply one read outcome to the policy — the pre-dispatch guard lives here:
 * a candidate outcome before a valid identity answer aborts the sweep;
 * transport desync/error is terminal, not one retryable silence; a positive
 * reply counts only when it is a bound `62`-echo with data — wrong-service
 * or empty replies are failures, never a gate opener.
 */
export function stepPolicy(state: PolicyState, role: 'identity' | 'candidate', outcome: ReadOutcome, policy: AbortPolicy): PolicyState {
  return applyOutcome(state, role, outcome, policy);
}

/**
 * Bound outcome application (C5): like `stepPolicy`, but the outcome is
 * validated against the exact entry that was dispatched. A positive reply
 * must echo THIS entry's DID — a `62` carrying a different DID is evidence
 * for nothing; a reply carrying no DID at all cannot bind either.
 */
export function stepPolicyBound(state: PolicyState, entry: ReadPlanEntry, outcome: ReadOutcome, policy: AbortPolicy): PolicyState {
  if (state.aborted) return state;
  if (state.pendingDid !== entry.did) {
    return { ...state, aborted: true, reason: `outcome for ${entry.did} has no matching outstanding dispatch` };
  }
  const ready = { ...state, pendingDid: null };
  if (outcome.kind === 'reply') {
    if (outcome.did !== undefined && !didHex(outcome.did)) {
      return failNow(ready, `identity/${entry.did} reply carried malformed DID echo '${outcome.did}'`, policy);
    }
    if (outcome.did === undefined || outcome.did.toUpperCase() !== entry.did) {
      return failNow(ready, `reply DID echo '${outcome.did ?? "absent"}' does not bind request 22${entry.did} — not evidence for this entry`, policy);
    }
  }
  const next = applyOutcome(ready, entry.role, outcome, policy);
  if (!next.aborted && entry.role === 'identity' && outcome.kind === 'reply' && outcome.serviceEcho === 0x62 && outcome.data.length > 0) {
    next.completedIdentityDids = [...new Set([...next.completedIdentityDids, entry.did])];
  }
  return next;
}

function failNow(state: PolicyState, reason: string, _policy: AbortPolicy): PolicyState {
  const next = { ...state, totalFailures: state.totalFailures + 1 };
  next.aborted = true;
  next.reason = reason;
  return next;
}

function applyOutcome(state: PolicyState, role: 'identity' | 'candidate', outcome: ReadOutcome, policy: AbortPolicy): PolicyState {
  if (state.aborted) return state;
  const next = { ...state };

  // Desync/error are terminal transport events — a sweep cannot continue
  // over an untrusted stream.
  if (outcome.kind === 'desync' || outcome.kind === 'error') {
    next.aborted = true;
    next.reason = `transport ${outcome.kind} — link untrusted; sweep aborted`;
    return next;
  }

  // Identity gate: candidates must not run before a bound identity answer.
  if (role === 'candidate' && policy.requireIdentityFirst && !next.identityAnswered) {
    next.aborted = true;
    next.reason = 'candidate dispatched before a bound identity reply — plan order violated; sweep aborted';
    return next;
  }

  switch (outcome.kind) {
    case 'reply': {
      // A bound positive reply: service echo 0x62 with payload data.
      const bound = outcome.serviceEcho === 0x62 && outcome.data.length > 0;
      if (!bound) {
        next.totalFailures += 1;
        if (role === 'identity') {
          next.aborted = true;
          next.reason = `identity reply not bound to the request (SID ${outcome.serviceEcho.toString(16)}, ${outcome.data.length} B) — cannot settle; sweep aborted`;
        }
        break;
      }
      next.consecutiveSilent = 0;
      if (role === 'identity') next.identityAnswered = true;
      break;
    }
    case 'nrc':
      next.consecutiveSilent = 0;
      next.totalFailures += 1;
      if (role === 'identity') {
        next.aborted = true;
        next.reason = `identity DID refused (NRC ${outcome.nrc.toString(16).toUpperCase()}) — unit cannot be settled; sweep aborted`;
      }
      break;
    case 'no-reply':
      next.consecutiveSilent += 1;
      next.totalFailures += 1;
      if (role === 'identity') {
        next.aborted = true;
        next.reason = 'identity DID unanswered — unit may be asleep or unreachable; sweep aborted';
      }
      break;
  }
  if (!next.aborted && next.consecutiveSilent >= policy.maxConsecutiveSilent) {
    next.aborted = true;
    next.reason = `${next.consecutiveSilent} consecutive silent reads — module not responding; sweep aborted`;
  }
  if (!next.aborted && next.totalFailures >= policy.maxTotalFailures) {
    next.aborted = true;
    next.reason = `${next.totalFailures} failed reads — candidate list too inaccurate for this unit; sweep aborted`;
  }
  return next;
}
