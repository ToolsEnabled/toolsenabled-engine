/* Mutation check (2026-08-27): preferred-model selection.
 * Exact mutation: replaced `return instruct || usable[0] || models[0] || null;`
 * with `return models[0] || null;` in local-node-runtime.js.
 * The edit landed, and this file went red (expected qwen-chat, got embed-small).
 * The module was restored to its pre-mutation SHA-256 afterward.
 */
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  authorization,
  assertModelFits,
  complete,
  detect,
  preferredModel,
  probeRuntime,
  resolveNode
} = require('../src/lib/providers/local-node-runtime');

function injectedHttp(step, calls) {
  return {
    request(options, callback) {
      const request = new EventEmitter();
      request.write = data => calls.push({ kind: 'write', data: String(data) });
      request.end = () => {
        calls.push({ kind: 'end', options });
        process.nextTick(() => {
          if (step.requestError) return request.emit('error', Object.assign(new Error('offline'), { code: step.requestError }));
          if (step.timeout) return request.emit('timeout');
          const response = new EventEmitter();
          response.statusCode = step.statusCode === undefined ? 200 : step.statusCode;
          response.destroy = () => calls.push({ kind: 'response-destroy' });
          callback(response);
          if (step.body !== undefined) response.emit('data', Buffer.from(step.body));
          response.emit('end');
        });
      };
      request.destroy = () => calls.push({ kind: 'request-destroy' });
      return request;
    }
  };
}

/* One fake loopback that answers by route, so a single detect() can see four
 * runtimes at once, each with its own version route. Records every request. */
function routedHttp(routes, calls) {
  return {
    request(options, callback) {
      const request = new EventEmitter();
      const step = routes[options.path] || { statusCode: 404, body: '{}' };
      request.write = data => calls.push({ kind: 'write', path: options.path, data: String(data) });
      request.end = () => {
        calls.push({ kind: 'end', path: options.path, port: options.port, timeout: options.timeout });
        process.nextTick(() => {
          if (step.requestError) return request.emit('error', Object.assign(new Error('offline'), { code: step.requestError }));
          if (step.timeout) return request.emit('timeout');
          const response = new EventEmitter();
          response.statusCode = step.statusCode === undefined ? 200 : step.statusCode;
          response.destroy = () => calls.push({ kind: 'response-destroy', path: options.path });
          callback(response);
          if (step.body !== undefined) response.emit('data', Buffer.from(step.body));
          response.emit('end');
        });
      };
      request.destroy = () => calls.push({ kind: 'request-destroy', path: options.path });
      return request;
    }
  };
}

/* THE VERSION EACH RUNNING RUNTIME REPORTS, READ OVER THE SAME LOOPBACK.
 * Settings shows which runtime and which version is serving without starting
 * any program: Ollama's /api/version, llama-server's /props build_info and
 * vLLM's /version. LM Studio publishes no version route and stays null. The
 * version is display only: every failure leaves it null and readiness as
 * discovery found it, and a detect() that did not ask sends no extra request. */
