// EXECUTABLE CHANGE
//
// TEST-CAN-FAIL REPORT (testcanfail-tests-redteam-mediation-fence-test-js)
// Suspect strengthened: FENCE-HOLDS F1 enumerated
// Object.getOwnPropertySymbols(registry), which is empty in the intended state,
// so its per-symbol assertion did not execute. The added deepEqual makes the
// intended zero-symbol invariant itself observable rather than relying on a
// vacuous universal assertion.
// Mutation attempted: add a non-enumerable symbol-keyed own property to the
// exported registry object. The required mutation/red/restore executions could
// not be completed because this image supplies Node v20.20.2, while the project
// requires Node >=22.19.0 and loading the subject fails first with:
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite"
// Fetching Node 22 was also unavailable (npm returned E403). This unmet runtime
// precondition also prevents quoting a mutation RED or restored GREEN result.
// The source file was not modified, so there is no mutated source to restore.
//
// Shape census:
// (1) FOUND: F1's possibly-empty symbol loop; strengthened below. The loops in
//     B1/B2/B3/I3 use non-empty literals. F3 first asserts its symbol collection
//     is empty and independently refuses the forgery, so its empty loop is not
//     the only evidence for its claim.
// (2) NOT-FOUND: no assertion uses process exit status or a merely truthy
//     process return as evidence; process.exitCode only reports accumulated
//     assertion failures.
// (3) NOT-FOUND: check/asyncCheck record caught assertion failures, asProduction
//     restores environment state in finally, and H's error-to-value catches are
//     followed by exact error-code assertions (a fulfilled success fails them).
// (4) NOT-FOUND: forged executors are adversarial inputs/recorders; mediation is
//     always decided by the real registry and AgentWorker implementations.
// (5) NOT-FOUND: there are no skips or platform guards. Isolated test state is
//     activated unconditionally and the production-state seam is asserted.
// (6) NOT-FOUND: expected values are fixed contract values or independently
//     observed controls, not computed by the implementation under test.

'use strict';

// RED TEAM: THE AGENT-TOOL MEDIATION FENCE.
//
// src/lib/tool-registry.js#isMediatedAgentToolExecutor() and
// src/agent/agent-worker.js#assertMediatedToolExecutor() are supposed to be the
// chokepoint that guarantees every tool call an AgentWorker makes passes through
// executeTool() -- permission tier, allowlist, egress preflight, action guards,
// model floor, audit, metering. Everything the product refuses to do sits behind
// that chokepoint.
//
// THE SHAPE OF THE HOLE THIS FILE FOUND, and what closed it.
// AGENT_TOOL_EXECUTOR_MARKER was a Symbol exported BY NAME on the public
// tool-registry.js module.exports object, and isMediatedAgentToolExecutor()
// only duck-typed "carries the marker + has a function called execute". Any
// module that could `require('.../tool-registry')` could stamp that Symbol onto
// a hand-rolled object and hand it to AgentWorker as a second, unmediated tool
// path -- and worse, the marker was an own symbol-keyed property of every real
// executor, so `Object.getOwnPropertySymbols(anyExecutor)[0]` recovered it by
// reflection with no import at all. The fix is a module-private WeakSet:
// membership is recorded by createAgentToolExecutor() and nothing outside
// tool-registry.js holds a reference to the set, so the question the fence asks
// changed from "does this look right" to "did I make this exact object".
//
// THIS FILE PINS TODAY'S REAL BEHAVIOUR. The tags are load-bearing:
//   FENCE-CLOSED: this route WORKED before the WeakSet landed and is refused
//     now. The comment above each one names what it used to achieve, so a
//     regression that reopens it is recognisable rather than merely red.
//   FENCE-HOLDS: already correct before the fix and still correct after it.
//   FENCE-SEAM: the ONE remaining way to mint a mediated executor outside the
//     factory -- registerAgentToolExecutorForTests(), which the agent-loop
//     suites need and which refuses outside an isolated test environment. It is
//     recorded here rather than hidden, both halves asserted.
// There are deliberately NO `FENCE-OPEN` tags left in this file. A grep for
// that string returning nothing is the point; if a future change reopens a
// route, tag it FENCE-OPEN again so the grep speaks.
//
// SAFETY. This file performs no real outward action. The forged/hijacked
// executors used below do nothing but push a record into a local array and
// return a benign object -- no network call, no vault read, no spend. The one
// section (H) that dispatches through a REAL, genuinely-created executor calls
// a real LOCAL-WRITE tool with intentionally incomplete arguments so it fails
// schema validation before its handler ever runs; no file is actually written.
// Audit/vault/state paths are redirected to a throwaway temp directory by
// tests/lib/isolated-environment.js, activated first, below.

