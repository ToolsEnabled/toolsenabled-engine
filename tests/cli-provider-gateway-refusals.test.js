'use strict';

require('./lib/isolated-environment').activate('cli-provider-gateway-refusals');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CliProviderGateway,
  GEMINI_MODELS,
  RELEASE_REVIEW_GEMINI_MODEL,
  MAX_PROMPT_BYTES,
  configuredGoogleAccountEmail
} = require('../src/lib/providers/cli-provider-gateway');
const modelFloor = require('../src/lib/model-floor');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-provider-refusals-'));

function enabledState(name, provider = 'codex') {
  const stateFile = path.join(root, name);
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    providers: {
      codex: provider === 'codex',
      claude: provider === 'claude',
      gemini: provider === 'gemini'
    },
    controlRevisions: { codex: 0, claude: 0, gemini: 0 },
    lastVerifiedAt: {},
    lastCheck: {}
  }));
  return stateFile;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code, `expected ${code}`);
}

(async () => {
  assert.deepEqual(GEMINI_MODELS, modelFloor.allowedFor('subscription'));
  assert.equal(RELEASE_REVIEW_GEMINI_MODEL, modelFloor.defaultFor('subscription'));

  let spawned = 0;
  let audited = 0;
  const untouchedFile = path.join(root, 'untouched.json');
  const refusing = new CliProviderGateway({
    stateFile: untouchedFile,
    spawnImpl() { spawned += 1; throw new Error('must not spawn'); },
    auditRecord() { audited += 1; throw new Error('must not audit'); }
  });

  await rejectsCode(refusing.setEnabled('codex', 'true'), 'INVALID_ENABLED_VALUE');
  await rejectsCode(refusing.complete('codex', '   '), 'INVALID_PROMPT');
  await rejectsCode(refusing.complete('codex', 'x'.repeat(MAX_PROMPT_BYTES + 1)), 'PROMPT_TOO_LARGE');
  await rejectsCode(refusing.complete('codex', 'hello'), 'PROVIDER_DISABLED');
  assert.equal(spawned, 0, 'input and disabled refusals must not spawn a CLI');
  assert.equal(audited, 0, 'input and disabled refusals must not claim an audit intent');
  assert.equal(fs.existsSync(untouchedFile), false, 'refusals must not create provider state');

  const modelState = enabledState('model.json');
  const modelStateBefore = fs.readFileSync(modelState, 'utf8');
  const invalidModel = new CliProviderGateway({ stateFile: modelState });
  invalidModel.run = async () => { throw new Error('must not run'); };
  await rejectsCode(invalidModel.complete('codex', 'hello', { model: 'caller-choice' }), 'INVALID_PROVIDER_MODEL');
  assert.equal(fs.readFileSync(modelState, 'utf8'), modelStateBefore, 'model refusal must not rewrite controls');

  const reviewState = enabledState('review.json', 'claude');
  const reviewStateBefore = fs.readFileSync(reviewState, 'utf8');
  const invalidReview = new CliProviderGateway({ stateFile: reviewState });
  invalidReview.run = async () => { throw new Error('must not run'); };
  await rejectsCode(invalidReview.completeReadOnlyReview('claude', 'review this'), 'INVALID_REVIEW_PROVIDER');
  assert.equal(fs.readFileSync(reviewState, 'utf8'), reviewStateBefore, 'review refusal must not rewrite controls');

  const invalidRegistry = {
    load() {
      return { defaultAccount: 'primary', accounts: { primary: { email: 'not-an-email' } } };
    },
    resolve() { return 'primary'; }
  };
  assert.throws(
    () => configuredGoogleAccountEmail(invalidRegistry),
    error => error?.code === 'GOOGLE_ACCOUNT_CONFIGURATION_INVALID'
  );

  const resolutionGateway = new CliProviderGateway({
    stateFile: path.join(root, 'resolution.json'),
    assertActive() {},
    googleAccountEmail() { throw new Error('registry parser failed'); }
  });
  const resolutionStatus = await resolutionGateway.status();
  const geminiStatus = resolutionStatus.providers.find(provider => provider.id === 'gemini');
  assert.equal(geminiStatus.configuredAccountError, 'GOOGLE_ACCOUNT_RESOLUTION_FAILED');
  assert.equal(geminiStatus.configuredAccountState, 'resolution_error');

  const busyState = path.join(root, 'busy.json');
  fs.writeFileSync(`${busyState}.lock`, 'another process owns this lock\n');
  const busyGateway = new CliProviderGateway({ stateFile: busyState });
  const realNow = Date.now;
  let clockReads = 0;
  Date.now = () => (++clockReads === 1 ? 0 : 10_001);
  try {
    await rejectsCode(busyGateway.setEnabled('codex', false), 'PROVIDER_STATE_BUSY');
  } finally {
    Date.now = realNow;
  }
  assert.equal(fs.existsSync(busyState), false, 'busy refusal must not write state');
  assert.equal(fs.readFileSync(`${busyState}.lock`, 'utf8'), 'another process owns this lock\n');

  const blockedState = enabledState('blocked-audit.json');
  const policyDenial = Object.assign(new Error('policy denied'), { code: 'POLICY_DENIED' });
  let blockedSpawns = 0;
  const blockedGateway = new CliProviderGateway({
    stateFile: blockedState,
    assertActive() { throw policyDenial; },
    auditRecord() { throw new Error('ledger offline'); },
    spawnImpl() { blockedSpawns += 1; throw new Error('must not spawn'); }
  });
  await assert.rejects(
    blockedGateway.complete('codex', 'hello'),
    error => error === policyDenial
      && error.blockedAuditPersistenceCode === 'PROVIDER_BLOCKED_AUDIT_PERSISTENCE_FAILED'
  );
  assert.equal(blockedSpawns, 0, 'policy and audit refusal must happen before spawn');

  for (const [name, result, code, auditOutcome] of [
    ['cancelled', { ok: false, cancelled: true, timedOut: false, stdout: '', stderr: '', durationMs: 3 }, 'PROVIDER_CANCELLED', 'cancelled'],
    ['empty', { ok: true, cancelled: false, timedOut: false, stdout: '', stderr: '', durationMs: 4 }, 'PROVIDER_EMPTY_RESPONSE', 'empty_response']
  ]) {
    const stateFile = enabledState(`${name}.json`);
    const before = fs.readFileSync(stateFile, 'utf8');
    const events = [];
    const gateway = new CliProviderGateway({
      stateFile,
      assertActive() {},
      auditRecord(action, target, details) { events.push({ action, target, details }); return { ok: true }; }
    });
    let runs = 0;
    gateway.run = async () => { runs += 1; return result; };
    await rejectsCode(gateway.complete('codex', 'hello'), code);
    assert.equal(runs, 1, `${code} must come from a driven provider result`);
    assert.deepEqual(events.map(event => event.details.outcome), ['intent', auditOutcome]);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before, `${code} must not rewrite provider controls`);
  }

  console.log('CLI provider gateway driven refusal tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
