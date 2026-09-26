'use strict';

// THE TOOL REGISTRY, WITH THE CEILING A TEST RUNS UNDER STATED OUT LOUD.
//
// src/lib/tool-registry.js#executeTool() refuses a dispatch that states no
// permission session, because an omitted one used to skip the tier check
// entirely. Most tests in this tree called it as `executeTool(name, args)` with
// no third argument at all -- which was the same unbound shape the production
// callers had, and which now correctly refuses.
//
// Those tests are not testing the permission system; they are testing what a
// tool DOES when the owner runs it on their own machine. So this module binds
// exactly that and says so: a local Full owner session, the widest ceiling the
// product has, which is the honest description of "the owner ran this here".
//
// WHY A MODULE AND NOT A DEFAULT IN THE REGISTRY. A default inside executeTool()
// is indistinguishable from the bug being removed -- it would make an omitted
// session mean "full access" again, just spelled differently. This lives under
// tests/, is never required from src/, and names its ceiling in one place where
// it can be read and changed. Nothing in the shipped product can reach it.
//
// A test that wants a DIFFERENT ceiling passes its own `permissionSession` in
// the context and it wins, because the caller's context is spread last. Tests
// that are ABOUT the tier -- guarded-permission-tier, install-tier-enforcement,
// fra-manifest-permission-tier -- deliberately do not use this module; they
// construct their own sessions, which is the whole point of them.

// THIS MODULE SEES THE SHIPPED REGISTRY AND NOTHING ELSE.
//
// It was split out of tests/helpers/owner-dispatch.js on 2026-08-20. That module
// did one further thing: it require()d src/lib/tool-packs, which registers the
// owner- and vendor-side tools the installer does not ship. That single edge is
// what made every test using the helper unpublishable, because an open file may
// not require a withheld one -- and the great majority of those tests were never
// about the owner packs at all. They wanted a bound permission session.
//
// So the two concerns now live apart:
//
//   * THIS FILE binds the ceiling over the CORE registry -- the same surface the
//     payload contains. Use it unless your test names a tool from a pack.
//   * tests/helpers/owner-dispatch.js loads the packs first and then re-exports
//     this module, so a test that really is about the owner's wider surface keeps
//     working unchanged. That file is withheld from publication, and so is any
//     test that requires it.
//
// Switching a test from owner-dispatch to dispatch is only correct if it passes
// afterwards: a test that named a pack tool will fail with an unknown-tool error
// rather than quietly asserting less, which is what makes the triage safe.
const registry = require('../../src/lib/tool-registry');

/** The local owner session. Stated, not assumed. */
const OWNER_SESSION = Object.freeze({ origin: 'local', tier: 'full' });

function executeTool(name, args, context = {}) {
  return registry.executeTool(name, args, { permissionSession: OWNER_SESSION, ...context });
}

function createAgentToolExecutor(context = {}) {
  return registry.createAgentToolExecutor({ permissionSession: OWNER_SESSION, ...context });
}

// A PASS-THROUGH PROXY, NOT A COPY, AND NOT FROZEN.
//
// This was `Object.freeze({ ...registry, executeTool, ... })`, and both halves
// of that were wrong in ways only a test could reveal:
//
//   * FROZEN. src/lib/tool-registry.js does NOT freeze its exports, and
//     tests/unified-agent-p13-policy-evaluator.js assigns to
//     `registry.TOOL_REGISTRY` as a deliberate seam. Freezing here turned that
//     into "Cannot assign to read only property 'TOOL_REGISTRY'". A drop-in
//     replacement has to preserve the mutability of the thing it stands in for.
//
//   * A COPY. The spread SNAPSHOTS the exports, so `helper.TOOL_REGISTRY = x`
//     would have written to this object while every other module kept reading
//     the real one. That is worse than the freeze: the write succeeds and the
//     test silently stops testing what it says it tests.
//
// The proxy forwards every read and every WRITE to the real module object, so a
// test that swaps only its require path behaves exactly as it did before, and
// intercepts just the two functions that need a ceiling bound.
const OVERRIDES = { executeTool, createAgentToolExecutor, OWNER_SESSION };

module.exports = new Proxy(registry, {
  get(target, property, receiver) {
    if (Object.prototype.hasOwnProperty.call(OVERRIDES, property)) return OVERRIDES[property];
    return Reflect.get(target, property, receiver);
  },
  set(target, property, value, receiver) {
    // Deliberately NOT special-cased: a test assigning executeTool wants to
    // replace the real one, and hiding that behind the override would make the
    // assignment silently ineffective.
    return Reflect.set(target, property, value, receiver);
  },
  has(target, property) {
    return Object.prototype.hasOwnProperty.call(OVERRIDES, property) || Reflect.has(target, property);
  },
  ownKeys(target) {
    return [...new Set([...Reflect.ownKeys(target), 'OWNER_SESSION'])];
  },
  getOwnPropertyDescriptor(target, property) {
    if (property === 'OWNER_SESSION') {
      return { configurable: true, enumerable: true, value: OWNER_SESSION, writable: false };
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  }
});
