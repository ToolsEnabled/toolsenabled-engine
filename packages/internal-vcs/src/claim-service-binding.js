'use strict';

/**
 * Real binding for FileKeeper's claim surface (acquireClaim / heartbeatClaim /
 * releaseClaim / inspectClaim).
 *
 * WHY THIS FILE EXISTS: `./services/claim-service.js` exports four
 * `unboundService(...)` stubs on purpose -- that file's job is to describe
 * the contract, and `test/unbound-services.test.js` locks it there (it walks
 * every file in `src/services/` and asserts it still returns
 * `unboundService(...)`, which is exactly why this binding lives in `src/`
 * instead of `src/services/`). The real implementation already exists at
 * `./m4/claim-authority.js` (407 lines, fully tested by
 * `test/m4-claims.test.js`) and is already wired into
 * `./m9/internal-vcs-system.js`'s `services.claims` facade. The problem was
 * never a missing implementation: `createInternalVcsSystem(options)` also
 * hard-requires `publicationAdapter`, `sagaAdapters`, `backupStore`,
 * `signatureAuthority`, `shadowImporter`, and `rollbackAdapter` (via
 * `requireDependency`, see internal-vcs-system.js) before it will construct
 * ANYTHING, including the claim authority that needs none of them. A caller
 * that only wants fenced claims -- a lane-dispatch loop deciding whether two
 * lanes may touch overlapping file territory concurrently -- has no adapters
 * for publication/saga/backup/shadow-import/rollback and was never going to
 * get any, so it could never call the factory, so claims were never bound.
 *
 * This module is the narrow fix: it binds ONLY the claim surface, requiring
 * ONLY what `createClaimAuthority` itself actually requires (nothing, by
 * default -- see "What is stubbed" below).
 *
 * NOT reimplemented: all matching, fencing, TTL, and expiry logic below is
 * `ClaimAuthority` from `./m4/claim-authority.js`, used as-is. This file
 * adds zero claim-authority logic; it only adapts the method surface named
 * by `./services/claim-service.js`'s JSDoc contract to a callable instance.
 *
 * What is stubbed, honestly, and why that is safe:
 *   - `clock`: defaults to `() => new Date().toISOString()` (real wall
 *     clock). This is `ClaimAuthority`'s own default, not something new the
 *     binding introduces.
 *   - `controlStore`: defaults to `null`, meaning claim.acquired /
 *     .heartbeat / .released / .revoked / .expired / .abandoned events are
 *     NOT durably logged and claim state does NOT survive a process
 *     restart -- it lives only in the `Map` inside the `ClaimAuthority`
 *     instance this factory creates. This is honest, not a shortcut: a real
 *     durable event log (`FileControlStore`) already exists at
 *     `./m1/control-store.js` and is reused verbatim, not rebuilt, when a
 *     caller passes one in via `controlStore`. This binding does not invent
 *     a second control-store implementation and does not silently write to
 *     disk by default.
 *   - identity/authorization: NOT stubbed because it is not needed here.
 *     `holderId` and `policyRevisionId` are opaque strings the caller
 *     supplies directly (see `./m4/claim-authority.js` `acquireClaim`);
 *     policy *resolution* is a separate concern (`./m3/identity-policy-authority.js`)
 *     used by the revision/governance surfaces, not by claims.
 *
 * Process scope: one `createClaimServiceBinding()` call produces one
 * in-memory `ClaimAuthority`. Fencing is only real between callers that
 * share the SAME bound instance (e.g. all lanes dispatched by one
 * long-lived supervisor process calling `getSharedClaimService()` below).
 * Two separate OS processes each calling `createClaimServiceBinding()`
 * independently get two independent claim tables and will NOT fence each
 * other -- pass a shared `controlStore` (or otherwise share one process) to
 * fence across processes.
 */

const { createClaimAuthority } = require('./m4/claim-authority');

