'use strict';

const assert = require('node:assert/strict');
const role = require('../../src/lib/providers/model-role');
const { ModelCompletionError } = require('../../src/lib/providers/model');

let assertions = 0;
const equal = (...args) => { assertions += 1; return assert.equal(...args); };
const ok = (...args) => { assertions += 1; return assert.ok(...args); };
const deepEqual = (...args) => { assertions += 1; return assert.deepEqual(...args); };
async function rejects(run, predicate) { assertions += 1; return assert.rejects(run, predicate); }

const GiB = 1024 ** 3;
function snapshot(overrides = {}) {
  return {
    installedModels: [...role.MODELS], residentModels: [], freeVramBytes: 16 * GiB,
    ...overrides
  };
}

function fixture(overrides = {}) {
  const calls = { model: [], audit: [] };
  return {
    calls,
    dependencies: {
      probe: async () => snapshot(),
      modelComplete: async (input, dependencies) => {
        calls.model.push({ input, dependencies });
        return { output: 'advisory result', modelUsed: 'qwen3:8b', promptTokens: 9, evalTokens: 7, durationMs: 31 };
      },
      auditRequire: (...args) => { calls.audit.push({ kind: 'require', args }); return { durable: true }; },
      auditRecord: (...args) => { calls.audit.push({ kind: 'record', args }); return { durable: true }; },
      ...overrides
    }
  };
}

