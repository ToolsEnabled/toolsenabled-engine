// EXECUTABLE CHANGE — testcanfail-tests-delegation-adapter-contracts-js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contracts = require('../../src/lib/delegation-adapter-contracts');

// This is deliberately independent of contracts.REQUIRED_METHODS. Building the
// fixture from the product's declaration made a missing operation disappear
// from both the subject and its expected input, so the check could agree with
// the same defect it was meant to detect.
const EXPECTED_METHODS = Object.freeze(['probe', 'start', 'collect', 'provideInput', 'cancel', 'cleanup']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hash(char) { return char.repeat(64); }
function throwsAdapter(fn) {
  assert.throws(fn, error => error instanceof contracts.DelegationAdapterContractError);
}

function assertRefusal(fn, code, message) {
  assert.throws(fn, error => {
    assert.equal(error instanceof contracts.DelegationAdapterContractError, true);
    assert.equal(error.name, 'DelegationAdapterContractError');
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

function validManifest() {
  return {
    schemaVersion: 1,
    adapterId: 'fake-adapter',
    adapterVersion: '1.0.0',
    supportedRoles: ['read_only_review'],
    transport: 'local',
    parser: { id: 'fixture-parser', version: '1.0.0' },
    probe: { protocol: 'provider-health/v1', maxAgeMs: 60_000 },
    process: { environment: 'sanitized', ownership: 'adapter_owned_process_tree', cleanup: 'owned_process_tree_only' },
    output: { eventSchema: 'agent-event/v1', resultContract: 'delegation-contracts/v1', eventKinds: ['complete', 'progress'] }
  };
}

function fakeAdapter(spy = {}, descriptorId = 'fake-adapter') {
  const adapter = {};
  Object.defineProperty(adapter, 'descriptorId', { value: descriptorId, enumerable: true, writable: false, configurable: false });
  for (const method of EXPECTED_METHODS) {
    adapter[method] = () => { spy[method] = (spy[method] || 0) + 1; };
  }
  return adapter;
}

function validWorkerResult() {
  return {
    schemaVersion: 1,
    workerResultId: 'wrk_abcdefghijklmnop',
    delegationId: 'dlg_abcdefghijklmnop',
    attempt: 1,
    terminalState: 'complete',
    baseSnapshot: { rootId: 'root-demo', commitSha1: 'a'.repeat(40), treeSha256: hash('b') },
    capabilityProfileHash: hash('c'),
    artifacts: [],
    verification: { state: 'passed', criterionIds: ['review-complete'], evidenceRefs: [] },
    blockerCode: null,
    usage: { modelTokens: 0, toolCalls: 0, wallMs: 0, usageRecordRefs: [] },
    brokerAcceptanceState: 'UNACCEPTED'
  };
}

(() => {
  // A fake adapter can register without provider-specific gateway code, but the
  // receipt is explicitly non-authorizing and never becomes broker acceptance.
  const manifest = validManifest();
  const spy = {};
  const receipt = contracts.validateAdapterRegistration(manifest, fakeAdapter(spy));
  assert.equal(receipt.adapterId, 'fake-adapter');
  assert.equal(receipt.grantsAuthority, false);
  assert.equal(receipt.acceptanceState, 'UNACCEPTED');
  assert.equal(receipt.adapterMayCreateTaskState, false);
  assert.equal(receipt.adapterMayMutateTaskState, false);
  assert.equal(receipt.adapterMayAcceptWork, false);
  assert.deepEqual(spy, {}, 'registration must not invoke an adapter method');
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.interfaceMethods), true);
  assert.throws(() => { receipt.grantsAuthority = true; }, TypeError);

  // The exact six AgentAdapter operations and its readonly descriptorId are
  // required; neither surplus fields nor partial adapters conform.
  assert.deepEqual(contracts.REQUIRED_METHODS, EXPECTED_METHODS);
  const incomplete = fakeAdapter();
  delete incomplete.cleanup;
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, incomplete));
  const extra = fakeAdapter();
  extra.createTask = () => {};
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, extra));
  const mismatch = fakeAdapter({}, 'wrong-adapter');
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, mismatch));

  // Getters are code. The checker must reject them without evaluating one.
  const getterAdapter = fakeAdapter();
  let getterReads = 0;
  Object.defineProperty(getterAdapter, 'probe', { enumerable: true, configurable: true, get() { getterReads += 1; return () => {}; } });
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, getterAdapter));
  assert.equal(getterReads, 0, 'adapter validation must not invoke an accessor or method');

  let adapterProxyGets = 0;
  const proxyAdapter = new Proxy(fakeAdapter(), {
    get() { adapterProxyGets += 1; throw new Error('adapter get trap must not run'); }
  });
  assert.equal(contracts.validateAdapterRegistration(manifest, proxyAdapter).adapterId, 'fake-adapter');
  assert.equal(adapterProxyGets, 0, 'valid adapter proxies must be read from descriptors');

  const symbolAdapter = fakeAdapter();
  symbolAdapter[Symbol('hidden-method')] = () => {};
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, symbolAdapter));
  throwsAdapter(() => contracts.validateAdapterRegistration(manifest, new Proxy(fakeAdapter(), {
    ownKeys() { throw new Error('Bearer adapter ownKeys trap'); }
  })));

  // Closed manifests reject both unknown mutable-authority claims and
  // secret-shaped metadata; there is no API transport to silently fall back to.
  const authority = validManifest();
  authority.canMutateTaskState = true;
  throwsAdapter(() => contracts.normalizeManifest(authority));
  const secret = validManifest();
  secret.parser.id = 'api-key-parser';
  throwsAdapter(() => contracts.normalizeManifest(secret));
  const apiTransport = validManifest();
  apiTransport.transport = 'gemini-api';
  const deniedTransportAdapterCalls = {};
  assertRefusal(
    () => contracts.validateAdapterRegistration(apiTransport, fakeAdapter(deniedTransportAdapterCalls)),
    'DELEGATION_ADAPTER_TRANSPORT_DENIED',
    'manifest transport is not allowed.'
  );
  assert.deepEqual(deniedTransportAdapterCalls, {}, 'a denied transport must not invoke or spawn through the adapter');

  // Schema compatibility is checked before any nested manifest inspection or
  // adapter validation. Refusal therefore cannot execute later untrusted input
  // or start work through an adapter.
  const unsupportedVersion = validManifest();
  unsupportedVersion.schemaVersion = 2;
  let nestedReads = 0;
  unsupportedVersion.parser = new Proxy(unsupportedVersion.parser, {
    ownKeys() { nestedReads += 1; throw new Error('unsupported schema must stop before parser inspection'); }
  });
  const unsupportedVersionAdapterCalls = {};
  assertRefusal(
    () => contracts.validateAdapterRegistration(unsupportedVersion, fakeAdapter(unsupportedVersionAdapterCalls)),
    'DELEGATION_ADAPTER_VERSION_UNSUPPORTED',
    'manifest schema version is unsupported.'
  );
  assert.equal(nestedReads, 0, 'an unsupported schema must not inspect nested untrusted fields');
  assert.deepEqual(unsupportedVersionAdapterCalls, {}, 'an unsupported schema must not invoke or spawn through the adapter');

  const hiddenManifestField = validManifest();
  Object.defineProperty(hiddenManifestField, 'transport', { value: 'local', enumerable: false });
  throwsAdapter(() => contracts.normalizeManifest(hiddenManifestField));

  const symbolManifest = validManifest();
  symbolManifest[Symbol('ambient-authority')] = true;
  throwsAdapter(() => contracts.normalizeManifest(symbolManifest));

  let manifestGetterReads = 0;
  const accessorManifest = validManifest();
  Object.defineProperty(accessorManifest, 'transport', {
    enumerable: true,
    get() { manifestGetterReads += 1; return 'local'; }
  });
  throwsAdapter(() => contracts.normalizeManifest(accessorManifest));
  assert.equal(manifestGetterReads, 0, 'manifest accessors must be rejected without invocation');

  let manifestProxyGets = 0;
  const proxyManifest = new Proxy(validManifest(), {
    get() { manifestProxyGets += 1; throw new Error('manifest get trap must not run'); }
  });
  assert.equal(contracts.normalizeManifest(proxyManifest).adapterId, 'fake-adapter');
  assert.equal(manifestProxyGets, 0, 'valid manifest proxies must be read from descriptors');

  let roleGetterReads = 0;
  const accessorRoles = validManifest();
  Object.defineProperty(accessorRoles.supportedRoles, '0', {
    configurable: true,
    enumerable: true,
    get() { roleGetterReads += 1; return 'read_only_review'; }
  });
  throwsAdapter(() => contracts.normalizeManifest(accessorRoles));
  assert.equal(roleGetterReads, 0, 'manifest array accessors must be rejected without invocation');

  const symbolRoles = validManifest();
  symbolRoles.supportedRoles[Symbol('hidden-role')] = 'disposable_edit';
  throwsAdapter(() => contracts.normalizeManifest(symbolRoles));

  let roleProxyGets = 0;
  const proxyRoles = validManifest();
  proxyRoles.supportedRoles = new Proxy(['read_only_review'], {
    get() { roleProxyGets += 1; throw new Error('role array get trap must not run'); }
  });
  assert.deepEqual(contracts.normalizeManifest(proxyRoles).supportedRoles, ['read_only_review']);
  assert.equal(roleProxyGets, 0, 'valid manifest array proxies must be read from descriptors');

  throwsAdapter(() => contracts.normalizeManifest(new Proxy(validManifest(), {
    getPrototypeOf() { throw new Error('OTP manifest prototype trap'); }
  })));
  throwsAdapter(() => contracts.normalizeManifest(new Proxy(validManifest(), {
    ownKeys() { throw new Error('Bearer manifest ownKeys trap'); }
  })));

  // A transient inspection failure is not evidence that the manifest is
  // invalid. It receives an explicit indeterminate result and is not latched:
  // retrying the same input after the machine recovers succeeds. As a control,
  // ordinary malformed input retains the definite INVALID classification.
  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const unavailable = new Proxy(validManifest(), {
      ownKeys() { throw Object.assign(new Error('inspection unavailable'), { code }); }
    });
    assert.throws(
      () => contracts.normalizeManifest(unavailable),
      error => error instanceof contracts.DelegationAdapterContractError
        && error.code === 'DELEGATION_ADAPTER_INSPECTION_UNAVAILABLE'
        && /does NOT claim.*absent or invalid/.test(error.message),
      `${code} must remain distinguishable from invalid input`
    );
  }

  let busy = true;
  const temporarilyUnreadable = new Proxy(validManifest(), {
    ownKeys(target) {
      if (busy) {
        busy = false;
        throw Object.assign(new Error('descriptor table busy'), { code: 'EMFILE' });
      }
      return Reflect.ownKeys(target);
    }
  });
  assert.throws(() => contracts.normalizeManifest(temporarilyUnreadable), {
    code: 'DELEGATION_ADAPTER_INSPECTION_UNAVAILABLE'
  });
  assert.equal(contracts.normalizeManifest(temporarilyUnreadable).adapterId, 'fake-adapter', 'indeterminate inspections must not be latched');
  assert.throws(
    () => contracts.normalizeManifest({}),
    error => error instanceof contracts.DelegationAdapterContractError
      && error.code === 'DELEGATION_ADAPTER_INVALID'
  );

  // Output requirements and normalized envelopes are strict and no duplicate
  // WorkerResult type is introduced: the existing delegation contract validates
  // the nested worker result and preserves its UNACCEPTED state.
  const malformedOutput = validManifest();
  malformedOutput.output.eventKinds = ['progress', 'complete'];
  throwsAdapter(() => contracts.normalizeManifest(malformedOutput));
  const event = contracts.validateEventEnvelope(manifest, {
    schemaVersion: 'agent-event/v1', adapterId: 'fake-adapter', kind: 'progress', sequence: 0, payloadHash: hash('d')
  });
  assert.equal(event.kind, 'progress');
  throwsAdapter(() => contracts.validateEventEnvelope(manifest, {
    schemaVersion: 'agent-event/v1', adapterId: 'fake-adapter', kind: 'error', sequence: -1, payloadHash: 'not-a-hash'
  }));
  const result = contracts.validateResultEnvelope(manifest, {
    schemaVersion: 'agent-adapter-result/v1', adapterId: 'fake-adapter', eventCursor: hash('e'), workerResult: validWorkerResult()
  });
  assert.equal(result.brokerAcceptanceState, 'UNACCEPTED');
  assert.equal(Object.isFrozen(result), true);

  // AGW-05 remains a pure contract; no canonical task store or provider runtime
  // can be imported from it.
  const source = fs.readFileSync(path.join(__dirname, '../../src/lib/delegation-adapter-contracts.js'), 'utf8');
  for (const forbidden of ['providers/tasks', 'task-store', 'audit-store', 'cli-provider-gateway', 'tool-registry', 'browser-owner', 'credential-metadata']) {
    assert.equal(new RegExp(`require\\(['\"](?:\\./)?${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}['\"]\\)`).test(source), false, `unexpected runtime import: ${forbidden}`);
  }

  console.log('delegation adapter contracts: all tests passed');
})();

