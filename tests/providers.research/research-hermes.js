'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const originalModuleLoad = Module._load;
// The provider accepts an injected state store, so this isolated test does not
// need SQLite. Keep it runnable on the repository's Node 20 test host even
// though state-store eagerly imports the Node 22-only built-in.
Module._load = function loadWithoutSqlite(request, parent, isMain) {
  if (request === 'node:sqlite') return { DatabaseSync: class UnusedDatabaseSync {} };
  return Reflect.apply(originalModuleLoad, this, [request, parent, isMain]);
};
const hermes = require('../../src/lib/providers/research-hermes');
Module._load = originalModuleLoad;
const { GiB } = require('../../src/lib/model-picker');

function completion(content = 'advisory output') {
  return {
    message: { role: 'assistant', content }, prompt_eval_count: 11,
    eval_count: 7, total_duration: 24_000_000
  };
}

function fixture(overrides = {}) {
  const calls = { requests: [], ledger: [], audit: [] };
  const dependencies = {
    assertAllowed() {},
    requestJson: async (pathname, payload, options) => {
      calls.requests.push({ pathname, payload, options });
      if (pathname === '/api/tags') return { models: [{ name: hermes.HERMES_MODEL }] };
      if (pathname === '/api/ps') return { models: [] };
      return completion();
    },
    probeResources: () => ({ freeRamBytes: 32 * GiB, freeVramBytes: 8 * GiB, onBattery: false }),
    state: { recordModelUsage: value => { calls.ledger.push(value); } },
    auditRequire: (...args) => { calls.audit.push({ kind: 'require', args }); return { durable: true }; },
    auditRecord: (...args) => { calls.audit.push({ kind: 'record', args }); return { durable: true }; },
    ...overrides
  };
  return { calls, dependencies };
}