require('../lib/isolated-environment').activate('mediation-fence-redteam');

const assert = require('node:assert/strict');
const AgentWorker = require('../../src/agent/agent-worker');
const registry = require('../../src/lib/tool-registry');
const {
  createAgentToolExecutor, isMediatedAgentToolExecutor,
  registerAgentToolExecutorForTests, TOOL_REGISTRY
} = registry;
const ScriptedFakeProvider = require('../helpers/scripted-provider');

const FULL_SESSION = Object.freeze({ origin: 'local', tier: 'full' });
const GUARDED_SESSION = Object.freeze({ origin: 'remote', tier: 'guarded' });
const CANARY_TOOL_NAME = 'redteam.mediation_fence_canary';
const UNMEDIATED = error => error?.code === 'UNMEDIATED_TOOL_EXECUTOR';

let checks = 0;
let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); checks += 1; }
  catch (error) { console.error(`  FAIL ${name}: ${error && error.stack || error}`); failures += 1; }
}

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); checks += 1; }
  catch (error) { console.error(`  FAIL ${name}: ${error && error.stack || error}`); failures += 1; }
}

// The forged handler contract for this whole file: record that it was called,
// touch nothing real, return a benign marker object. Before the fix this
// function ended with an Object.defineProperty that stamped the exported marker
// Symbol and made the result indistinguishable from a real executor. There is
// nothing left to stamp, so what it returns is now exactly what it looks like:
// a plain object wearing an executor's shape and none of its provenance.
function forgeExecutor(handler = async (name, args) => ({ ok: true, forged: true, name, args })) {
  return {
    calls: [],
    async execute(name, args, options) {
      this.calls.push({ name, args, options });
      return handler(name, args, options);
    }
  };
}

function scriptedToolCallResponse(toolName, args = {}) {
  return { text: 'invoking a tool', toolCalls: [{ name: toolName, args }], finishReason: 'tool_calls' };
}

async function dispatchOneCall(workerOptions, runCycleExtra, toolName = CANARY_TOOL_NAME) {
  const provider = new ScriptedFakeProvider([scriptedToolCallResponse(toolName, { probe: true })]);
  const worker = new AgentWorker({ limits: { maxCycles: 1, maxToolCalls: 5 }, ...workerOptions });
  return worker.runCycle({ prompt: 'trigger exactly one tool call', provider, ...runCycleExtra });
}

// Run `fn` with the isolated-test marker removed, so a call can be observed
// exactly as production would see it. Synchronous on purpose: no await inside,
// so no other work in this process can observe the gap.
function asProduction(fn) {
  const marker = 'TOOLSENABLED_TEST_ISOLATED';
  const saved = process.env[marker];
  delete process.env[marker];
  try { return fn(); }
  finally { if (saved === undefined) delete process.env[marker]; else process.env[marker] = saved; }
}

