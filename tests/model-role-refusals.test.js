'use strict';

const assert = require('node:assert/strict');
const role = require('../src/lib/providers/model-role');

const GiB = 1024 ** 3;
const request = Object.freeze({
  role: 'builder',
  model: 'qwen3:8b',
  prompt: 'Describe a bounded implementation plan.'
});

function harness(overrides = {}) {
  const calls = { probe: 0, modelComplete: 0, auditRequire: 0, auditRecord: 0, auditEvents: [] };
  const dependencies = {
    probe: async () => {
      calls.probe += 1;
      return { installedModels: [request.model], residentModels: [], freeVramBytes: 16 * GiB };
    },
    modelComplete: async () => {
      calls.modelComplete += 1;
      return { output: 'advice', modelUsed: request.model, promptTokens: 1, evalTokens: 1, durationMs: 1 };
    },
    auditRequire: (...args) => {
      calls.auditRequire += 1;
      calls.auditEvents.push(args);
      return { durable: true };
    },
    auditRecord: (...args) => {
      calls.auditRecord += 1;
      calls.auditEvents.push(args);
      return { durable: true };
    }
  };
  Object.assign(dependencies, overrides(calls));
  return { calls, dependencies };
}

async function assertPreflightRefusal(changes, code) {
  const test = harness(() => ({}));
  await assert.rejects(
    role.complete({ ...request, ...changes }, test.dependencies),
    error => error instanceof role.ModelRoleError && error.code === code
  );
  assert.deepEqual(test.calls, {
    probe: 0, modelComplete: 0, auditRequire: 0, auditRecord: 0, auditEvents: []
  }, `${code} must refuse before probing, invoking the model, or writing audit records`);
}

(async () => {
  await assertPreflightRefusal({ role: 'operator' }, 'MODEL_ROLE_ROLE_INVALID');
  await assertPreflightRefusal({ model: 'remote-model' }, 'MODEL_ROLE_MODEL_INVALID');
  await assertPreflightRefusal({ prompt: 'password=hunter2' }, 'MODEL_ROLE_SENSITIVE_INPUT');
  await assertPreflightRefusal({ prompt: 'Apply this patch.' }, 'MODEL_ROLE_AUTHORITY_INPUT');

  const execution = harness(calls => ({
    modelComplete: async () => {
      calls.modelComplete += 1;
      throw new Error('transport detail that must not escape');
    }
  }));
  await assert.rejects(
    role.complete(request, execution.dependencies),
    error => error instanceof role.ModelRoleError
      && error.code === 'MODEL_ROLE_EXECUTION_FAILED'
      && error.message === 'The selected local model did not complete.'
  );
  assert.equal(execution.calls.probe, 1);
  assert.equal(execution.calls.modelComplete, 1);
  assert.equal(execution.calls.auditRequire, 1);
  assert.equal(execution.calls.auditRecord, 1);
  assert.equal(execution.calls.auditEvents[0][0], 'model.role_complete.intent');
  assert.equal(execution.calls.auditEvents[1][0], 'model.role_complete.failed');
  assert.equal(execution.calls.auditEvents[1][2].code, 'MODEL_ROLE_EXECUTION_FAILED');

  console.log('Model role refusal tests passed.');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