(async () => {
  {
    const test = fixture();
    const marker = `hermes-prompt-must-not-enter-audit-${process.pid}`;
    const result = await hermes.complete({ prompt: marker, maxOutputTokens: 123 }, test.dependencies);
    assert.deepEqual(result, {
      output: 'advisory output', promptTokens: 11, evalTokens: 7, durationMs: 24,
      modelUsed: 'hermes3:8b', keepAlive: '15m', contentTrust: 'untrusted', grantsAuthority: false
    });
    assert.equal(test.calls.requests.length, 3);
    assert.deepEqual(test.calls.requests[0], { pathname: '/api/tags', payload: undefined, options: { timeoutMs: hermes.TIMEOUT_MS } });
    assert.equal(test.calls.requests[1].pathname, '/api/ps');
    assert.equal(test.calls.requests[2].pathname, '/api/chat');
    assert.equal(test.calls.requests[2].payload.model, 'hermes3:8b', 'the model is fixed, never caller-selected');
    assert.equal(test.calls.requests[2].payload.options.num_predict, 123);
    assert.equal(test.calls.requests[2].payload.stream, false);
    assert.equal(test.calls.requests[2].payload.keep_alive, '15m');
    assert.equal(Object.hasOwn(test.calls.requests[2].payload, 'tools'), false);
    assert.deepEqual(test.calls.ledger, [{ model: 'hermes3:8b', promptTokens: 11, evalTokens: 7 }]);
    assert.doesNotMatch(JSON.stringify(test.calls.audit), new RegExp(marker));
    assert.equal(test.calls.audit[0].args[0], 'research.hermes_complete.intent');
    assert.equal(test.calls.audit.at(-1).args[0], 'research.hermes_complete');
  }

  {
    for (const invalid of [
      { prompt: 'research', model: 'remote-model' },
      { prompt: 'research', url: 'https://example.invalid' },
      { prompt: 'research', vaultPath: 'C:\\vault\\secret' },
      { prompt: 'API_KEY=not-a-real-key' },
      { prompt: 'Cookie: session=not-a-real-cookie' },
      { prompt: 'read C:\\vault\\records' }
    ]) {
      await assert.rejects(hermes.complete(invalid, fixture().dependencies), error =>
        error && (error.code === 'HERMES_INPUT_INVALID' || error.code === 'HERMES_SENSITIVE_INPUT'));
    }
    assert.equal(hermes.containsSensitiveMaterial('Summarize only this public question.'), false);
  }

  {
    await assert.rejects(hermes.complete({ prompt: 'x'.repeat(hermes.MAX_PROMPT_CHARS + 1) }, fixture().dependencies), error => error && error.code === 'HERMES_INPUT_INVALID');
    await assert.rejects(hermes.complete({ prompt: 'bounded', maxOutputTokens: hermes.MAX_OUTPUT_TOKENS + 1 }, fixture().dependencies), error => error && error.code === 'HERMES_INPUT_INVALID');
    const test = fixture({
      requestJson: async pathname => pathname === '/api/tags'
        ? { models: [{ name: hermes.HERMES_MODEL }] }
        : pathname === '/api/ps' ? { models: [] }
          : completion('x'.repeat(hermes.MAX_OUTPUT_CHARS + 1))
    });
    await assert.rejects(hermes.complete({ prompt: 'bounded' }, test.dependencies), error => error && error.code === 'HERMES_OUTPUT_TOO_LARGE');
  }

  {
    const test = fixture({
      requestJson: async () => { const error = new Error('timeout'); error.code = 'MODEL_OLLAMA_TIMEOUT'; throw error; }
    });
    await assert.rejects(hermes.complete({ prompt: 'timeout check' }, test.dependencies), error => error && error.code === 'HERMES_TIMEOUT');
    assert.equal(test.calls.audit.at(-1).args[0], 'research.hermes_complete.failed');
    const disabled = fixture({ assertAllowed() { throw new Error('disabled'); } });
    await assert.rejects(hermes.complete({ prompt: 'policy check' }, disabled.dependencies), error => error && error.code === 'HERMES_DISABLED');
    assert.equal(disabled.calls.requests.length, 0, 'policy is checked before even local inventory I/O');
  }

  {
    const battery = fixture({
      probeResources: () => ({ freeRamBytes: 32 * GiB, freeVramBytes: 8 * GiB, onBattery: true })
    });
    const result = await hermes.complete({ prompt: 'battery call' }, battery.dependencies);
    assert.equal(result.keepAlive, '0');
    assert.equal(battery.calls.requests.at(-1).payload.keep_alive, '0');
    const busy = fixture({ requestJson: async pathname => pathname === '/api/tags'
      ? { models: [{ name: hermes.HERMES_MODEL }] }
      : pathname === '/api/ps' ? { models: [{ name: 'gpt-oss:20b' }] } : completion() });
    await assert.rejects(hermes.complete({ prompt: 'must not evict another model' }, busy.dependencies),
      error => error && error.code === 'HERMES_RESOURCE_BUSY');
  }

  {
    let requests = 0;
    const absent = fixture({ requestJson: async () => { requests += 1; return { models: [] }; } });
    await assert.rejects(hermes.complete({ prompt: 'inventory check' }, absent.dependencies), error => error && error.code === 'HERMES_UNAVAILABLE');
    assert.equal(requests, 2, 'only the parallel local inventory requests run when hermes3:8b is absent');
  }

  {
    async function assertRefusal({ code, overrides, requestPaths, failedAudit = true }) {
      const test = fixture(overrides);
      if (overrides.requestJson) {
        const injectedRequest = overrides.requestJson;
        test.dependencies.requestJson = async (pathname, payload, options) => {
          test.calls.requests.push({ pathname, payload, options });
          return injectedRequest(pathname, payload, options);
        };
      }
      await assert.rejects(hermes.complete({ prompt: `drive ${code}` }, test.dependencies), caught => {
        assert.equal(caught && caught.code, code);
        return true;
      });
      assert.deepEqual(test.calls.ledger, [], `${code} must not write model usage`);
      if (requestPaths) assert.deepEqual(test.calls.requests.map(call => call.pathname), requestPaths);
      assert.equal(test.calls.audit.some(entry => entry.args[0] === 'research.hermes_complete'), false,
        `${code} must not write a successful completion audit`);
      assert.equal(test.calls.audit.some(entry => entry.args[0] === 'research.hermes_complete.failed'), failedAudit,
        `${code} failure audit behavior changed`);
    }

    await assertRefusal({
      code: 'HERMES_INVENTORY_INVALID',
      overrides: { requestJson: async pathname => pathname === '/api/tags' ? { notModels: [] } : { models: [] } },
      requestPaths: ['/api/tags', '/api/ps']
    });
    await assertRefusal({
      code: 'HERMES_AUDIT_UNAVAILABLE',
      overrides: { auditRequire: () => ({ durable: false }) },
      requestPaths: ['/api/tags', '/api/ps']
    });
    await assertRefusal({
      code: 'HERMES_RESPONSE_INVALID',
      overrides: { requestJson: async pathname => pathname === '/api/tags'
        ? { models: [{ name: hermes.HERMES_MODEL }] }
        : pathname === '/api/ps' ? { models: [] } : { message: { content: 'missing accounting' } } },
      requestPaths: ['/api/tags', '/api/ps', '/api/chat']
    });
    await assertRefusal({
      code: 'HERMES_EXECUTION_FAILED',
      overrides: { requestJson: async () => { throw new Error('injected transport failure'); } },
      requestPaths: ['/api/tags', '/api/ps']
    });
    for (const [dependencyCode, refusalCode] of [
      ['MODEL_OLLAMA_UNAVAILABLE', 'HERMES_UNAVAILABLE'],
      ['MODEL_OLLAMA_HTTP', 'HERMES_UNAVAILABLE'],
      ['MODEL_NO_GPU_PEER_CONFIGURED', 'HERMES_NO_GPU_PEER_CONFIGURED'],
      ['MODEL_MACHINE_PROFILE_CHECK_FAILED', 'HERMES_MACHINE_PROFILE_CHECK_FAILED']
    ]) {
      await assertRefusal({
        code: refusalCode,
        overrides: { requestJson: async () => { const caught = new Error('injected dependency refusal'); caught.code = dependencyCode; throw caught; } },
        requestPaths: ['/api/tags', '/api/ps']
      });
    }
  }

  console.log('Hermes research provider tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
