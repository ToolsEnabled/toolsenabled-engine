// EXECUTABLE CHANGE
'use strict';

// Discrimination report (testcanfail-tests-approval-boundary-bypasses-test-js):
// STRENGTHENED: the two handler-absence assertions below now first prove that
// their public registry collections still contain host.exec. Mutations applied:
// (a) export an empty TOOL_REGISTRY. RED: "AssertionError [ERR_ASSERTION]: the
// exported registry must contain the destructive tool whose handler boundary is
// being checked"; (b) return [] from registeredTools(). RED: "AssertionError
// [ERR_ASSERTION]: registeredTools() must contain the destructive tool whose
// handler boundary is being checked". The source was restored byte-for-byte
// after each mutation (verified with sha256sum).
// RESTORED RUN: the unmodified source reaches the same environmental precondition:
// "code: 'AUDIT_UNAVAILABLE'" / "reason: 'AUDIT_SIGNING_KEY_UNAVAILABLE'".
// PRECONDITION-NOT-MET: a readable Windows-identity audit signing key is required
// for the scheduler positive control to reach the assertions under audit.
// NOT-FOUND (1): both for-of collections are non-empty inline array literals.
// NOT-FOUND (2): no exit-status or merely-truthy process assertion exists.
// NOT-FOUND (3): no catch or optional chain swallows an asserted failure; the
// provider restoration uses finally only, and the outer catch fails the process.
// NOT-FOUND (4): the gmail stub is an observation seam for scheduler admission,
// not a mock of the registry authorization being tested; its exact result is checked.
// NOT-FOUND (5): the file has no skip or platform precondition guard.
// NOT-FOUND (6): no expected value is computed by the implementation under test.

require('./lib/isolated-environment').activate('approval-boundary-bypasses');

const assert = require('node:assert/strict');
const { getStateStore, hashInput } = require('../src/lib/state-store');
const approvals = require('../src/lib/approvals');
const scopedApprovals = require('../src/lib/scoped-approvals');
const registry = require('../src/lib/tool-registry');

const OWNER_SESSION = Object.freeze({ origin: 'local', tier: 'full' });

function code(expected) {
  return error => Boolean(error && error.code === expected);
}

async function attemptExportedHandler(name, args) {
  const descriptor = registry.getTool(name);
  if (!descriptor || typeof descriptor.handler !== 'function') {
    const error = new Error(`The public descriptor for '${name}' exposes no live handler.`);
    error.code = 'TOOL_HANDLER_NOT_EXPORTED';
    throw error;
  }
  return descriptor.handler(args);
}

async function attemptExportedApprovalCreation(api, method, input, dependencies) {
  if (!api || typeof api[method] !== 'function') {
    const error = new Error(`Approval creation API '${method}' is not exported.`);
    error.code = 'APPROVAL_CREATION_API_NOT_EXPORTED';
    throw error;
  }
  return api[method](input, dependencies);
}

// These witnesses deliberately precede integration setup: an empty public view
// must fail as an empty public view, rather than pass both universal `.some()`
// handler-absence checks below or be masked by an unrelated platform facility.
assert.ok(registry.TOOL_REGISTRY.some(tool => tool.name === 'host.exec'),
  'the exported registry must contain the destructive tool whose handler boundary is being checked');
assert.ok(registry.registeredTools().some(tool => tool.name === 'host.exec'),
  'registeredTools() must contain the destructive tool whose handler boundary is being checked');

