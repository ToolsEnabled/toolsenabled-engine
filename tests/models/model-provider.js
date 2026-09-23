// EXECUTABLE CHANGE
// testcanfail-tests-models-model-provider-js
//
// Mutation report:
// - SAME-CODE EXPECTED VALUE: QUICK_EDIT_TIMEOUT_MS was mutated from 45000 to
//   45001. The former comparison to model.QUICK_EDIT_TIMEOUT_MS stayed green;
//   the independent expectation below went RED with
//   "AssertionError: Expected values to be strictly equal: 45001 !== 45000".
// - SAME-CODE EXPECTED VALUE: QUICK_EDIT_MAX_OUTPUT_TOKENS was mutated from
//   2048 to 2047. The former comparison to the exported product constant stayed
//   green; the independent expectation below went RED with
//   "AssertionError: Expected values to be strictly equal: 2047 !== 2048".
// - SAME-CODE EXPECTED VALUE: QUICK_EDIT_SCHEMA.summary.maxLength was mutated
//   from 2000 to 1999. The former comparison to model.QUICK_EDIT_SCHEMA stayed
//   green; the independent schema expectation below went RED with
//   "AssertionError: Expected values to be strictly deep-equal" and the diff
//   "-     maxLength: 2000" / "+     maxLength: 1999".
// - NOT-FOUND: an assertion loop over a collection that can be empty. Both
//   loops use non-empty literals owned by this test.
// - NOT-FOUND: exit-status or truthy-return-only evidence.
// - NOT-FOUND: try/catch or optional chaining that swallows the tested failure.
// - NOT-FOUND: an assertion against a mock of the behavior under test.
// - NOT-FOUND: a skip or platform precondition guard.
// - PRECONDITION: system Node 20 lacks node:sqlite; mutation runs used the
//   installed /root/.nvm/versions/node/v22.22.2/bin/node runtime.
// - RESTORE: src/lib/providers/model.js was restored byte-for-byte (SHA-256
//   6d314845f3ab8d2c589f8bbdb9bd9a00c0c32c716d16f06395af51c51ee176ad),
//   then the test was green: "Model provider tests passed.".
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const model = require('../../src/lib/providers/model');
const { GiB } = require('../../src/lib/model-picker');

assert.equal(model.OLLAMA_PORT, 11434);

// Machine topology is a USER SETTING (src/lib/machine-profile.js), never a
// hardcoded address baked into this provider. Exercise all three
// distinguishable outcomes of resolveGpuPeerHost: no profile configured (the
// default, single-machine case every customer starts from), a profile that
// configures a real peer, and a profile the loader itself could not check.
{
  const noPeerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-provider-no-peer-'));
  try {
    assert.throws(
      () => model.resolveGpuPeerHost({ repoRoot: noPeerRoot }),
      error => error && error.code === 'MODEL_NO_GPU_PEER_CONFIGURED',
      'A fresh single-machine install with no machine profile must degrade honestly, not guess an address.'
    );
  } finally {
    fs.rmSync(noPeerRoot, { recursive: true, force: true });
  }
}

