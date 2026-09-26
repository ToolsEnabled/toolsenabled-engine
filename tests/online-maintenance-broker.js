// EXECUTABLE CHANGE
'use strict';

/*
Test-can-fail report (testcanfail-tests-online-maintenance-broker-js)

STRENGTHENED: the ERROR_MESSAGES for/of assertions used a possibly empty
collection and used that same collection as their oracle.  With the product
catalog temporarily replaced by {}, the original test stayed green:
  "online maintenance broker tests passed (66 assertions)."
The independent complete catalog below instead went red:
  "AssertionError [ERR_ASSERTION]: the complete public error catalog matches its independent contract"
  "+ {}"

STRENGTHENED: the launch executable comparison used the broker's own exported
FIXED_EXECUTABLE as its expected value.  Changing the product constant to
'/tmp/mutated-handler' left the original test green:
  "online maintenance broker tests passed (112 assertions)."
The independent literal assertion instead went red:
  "AssertionError [ERR_ASSERTION]: the executable matches the independent fixed path"
  "+ '/tmp/mutated-handler'"
  "- '/usr/local/libexec/toolsenabled-online-maintenance-handler'"

STRENGTHENED: the launch environment comparison likewise used the broker's own
exported FIXED_ENV as its expected value.  Changing its LANG to 'mutated' left
the original test green:
  "online maintenance broker tests passed (112 assertions)."
The independent allowlist assertion instead went red:
  "AssertionError [ERR_ASSERTION]: the environment matches the independent allowlist"
  "+   LANG: 'mutated',"
  "-   LANG: 'C',"

NOT-FOUND (1): no other assertion loop can execute zero times; the session
loop has literal bounds 1..31.  NOT-FOUND (2): no exit-status/truthy-return
assertion is used as a process-load proxy.  NOT-FOUND (3): no try/catch or
optional chain swallows an asserted failure.  NOT-FOUND (4): adapters are
fakes at the broker boundary, but no assertion tests an adapter by asserting
against that same adapter.  NOT-FOUND (5): there are no skips or platform
precondition guards.  NOT-FOUND (6): no additional expected value is computed
by the behavior it checks.

PRECONDITIONS: none unmet.  Node v20.20.2 was available.  After every mutation,
src/lib/online-maintenance-broker.js was restored byte-for-byte (SHA-256 both
before and after: 3bc17b3ba2ec392bd757033d487712883556d1e6ccb04831b8c60c746a079015).
The restored strengthened test was green:
  "online maintenance broker tests passed (115 assertions)."
*/

const assert = require('node:assert/strict');
const maintenance = require('../src/lib/online-maintenance-contract');
const brokerModule = require('../src/lib/online-maintenance-broker');
const { createOnlineMaintenanceBroker, OnlineMaintenanceBrokerError } = brokerModule;

let assertions = 0;
const equal = (...args) => { assertions += 1; return assert.equal(...args); };
const ok = (...args) => { assertions += 1; return assert.ok(...args); };
const deepEqual = (...args) => { assertions += 1; return assert.deepEqual(...args); };
const throws = (fn, code) => { assertions += 1; assert.throws(fn, error => error && error.code === code); };
const rejects = async (promise, code) => { assertions += 1; await assert.rejects(promise, error => error && error.code === code); };