async function versionCoverage() {
  const ALL = ['ollama', 'lm-studio', 'llama-cpp', 'vllm'];
  const catalogue = { body: JSON.stringify({ data: [{ id: 'qwen-chat' }] }) };
  const good = {
    '/v1/models': catalogue,
    '/api/version': { body: JSON.stringify({ version: '0.34.2' }) },
    '/props': { body: JSON.stringify({ build_info: 'b11095-45c586f', model_path: '/private/models/secret.gguf', chat_template: 'x'.repeat(4096) }) },
    '/version': { body: JSON.stringify({ version: '0.11.0+cu128' }) }
  };
  const calls = [];
  const found = await detect({ runtimes: ALL, versions: true }, { http: routedHttp(good, calls) });
  const byId = Object.fromEntries(found.runtimes.map(entry => [entry.runtime, entry]));
  assert.equal(byId.ollama.version, '0.34.2');
  assert.equal(byId['lm-studio'].version, null, 'LM Studio publishes no version route');
  assert.equal(byId['llama-cpp'].version, 'b11095-45c586f');
  assert.equal(byId.vllm.version, '0.11.0+cu128');
  assert.equal(found.ready, true);
  assert.equal(found.selected.runtime, 'ollama');
  assert.equal(found.selected.version, '0.34.2', 'the selected runtime carries its version');
  assert.deepEqual(byId.ollama.models, ['qwen-chat']);
  assert.ok(Object.isFrozen(byId.ollama), 'a runtime entry stays frozen');
  assert.equal(JSON.stringify(found).includes('secret.gguf'), false, 'only the version field leaves the /props reply');
  const ends = calls.filter(call => call.kind === 'end');
  assert.equal(ends.filter(call => call.path === '/v1/models').length, 4);
  assert.deepEqual(ends.filter(call => call.path !== '/v1/models').map(call => call.path).sort(), ['/api/version', '/props', '/version']);
  assert.equal(calls.filter(call => call.kind === 'write').length, 0, 'version reads send no body');
  assert.ok(ends.filter(call => call.path !== '/v1/models').every(call => call.timeout <= 2000), 'a version read is bounded to two seconds');

  // Without `versions: true` nothing beyond discovery is sent, and no version field appears.
  const quietCalls = [];
  const quiet = await detect({ runtimes: ALL }, { http: routedHttp(good, quietCalls) });
  assert.deepEqual([...new Set(quietCalls.filter(call => call.kind === 'end').map(call => call.path))], ['/v1/models']);
  assert.equal(quiet.runtimes.some(entry => 'version' in entry), false);

  // Every failure of the version route leaves the version null and nothing else changed.
  for (const [label, step] of [
    ['missing route', { statusCode: 404, body: '{"error":"not found"}' }],
    ['invalid JSON', { body: 'not-json' }],
    ['timeout', { timeout: true }],
    ['reset', { requestError: 'ECONNRESET' }],
    ['markup', { body: JSON.stringify({ version: '<img src=x onerror=alert(1)>' }) }],
    ['spaces', { body: JSON.stringify({ version: '0.34.2 (built by someone)' }) }],
    ['overlong', { body: JSON.stringify({ version: '1'.repeat(65) }) }],
    ['number', { body: JSON.stringify({ version: 34 }) }],
    ['array', { body: JSON.stringify([{ version: '0.34.2' }]) }],
    ['too large', { body: 'x'.repeat(1024 * 1024 + 1) }]
  ]) {
    const failing = await detect({ runtimes: ['ollama'], versions: true }, {
      http: routedHttp({ '/v1/models': catalogue, '/api/version': step }, [])
    });
    assert.equal(failing.runtimes[0].version, null, label);
    assert.equal(failing.ready, true, `${label}: a version failure never changes readiness`);
    assert.deepEqual(failing.runtimes[0].models, ['qwen-chat'], label);
  }

  // A runtime that is not listening is not asked for a version at all.
  const offCalls = [];
  const off = await detect({ runtimes: ['ollama'], versions: true }, {
    http: routedHttp({ '/v1/models': { requestError: 'ECONNREFUSED' }, '/api/version': good['/api/version'] }, offCalls)
  });
  assert.equal(off.runtimes[0].listening, false);
  assert.equal(off.runtimes[0].version, null);
  assert.equal(offCalls.some(call => call.path === '/api/version'), false);
}

async function rejectsCode(action, code) {
  await assert.rejects(action, error => error && error.code === code);
}

