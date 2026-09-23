'EXECUTABLE CHANGE'; // assertion audit report: testcanfail-tests-coordinator-backup-duty-test-js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backupDuty = require('../src/lib/coordinator/backup-duty.js');
const backupAgeStatus = require('../src/lib/coordinator/backup-age-status.js');
const registry = require('../src/lib/coordinator/duty-registry.js');
const { DUTY_OUTCOME } = require('../src/lib/coordinator/heartbeat.js');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function validDefinition() {
  return {
    schemaVersion: 1,
    id: 'recurring-backup-definition',
    host: 'coordinator-duty-host',
    mode: 'report-only',
    intervalMs: 86_400_000,
    destination: { kind: 'local-directory', path: 'C:\\Backup' },
    retention: { maxSnapshots: 7 },
    plannedArtifacts: ['git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'],
    safety: { registerScheduledTask: false, createArtifacts: false, deleteArtifacts: false, readVaultContents: false, readDestinationMetadata: true }
  };
}

function frozenGateReport() {
  const result = require('../src/lib/coordinator/backup-execution-gate.js')
    .evaluateBackupExecutionGate(backupDuty.loadDefinition().definition);
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: 'backup-execution-gate',
    status: 'blocked',
    executionAuthorized: false,
    activationRequired: true,
    mode: 'report-only',
    intervalMs: 86_400_000,
    retentionMaxSnapshots: 7,
    plannedArtifacts: ['git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'],
    artifactsCreated: 0,
    artifactsDeleted: 0,
    scheduledTaskRegistered: false,
    vaultContentsRead: false,
    backupExistence: 'not-asserted',
    contentTrust: 'untrusted',
    activationContract: {
      schemaVersion: 1,
      kind: 'recurring-backup-activation-request',
      requestState: 'not-present',
      executionAuthorized: false,
      ownerApprovalRequired: true,
      schedulerRegistrationAuthorized: false,
      retentionDeletionAuthorized: false
    }
  }, 'the adversarial fixtures require an independently specified valid gate report');
  return Object.freeze({
    ...result,
    plannedArtifacts: Object.freeze([...result.plannedArtifacts]),
    activationContract: Object.freeze({ ...result.activationContract })
  });
}

// Mutation audit:
// - SAME-CODE EXPECTED VALUE: `frozenGateReport` previously accepted whatever
//   `evaluateBackupExecutionGate` returned as the baseline for three adversarial
//   checks. Mutating that successful return to `{}` after its first call left
//   those checks green. The independent contract assertion above made the same
//   mutation RED with: `AssertionError [ERR_ASSERTION]: the adversarial fixtures
//   require an independently specified valid gate report`.
// - EMPTY ITERATION: NOT-FOUND. Both safety/primitive loops use non-empty test
//   literals; the candidate loop has a two-element literal. The only derived
//   iteration, `Object.entries(baseline)`, is now preceded by the contract check.
// - EXIT STATUS / TRUTHY RETURN: NOT-FOUND.
// - SWALLOWED FAILURE (try/catch or optional-chain): NOT-FOUND.
// - MOCK OF SUBJECT: NOT-FOUND. Injected gates/readers are inputs used to test
//   the registry boundary, rather than replacements for that boundary.
// - SKIP / PRECONDITION GUARD: NOT-FOUND.
// - Unmet preconditions: NONE.
// - The mutation was restored byte-for-byte (SHA-256 checked), then
//   `node tests/coordinator-backup-duty.test.js` was GREEN with:
//   `coordinator-backup-duty: 16 checks passed`.