// Independent oracle: constructing OnlineMaintenanceBrokerError reads the same
// exported table, so comparing each error back to that table alone cannot catch
// an emptied or corrupted table.
const expectedErrorMessages = {
  ONLINE_MAINTENANCE_AUDIT_FAILED: 'The maintenance action stopped because its required audit record could not be saved.',
  ONLINE_MAINTENANCE_AUDIT_REQUIRED: 'Online maintenance requires a working audit recorder before it can run.',
  ONLINE_MAINTENANCE_BROKER_DISABLED: 'Online maintenance is turned off on this computer.',
  ONLINE_MAINTENANCE_BROKER_GENERATION_INVALID: 'The maintenance broker belongs to an obsolete service generation and must be restarted.',
  ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID: 'The maintenance broker is not configured correctly on this computer.',
  ONLINE_MAINTENANCE_CANCELLED: 'The maintenance action was cancelled before it completed.',
  ONLINE_MAINTENANCE_COMMAND_DENIED: 'This command is not one of the maintenance actions this computer permits.',
  ONLINE_MAINTENANCE_CONTROL_INVALID: 'The maintenance controls could not be read safely, so the action was not run.',
  ONLINE_MAINTENANCE_EXECUTION_FAILED: 'The maintenance program failed, so no result was accepted.',
  ONLINE_MAINTENANCE_IDENTITY_STALE: 'The maintenance authorization belongs to an older service identity; reconnect and try again.',
  ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE: 'The online-maintenance kill switch is active, so this action was not run.',
  ONLINE_MAINTENANCE_KILL_FAILED: 'The maintenance process could not be confirmed stopped; the action remains refused for safety.',
  ONLINE_MAINTENANCE_OUTPUT_INVALID: 'The maintenance program returned an invalid result, so it was not accepted.',
  ONLINE_MAINTENANCE_OUTPUT_OVERFLOW: 'The maintenance result exceeded the allowed size and was not accepted.',
  ONLINE_MAINTENANCE_OUTPUT_TRUNCATED: 'The maintenance result was incomplete and was not accepted.',
  ONLINE_MAINTENANCE_PATH_DENIED: 'The requested location is outside the read-only maintenance boundary.',
  ONLINE_MAINTENANCE_QUEUE_FULL: 'Online maintenance is busy and its waiting queue is full; try again later.',
  ONLINE_MAINTENANCE_SERVICE_IDENTITY_DENIED: 'The running service is not the identity authorized for online maintenance.',
  ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID: 'The maintenance service identity could not be verified, so the action was not run.',
  ONLINE_MAINTENANCE_SESSION_DENIED: 'This maintenance session is invalid, expired, or has already used this command position.',
  ONLINE_MAINTENANCE_SESSION_STATE_REQUIRED: 'Online maintenance requires a working session-state recorder before it can run.',
  ONLINE_MAINTENANCE_SPAWN_INVALID: 'The maintenance program did not start in a verifiable way.',
  ONLINE_MAINTENANCE_TIMEOUT: 'The maintenance action exceeded its time limit and was stopped.'
};
deepEqual(brokerModule.ERROR_MESSAGES, expectedErrorMessages, 'the complete public error catalog matches its independent contract');

for (const [code, message] of Object.entries(brokerModule.ERROR_MESSAGES)) {
  const error = new OnlineMaintenanceBrokerError(code);
  equal(error.message, message, `${code} keeps its person-readable sentence`);
  ok(/[.!?]$/.test(error.message) && error.message !== code, `${code} must not surface as a bare machine code`);
}

const profile = maintenance.createOnlineMaintenanceProfile({ identityGeneration: 4 });
const expectedServiceIdentity = Object.freeze({ name: maintenance.SERVICE_ACCOUNT, nonAdmin: true, serviceAccount: maintenance.SERVICE_ACCOUNT, sid: 'S-1-5-21-111-222-333-444', uid: 'uid-maint-1001' });
const identity = Object.freeze({ identityId: 'online-id_abcdefgh', generation: 4, credentialDomain: maintenance.CREDENTIAL_DOMAIN, serviceAccount: maintenance.SERVICE_ACCOUNT, nonAdmin: true });
let receiptCounter = 0;
let sessionCounter = 0;

function request(overrides = {}) {
  return {
    profile, profileEnabled: true, identity, commandId: 'health.snapshot', args: {}, requestedTimeoutMs: 40,
    requestedOutputBytes: 64, revokedIdentityIds: [], sessionCommandIndex: 0, killSwitchActive: false, ...overrides
  };
}
function sessionId() { return `online-session_${String(++sessionCounter).padStart(8, '0')}`; }
function output(stdout = 'ok', stderr = '') { return { exitCode: 0, stdout, stderr, totalOutputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), truncated: false }; }
function receipt(phase) { return { durable: true, ok: true, phase, receiptId: `audit_receipt${String(++receiptCounter).padStart(8, '0')}` }; }
function sessions(overrides = {}) {
  const next = new Map();
  return {
    consume: async ({ commandIndex, generation, sessionId: id }) => {
      if (overrides.consume) return overrides.consume({ commandIndex, generation, sessionId: id, next });
      const key = `${id}:${generation}`;
      const expected = next.get(key) || 0;
      if (commandIndex !== expected) return { ok: false, sessionId: id, generation, nextIndex: expected };
      next.set(key, expected + 1);
      return { ok: true, sessionId: id, generation, nextIndex: expected + 1 };
    }
  };
}
function broker(overrides = {}) {
  const auditEvents = []; const launchCalls = []; let killCalls = 0;
  const audit = {
    require: async event => { auditEvents.push(event); return receipt('intent'); },
    record: async event => { auditEvents.push(event); return receipt('completed'); }
  };
  const options = {
    audit,
    enabled: true,
    expectedServiceIdentity,
    generation: 4,
    killProcessTree: async () => { killCalls += 1; return { ok: true, terminated: true }; },
    killSwitchActive: false,
    launch: async launch => { launchCalls.push(launch); return { handle: {}, completed: Promise.resolve(output()) }; },
    maxConcurrency: 1,
    maxQueue: 1,
    openBeneath: async ({ rootId }) => ({ ok: true, rootId, kind: 'opened-readonly', capabilityId: `cap_opened${rootId.replace('-', '')}` }),
    profile,
    serviceIdentity: async () => ({ ...expectedServiceIdentity }),
    sessionState: sessions(),
    ...overrides
  };
  const value = createOnlineMaintenanceBroker(options);
  return { auditEvents, killCalls: () => killCalls, launchCalls, options, value };
}
async function execute(instance, overrides = {}, id = sessionId()) { return instance.value.execute(request(overrides), id); }