async function refusalCoverage() {
  // Validation and runtime selection refuse before contacting (or writing to)
  // an HTTP implementation. These assertions make that safety behaviour part
  // of the contract, rather than merely checking the error vocabulary.
  for (const [input, code] of [
    [{ prompt: '', model: 'valid' }, 'LOCAL_NODE_INPUT_INVALID'],
    [{ prompt: 'valid', model: 'bad model' }, 'LOCAL_NODE_INPUT_INVALID'],
    [{ prompt: 'valid', model: 'valid', runtime: 'missing' }, 'LOCAL_NODE_RUNTIME_UNKNOWN']
  ]) {
    let spawned = 0;
    await rejectsCode(() => complete(input, { http: { request() { spawned += 1; } } }), code);
    assert.equal(spawned, 0, `${code} must refuse before spawning an HTTP request`);
  }
  let probeSpawned = 0;
  await rejectsCode(
    () => probeRuntime('missing', {}, { http: { request() { probeSpawned += 1; } } }),
    'LOCAL_NODE_RUNTIME_UNKNOWN'
  );
  assert.equal(probeSpawned, 0);

  // A successful catalogue request drives resolveNode to its model refusal;
  // no completion POST/body is issued after the catalogue proves it absent.
  const modelCalls = [];
  await rejectsCode(
    () => resolveNode({ runtime: 'ollama', model: 'absent' }, {
      http: injectedHttp({ body: JSON.stringify({ data: [{ id: 'installed' }] }) }, modelCalls)
    }),
    'LOCAL_NODE_MODEL_NOT_INSTALLED'
  );
  assert.equal(modelCalls.filter(call => call.kind === 'end').length, 1);
  assert.equal(modelCalls.filter(call => call.kind === 'write').length, 0);

  const cases = [
    ['LOCAL_NODE_HTTP', { statusCode: 503, body: '{}' }],
    ['LOCAL_NODE_RESPONSE_INVALID', { body: 'not-json' }],
    ['LOCAL_NODE_RESPONSE_TOO_LARGE', { body: 'x'.repeat(1024 * 1024 + 1) }],
    ['LOCAL_NODE_TIMEOUT', { timeout: true }],
    ['LOCAL_NODE_UNREACHABLE', { requestError: 'ECONNRESET' }]
  ];
  for (const [code, step] of cases) {
    const calls = [];
    await rejectsCode(
      () => probeRuntime('ollama', {}, { http: injectedHttp(step, calls) }),
      code
    );
    assert.equal(calls.filter(call => call.kind === 'write').length, 0, `${code} probe must not write a body`);
    if (code === 'LOCAL_NODE_RESPONSE_TOO_LARGE') assert.equal(calls.some(call => call.kind === 'response-destroy'), true);
    if (code === 'LOCAL_NODE_TIMEOUT') assert.equal(calls.some(call => call.kind === 'request-destroy'), true);
  }
}

/* THE SELECTED NODE MUST BE A PROPERTY OF WHAT IS INSTALLED, NOT OF PULL ORDER.
 *
 * Measured against the Ollama on this machine 2026-09-04: GET /v1/models orders
 * its catalogue by install time, so the three models below arrive newest-first
 * and arrive in the opposite order the moment a spare is re-pulled. The second
 * of them advertises `completion` only -- no tool calling -- so a first-match
 * preference can silently hand the fleet a local node that cannot call a tool.
 * Both orders must therefore resolve to the same, strongest model. */
function strengthRankedPreference() {
  const installed = Object.freeze([
    'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M',
    'hf.co/John1604/Qwen3-Coder-30B-A3B-Instruct-gguf:q3_k_s',
    'qwen3.5:9b'
  ]);
  const strongest = 'hf.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-gguf:Q3_K_M';
  assert.equal(preferredModel(installed), strongest);
  assert.equal(preferredModel([...installed].reverse()), strongest,
    'catalogue order must not change which local model the node dispatches to');

  // The ladder read off the id: instruction-tuned, then parameter count, then
  // quantization fidelity -- "the strongest, highest-quantized model that fits".
  assert.equal(
    preferredModel(['qwen2.5:7b-instruct', 'qwen3-coder:30b-a3b-instruct']),
    'qwen3-coder:30b-a3b-instruct',
    'more parameters must win among instruction-tuned models'
  );
  assert.equal(
    preferredModel(['qwen2.5:7b-instruct-q8_0', 'qwen2.5:7b-instruct-q2_K']),
    'qwen2.5:7b-instruct-q8_0',
    'the higher quantization must win at equal parameter count'
  );
  assert.equal(
    preferredModel(['hf.co/x/Model-Instruct:Q3_K_S', 'hf.co/x/Model-Instruct:Q3_K_M']),
    'hf.co/x/Model-Instruct:Q3_K_M',
    'K-medium must outrank K-small inside the same bit width'
  );
  // A tag-less id is the runtime's own default build (4-bit K-medium), so it
  // must not be ranked below an explicitly 2-bit build of the same weights.
  assert.equal(
    preferredModel(['qwen2.5:7b-instruct-q2_K', 'qwen2.5:7b-instruct']),
    'qwen2.5:7b-instruct',
    'an untagged default build outranks an explicitly smaller quantization'
  );

  // Behaviour that was already promised and must survive the ranking.
  assert.equal(preferredModel(['embed-small', 'qwen-chat', 'plain']), 'qwen-chat');
  assert.equal(preferredModel(['nomic-embed-text:latest']), 'nomic-embed-text:latest');
  assert.equal(preferredModel([]), null);
}