async function run() {
  process.stdout.write('coordinator-backup-duty\n');

  await check('the shipped report-only backup definition validates and is summarized without its destination path', () => {
    const loaded = backupDuty.loadDefinition();
    assert.equal(loaded.valid, true, loaded.errors.join('; '));
    assert.equal(loaded.definition.mode, 'report-only');
    assert.equal(loaded.definition.destinationKind, 'local-directory');
    assert.equal(Object.hasOwn(loaded.definition, 'destination'), false);
    assert.equal(Object.isFrozen(loaded.definition), true);
    assert.equal(Object.isFrozen(loaded.definition.plannedArtifacts), true);
  });

  await check('validation refuses every capability that would make this foundation execute a backup or hide metadata observation', () => {
    for (const key of ['registerScheduledTask', 'createArtifacts', 'deleteArtifacts', 'readVaultContents']) {
      const definition = validDefinition();
      definition.safety[key] = true;
      const verdict = backupDuty.validateDefinition(definition);
      assert.equal(verdict.valid, false, `${key} must be refused before a future implementation is considered`);
      assert.match(verdict.errors.join('; '), /safety/);
    }
    const definition = validDefinition();
    definition.safety.readDestinationMetadata = false;
    assert.equal(backupDuty.validateDefinition(definition).valid, false,
      'metadata observation must be explicit rather than silently enabled later');
  });

  await check('validation refuses a non-report-only mode and an incomplete artifact plan', () => {
    const definition = validDefinition();
    definition.mode = 'execute';
    definition.plannedArtifacts.pop();
    const verdict = backupDuty.validateDefinition(definition);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors.join('; '), /mode must be report-only/);
    assert.match(verdict.errors.join('; '), /plannedArtifacts/);
  });

  await check('validation refuses unrecognized configuration rather than silently ignoring a future execution switch', () => {
    const definition = validDefinition();
    definition.runCommand = 'not-permitted';
    const verdict = backupDuty.validateDefinition(definition);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors.join('; '), /unsupported keys/);
  });

  await check('validation keeps retention within the downstream activation and artifact-plan limit', () => {
    const definition = validDefinition();
    definition.retention.maxSnapshots = 91;
    const verdict = backupDuty.validateDefinition(definition);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors.join('; '), /1 through 90/);
  });

  await check('an unreadable definition reports invalid rather than assuming readiness', () => {
    const loaded = backupDuty.loadDefinition({
      file: path.join(__dirname, 'does-not-exist.json'),
      fsImpl: { readFileSync: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } }
    });
    assert.equal(loaded.valid, false);
    assert.equal(loaded.definition, null);
    assert.match(loaded.errors.join('; '), /unavailable/);
  });

  await check('a failed local-override lookup does not silently select the tracked template', () => {
    let trackedDefinitionRead = false;
    const fsImpl = {
      existsSync: () => { throw new Error('config directory is unreadable'); },
      readFileSync: () => { trackedDefinitionRead = true; return JSON.stringify(validDefinition()); }
    };
    const loaded = backupDuty.loadDefinition({ fsImpl });
    const observation = backupDuty.loadObservationTarget({ fsImpl });
    assert.equal(loaded.valid, false);
    assert.equal(loaded.definition, null);
    assert.match(loaded.errors.join('; '), /unavailable/);
    assert.equal(observation.valid, false);
    assert.equal(observation.target, null);
    assert.equal(trackedDefinitionRead, false);
  });

  await check('the existing duty host registers a report-only mechanical duty and surfaces invalid config as UNAVAILABLE', async () => {
    const duty = registry.getDuty('backup-definition-report');
    assert.equal(duty.kind, registry.DUTY_KIND.MECHANICAL);
    assert.equal(duty.intervalMs, 300_000);
    assert.match(duty.description, /does not create/i);

    const good = await registry._internals.runBackupDefinitionReport({
      deps: { backupDuty: { loadDefinition: () => ({ valid: true, errors: [], definition: backupDuty.loadDefinition().definition }) } }
    });
    assert.equal(good.outcome, DUTY_OUTCOME.OK);
    assert.equal(good.detail.execution, 'report-only');
    assert.equal(good.detail.artifactsCreated, 0);
    assert.equal(good.detail.artifactsDeleted, 0);
    assert.equal(good.detail.scheduledTaskRegistered, false);
    assert.equal(good.detail.vaultContentsRead, false);

    const bad = await registry._internals.runBackupDefinitionReport({
      deps: { backupDuty: { loadDefinition: () => ({ valid: false, errors: ['bad config'], definition: null }) } }
    });
    assert.equal(bad.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.match(bad.reason, /invalid or unavailable/);

    const unsafe = await registry._internals.runBackupDefinitionReport({
      deps: { backupDuty: { loadDefinition: () => ({ valid: true, errors: [], definition: { ...validDefinition(), mode: 'report-only' } }) } }
    });
    assert.equal(unsafe.outcome, DUTY_OUTCOME.UNAVAILABLE,
      'the registry must not pass through a raw definition (including its destination path) from an injected reader');
  });

  await check('the backup-duty source has no write, process, vault, or cleanup primitive', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'backup-duty.js'), 'utf8');
    for (const forbidden of [/writeFile/, /copyFile/, /rename/, /unlink/, /rmSync/, /exec(?:File)?Sync/, /spawn(?:Sync)?/, /secrets\.ps1/]) {
      assert.equal(forbidden.test(source), false, `report-only definition source contains forbidden primitive ${forbidden}`);
    }
  });

  await check('the observation duty projects injected metadata without exposing the configured destination', async () => {
    const nowMs = Date.parse('2026-07-29T12:00:00.000Z');
    let receivedPath = null;
    const result = await registry._internals.runBackupObservationReport({
      now: () => nowMs,
      deps: {
        backupDuty: { loadObservationTarget: () => ({ valid: true, target: { destinationPath: 'C:\\secret-backups' } }) },
        backupObserver: { observeBackupDestination: candidate => {
          receivedPath = candidate;
          return {
            schemaVersion: 1,
            kind: 'backup-age-observation',
            reportMode: 'report-only',
            observedAt: '2026-07-29T12:00:00.000Z',
            lastBackupAt: '2026-07-29T11:00:00.000Z'
          };
        } },
        backupAgeStatus
      }
    });
    assert.equal(receivedPath, 'C:\\secret-backups');
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.status, 'fresh');
    assert.equal(JSON.stringify(result.detail).includes('secret-backups'), false);
    assert.equal(result.detail.grantsAuthority, false);
    assert.equal(result.detail.backupExistence, 'not-asserted');
  });

  await check('the observation duty says unavailable rather than inventing backup age', async () => {
    const result = await registry._internals.runBackupObservationReport({
      now: () => Date.parse('2026-07-29T12:00:00.000Z'),
      deps: {
        backupDuty: { loadObservationTarget: () => ({ valid: true, target: { destinationPath: 'C:\\secret-backups' } }) },
        backupObserver: { observeBackupDestination: () => ({
          schemaVersion: 1,
          kind: 'backup-age-observation',
          reportMode: 'report-only',
          observedAt: '2026-07-29T12:00:00.000Z',
          lastBackupAt: null
        }) },
        backupAgeStatus
      }
    });
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.deepEqual(result.detail, {
      status: 'unavailable', contentTrust: 'untrusted', grantsAuthority: false, backupExistence: 'not-asserted'
    });
  });

  await check('the execution-gate duty exposes deliberately blocked policy rather than pretending a recurring backup exists', async () => {
    const result = await registry._internals.runBackupExecutionGateReport({
      deps: {
        backupDuty: { loadDefinition: () => ({ valid: true, definition: backupDuty.loadDefinition().definition }) },
        backupExecutionGate: require('../src/lib/coordinator/backup-execution-gate.js')
      }
    });
    assert.equal(registry.getDuty('backup-execution-gate-report').kind, registry.DUTY_KIND.MECHANICAL);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.status, 'blocked');
    assert.equal(result.detail.executionAuthorized, false);
    assert.equal(result.detail.artifactsCreated, 0);
    assert.equal(result.detail.artifactsDeleted, 0);
    assert.equal(result.detail.scheduledTaskRegistered, false);
    assert.equal(result.detail.vaultContentsRead, false);
    assert.equal(result.detail.backupExistence, 'not-asserted');
    assert.equal(JSON.stringify(result.detail).includes('Backups'), false);
  });

  await check('the execution-gate duty fails closed if an injected gate tries to imply activation', async () => {
    const result = await registry._internals.runBackupExecutionGateReport({
      deps: {
        backupDuty: { loadDefinition: () => ({ valid: true, definition: backupDuty.loadDefinition().definition }) },
        backupExecutionGate: { evaluateBackupExecutionGate: () => ({ status: 'blocked', executionAuthorized: true }) }
      }
    });
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
  });

  await check('the execution-gate duty rejects a forged nested activation contract even when its top-level blocked flags look safe', async () => {
    const baseline = frozenGateReport();
    const forged = Object.freeze({
      ...baseline,
      activationContract: Object.freeze({
        ...baseline.activationContract,
        executionAuthorized: true,
        schedulerRegistrationAuthorized: true,
        destinationPath: 'C:\\forged-backups'
      })
    });
    const result = await registry._internals.runBackupExecutionGateReport({
      deps: {
        backupDuty: { loadDefinition: () => ({ valid: true, definition: backupDuty.loadDefinition().definition }) },
        backupExecutionGate: { evaluateBackupExecutionGate: () => forged }
      }
    });
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.deepEqual(result.detail, {});
  });

  await check('the execution-gate duty rejects path leakage through an otherwise valid-looking report', async () => {
    const baseline = frozenGateReport();
    const leaked = Object.freeze({ ...baseline, destinationPath: 'C:\\forged-backups' });
    const result = await registry._internals.runBackupExecutionGateReport({
      deps: {
        backupDuty: { loadDefinition: () => ({ valid: true, definition: backupDuty.loadDefinition().definition }) },
        backupExecutionGate: { evaluateBackupExecutionGate: () => leaked }
      }
    });
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.deepEqual(result.detail, {});
  });

  await check('the execution-gate duty rejects accessor-backed reports and polluted prototypes', async () => {
    const baseline = frozenGateReport();
    const accessorBacked = {};
    for (const [key, value] of Object.entries(baseline)) {
      Object.defineProperty(accessorBacked, key, { enumerable: true, get: () => value });
    }
    const polluted = Object.freeze(Object.assign(Object.create({ destinationPath: 'C:\\forged-backups' }), baseline));
    for (const candidate of [Object.freeze(accessorBacked), polluted]) {
      const result = await registry._internals.runBackupExecutionGateReport({
        deps: {
          backupDuty: { loadDefinition: () => ({ valid: true, definition: backupDuty.loadDefinition().definition }) },
          backupExecutionGate: { evaluateBackupExecutionGate: () => candidate }
        }
      });
      assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    }
  });

  process.stdout.write(`\ncoordinator-backup-duty: ${passed} checks passed\n`);
}

run().catch(error => {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
});