{
  const peerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-provider-peer-'));
  try {
    fs.mkdirSync(path.join(peerRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(peerRoot, 'config', 'machines.profile.json'), JSON.stringify({
      schemaVersion: 1, mode: 'multi', transport: 'direct',
      thisMachine: { id: 'this-one', label: 'This one' },
      peers: [{ id: 'gpu-box', label: 'GPU box', address: '203.0.113.5' }]
    }), 'utf8');
    assert.equal(model.resolveGpuPeerHost({ repoRoot: peerRoot }), '203.0.113.5',
      'A configured peer address must be used exactly as the user set it, not translated or guessed.');
  } finally {
    fs.rmSync(peerRoot, { recursive: true, force: true });
  }
}

{
  assert.throws(
    () => model.resolveGpuPeerHost({ loadMachineProfile: () => { throw new Error('profile read exploded'); } }),
    error => error && error.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED',
    'A broken profile check must be reported as a broken check, never silently reported as "nothing configured".'
  );
}

// COULD-NOT-LOOK, THE WAY THE SHIPPED LOADER ACTUALLY DELIVERS IT.
// src/lib/machine-profile.js loadMachineProfile() never throws for a bad file:
// an unreadable or malformed config/machines.profile.json comes back as a
// usable single-machine profile tagged source:'unreadable'/'malformed', and it
// is hasPeers() that refuses to answer for those and for a profile whose every
// declared peer was rejected. Those three shapes -- not an exploding loader --
// are how "the check could not be made" reaches this function in production, so
// they are what must carry MODEL_MACHINE_PROFILE_CHECK_FAILED.
{
  const indeterminate = [
    ['unreadable', { source: 'unreadable', peers: [], rejected: [] }],
    ['malformed', { source: 'malformed', peers: [], rejected: [] }],
    ['every declared peer rejected', {
      source: 'profile', peers: [], rejected: [{ id: 'gpu-box', address: 'not-an-address' }]
    }]
  ];
  for (const [label, profile] of indeterminate) {
    assert.throws(
      () => model.resolveGpuPeerHost({ loadMachineProfile: () => profile }),
      error => error && error.code === 'MODEL_MACHINE_PROFILE_CHECK_FAILED'
        && error.details.profileSource === profile.source,
      `A ${label} machine profile must report that the check could not be made, never "no peer is configured" and never a down service.`
    );
  }
}

{
  const peers = [
    { id: 'gpu-box-a', label: 'GPU box A', address: '203.0.113.5' },
    { id: 'gpu-box-b', label: 'GPU box B', address: '203.0.113.6' }
  ];
  for (const declared of [peers, peers.slice().reverse()]) {
    assert.throws(
      () => model.resolveGpuPeerHost({
        loadMachineProfile: () => ({ source: 'profile', peers: declared, rejected: [] })
      }),
      error => error && error.code === 'MODEL_GPU_PEER_AMBIGUOUS'
        && error.details.reason === 'gpu_peer_ambiguous'
        && error.details.peerIds.join(',') === 'gpu-box-a,gpu-box-b',
      'Multiple peers without a supported explicit GPU selector must refuse independently of declaration order.'
    );
  }
}

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: { label: { type: 'string' } },
  required: ['label'],
  additionalProperties: false
});

function resourceProbe(overrides = {}) {
  return {
    ollamaReachable: true,
    installedModels: ['qwen3.5:4b'],
    residentModels: [],
    freeRamBytes: 32 * GiB,
    freeVramBytes: 6 * GiB,
    onBattery: false,
    ...overrides
  };
}

function completion(content, promptTokens, evalTokens, durationMs) {
  return {
    message: { role: 'assistant', content }, prompt_eval_count: promptTokens,
    eval_count: evalTokens, total_duration: durationMs * 1_000_000
  };
}

function fixture(overrides = {}) {
  const calls = { chats: [], ledger: [], audit: [] };
  const dependencies = {
    probe: async () => resourceProbe(),
    chat: async request => {
      calls.chats.push(request);
      return completion('plain local output', 4, 3, 12);
    },
    state: {
      recordModelUsage(value) { calls.ledger.push(value); return value; }
    },
    auditRequire: (...args) => { calls.audit.push({ kind: 'require', args }); return { durable: true, anchored: true }; },
    auditRecord: (...args) => { calls.audit.push({ kind: 'record', args }); return { durable: true }; },
    ...overrides
  };
  return { calls, dependencies };
}

