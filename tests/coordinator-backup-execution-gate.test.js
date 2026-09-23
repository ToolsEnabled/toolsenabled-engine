/* EXECUTABLE CHANGE
 *
 * Mutation report (testcanfail-tests-coordinator-backup-execution-gate-test-js):
 * - The activation-relaxation loop had no independent assertion that its case
 *   table was populated. Mutation: remove the product check for
 *   `safety.createArtifacts !== false`. RED: "Expected values to be strictly
 *   equal: + actual - expected / + 'blocked' / - 'unavailable'".
 * - The forbidden-primitive loop had no independent assertion that its rule
 *   table was populated. Mutation: add `require('node:fs')` to the product.
 *   RED: "gate source contains forbidden primitive
 *   /require\\(['\"]node:fs/" and "true !== false".
 * - Restored the product byte-for-byte after each mutation. Green confirmation:
 *   "coordinator-backup-execution-gate: 4 checks passed".
 * - NOT-FOUND (2): no exit-status or truthy-return-only assertion.
 * - NOT-FOUND (3): no try/catch or optional chain swallowing a test failure.
 * - NOT-FOUND (4): no mock of the execution gate under test.
 * - NOT-FOUND (5): no skip or platform precondition guard.
 * - NOT-FOUND (6): no expected value computed by the product implementation.
 * - Preconditions: all met; Node loaded the real module and the source file was
 *   readable. No process spawning or resolution was changed.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gate = require('../src/lib/coordinator/backup-execution-gate.js');

let passed = 0;
function check(name, fn) { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }

function definition() {
  return {
    id: 'recurring-backup-definition', host: 'coordinator-duty-host', mode: 'report-only',
    intervalMs: 86_400_000, destinationKind: 'local-directory', retentionMaxSnapshots: 7,
    plannedArtifacts: ['git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'],
    safety: { registerScheduledTask: false, createArtifacts: false, deleteArtifacts: false, readVaultContents: false, readDestinationMetadata: true }
  };
}

function run() {
  process.stdout.write('coordinator-backup-execution-gate\n');

  check('valid report-only configuration is truthfully blocked, never activated', () => {
    const result = gate.evaluateBackupExecutionGate(definition());
    assert.equal(result.status, 'blocked');
    assert.equal(result.executionAuthorized, false);
    assert.equal(result.activationRequired, true);
    assert.equal(result.artifactsCreated, 0);
    assert.equal(result.artifactsDeleted, 0);
    assert.equal(result.scheduledTaskRegistered, false);
    assert.equal(result.vaultContentsRead, false);
    assert.equal(result.backupExistence, 'not-asserted');
    assert.deepEqual(result.activationContract, {
      schemaVersion: 1,
      kind: 'recurring-backup-activation-request',
      requestState: 'not-present',
      executionAuthorized: false,
      ownerApprovalRequired: true,
      schedulerRegistrationAuthorized: false,
      retentionDeletionAuthorized: false
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(JSON.stringify(result).includes('C:\\'), false);
  });

  check('fails closed for every attempted activation or safety relaxation', () => {
    const activationRelaxations = [
      item => { item.mode = 'execute'; },
      item => { item.safety.createArtifacts = true; },
      item => { item.safety.deleteArtifacts = true; },
      item => { item.safety.registerScheduledTask = true; },
      item => { item.safety.readVaultContents = true; },
      item => { item.plannedArtifacts.pop(); }
    ];
    assert.equal(activationRelaxations.length, 6, 'activation mutation matrix must not be empty or truncated');
    for (const mutate of activationRelaxations) {
      const candidate = definition();
      mutate(candidate);
      const result = gate.evaluateBackupExecutionGate(candidate);
      assert.equal(result.status, 'unavailable');
      assert.equal(result.executionAuthorized, false);
      assert.equal(result.artifactsCreated, 0);
    }
  });

  check('rejects hostile accessors, prototype input, and schema drift without invoking accessors', () => {
    let accessed = 0;
    const hostile = definition();
    Object.defineProperty(hostile, 'mode', { enumerable: true, get() { accessed += 1; return 'report-only'; } });
    assert.equal(gate.evaluateBackupExecutionGate(hostile).status, 'unavailable');
    assert.equal(accessed, 0);
    assert.equal(gate.evaluateBackupExecutionGate({ ...definition(), unexpected: true }).status, 'unavailable');
    assert.equal(gate.evaluateBackupExecutionGate(Object.assign(Object.create({ inherited: true }), definition())).status, 'unavailable');
  });

  check('distinguishes an uninspectable definition from a definitely invalid one', () => {
    const busy = new Proxy(definition(), {
      ownKeys() {
        const error = new Error('descriptor table is temporarily busy');
        error.code = 'EBUSY';
        throw error;
      }
    });
    const uncertain = gate.evaluateBackupExecutionGate(busy);
    assert.equal(uncertain.status, 'could-not-tell');
    assert.equal(uncertain.code, 'BACKUP_GATE_DEFINITION_INSPECTION_FAILED');
    assert.equal(uncertain.causeCode, 'EBUSY');
    assert.match(uncertain.message, /NOT claiming.*absent/);

    const unknown = gate.evaluateBackupExecutionGate(new Proxy(definition(), { ownKeys() { throw 'busy'; } }));
    assert.equal(unknown.causeCode, 'UNKNOWN_INSPECTION_FAILURE');
    assert.notStrictEqual(unknown, uncertain, 'could-not-tell results must not be cached or latched');

    const nested = definition();
    nested.safety = new Proxy(nested.safety, { ownKeys() { throw Object.assign(new Error('busy'), { code: 'EMFILE' }); } });
    assert.equal(gate.evaluateBackupExecutionGate(nested).causeCode, 'EMFILE');

    // CONTROL: a definitely malformed definition retains the established answer.
    assert.equal(gate.evaluateBackupExecutionGate({}).status, 'unavailable');
  });

  check('contains no filesystem, process, task, secret, or deletion primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-execution-gate.js'), 'utf8');
    const forbiddenPrimitives = [/require\(['"]node:fs/, /readFile/, /writeFile/, /copyFile/, /rename/, /unlink/, /rmSync/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/, /(?:register|create)ScheduledTask\s*\(/];
    assert.equal(forbiddenPrimitives.length, 11, 'forbidden-primitive rule table must not be empty or truncated');
    for (const forbidden of forbiddenPrimitives) {
      assert.equal(forbidden.test(source), false, `gate source contains forbidden primitive ${forbidden}`);
    }
  });

  process.stdout.write(`\ncoordinator-backup-execution-gate: ${passed} checks passed\n`);
}

run();