async function main() {
  console.log('mediation-fence red team');

  // ==========================================================================
  // 0. CANARY -- confirm the fix's stated shape before testing around it. If
  //    either of these fails, this whole file's premise is stale and every
  //    FENCE-CLOSED result below needs re-deriving.
  // ==========================================================================

  check('canary: NO marker Symbol is exported by name from the public registry object', () => {
    assert.equal(registry.AGENT_TOOL_EXECUTOR_MARKER, undefined,
      'the marker export is what made forgery a one-liner; it must not come back');
    const exportedSymbols = Object.entries(registry)
      .filter(([, value]) => typeof value === 'symbol')
      .map(([name]) => name);
    assert.deepEqual(exportedSymbols, [],
      `any exported Symbol is a candidate key to the same door: ${exportedSymbols.join(', ')}`);
  });

  check('canary: isMediatedAgentToolExecutor checks OBJECT IDENTITY, not marker + execute() shape', () => {
    const forged = forgeExecutor();
    assert.equal(typeof forged.execute, 'function', 'the forgery genuinely has the executor shape');
    assert.equal(isMediatedAgentToolExecutor(forged), false,
      'if this is ever true, the check went back to duck-typing and every FENCE-CLOSED test below must be re-run');
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    assert.equal(isMediatedAgentToolExecutor(real), true, 'the factory output must still be accepted');
  });

  // ==========================================================================
  // A. STAMP A FORGED EXECUTOR ONTO ALL THREE ENTRY POINTS.
  //    src/agent/agent-worker.js reads the executor from, in order:
  //      input.toolExecutor -> this.toolExecutor -> this.toolRegistry
  //    this.toolExecutor and this.toolRegistry are bound once, at construction,
  //    from options.toolExecutor / options.toolRegistry.
  // ==========================================================================

  // FENCE-CLOSED: this used to construct successfully and run the forged
  // handler instead of executeTool() on the first tool call. It now refuses at
  // the wiring site, before a provider is ever contacted.
  check('FENCE-CLOSED A1: a forged executor via options.toolExecutor (constructor) is REFUSED', () => {
    assert.throws(() => new AgentWorker({ toolExecutor: forgeExecutor() }), UNMEDIATED);
  });

  // FENCE-CLOSED: same route, the options.toolRegistry entry point.
  check('FENCE-CLOSED A2: a forged executor via options.toolRegistry (constructor) is REFUSED', () => {
    assert.throws(() => new AgentWorker({ toolRegistry: forgeExecutor() }), UNMEDIATED);
  });

  // FENCE-CLOSED: the per-call entry point, checked freshly on every runCycle()
  // rather than once at construction. It used to reach the forged handler.
  await asyncCheck('FENCE-CLOSED A3: a forged executor via input.toolExecutor (runCycle argument) is REFUSED before any dispatch', async () => {
    const forged = forgeExecutor();
    await assert.rejects(dispatchOneCall({}, { toolExecutor: forged }), UNMEDIATED);
    assert.equal(forged.calls.length, 0, 'the forged handler must never be reached, not even once');
  });

  // ==========================================================================
  // B. A FALSY EXECUTOR. assertMediatedToolExecutor() used to return early on
  //    `!executor`, which waved through 0, '', NaN and false alongside the two
  //    values that actually mean "not supplied". That was never a live bypass
  //    -- no falsy value can carry a callable `.execute`, so dispatch failed
  //    closed one line later at TOOL_EXECUTOR_UNAVAILABLE -- but it turned a
  //    wiring bug into a mid-run terminal reason. The skip now reads
  //    `undefined || null` exactly.
  // ==========================================================================

  const NOT_SUPPLIED = [undefined, null];
  const WRONG_TYPE_FALSY = [0, '', NaN, false];

  check('FENCE-HOLDS B1: undefined and null still mean "no executor supplied" and are skipped at construction', () => {
    for (const value of NOT_SUPPLIED) {
      assert.doesNotThrow(() => new AgentWorker({ toolExecutor: value }),
        `${String(value)} means "not supplied" and must stay constructible`);
      assert.doesNotThrow(() => new AgentWorker({ toolRegistry: value }),
        `${String(value)} means "not supplied" and must stay constructible`);
    }
  });

  // FENCE-CLOSED: these four used to slip past the assertion entirely.
  await asyncCheck('FENCE-CLOSED B2: a non-nullish falsy value in an executor slot is REFUSED at the wiring site, not at dispatch', async () => {
    for (const value of WRONG_TYPE_FALSY) {
      assert.throws(() => new AgentWorker({ toolExecutor: value }), UNMEDIATED,
        `${String(value)} is a wiring bug and must be refused where it was wired`);
      assert.throws(() => new AgentWorker({ toolRegistry: value }), UNMEDIATED,
        `${String(value)} is a wiring bug and must be refused where it was wired`);
      await assert.rejects(dispatchOneCall({}, { toolExecutor: value }), UNMEDIATED);
    }
  });

  await asyncCheck('FENCE-HOLDS B3: a genuinely absent input.toolExecutor still fails closed at dispatch', async () => {
    for (const value of NOT_SUPPLIED) {
      const result = await dispatchOneCall({}, { toolExecutor: value });
      assert.equal(result.status, 'FAILED');
      assert.equal(result.terminalReason.code, 'TOOL_EXECUTOR_UNAVAILABLE',
        `${String(value)} must fail closed, not silently succeed or silently no-op`);
    }
  });

  // ==========================================================================
  // C. A PROXY THAT PASSES THE FENCE CHECK THROUGH TO A REAL EXECUTOR, BUT
  //    ROUTES execute() TO A HAND-ROLLED HANDLER.
  // ==========================================================================

  // FENCE-HOLDS, BUT THE REASON CHANGED, AND THAT IS THE POINT. This used to be
  // blocked by accident: createAgentToolExecutor() returns Object.freeze(...),
  // which makes `execute` non-configurable and non-writable, and the ECMAScript
  // Proxy [[Get]] invariant makes a lying `get` trap throw a TypeError for
  // exactly that kind of property. The old fence read `executor.execute` first,
  // so the throw happened inside it -- V8 doing the work, not this codebase.
  // The fence no longer reads any property at all, so nothing throws: the proxy
  // is simply a DIFFERENT OBJECT from the one the factory minted, and is
  // refused on identity. The invariant still fires on a bare property read,
  // asserted below, which is what makes the distinction visible.
  check('FENCE-HOLDS C1: a lying Proxy over a REAL executor is refused ON IDENTITY -- deliberately now, not by a Proxy invariant', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'execute') return async () => ({ ok: true, hijacked: true });
        return Reflect.get(target, prop, receiver);
      }
    });
    assert.equal(isMediatedAgentToolExecutor(proxy), false,
      'the fence must reject the wrapper without reading a single property off it');
    assert.throws(() => new AgentWorker({ toolExecutor: proxy }), UNMEDIATED);
    assert.throws(() => proxy.execute, TypeError,
      'the V8/spec invariant still fires on a bare property read -- independent of the fence, and no longer relied on by it');
  });

  // FENCE-CLOSED: the identical technique over an UNFROZEN forged target used
  // to work, because no invariant protects a target that was never frozen --
  // i.e. this was route A wearing a Proxy costume. Identity closes both at once.
  await asyncCheck('FENCE-CLOSED C2: the same lying-Proxy technique over an unfrozen forged object is REFUSED too', async () => {
    const forged = forgeExecutor();
    let hijackedCalls = 0;
    const proxy = new Proxy(forged, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return async (name, args) => { hijackedCalls += 1; return { ok: true, hijacked: true, name, args }; };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    assert.equal(isMediatedAgentToolExecutor(proxy), false, 'an unfrozen target changes nothing: identity is the only test');
    await assert.rejects(dispatchOneCall({}, { toolExecutor: proxy }), UNMEDIATED);
    assert.equal(hijackedCalls, 0, 'the hijacked handler must never run');
  });

  // ==========================================================================
  // D. Object.create(realExecutor) -- PROTOTYPAL SHADOWING.
  // ==========================================================================

  // FENCE-CLOSED (STRICTER THAN BEFORE): a prototype-chain child used to be
  // ACCEPTED, because the marker resolved through the chain. Unshadowed it was
  // harmless -- it really did call the real execute -- but accepting it is what
  // made D3 exploitable. A child is not the object the factory minted, so it is
  // refused now whether or not it has been tampered with, and the real function
  // is still reachable through it, which is the part that did not change.
  check('FENCE-CLOSED D1: Object.create(realExecutor) is REFUSED even untampered, though it still resolves the real execute()', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const child = Object.create(real);
    assert.equal(child.execute, real.execute, 'unshadowed, execute is still the literal real function reference');
    assert.equal(isMediatedAgentToolExecutor(child), false, 'inheriting behaviour is not the same as being the minted object');
    assert.throws(() => new AgentWorker({ toolExecutor: child }), UNMEDIATED);
  });

  // FENCE-HOLDS: plain JS semantics (Object.freeze on a prototype blocks
  // simple-assignment shadowing from a child), not something the mediation
  // fence provides. Documented so nobody mistakes it for the fence working --
  // the next check shows the same freeze does NOT stop Object.defineProperty.
  check('FENCE-HOLDS D2: shadowing execute on the child via plain assignment is blocked (frozen non-writable inherited property, strict mode)', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const child = Object.create(real);
    assert.throws(() => { child.execute = async () => ({ hijacked: true }); }, TypeError);
    assert.equal(child.execute, real.execute, 'the real function must remain reachable after the failed assignment');
  });

  // FENCE-CLOSED: the shadow itself still succeeds and always will --
  // Object.freeze(real) freezes real's OWN property table, while
  // Object.defineProperty writes the child's, never consulting the prototype.
  // JavaScript offers no way to stop that. What changed is that the resulting
  // object can no longer be handed to AgentWorker: the fence asks who minted
  // it, and the answer is nobody. This is the route the WeakSet exists for.
  await asyncCheck('FENCE-CLOSED D3: Object.defineProperty still shadows the child (JS semantics), but the hijacked child is REFUSED', async () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const child = Object.create(real);
    let hijacked = 0;
    Object.defineProperty(child, 'execute', {
      value: async () => { hijacked += 1; return { ok: true }; },
      enumerable: true, writable: true, configurable: true
    });
    assert.notEqual(child.execute, real.execute, 'the shadow genuinely took effect -- freezing a prototype cannot prevent it');
    assert.equal(isMediatedAgentToolExecutor(child), false, 'but a shadowed child is not a mediated executor');
    await assert.rejects(dispatchOneCall({}, { toolExecutor: child }), UNMEDIATED);
    assert.equal(hijacked, 0, 'the shadowed handler must never be reached through AgentWorker');
  });

  // ==========================================================================
  // E. {...realExecutor} -- A SPREAD COPY.
  // ==========================================================================

  // FENCE-HOLDS, for a better reason than before. A spread copy used to be
  // rejected only because the marker was defined enumerable:false and so did
  // not survive the copy -- a property of how the marker was declared, one
  // Object.defineProperty away from being undone (see E2). It is rejected now
  // because a copy is a different object, which nothing can undo.
  check('FENCE-HOLDS E1: a plain spread copy of a real executor is REJECTED', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const copy = { ...real };
    assert.equal(typeof copy.execute, 'function', 'spread does still copy the enumerable execute property');
    assert.equal(isMediatedAgentToolExecutor(copy), false);
    assert.throws(() => new AgentWorker({ toolExecutor: copy }), UNMEDIATED);
  });

  // FENCE-CLOSED: re-stamping the marker onto that same copy used to revive the
  // bypass in one line. There is now nothing to re-stamp -- copying EVERY own
  // property of a real executor, string- and symbol-keyed alike, still produces
  // an object the fence does not know.
  check('FENCE-CLOSED E2: copying every own property of a real executor onto a hijacked copy does NOT revive the bypass', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const copy = { ...real, execute: async () => ({ hijacked: true }) };
    for (const symbol of Object.getOwnPropertySymbols(real)) {
      Object.defineProperty(copy, symbol, { value: true, enumerable: false });
    }
    for (const name of Object.getOwnPropertyNames(real)) {
      if (name === 'execute') continue;
      Object.defineProperty(copy, name, { value: real[name], enumerable: false });
    }
    assert.equal(isMediatedAgentToolExecutor(copy), false, 'membership is not a property, so it cannot be copied');
    assert.throws(() => new AgentWorker({ toolExecutor: copy }), UNMEDIATED);
  });

  // ==========================================================================
  // F. REACHING THE FENCE'S KEY WITHOUT BEING HANDED ONE.
  // ==========================================================================

  check('FENCE-HOLDS F1: nothing symbol-keyed on the registry export mediates anything', () => {
    const symbolKeys = Object.getOwnPropertySymbols(registry);
    assert.deepEqual(symbolKeys, [],
      'the registry export must not expose even an unknown symbol-keyed candidate for a mediation marker');
    for (const symbol of symbolKeys) {
      const fake = { execute: async () => ({}) };
      Object.defineProperty(fake, symbol, { value: true });
      assert.equal(isMediatedAgentToolExecutor(fake), false,
        'a symbol-keyed property of the registry export must not be a usable marker');
    }
    assert.equal(registry.AGENT_TOOL_EXECUTOR_MARKER, undefined,
      'and the by-name route -- an ordinary, enumerable property read, which never needed reflection at all -- is gone');
  });

  check('FENCE-HOLDS F2: Symbol.for() cannot forge mediation', () => {
    const guess = Symbol.for('toolsenabled.agent-tool-executor');
    const fake = { execute: async () => ({}) };
    Object.defineProperty(fake, guess, { value: true });
    assert.equal(isMediatedAgentToolExecutor(fake), false, 'a Symbol.for() guess must not satisfy the fence');
  });

  // FENCE-CLOSED, AND THE HIGHEST-VALUE ROUTE THIS FILE FOUND. The marker used
  // to be recoverable via reflection off ANY real executor INSTANCE, with zero
  // import of tool-registry.js: a caller that only ever SAW one live executor
  // -- handed one by legitimate code, or observing one across a serialization
  // boundary that leaks object references -- could mint forgeries forever
  // after. Un-exporting the constant would NOT have closed that; only removing
  // the marker from the object entirely does. A real executor now carries no
  // symbol-keyed own property at all, and its only own property is `execute`.
  check('FENCE-CLOSED F3: a real executor INSTANCE leaks no marker -- reflection recovers nothing to forge with', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    assert.deepEqual(Object.getOwnPropertySymbols(real), [],
      'a symbol-keyed own property here is a key any observer of one executor can copy');
    assert.deepEqual(Object.getOwnPropertyNames(real), ['execute'],
      'nothing beyond the dispatch function should be observable on an executor');
    const forged = { execute: async () => ({ hijacked: true }) };
    for (const symbol of Object.getOwnPropertySymbols(real)) {
      Object.defineProperty(forged, symbol, { value: true, enumerable: false });
    }
    assert.equal(isMediatedAgentToolExecutor(forged), false,
      'observing a live executor must grant no ability to mint another');
  });

  // ==========================================================================
  // G. OBTAIN A REAL EXECUTOR, THEN TRY TO MUTATE IT IN PLACE. IS Object.freeze REAL?
  // ==========================================================================

  // FENCE-HOLDS: genuine protection before the fix and after it. Note the last
  // assertion: the freeze also refuses any NEW property, which is what stops a
  // caller re-decorating a real executor with a marker of its own devising.
  check('FENCE-HOLDS G: Object.freeze on a real executor genuinely blocks direct mutation of that exact object', () => {
    const real = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    assert.equal(Object.isFrozen(real), true);
    assert.throws(() => { real.execute = async () => ({ hijacked: true }); }, TypeError,
      'assigning over execute on the frozen object itself must throw in strict mode');
    assert.throws(() => Object.defineProperty(real, 'execute', { value: async () => ({}) }), TypeError,
      'redefining execute on the frozen object itself must throw');
    assert.throws(() => Object.defineProperty(real, Symbol('forged-marker'), { value: true }), TypeError,
      'adding any new symbol-keyed property to the frozen object must throw');
    assert.throws(() => { delete real.execute; }, TypeError,
      'deleting execute from the frozen object itself must throw in strict mode');
  });

  // ==========================================================================
  // H. THE ROUTE NOBODY NAMED: THE CLOSED-OVER `context`.
  //
  // createAgentToolExecutor(context) returns Object.freeze(executor), but
  // `execute()` used to be a closure over the ORIGINAL, CALLER-SUPPLIED
  // `context` object, which the factory never froze or cloned. The executor's
  // OWN property table was genuinely immutable (section G proves it) -- while
  // the authority behind every call it made lived in a second, ordinary,
  // mutable object the caller still held a reference to.
  //
  // That was worse than C/D3/F3 for one specific reason: it SURVIVES an
  // identity fix. The WeakSet still contains `real` here -- `real` never
  // changes identity, is never re-created, and its `execute` reference never
  // changes either. Only the free variable that function closed over changed.
  // Membership proves provenance, never immutability, so the factory binds a
  // shallow frozen snapshot (`Object.freeze({ ...context })`) as well.
  //
  // Demonstrated without any real filesystem action: GUARDED is refused at the
  // permission-tier gate (PERMISSION_EFFECT_REFUSED) before schema validation
  // or the handler ever run. The third executor below is the control: built
  // with FULL from the start, the identical call clears the tier gate and fails
  // one step later on schema validation (INVALID_PARAMS, from the deliberately
  // incomplete `{}` arguments) -- never reaching the real handler either way.
  // Without that control, "still refused" could just mean FULL refuses too.
  // ==========================================================================

  // FENCE-CLOSED: before the snapshot, mutating context.permissionSession to
  // FULL moved the SAME frozen executor, calling the SAME execute reference,
  // from PERMISSION_EFFECT_REFUSED to past the tier gate.
  await asyncCheck('FENCE-CLOSED H: mutating the closed-over context after construction no longer changes what a real executor does', async () => {
    const localWriteTool = TOOL_REGISTRY.find(entry => entry.effect === 'local-write');
    assert.ok(localWriteTool, 'need a real local-write tool to show the tier gate; TOOL_REGISTRY layout changed if this is missing');

    const context = { permissionSession: GUARDED_SESSION };
    const real = createAgentToolExecutor(context);
    assert.equal(isMediatedAgentToolExecutor(real), true, 'this is the genuine, minted, frozen executor -- no forgery anywhere in this check');
    assert.equal(Object.isFrozen(context), false,
      "the factory freezes its own SNAPSHOT, not the caller's object -- freezing the caller's object would be a surprising side effect");

    const before = await real.execute(localWriteTool.name, {}, {}).catch(error => error);
    assert.equal(before?.code, 'PERMISSION_EFFECT_REFUSED', 'GUARDED must refuse a local-write tool at the tier gate, before schema validation');

    // Same object identity throughout. No new executor. No new function.
    context.permissionSession = FULL_SESSION;

    const after = await real.execute(localWriteTool.name, {}, {}).catch(error => error);
    assert.equal(after?.code, 'PERMISSION_EFFECT_REFUSED',
      'the ceiling this executor was built with must survive any later write to the object it was built from');

    // CONTROL: prove the tier gate can actually be cleared for this exact tool,
    // so the assertion above is "the mutation did nothing" and not "nothing
    // ever gets past this gate".
    const genuinelyFull = createAgentToolExecutor({ permissionSession: FULL_SESSION });
    const control = await genuinelyFull.execute(localWriteTool.name, {}, {}).catch(error => error);
    assert.equal(control?.code, 'INVALID_PARAMS',
      'a FULL executor must clear the tier gate and fail one step later on schema validation -- no real handler runs either way');
  });

  // ==========================================================================
  // I. THE ONE SANCTIONED WAY IN BESIDES THE FACTORY.
  //
  // Closing the fence to identity also closed the route the agent-loop suites
  // legitimately used: a recording double that never dispatches anything real
  // cannot be minted by createAgentToolExecutor(), and there is no longer a
  // marker to stamp on it. registerAgentToolExecutorForTests() is that seam.
  // Recorded here, not hidden, because an undocumented seam is the old hole
  // with better manners -- and both halves are asserted: what it grants, and
  // that production cannot reach it.
  // ==========================================================================

  // FENCE-SEAM: the grant. This is the ONLY non-factory route to mediation.
  await asyncCheck('FENCE-SEAM I1: registerAgentToolExecutorForTests() makes a double mediated inside an isolated test environment', async () => {
    const double = forgeExecutor();
    assert.equal(isMediatedAgentToolExecutor(double), false, 'unregistered, it is refused like any other forgery');
    const returned = registerAgentToolExecutorForTests(double);
    assert.equal(returned, double, 'the seam returns the same object so it can be used inline');
    assert.equal(isMediatedAgentToolExecutor(double), true);
    const result = await dispatchOneCall({}, { toolExecutor: double });
    assert.equal(double.calls.length, 1, 'a registered double is expected to receive the call -- that is what it is for');
    assert.equal(result.totalToolCalls, 1);
  });

  // FENCE-SEAM: the refusal. Without the isolated-environment marker -- which
  // is exactly how production runs -- the seam grants nothing at all, so the
  // factory is the only door outside tests. The env check is a fence against
  // accident and drift, not against an in-process attacker who can write
  // process.env; an attacker already inside this process needs no fence.
  check('FENCE-SEAM I2: registerAgentToolExecutorForTests() REFUSES outside an isolated test environment, and grants nothing', () => {
    const double = forgeExecutor();
    asProduction(() => {
      assert.throws(() => registerAgentToolExecutorForTests(double),
        error => error?.code === 'TEST_SEAM_UNAVAILABLE');
    });
    assert.equal(isMediatedAgentToolExecutor(double), false, 'a refused registration must leave the object exactly as unmediated as it was');
    assert.equal(process.env.TOOLSENABLED_TEST_ISOLATED, '1', 'the marker must be restored for the rest of this run');
  });

  check('FENCE-SEAM I3: registerAgentToolExecutorForTests() refuses anything that is not executor-shaped', () => {
    const invalid = error => error?.code === 'INVALID_TEST_EXECUTOR';
    for (const value of [undefined, null, 0, '', false, 'executor', {}, { execute: 'not a function' }]) {
      assert.throws(() => registerAgentToolExecutorForTests(value), invalid,
        `${String(value)} must not be registerable`);
    }
  });

  console.log(`\nmediation-fence red team: ${checks} checks, ${failures} failed.`);
  console.log('FENCE-CLOSED marks a route that used to work; FENCE-SEAM marks the one sanctioned way in besides the factory.');
  console.log('A grep for FENCE-OPEN in this file should return nothing. Tag any newly reopened route with it.');
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
