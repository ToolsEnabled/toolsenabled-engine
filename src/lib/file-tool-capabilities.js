'use strict';

// Private in-memory capability custody. The surface validates transport and
// agent identity before registration; the kernel consumes only opaque objects
// already registered here. No wire metadata can register or copy authority.
const active = new WeakSet();
const issued = new WeakSet();
const retirementCallbacks = new WeakMap();
const guards = new WeakMap();
const invocations = new WeakMap();

function refused() {
  return Object.assign(new Error('Repository coordination requires a current transport-bound file scope; caller-supplied actor fields cannot establish one.'), {
    code: 'REPO_FILE_COORDINATION_IDENTITY_REQUIRED'
  });
}

function registerFileToolContext(context) {
  if (!context || issued.has(context) || !Object.isFrozen(context) || !context.binding
    || typeof context.binding !== 'object' || !Object.isFrozen(context.binding)) throw refused();
  issued.add(context);
  active.add(context);
  return context;
}
function guardFileToolContext(context, assertCurrent) {
  requireFileToolContext(context);
  if (typeof assertCurrent !== 'function' || guards.has(context)) throw refused();
  guards.set(context, assertCurrent);
}
function requireFileToolContext(context) {
  if (!context || !active.has(context)) throw refused();
  guards.get(context)?.();
  return context.binding;
}
function registerFileToolInvocation(context, metadata) {
  requireFileToolContext(context);
  const capability = Object.freeze(Object.create(null));
  invocations.set(capability, { context, metadata, consumed: false });
  return capability;
}

function invocationRefused() {
  return Object.assign(new Error('Repository file execution requires this dispatch\'s current private one-shot invocation; a returned call trace cannot authorize another call.'), {
    code: 'REPO_FILE_INVOCATION_INVALID'
  });
}

function checkedInvocation(capability, context, toolName) {
  const invocation = capability && invocations.get(capability);
  if (!invocation || invocation.context !== context || invocation.metadata.toolName !== toolName) throw invocationRefused();
  requireFileToolContext(context);
  return invocation;
}

function consumeFileToolInvocation(capability, context, toolName) {
  const invocation = checkedInvocation(capability, context, toolName);
  if (invocation.consumed) throw invocationRefused();
  invocation.consumed = true;
  return invocation.metadata;
}

function assertFileToolInvocationCurrent(capability, context, toolName) {
  const invocation = checkedInvocation(capability, context, toolName);
  if (!invocation.consumed) throw invocationRefused();
  return invocation.metadata;
}

function endFileToolInvocation(capability) {
  if (capability) invocations.delete(capability);
}

function onFileToolContextRetired(context, key, callback) {
  requireFileToolContext(context);
  let callbacks = retirementCallbacks.get(context);
  if (!callbacks) { callbacks = new Map(); retirementCallbacks.set(context, callbacks); }
  if (!callbacks.has(key)) callbacks.set(key, callback);
}

function retireFileToolContext(context, reason = 'transport-retired') {
  if (!context || !active.has(context)) return Promise.resolve();
  active.delete(context);
  const callbacks = retirementCallbacks.get(context);
  retirementCallbacks.delete(context);
  return Promise.all([...(callbacks?.values() || [])].map(callback => Promise.resolve().then(() => callback(reason))));
}

module.exports = Object.freeze({ registerFileToolContext, guardFileToolContext, requireFileToolContext,
  retireFileToolContext, onFileToolContextRetired, registerFileToolInvocation,
  consumeFileToolInvocation, assertFileToolInvocationCurrent, endFileToolInvocation });