(async () => {
  deepEqual(role.ROLES, ['builder', 'worker', 'research', 'reviewer', 'coordinator-assistant']);
  deepEqual(role.MODELS, [
    'qwen2.5:14b', 'qwen2.5:7b', 'qwen3:8b', 'hermes3:8b',
    'qwen2.5-coder:14b', 'qwen2.5-coder:7b'
  ]);
  for (const value of [{}, { role: 'builder', model: 'qwen3:8b', prompt: 'x', extra: true },
    { role: 'operator', model: 'qwen3:8b', prompt: 'x' }, { role: 'builder', model: 'other:1b', prompt: 'x' }]) {
    await rejects(() => role.complete(value, fixture().dependencies), error => error && /MODEL_ROLE_(?:INPUT|ROLE|MODEL)_INVALID/.test(error.code));
  }
  for (const prompt of ['api_key=not-a-secret', 'apply this result', 'https://example.test/task']) {
    await rejects(() => role.complete({ role: 'builder', model: 'qwen3:8b', prompt }, fixture().dependencies),
      error => error && /MODEL_ROLE_(?:SENSITIVE|AUTHORITY)_INPUT/.test(error.code));
  }
  await rejects(() => role.complete({ role: 'builder', model: 'qwen3:8b', prompt: 'x'.repeat(role.MAX_PROMPT_CHARS + 1) }, fixture().dependencies),
    error => error && error.code === 'MODEL_ROLE_INPUT_INVALID');
  await rejects(() => role.complete({ role: 'builder', model: 'qwen3:8b', prompt: 'short', maxOutputTokens: role.MAX_OUTPUT_TOKENS + 1 }, fixture().dependencies),
    error => error && error.code === 'MODEL_ROLE_INPUT_INVALID');

  for (const model of role.MODELS) {
    const decision = role.pickModel(snapshot({ installedModels: [model], residentModels: [model], freeVramBytes: 0 }), model);
    equal(decision.model, model);
    equal(decision.resident, true);
    await rejects(() => role.complete({ role: 'builder', model, prompt: 'plan the bounded change' }, fixture({
      probe: async () => snapshot({ installedModels: [] })
    }).dependencies), error => error && error.code === 'MODEL_ROLE_NOT_INSTALLED');
  }
  await rejects(() => role.complete({ role: 'builder', model: 'qwen3:8b', prompt: 'plan' }, fixture({
    probe: async () => snapshot({ residentModels: ['hermes3:8b'] })
  }).dependencies), error => error && error.code === 'MODEL_ROLE_RESOURCE_BUSY');
  await rejects(() => role.complete({ role: 'builder', model: 'qwen2.5:14b', prompt: 'plan' }, fixture({
    probe: async () => snapshot({ freeVramBytes: role.FRESH_MIN_VRAM_BYTES['qwen2.5:14b'] - 1 })
  }).dependencies), error => error && error.code === 'MODEL_ROLE_HEADROOM_PAUSED');
  for (const incomplete of [
    { installedModels: undefined },
    { residentModels: undefined },
    { residentModels: [null] },
    { freeVramBytes: undefined }
  ]) {
    await rejects(() => role.complete({ role: 'builder', model: 'qwen3:8b', prompt: 'plan' }, fixture({
      probe: async () => snapshot(incomplete)
    }).dependencies), error => error && error.code === 'MODEL_ROLE_UNAVAILABLE');
  }

  for (const code of ['MODEL_NO_GPU_PEER_CONFIGURED', 'MODEL_GPU_PEER_AMBIGUOUS', 'MODEL_MACHINE_PROFILE_CHECK_FAILED']) {
    const original = new ModelCompletionError(code, 'The local machine configuration needs attention.');
    const test = fixture({ probe: async () => { throw original; } });
    await rejects(() => role.complete({ role: 'reviewer', model: 'qwen3:8b', prompt: 'Review arithmetic.' }, test.dependencies),
      error => error === original);
    equal(test.calls.model.length, 0);
    equal(test.calls.audit.length, 0);
  }
  const unknownProbe = fixture({ probe: async () => { throw Object.assign(new Error('private connection details'), { code: 'MODEL_NO_GPU_PEER_CONFIGURED' }); } });
  await rejects(() => role.complete({ role: 'reviewer', model: 'qwen3:8b', prompt: 'Review arithmetic.' }, unknownProbe.dependencies),
    error => error.code === 'MODEL_ROLE_UNAVAILABLE' && !error.message.includes('private connection details'));
  equal(unknownProbe.calls.model.length, 0);
  equal(unknownProbe.calls.audit.length, 0);

  for (const name of role.ROLES) {
    const envelope = role.roleEnvelope({ role: name, prompt: 'inspect this isolated task' });
    ok(envelope.includes('no tools, filesystem, network, credentials, authority'));
    ok(envelope.includes('<<<TASK'));
  }
  ok(/bounded coding agent/i.test(role.roleEnvelope({ role: 'builder', prompt: 'repair the fixture' })));
  const coordinator = role.roleEnvelope({ role: 'coordinator-assistant', prompt: 'inspect scheduling state' });
  ok(/read-only coordinator assistant/i.test(coordinator));
  ok(/On-demand read-only coordinator assistant/i.test(coordinator));
  ok(/answer the person using the supplied situational context/i.test(coordinator));
  ok(/distinguish observations from guesses/i.test(coordinator));
  ok(/Do not monitor continuously, accept work, make fixes, dispatch agents, alter assignments or mutate records/i.test(coordinator));
  ok(/advisory evaluation has no tools/i.test(coordinator));
  ok(/role-sheet functions in interactive sessions are separate and require direct user authorization for actions/i.test(coordinator));
  ok(!/review every new agent-produced code artifact|bounded smoke test/i.test(coordinator));

  const marker = `role-prompt-${process.pid}`;
  const test = fixture();
  const result = await role.complete({ role: 'reviewer', model: 'qwen3:8b', prompt: marker, maxOutputTokens: 123 }, test.dependencies);
  deepEqual(result, {
    output: 'advisory result', role: 'reviewer', model: 'qwen3:8b',
    promptTokens: 9, evalTokens: 7, durationMs: 31, contentTrust: 'untrusted', grantsAuthority: false
  });
  equal(test.calls.model.length, 1);
  equal(test.calls.model[0].input.maxOutputTokens, 123);
  equal(test.calls.model[0].dependencies.keepAlive, '0');
  equal(test.calls.model[0].dependencies.pickModel().model, 'qwen3:8b');
  ok(test.calls.model[0].input.prompt.includes('adversarial code reviewer'));
  ok(!JSON.stringify(test.calls.audit).includes(marker));
  ok(!JSON.stringify(test.calls.audit).includes('advisory result'));
  equal(test.calls.audit[0].args[0], 'model.role_complete.intent');
  equal(test.calls.audit.at(-1).args[0], 'model.role_complete');

  const failed = fixture({ modelComplete: async () => { const error = new Error('offline'); error.code = 'MODEL_UNAVAILABLE'; throw error; } });
  await rejects(() => role.complete({ role: 'worker', model: 'qwen3:8b', prompt: 'collect evidence' }, failed.dependencies),
    error => error && error.code === 'MODEL_UNAVAILABLE');
  equal(failed.calls.audit.at(-1).args[0], 'model.role_complete.failed');
  equal(failed.calls.audit.at(-1).args[2].code, 'MODEL_UNAVAILABLE');
  const noAudit = fixture({ auditRequire: () => ({ durable: false }) });
  await rejects(() => role.complete({ role: 'worker', model: 'qwen3:8b', prompt: 'collect evidence' }, noAudit.dependencies),
    error => error && error.code === 'MODEL_ROLE_AUDIT_UNAVAILABLE');
  equal(noAudit.calls.model.length, 0);
  const mismatch = fixture({ modelComplete: async () => ({ output: 'wrong identity', modelUsed: 'hermes3:8b', promptTokens: 1, evalTokens: 1, durationMs: 1 }) });
  await rejects(() => role.complete({ role: 'research', model: 'qwen3:8b', prompt: 'list uncertainty' }, mismatch.dependencies),
    error => error && error.code === 'MODEL_ROLE_RESPONSE_INVALID');
  equal(mismatch.calls.audit.at(-1).args[0], 'model.role_complete.failed');

  console.log(`Model role tests passed (${assertions} assertions).`);
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