(async () => {
  // 1. Caller-shaped scheduler strings are not authority. On the vulnerable
  // code this reaches system.credential_remove without a token; the fixed code
  // finds no matching durable RUNNING scheduler row and falls back to refusal.
  await assert.rejects(
    registry.executeTool('system.credential_remove', {
      vaultKey: 'approval_boundary_scheduler_probe', reason: 'legacy_cleanup'
    }, {
      permissionSession: OWNER_SESSION,
      internal: 'scheduler-runner-v1',
      requestId: 'scheduler:scheduler-run-forged-approval-boundary'
    }),
    code('APPROVAL_REQUIRED'),
    'forged scheduler context must not bypass the one-time token path'
  );

  // Positive control: a real scheduler admission remains usable, and is bound
  // to the immutable registration's exact action/arguments. The provider is
  // stubbed only after the real durable row exists, so no email is sent.
  const scheduledArgs = { to: 'owner@example.invalid', subject: 'approval-boundary-positive-control' };
  const runtime = {
    nodePath: process.execPath,
    runnerPath: require('node:path').resolve(__dirname, '..', 'src', 'job-runner.js'),
    principalId: 'S-1-5-21-111111111-222222222-333333333-1001'
  };
  const store = getStateStore();
  const created = store.putSchedulerJob({
    name: 'approval-boundary-positive', schedule: 'hourly', action: 'gmail.send',
    args: scheduledArgs, runtime
  });
  const claim = store.claimSchedulerOutbox({ jobId: created.job.jobId });
  store.completeSchedulerOutbox(claim.handle, { disposition: 'succeeded', observation: { state: 'present' } });
  const started = store.startSchedulerRun({
    installationId: store.schedulerInstallation().installationId,
    jobId: created.job.jobId, generation: created.registration.generation,
    ownershipMarker: created.registration.ownershipMarker
  });
  const google = require('../src/lib/providers/google');
  const originalGmailSend = google.gmailSend;
  google.gmailSend = async args => ({ stubbed: true, args });
  try {
    assert.deepEqual(await registry.executeTool('gmail.send', scheduledArgs, {
      permissionSession: OWNER_SESSION,
      internal: 'scheduler-runner-v1', requestId: `scheduler:${started.runId}`
    }), { stubbed: true, args: scheduledArgs });
    store.completeSchedulerRun(started, { status: 'succeeded', result: { stubbed: true } });
  } finally {
    google.gmailSend = originalGmailSend;
  }

  // 2a. host.exec itself must enter the token path. The command is deliberately
  // harmless so mutation-checking the old descriptor cannot alter the machine.
  await assert.rejects(
    registry.executeTool('host.exec', {
      command: 'Write-Output approval-boundary-probe', shell: 'powershell', timeoutMs: 5000
    }, { permissionSession: OWNER_SESSION }),
    code('APPROVAL_REQUIRED'),
    'host.exec must refuse before spawning without an exact one-time approval'
  );

  // 2b. Public registry views must not provide a route beside executeTool().
  await assert.rejects(
    attemptExportedHandler('host.exec', { command: 'Write-Output public-handler-probe' }),
    code('TOOL_HANDLER_NOT_EXPORTED'),
    'a destructive live handler must not be callable through getTool()'
  );
  assert.equal(registry.TOOL_REGISTRY.some(tool => typeof tool.handler === 'function'), false);
  assert.equal(registry.registeredTools().some(tool => typeof tool.handler === 'function'), false);

  // 2c. A caller must not replace the trusted prompt/clock/state with a fake
  // approving surface and thereby mint a real-shaped legacy grant.
  const legacyInput = {
    action: 'host.exec',
    inputHash: hashInput({ action: 'host.exec', arguments: { command: 'probe' } }),
    title: 'probe', message: 'probe', timeoutSeconds: 60
  };
  await assert.rejects(
    attemptExportedApprovalCreation(approvals, 'request', legacyInput, {
      prompt: async () => ({ answer: 'yes' }), now: () => 1000,
      state: { createApprovalGrant: grant => ({ ...grant, approvalId: 'forged-grant', expiresAt: 'later' }) }
    }),
    code('APPROVAL_CREATION_API_NOT_EXPORTED'),
    'legacy approval grant creation must not be exported'
  );

  // The scoped path had the same injectable prompt/state seam. Its canonical
  // action shape is complete enough that the vulnerable code would return a
  // token; fixed code rejects before consulting either fake dependency.
  const scopedAction = {
    approvalId: 'approval-scoped-probe', action: 'host.exec', target: { kind: 'local' },
    parameters: { command: 'probe' }, subject: { kind: 'task' }, previewHash: 'a'.repeat(64),
    expiresAtMs: 60_000
  };
  await assert.rejects(
    attemptExportedApprovalCreation(scopedApprovals, 'request', { approvalId: scopedAction.approvalId }, {
      prompt: async () => ({ answer: 'yes' }), now: () => 1000,
      state: {
        getScopedApprovalAction: () => scopedAction,
        approveScopedApproval: () => scopedAction
      }
    }),
    code('APPROVAL_CREATION_API_NOT_EXPORTED'),
    'scoped approval record/token creation must not be exported'
  );
  for (const method of ['recordProvenance', 'createAction', 'request']) {
    assert.equal(typeof scopedApprovals[method], 'undefined', `scoped approval ${method} must not be exported`);
  }

  // 3. The reviewed Playwright positive list contains consequential verbs, so
  // the umbrella call must refuse before reaching the authenticated browser.
  const browser = registry.getTool('browser.playwright_call');
  assert.equal(browser.annotations.destructiveHint, true);
  assert.equal(browser.approvalEligible, true);
  await assert.rejects(
    registry.executeTool('browser.playwright_call', {
      name: 'browser_click', arguments: { element: 'Purchase', ref: 'button-1' }
    }, { permissionSession: OWNER_SESSION }),
    code('APPROVAL_REQUIRED'),
    'reviewed browser mutation verbs must enter the exact token path'
  );

  // 4. Explicit policy requirements are a checked invariant, not advisory
  // strings. This synthetic copy performs both formerly reachable mismatch
  // classes without mutating the frozen real registry.
  const policy = require('../config/toolsenabled.policy.json');
  const mismatch = registry.TOOL_REGISTRY.map(tool => tool.name === 'scheduler.reconcile'
    ? { ...tool, approvalEligible: false } : tool);
  assert.throws(
    () => registry.assertApprovalPolicyCompatible(mismatch, policy),
    code('APPROVAL_POLICY_DESCRIPTOR_MISMATCH'),
    'an explicitly required but ineligible descriptor must fail closed'
  );
  const policyWithPhantomAction = {
    ...policy,
    approvals: { ...policy.approvals, actions: [...policy.approvals.actions, 'unregistered_provider.action'] }
  };
  assert.throws(
    () => registry.assertApprovalPolicyCompatible(registry.TOOL_REGISTRY, policyWithPhantomAction),
    code('APPROVAL_POLICY_DESCRIPTOR_MISMATCH'),
    'an explicitly required but unregistered tool must fail closed'
  );

  for (const name of ['scheduler.reconcile', 'sandbox.auth_profile_create']) {
    const tool = registry.getTool(name);
    assert.ok(tool, `${name} must be registered`);
    assert.equal(tool.approvalEligible, true, `${name} must accept the one-time approval transport`);
    assert.equal(typeof tool.handler, 'undefined', `${name} must not export its live handler`);
  }
  assert.equal(registry.getTool('unregistered_provider.action'), null,
    'an unregistered pack tool must not leak into the shipped registry');
  assert.equal(policy.approvals.actions.includes('unregistered_provider.action'), false,
    'policy must not claim an unenforceable requirement for an unregistered pack tool');
  assert.equal(registry.getTool('scheduler.reconcile').annotations.destructiveHint, true,
    'scheduler.reconcile can execute delete operations and must advertise that fact');

  console.log('Approval-boundary bypass regressions passed (scheduler provenance, host dispatch/export, approval authority, browser mutations, and policy/descriptor consistency).');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