async function main() {
  const previousStateRoot = process.env.TOOLSENABLED_STATE_ROOT;
  const testStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-local-runtime-'));
  process.env.TOOLSENABLED_STATE_ROOT = testStateRoot;
  try {
    await refusalCoverage();
    await versionCoverage();
    strengthRankedPreference();
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'embed-small' }, { id: 'qwen-chat' }] }));
        return;
      }
      if (request.url === '/api/ps') {
        response.end(JSON.stringify({ models: [{ name: 'qwen-chat', size: 100, size_vram: 100, context_length: 8192 }] }));
        return;
      }
      response.end(JSON.stringify({
        message: { content: 'local answer' }, done: true, done_reason: 'stop',
        prompt_eval_count: 7, eval_count: 2
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = server.address().port;

    assert.deepEqual(authorization(), {
      accept: 'application/json',
      'content-type': 'application/json'
    });
    assert.equal(authorization('  local-secret  ').authorization, 'Bearer local-secret');
    assert.equal(preferredModel(['embed-small', 'qwen-chat', 'plain']), 'qwen-chat');

    assert.throws(
      () => assertModelFits('qwen2.5:7b-instruct', { freeVramBytes: 4 * 1024 ** 3 }),
      error => error.code === 'LOCAL_NODE_MODEL_WILL_NOT_FIT'
        && error.message.includes('qwen2.5:7b-instruct')
        && error.message.includes('4.0 GiB')
    );
    assert.throws(
      () => assertModelFits('qwen2.5:3b-instruct', { freeVramBytes: null }),
      error => error.code === 'LOCAL_NODE_CAPACITY_UNKNOWN' && error.message.includes('qwen2.5:3b-instruct')
    );

    const probe = await probeRuntime('ollama', { port, apiKey: '  local-secret  ' });
    assert.equal(probe.listening, true);
    assert.deepEqual(probe.models, ['embed-small', 'qwen-chat']);

    const node = await resolveNode({ runtime: 'ollama', model: 'qwen-chat', port }, {
      probeResources: () => ({ freeVramBytes: 8 * 1024 ** 3 })
    });
    assert.deepEqual(
      { runtime: node.runtime, model: node.model, host: node.host, port: node.port, chatPath: node.chatPath },
      { runtime: 'ollama', model: 'qwen-chat', host: '127.0.0.1', port, chatPath: '/api/chat' }
    );

    const result = await complete({
      prompt: 'Answer locally',
      system: 'Be concise',
      model: node.model,
      runtime: node.runtime,
      host: node.host,
      port: node.port,
      maxOutputTokens: 32,
      apiKey: '  local-secret  '
    });
    assert.deepEqual(result, {
      text: 'local answer',
      runtime: 'ollama',
      model: 'qwen-chat',
      costUsd: 0,
      promptTokens: 7,
      completionTokens: 2,
      finishReason: 'stop',
      contentTrust: 'untrusted',
      grantsAuthority: false
    });

    const completionRequest = requests.find(request => request.url === '/api/chat');
    assert.deepEqual(completionRequest, {
      method: 'POST',
      url: '/api/chat',
      authorization: 'Bearer local-secret',
      body: {
        model: 'qwen-chat',
        messages: [
          { role: 'system', content: 'Be concise' },
          { role: 'user', content: 'Answer locally' }
        ],
        options: { num_ctx: 8192, num_gpu: 999, num_predict: 32 },
        think: false,
        keep_alive: '10m',
        stream: false
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

    console.log('local-node-runtime behaviour: ok');
  } finally {
    if (previousStateRoot === undefined) delete process.env.TOOLSENABLED_STATE_ROOT;
    else process.env.TOOLSENABLED_STATE_ROOT = previousStateRoot;
    fs.rmSync(testStateRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
