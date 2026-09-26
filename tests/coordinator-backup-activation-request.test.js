'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../src/lib/coordinator/backup-activation-request.js');

let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }
function request(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: contract.KIND,
    requestId: 'q37-backup-activation-0001',
    rootBinding: contract.ROOT_BINDING,
    requestedAt: '2026-07-30T02:03:04.000Z',
    artifactKinds: [...contract.ARTIFACT_KINDS],
    retentionMaxSnapshots: 7,
    schedulerRegistrationRequested: false,
    ownerApproval: 'not-approved',
    ...overrides
  };
}

function run() {
  process.stdout.write('coordinator-backup-activation-request\n');
  check('uses the recurring backup canonical artifact list', () => {
    assert.deepEqual(contract.ARTIFACT_KINDS, [
      'git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'
    ]);
  });
  check('accepts only a pending, fixed-root request and never grants execution', () => {
    const result = contract.validatePendingActivationRequest(request());
    assert.equal(result.valid, true);
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.ownerApprovalRequired, true);
    assert.equal(result.schedulerRegistrationAuthorized, false);
    assert.equal(result.retentionDeletionAuthorized, false);
    assert.equal(result.request.ownerApproval, 'not-approved');
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes('C:\\'), false);
  });
  check('refuses approval-looking values, scheduling, root changes, source/path fields, and schema drift', () => {
    const cases = [
      request({ ownerApproval: 'approved' }),
      request({ schedulerRegistrationRequested: true }),
      request({ rootBinding: 'other-root' }),
      request({ artifactKinds: ['vault-state-copy', 'git-bundle', 'manifest-sha256', 'retention-prune'] }),
      request({ requestedAt: '2026-07-30T02:03:04Z' }),
      { ...request(), destinationPath: 'C:\\secret' }
    ];
    for (const candidate of cases) {
      const result = contract.validatePendingActivationRequest(candidate);
      assert.equal(result.valid, false);
      assert.equal(result.executionAuthorized, false);
      assert.equal(result.request, null);
    }
  });
  check('rejects accessors and prototype input without evaluating the accessor', () => {
    let accessed = 0;
    const hostile = request();
    Object.defineProperty(hostile, 'ownerApproval', { enumerable: true, get() { accessed += 1; return 'not-approved'; } });
    assert.equal(contract.validatePendingActivationRequest(hostile).valid, false);
    assert.equal(accessed, 0);
    assert.equal(contract.validatePendingActivationRequest(Object.assign(Object.create({ inherited: true }), request())).valid, false);
  });
  check('reports an inspection failure as indeterminate without latching it', () => {
    const busy = new Proxy(request(), { getPrototypeOf() { throw { busy: true }; } });
    const result = contract.validatePendingActivationRequest(busy);
    assert.equal(result.valid, null);
    assert.equal(result.code, contract.INSPECTION_UNAVAILABLE);
    assert.match(result.errors[0], /NOT claiming .* absent or invalid/);
    assert.equal(contract.validatePendingActivationRequest(request()).valid, true);

    // Control: the legitimate CommonJS module cache remains intact.
    assert.strictEqual(require('../src/lib/coordinator/backup-activation-request.js'), contract);
  });
  check('the host-facing summary is blocked with no request identifier or filesystem information', () => {
    const summary = contract.activationContractSummary();
    assert.deepEqual(summary, {
      schemaVersion: 1, kind: contract.KIND, requestState: 'not-present', executionAuthorized: false,
      ownerApprovalRequired: true, schedulerRegistrationAuthorized: false, retentionDeletionAuthorized: false
    });
    assert.equal(Object.isFrozen(summary), true);
  });
  check('contains no filesystem, process, scheduler, vault, or deletion primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-activation-request.js'), 'utf8');
    for (const forbidden of [/require\(['"]node:fs/, /readFile/, /writeFile/, /copyFile/, /rename/, /unlink/, /rmSync/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/, /(?:register|create)ScheduledTask\s*\(/, /vault\//i]) {
      assert.equal(forbidden.test(source), false, `activation request source contains forbidden primitive ${forbidden}`);
    }
  });
  process.stdout.write(`\ncoordinator-backup-activation-request: ${passed} checks passed\n`);
}

try { run(); } catch (error) { process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`); process.exitCode = 1; }