(async () => {
  {
    const normal = broker();
    const done = await execute(normal);
    equal(done.exitCode, 0); equal(done.stdout, 'ok'); equal(done.truncated, false); equal(done.outputBytes, 2);
    equal(normal.auditEvents.length, 2); equal(normal.launchCalls.length, 1);
    deepEqual(normal.launchCalls[0].argv, ['health.snapshot']);
    equal(normal.launchCalls[0].executable, brokerModule.FIXED_EXECUTABLE); equal(normal.launchCalls[0].executable, '/usr/local/libexec/toolsenabled-online-maintenance-handler', 'the executable matches the independent fixed path'); equal(normal.launchCalls[0].shell, false);
    equal(normal.launchCalls[0].windowsHide, true); deepEqual(normal.launchCalls[0].env, brokerModule.FIXED_ENV); deepEqual(normal.launchCalls[0].env, { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, 'the environment matches the independent allowlist');
    equal(normal.launchCalls[0].maxOutputBytes, 64); equal(normal.launchCalls[0].timeoutMs, 40);
    ok(!Object.hasOwn(normal.launchCalls[0], 'cwd')); ok(!JSON.stringify(normal.auditEvents).includes('secret-marker'));
    ok(Object.isFrozen(brokerModule.OPERATION_TABLE)); ok(Object.isFrozen(brokerModule.FIXED_ENV));
  }
  {
    const captured = broker();
    captured.options.launch = async () => { throw Error('mutated-launch-marker'); };
    captured.options.openBeneath = async () => { throw Error('mutated-open-marker'); };
    captured.options.serviceIdentity = async () => { throw Error('mutated-identity-marker'); };
    captured.options.killProcessTree = async () => { throw Error('mutated-kill-marker'); };
    captured.options.audit.require = async () => { throw Error('mutated-audit-marker'); };
    captured.options.sessionState.consume = async () => { throw Error('mutated-session-marker'); };
    const done = await execute(captured);
    equal(done.stdout, 'ok'); equal(captured.launchCalls.length, 1);
  }

  await rejects(broker({ enabled: false }).value.execute(request(), sessionId()), 'ONLINE_MAINTENANCE_BROKER_DISABLED');
  await rejects(broker({ killSwitchActive: true }).value.execute(request(), sessionId()), 'ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE');
  await rejects(broker().value.execute(request(), 'not-a-session'), 'ONLINE_MAINTENANCE_SESSION_DENIED');
  await rejects(broker().value.execute({ ...request(), executable: 'secret-marker' }, sessionId()), 'ONLINE_MAINTENANCE_INVALID_SHAPE');
  await rejects(broker().value.execute(request({ args: { cwd: 'secret-marker' } }), sessionId()), 'ONLINE_MAINTENANCE_INVALID_SHAPE');
  await rejects(execute(broker(), { commandId: 'host.exec' }), 'ONLINE_MAINTENANCE_COMMAND_DENIED');
  throws(() => broker({ workingRoots: {} }), 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID');
  throws(() => broker({ operationSpecs: {} }), 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID');
  throws(() => broker({ expectedServiceIdentity: { ...expectedServiceIdentity, uid: undefined } }), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');

  await rejects(execute(broker({ serviceIdentity: async () => ({ ...expectedServiceIdentity, nonAdmin: false }) })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');
  await rejects(execute(broker({ serviceIdentity: async () => ({ ...expectedServiceIdentity, uid: undefined }) })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');
  await rejects(execute(broker({ serviceIdentity: async () => ({ ...expectedServiceIdentity, uid: 'uid-other-1002' }) })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_DENIED');
  await rejects(execute(broker({ serviceIdentity: async () => ({ ...expectedServiceIdentity, sid: 'S-1-5-21-000-000-000-000' }) })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_DENIED');
  await rejects(execute(broker({ serviceIdentity: async () => ({ ...expectedServiceIdentity, name: 'other-service' }) })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');
  await rejects(execute(broker({ serviceIdentity: async () => { throw Error('adapter-secret-marker'); } })), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');

  {
    let launches = 0;
    const failing = broker({ audit: { require: async () => { throw Error('late-audit-marker'); }, record: async () => receipt('completed') }, launch: async () => { launches += 1; return { handle: {}, completed: Promise.resolve(output()) }; } });
    await rejects(execute(failing), 'ONLINE_MAINTENANCE_AUDIT_FAILED'); equal(launches, 0);
  }
  {
    let launches = 0;
    const failing = broker({ audit: { require: async () => receipt('intent'), record: async () => { throw Error('late-completion-marker'); } }, launch: async () => { launches += 1; return { handle: {}, completed: Promise.resolve(output()) }; } });
    await rejects(execute(failing), 'ONLINE_MAINTENANCE_AUDIT_FAILED'); equal(launches, 1);
  }
  {
    const thenable = { then() { throw Error('thenable-marker'); } };
    const failing = broker({ audit: { require: () => thenable, record: async () => receipt('completed') } });
    await rejects(execute(failing), 'ONLINE_MAINTENANCE_AUDIT_FAILED');
  }
  {
    const getterAudit = {};
    Object.defineProperty(getterAudit, 'require', { enumerable: true, get() { throw Error('getter-marker'); } });
    Object.defineProperty(getterAudit, 'record', { enumerable: true, value: async () => receipt('completed') });
    throws(() => broker({ audit: getterAudit }), 'ONLINE_MAINTENANCE_AUDIT_REQUIRED');
  }

  await rejects(execute(broker({ openBeneath: async ({ rootId }) => ({ ok: true, rootId, kind: 'opened-readonly', capabilityId: '/etc/passwd' }) })), 'ONLINE_MAINTENANCE_PATH_DENIED');
  await rejects(execute(broker({ openBeneath: async ({ rootId }) => ({ ok: true, rootId, kind: 'opened-readonly', capabilityId: 'cap_okvalue', path: '/secret' }) })), 'ONLINE_MAINTENANCE_PATH_DENIED');
  await rejects(execute(broker({ openBeneath: async ({ rootId }) => ({ ok: true, rootId: 'backup-state', kind: 'opened-readonly', capabilityId: 'cap_okvalue' }) })), 'ONLINE_MAINTENANCE_PATH_DENIED');
  await rejects(execute(broker(), { commandId: 'backup.manifest', args: { relativePath: '../secret.json' } }), 'ONLINE_MAINTENANCE_INVALID_VALUE');
  await rejects(execute(broker(), { commandId: 'backup.manifest', args: { relativePath: 'C:/secret.json' } }), 'ONLINE_MAINTENANCE_INVALID_VALUE');
  await rejects(execute(broker(), { commandId: 'backup.manifest', args: { relativePath: '\\\\server\\share.json' } }), 'ONLINE_MAINTENANCE_INVALID_VALUE');

  await rejects(execute(broker({ launch: async () => ({ handle: {}, completed: Promise.resolve(output('x'.repeat(65))) }) })), 'ONLINE_MAINTENANCE_OUTPUT_OVERFLOW');
  await rejects(execute(broker({ launch: async () => ({ handle: {}, completed: Promise.resolve({ ...output(), truncated: true }) }) })), 'ONLINE_MAINTENANCE_OUTPUT_TRUNCATED');
  await rejects(execute(broker({ launch: async () => ({ handle: {}, completed: Promise.resolve({ ...output(), totalOutputBytes: 999 }) }) })), 'ONLINE_MAINTENANCE_OUTPUT_OVERFLOW');
  await rejects(execute(broker({ launch: async () => ({ handle: {}, completed: Promise.resolve({ exitCode: 1, stdout: '', stderr: '', totalOutputBytes: 0, truncated: false }) }) })), 'ONLINE_MAINTENANCE_EXECUTION_FAILED');
  await rejects(execute(broker({ launch: async () => null })), 'ONLINE_MAINTENANCE_SPAWN_INVALID');
  await rejects(execute(broker({ launch: async () => ({ handle: {}, completed: Promise.resolve(null) }) })), 'ONLINE_MAINTENANCE_OUTPUT_INVALID');

  {
    // REGRESSION for agent-coord finding/fable-review/mission-bridge-three-
    // defects thread 3: `completed` REJECTING (the launched process errored
    // out, as opposed to resolving with a non-zero exit) used to reach
    // fail() directly without killing the tree first, unlike every sibling
    // failure branch in run() -- a leaked process tree.
    const rejecting = broker({ launch: async () => ({ handle: {}, completed: Promise.reject(Error('completed-rejected-marker')) }) });
    await rejects(execute(rejecting), 'ONLINE_MAINTENANCE_EXECUTION_FAILED');
    ok(rejecting.killCalls() >= 1, 'a rejected completed promise must still kill the process tree, not leak it');
  }

  {
    const slow = broker({ launch: async ({ signal }) => ({ handle: {}, completed: new Promise(resolve => signal.addEventListener('abort', () => resolve({ exitCode: 1, stdout: '', stderr: '', totalOutputBytes: 0, truncated: false }))) }) });
    await rejects(execute(slow, { requestedTimeoutMs: 1 }), 'ONLINE_MAINTENANCE_TIMEOUT'); ok(slow.killCalls() >= 1);
  }
  {
    const hung = broker({ launch: async () => new Promise(() => {}) });
    await rejects(execute(hung, { requestedTimeoutMs: 1 }), 'ONLINE_MAINTENANCE_TIMEOUT');
    equal(hung.value.snapshot().active, 1); equal(hung.value.snapshot().queued, 0);
  }
  {
    let release; let started = false; let killed = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const raced = broker({ launch: async () => { started = true; return gate; }, killProcessTree: async () => { killed += 1; return { ok: true, terminated: true }; } });
    const active = execute(raced, { requestedTimeoutMs: 100 });
    while (!started) await new Promise(resolve => setImmediate(resolve));
    await raced.value.setControl({ enabled: true, generation: 5, killSwitchActive: false });
    release({ handle: { processAlreadyStarted: true }, completed: Promise.resolve(output()) });
    await rejects(active, 'ONLINE_MAINTENANCE_IDENTITY_STALE');
    await new Promise(resolve => setImmediate(resolve)); equal(killed, 1);
  }
  {
    const badKill = broker({ launch: async ({ signal }) => ({ handle: {}, completed: new Promise(resolve => signal.addEventListener('abort', () => resolve(output()))) }), killProcessTree: async () => ({ ok: true, terminated: false }) });
    await rejects(execute(badKill, { requestedTimeoutMs: 1 }), 'ONLINE_MAINTENANCE_KILL_FAILED');
    equal(badKill.value.snapshot().active, 1);
  }

  {
    const state = sessions(); const sequential = broker({ sessionState: state }); const id = sessionId();
    await sequential.value.execute(request({ sessionCommandIndex: 0 }), id);
    await rejects(sequential.value.execute(request({ sessionCommandIndex: 0 }), id), 'ONLINE_MAINTENANCE_SESSION_DENIED');
    await rejects(sequential.value.execute(request({ sessionCommandIndex: 2 }), id), 'ONLINE_MAINTENANCE_SESSION_DENIED');
    for (let index = 1; index < 32; index += 1) await sequential.value.execute(request({ sessionCommandIndex: index }), id);
    await rejects(sequential.value.execute(request({ sessionCommandIndex: 31 }), id), 'ONLINE_MAINTENANCE_SESSION_DENIED');
  }
  {
    let release; let launched = false; let launchCount = 0;
    const held = broker({ launch: async ({ signal }) => {
      launchCount += 1;
      if (launchCount > 1) return { handle: {}, completed: Promise.resolve(output()) };
      launched = true;
      return { handle: {}, completed: new Promise(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(output())); }) };
    } });
    const first = execute(held, { requestedTimeoutMs: 100 }); const second = execute(held, { sessionCommandIndex: 0, requestedTimeoutMs: 100 });
    while (!launched) await new Promise(resolve => setImmediate(resolve));
    await rejects(execute(held, { sessionCommandIndex: 0 }), 'ONLINE_MAINTENANCE_QUEUE_FULL');
    release(output()); await first; await second;
    equal(held.value.snapshot().active, 0);
  }

  console.log(`online maintenance broker tests passed (${assertions} assertions).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