(async () => {
  {
    const test = fixture({
      chat: async request => {
        test.calls.chats.push(request);
        return completion(JSON.stringify({ label: 'classified' }), 12, 5, 24);
      }
    });
    const marker = `prompt-must-not-enter-audit-${process.pid}`;
    const result = await model.complete({ prompt: marker, schema: OUTPUT_SCHEMA, maxOutputTokens: 44 }, test.dependencies);
    assert.deepEqual(result, {
      output: { label: 'classified' }, modelUsed: 'qwen3.5:4b', tier: 'workhorse',
      promptTokens: 12, evalTokens: 5, durationMs: 24,
      contentTrust: 'untrusted', grantsAuthority: false
    });
    assert.equal(test.calls.chats.length, 1);
    assert.equal(test.calls.chats[0].stream, false);
    assert.equal(test.calls.chats[0].model, 'qwen3.5:4b');
    assert.equal(test.calls.chats[0].format, OUTPUT_SCHEMA);
    assert.equal(test.calls.chats[0].options.num_predict, 44);
    assert.equal(test.calls.chats[0].options.temperature, 0);
    assert.equal(test.calls.chats[0].think, false, 'Qwen3.5 structured calls must reserve tokens for the final JSON, not hidden reasoning.');
    assert.equal(Object.hasOwn(test.calls.chats[0], 'tools'), false);
    assert.deepEqual(test.calls.ledger, [{ model: 'qwen3.5:4b', promptTokens: 12, evalTokens: 5 }]);
    assert.doesNotMatch(JSON.stringify(test.calls.audit), new RegExp(marker));
    assert.equal(test.calls.audit[0].args[0], 'model.complete.intent');
    assert.equal(test.calls.audit.at(-1).args[0], 'model.complete');
  }

  {
    const test = fixture({
      probe: async () => resourceProbe({
        installedModels: ['gpt-oss:20b'], residentModels: ['gpt-oss:20b'],
        freeRamBytes: 13 * GiB, freeVramBytes: 2.1 * GiB
      })
    });
    test.dependencies.keepAlive = '15m';
    const result = await model.complete({ prompt: 'bounded strong synthesis', allowSlowTier: true }, test.dependencies);
    assert.equal(result.modelUsed, 'gpt-oss:20b');
    assert.equal(test.calls.chats[0].think, 'low');
    assert.equal(test.calls.chats[0].keep_alive, '15m');
    assert.equal(test.calls.chats[0].options.num_ctx, 4096);
    assert.equal(test.calls.chats[0].options.num_gpu, 8);
    assert.equal(Object.hasOwn(test.calls.chats[0], 'tools'), false);
  }

  {
    const test = fixture({
      probe: async () => resourceProbe({
        installedModels: ['qwen3:8b'], residentModels: ['qwen3:8b']
      }),
      pickModel: () => ({ available: true, model: 'qwen3:8b', tier: 'workhorse' })
    });
    await model.complete({ prompt: 'bounded non-thinking synthesis' }, test.dependencies);
    assert.equal(test.calls.chats[0].think, false);
  }

  {
    const test = fixture({ chat: async request => {
      test.calls.chats.push(request);
      return completion('   ', 2, 8, 10);
    } });
    await assert.rejects(model.complete({ prompt: 'empty final output must fail' }, test.dependencies),
      error => error && error.code === 'MODEL_RESPONSE_INVALID');
    assert.equal(test.calls.ledger.length, 0);
    assert.equal(test.calls.audit.at(-1).args[2].code, 'MODEL_RESPONSE_INVALID');
  }

  {
    const responses = [
      completion('not JSON', 3, 2, 8),
      completion(JSON.stringify({ label: 'retry-succeeded' }), 4, 6, 10)
    ];
    const test = fixture({
      chat: async request => {
        test.calls.chats.push(request);
        return responses.shift();
      }
    });
    const result = await model.complete({ prompt: 'classify this', schema: OUTPUT_SCHEMA }, test.dependencies);
    assert.equal(test.calls.chats.length, 2, 'A schema failure gets exactly one fresh retry.');
    assert.equal(test.calls.chats[1].messages.length, 1, 'The retry carries no prior model output or conversation state.');
    assert.match(test.calls.chats[1].messages[0].content, /prior response did not validate/i);
    assert.deepEqual(test.calls.ledger, [
      { model: 'qwen3.5:4b', promptTokens: 3, evalTokens: 2 },
      { model: 'qwen3.5:4b', promptTokens: 4, evalTokens: 6 }
    ]);
    assert.equal(result.promptTokens, 7);
    assert.equal(result.evalTokens, 8);
    assert.equal(result.durationMs, 18);
  }

  {
    const test = fixture({
      chat: async request => {
        test.calls.chats.push(request);
        return completion('still invalid', 2, 1, 3);
      }
    });
    await assert.rejects(
      model.complete({ prompt: 'classify this', schema: OUTPUT_SCHEMA }, test.dependencies),
      error => error && error.code === 'MODEL_SCHEMA_INVALID'
    );
    assert.equal(test.calls.chats.length, 2);
    assert.equal(test.calls.ledger.length, 2, 'Invalid attempts still enter the aggregate token ledger.');
    assert.equal(test.calls.audit.at(-1).args[0], 'model.complete.schema_invalid');
  }

  {
    const test = fixture({ probe: async () => resourceProbe({ ollamaReachable: false }) });
    await assert.rejects(
      model.complete({ prompt: 'must not use a cloud fallback' }, test.dependencies),
      error => error && error.code === 'MODEL_UNAVAILABLE'
    );
    assert.equal(test.calls.chats.length, 0);
    assert.equal(test.calls.ledger.length, 0);
  }

  {
    await assert.rejects(
      model.complete({ prompt: 'invalid schema', schema: { oneOf: [{ type: 'string' }] } }, fixture().dependencies),
      error => error && error.code === 'MODEL_SCHEMA_UNSUPPORTED'
    );
  }

  {
    const test = fixture();
    const instruction = `rename-local-symbol-${process.pid}`;
    const source = `const oldName = '${process.pid}';`;
    let observedTimeout = null;
    const result = await model.quickEdit({ instruction, source, language: 'javascript' }, {
      probe: test.dependencies.probe,
      state: test.dependencies.state,
      auditRequire: test.dependencies.auditRequire,
      auditRecord: test.dependencies.auditRecord,
      requestJson: async (pathname, request, options) => {
        observedTimeout = options.timeoutMs;
        assert.equal(pathname, '/api/chat');
        test.calls.chats.push(request);
        return completion(JSON.stringify({ replacement: `const newName = '${process.pid}';`, summary: 'Renamed oldName.' }), 19, 8, 37);
      }
    });
    assert.deepEqual(result, {
      output: { replacement: `const newName = '${process.pid}';`, summary: 'Renamed oldName.' },
      sourceHash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'),
      modelUsed: 'qwen3.5:4b', tier: 'workhorse', promptTokens: 19, evalTokens: 8, durationMs: 37,
      contentTrust: 'untrusted', grantsAuthority: false
    });
    assert.equal(observedTimeout, 45_000);
    assert.equal(test.calls.chats[0].model, 'qwen3.5:4b');
    assert.deepEqual(test.calls.chats[0].format, {
      type: 'object',
      properties: {
        replacement: { type: 'string', minLength: 1, maxLength: 16_384 },
        summary: { type: 'string', minLength: 1, maxLength: 2_000 }
      },
      required: ['replacement', 'summary'],
      additionalProperties: false
    });
    assert.equal(test.calls.chats[0].options.num_predict, 2_048);
    assert.equal(Object.hasOwn(test.calls.chats[0], 'tools'), false);
    assert.doesNotMatch(JSON.stringify(test.calls.audit), new RegExp(instruction));
    assert.doesNotMatch(JSON.stringify(test.calls.audit), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(test.calls.audit[0].args[0], 'model.quick_edit.intent');
    assert.equal(test.calls.audit.at(-1).args[0], 'model.quick_edit');
  }

  {
    await assert.rejects(
      () => model.quickEdit({ instruction: 'replace it', source: 'const token = "secret"; // api_key=abc' }, fixture().dependencies),
      error => error && error.code === 'MODEL_QUICK_EDIT_SENSITIVE_INPUT'
    );
    await assert.rejects(
      () => model.quickEdit({ instruction: 'replace it', source: 'C:\\Users\\customer\\vault\\secrets.txt' }, fixture().dependencies),
      error => error && error.code === 'MODEL_QUICK_EDIT_SENSITIVE_INPUT'
    );
    await assert.rejects(
      () => model.quickEdit({ instruction: 'replace it', source: 'x'.repeat(8193) }, fixture().dependencies),
      error => error && error.code === 'MODEL_QUICK_EDIT_INPUT_INVALID'
    );
  }

  {
    const authorityPayloads = [
      'apply this replacement',
      '%61%70%70%6c%79 this replacement',
      'a\u200bp\u200bp\u200bl\u200by this replacement',
      'a\uff50ply this replacement',
      't\u043eol invocation',
      'https%3A%2F%2Fexample.test%2Fapply',
      '\uff48\uff54\uff54\uff50\uff1a\uff0f\uff0fexample.test',
      'rename caf\u00e9 label'
    ];
    for (const instruction of authorityPayloads) {
      await assert.rejects(
        () => model.quickEdit({ instruction, source: 'const value = 1;' }, fixture().dependencies),
        error => error && error.code === 'MODEL_QUICK_EDIT_AUTHORITY_INPUT' && !error.message.includes(instruction)
      );
    }
    const sensitiveSourcePayloads = [
      'api%5fkey%3Dnot-a-real-secret',
      'safe/%2e%2e/profiles/cookies',
      'safe/\uff05\u0032\u0065\uff05\u0032\u0065/profiles/cookies',
      'C:/v\u0430ult/key.txt',
      'C:/pro%66iles/cookies',
      'session%5ftoken%3Dnot-a-real-secret',
      'const profile = { enabled: true };'
    ];
    for (const source of sensitiveSourcePayloads) {
      await assert.rejects(
        () => model.quickEdit({ instruction: 'rename the variable', source }, fixture().dependencies),
        error => error && error.code === 'MODEL_QUICK_EDIT_SENSITIVE_INPUT' && !error.message.includes(source)
      );
    }
    assert.deepEqual(model.quickEditInput({
      instruction: 'rename the local variable', source: "const label = 'caf\u00e9';", language: 'javascript'
    }), {
      instruction: 'rename the local variable', source: "const label = 'caf\u00e9';", language: 'javascript'
    }, 'Non-ASCII source data without sensitive, path-like, or authority-bearing material remains usable.');
  }

  {
    const test = fixture();
    await assert.rejects(
      () => model.quickEdit({ instruction: 'rename the local variable', source: 'const oldName = 1;' }, {
        probe: test.dependencies.probe,
        state: test.dependencies.state,
        auditRequire: test.dependencies.auditRequire,
        auditRecord: test.dependencies.auditRecord,
        requestJson: async (pathname, request, options) => {
          assert.equal(pathname, '/api/chat');
          assert.equal(options.timeoutMs, 45_000);
          test.calls.chats.push(request);
          return completion('not valid JSON', 3, 2, 10);
        }
      }),
      error => error && error.code === 'MODEL_SCHEMA_INVALID'
    );
    assert.equal(test.calls.chats.length, 1, 'Quick edit has one schema attempt, keeping its 45-second timeout total.');
    assert.equal(test.calls.audit.at(-1).args[0], 'model.quick_edit.schema_invalid');
  }

  {
    const test = fixture({ probe: async () => resourceProbe({ freeVramBytes: 4 * GiB }) });
    await assert.rejects(
      () => model.quickEdit({ instruction: 'replace it', source: 'const a = 1;' }, test.dependencies),
      error => error && error.code === 'MODEL_UNAVAILABLE' && error.details.reason === 'no_eligible_fast_local_model'
    );
    assert.equal(test.calls.chats.length, 0, 'No quick-edit request can bypass the fast picker headroom refusal.');
  }

  {
    const observed = await model.probeLocalModel({
      requestJson: async pathname => pathname === '/api/tags'
        ? { models: [{ name: 'qwen3.5:4b' }] }
        : { models: [{ name: 'qwen3.5:4b' }] },
      probeResources: () => ({ freeRamBytes: 10, freeVramBytes: 20, onBattery: true })
    });
    assert.deepEqual(observed, {
      ollamaReachable: true, installedModels: ['qwen3.5:4b'], residentModels: ['qwen3.5:4b'],
      freeRamBytes: 10, freeVramBytes: 20, onBattery: true
    });
    await assert.rejects(
      model.probeLocalModel({ requestJson: async () => { throw new Error('stopped'); } }),
      error => error && error.code === 'MODEL_UNAVAILABLE'
    );
  }

  {
    // A configuration gap must survive probeLocalModel's catch-all rather
    // than being reported as "no local Ollama service is available", which
    // would misdescribe an absent setting as a live service that failed.
    const noPeer = new model.ModelCompletionError('MODEL_NO_GPU_PEER_CONFIGURED', 'no peer configured', {
      reason: 'no_gpu_peer_configured'
    });
    await assert.rejects(
      model.probeLocalModel({ requestJson: async () => { throw noPeer; } }),
      error => error === noPeer
    );

    const checkFailed = new model.ModelCompletionError('MODEL_MACHINE_PROFILE_CHECK_FAILED', 'check failed', {});
    await assert.rejects(
      model.probeLocalModel({ requestJson: async () => { throw checkFailed; } }),
      error => error === checkFailed
    );
  }

  {
    // The acceptance path: a customer with one computer and no peer
    // configured calls model.complete (the model_complete tool) and gets a
    // clear, immediate, honest refusal -- never a hang, never empty output,
    // never a guessed address.
    const noPeer = new model.ModelCompletionError('MODEL_NO_GPU_PEER_CONFIGURED', 'no GPU peer configured', {
      reason: 'no_gpu_peer_configured'
    });
    await assert.rejects(
      model.complete({ prompt: 'a customer with one computer' }, {
        probe: async () => { throw noPeer; },
        state: { recordModelUsage() {} },
        auditRequire: () => ({ durable: true }),
        auditRecord: () => ({ durable: true })
      }),
      error => error === noPeer
    );
  }

  console.log('Model provider tests passed.');
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