/**
 * Bind a fresh, single, in-process claim authority to the four claim-service
 * methods. The returned object is the "smallest honest binding" a
 * lane-dispatch caller can hold onto and call repeatedly to acquire a
 * fenced claim over a file territory (a `ScopeSelector[]`), heartbeat it
 * before its TTL lapses, and release it when the lane finishes.
 *
 * @param {object} [options]
 * @param {object|null} [options.controlStore] Durable event sink, e.g.
 *   `createFileControlStore({ root })` from `./m1/control-store.js`.
 *   Defaults to `null` (in-memory only; see module header).
 * @param {() => (number|string)} [options.clock] Defaults to the real wall
 *   clock (`ClaimAuthority`'s own default).
 * @param {number} [options.maxTtlMs] Upper bound enforced on every
 *   `ttlMs` passed to acquireClaim/heartbeatClaim. Defaults to
 *   `ClaimAuthority`'s own default (5 minutes).
 * @param {string} [options.compatibilityRuleRevisionId] Forwarded as-is.
 * @param {((left, right) => boolean|null)|null} [options.aliasResolver]
 *   Forwarded as-is; see `./m4/claim-authority.js` `selectorRelation`.
 * @returns {Readonly<{
 *   acquireClaim: (input: object) => Promise<object>,
 *   heartbeatClaim: (input: object) => Promise<object>,
 *   releaseClaim: (input: object) => Promise<object>,
 *   inspectClaim: (input: object) => Promise<object>,
 * }>}
 */
function createClaimServiceBinding(options = {}) {
  const {
    controlStore = null,
    clock,
    maxTtlMs,
    compatibilityRuleRevisionId,
    aliasResolver,
  } = options;

  const authorityOptions = { controlStore };
  if (clock !== undefined) authorityOptions.clock = clock;
  if (maxTtlMs !== undefined) authorityOptions.maxTtlMs = maxTtlMs;
  if (compatibilityRuleRevisionId !== undefined) authorityOptions.compatibilityRuleRevisionId = compatibilityRuleRevisionId;
  if (aliasResolver !== undefined) authorityOptions.aliasResolver = aliasResolver;

  const authority = createClaimAuthority(authorityOptions);

  return Object.freeze({
    /** @param {{holderId:string,scope:import('./types').ScopeSelector[],ttlMs:number,expectedAbsent?:boolean,policyRevisionId:string,compatibilityRuleRevisionId?:string}} input @returns {Promise<import('./types').WorkClaim>} */
    async acquireClaim(input) { return authority.acquireClaim(input); },
    /** @param {{binding:import('./types').FenceBinding,ttlMs:number}} input @returns {Promise<import('./types').WorkClaim>} */
    async heartbeatClaim(input) { return authority.heartbeatClaim(input); },
    /** @param {{binding:import('./types').FenceBinding,reason:string}} input @returns {Promise<import('./types').LifecycleTransition>} */
    async releaseClaim(input) { return authority.releaseClaim(input); },
    /** @param {{scope:import('./types').ScopeSelector[],authoritySnapshotId?:string|null}} input @returns {Promise<{claims:import('./types').WorkClaim[],compatibility:import('./types').ScopeCompatibilityDecision}>} */
    async inspectClaim(input) { return authority.inspectClaim(input); },
    /**
     * Escape hatch for callers that need `bindingFor`/`validateFence`
     * directly (e.g. to fence a write with a claim acquired earlier) without
     * reaching past this binding into `./m4/claim-authority.js` themselves.
     */
    _authority: authority,
  });
}

// One process-wide shared binding, created lazily on first use. This is the
// instance a lane-dispatch supervisor should call so every lane dispatched
// by that one process shares one claim table -- see "Process scope" above.
// Deliberately NOT auto-created at module load: constructing it is free
// (pure JS, no I/O by default) but callers that want a controlStore/clock
// override must be able to configure it before anything touches it.
let sharedBinding = null;

/**
 * @param {Parameters<typeof createClaimServiceBinding>[0]} [options] Only
 *   consulted on the FIRST call in this process; later calls return the
 *   already-created shared instance regardless of `options`.
 */
function getSharedClaimService(options) {
  if (!sharedBinding) sharedBinding = createClaimServiceBinding(options);
  return sharedBinding;
}

/** Test-only: drop the process-wide shared binding so the next `getSharedClaimService` call builds a fresh one. */
function resetSharedClaimServiceForTests() {
  sharedBinding = null;
}

module.exports = Object.freeze({
  createClaimServiceBinding,
  getSharedClaimService,
  resetSharedClaimServiceForTests,
});