/*
Test-can-fail report
====================

FOUND — SAME-CODE EXPECTATION / VACUOUS FIXTURE LOOP
`fakeAdapter` populated its methods by iterating the product export
`contracts.REQUIRED_METHODS`. If that export omitted a required operation, the
fixture omitted it too and registration could accept the mutually incomplete
interface. The fixture now uses the independently written EXPECTED_METHODS, and
the new deep-equality assertion also checks the public declaration directly.

Mutation: removed `cleanup` from REQUIRED_METHODS in
src/lib/delegation-adapter-contracts.js. The strengthened test went RED with
exit status 1 and this output:

  DelegationAdapterContractError: adapter has unsupported or missing interface members.
      at validateAdapterInstance (/workspace/engine/src/lib/delegation-adapter-contracts.js:231:5)
      at Object.validateAdapterRegistration (/workspace/engine/src/lib/delegation-adapter-contracts.js:293:19)
      at /workspace/engine/tests/delegation/adapter-contracts.js:66:29
    code: 'DELEGATION_ADAPTER_INVALID'

The product file was restored byte-for-byte: its SHA-256 was
d8919679fc577da9c7faa250f4d478a93e57642355e8b5253f816134affd4511
both before mutation and after restoration. The restored run was GREEN:

  delegation adapter contracts: all tests passed

NOT-FOUND — EMPTY COLLECTION: after removing the same-code fixture loop above,
the remaining assertion loop uses an in-test, non-empty forbidden-import list.
NOT-FOUND — EXIT STATUS / TRUTHY RETURN: this file spawns no process and makes
no exit-status or bare truthiness assertion.
NOT-FOUND — SWALLOWED FAILURE: there is no test try/catch or optional chain;
`assert.throws` requires the expected contract-error instance.
NOT-FOUND — MOCK OF SUBJECT: fake adapters are adversarial inputs to the real
contract validator, not replacements for it; the one self-derived fixture
surface was replaced as described above.
NOT-FOUND — SKIP / PRECONDITION GUARD: the file has no skip or platform guard.
NOT-FOUND — OTHER SAME-CODE EXPECTATION: expected manifests, envelopes, states,
and forbidden imports are independently specified test data.

Unmet preconditions: none.
*/
