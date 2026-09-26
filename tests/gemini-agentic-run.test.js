#!/usr/bin/env node
'use strict';

// Contract tests for the executable wrapper itself. The provider is replaced
// in the child process so these cases drive the real argv, JSON reader,
// serialization, and process exit behavior without contacting Gemini.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'gemini-agentic-run.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-agentic-run-'));
const preload = path.join(temp, 'provider-stub.js');

fs.writeFileSync(preload, `'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
class GeminiAgenticError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
Module._load = function (request, parent, isMain) {
  if (request === '../src/lib/providers/gemini-agentic') {
    return {
      GeminiAgenticError,
      async runAgenticTask(input) {
        if (input.action === 'known-refusal') {
          throw new GeminiAgenticError(input.code, input.message, input.details);
        }
        if (input.action === 'unexpected-error') throw new Error(input.message);
        if (input.action === 'non-error') throw null;
        return { receipt: input.value };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

function run(args, input) {
  let argv = args;
  if (input !== undefined) {
    const inputFile = path.join(temp, `input-${run.sequence += 1}.json`);
    fs.writeFileSync(inputFile, typeof input === 'string' ? input : JSON.stringify(input));
    argv = ['--input', inputFile];
  }
  return spawnSync(process.execPath, ['--require', preload, TOOL, ...argv], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
}
run.sequence = 0;

function packet(result) {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout must be JSON: ${result.stdout}`);
  return JSON.parse(result.stdout);
}

try {
  const noInput = run([]);
  assert.equal(noInput.status, 2, 'missing --input must retain its named CLI-usage exit code');
  assert.equal(noInput.stdout, '');
  assert.match(noInput.stderr, /^Usage: node tools\/gemini-agentic-run\.js --input <path\/to\/input\.json>\n$/);

  for (const [label, args] of [
    ['missing file', ['--input', path.join(temp, 'does-not-exist.json')]],
    ['missing flag value', ['--input']]
  ]) {
    const result = run(args);
    if (label === 'missing flag value') {
      assert.equal(result.status, 2, `${label} must be a usage refusal`);
      assert.match(result.stderr, /^Usage:/);
    } else {
      assert.equal(result.status, 1, `${label} must use the failure exit code`);
      assert.deepEqual(packet(result), { ok: false, code: 'GEMINI_AGENTIC_RUN_INPUT_MISSING' });
    }
  }

  const nullInput = run([], null);
  assert.equal(nullInput.status, 1, 'a JSON null input must use the failure exit code');
  assert.deepEqual(packet(nullInput), { ok: false, code: 'GEMINI_AGENTIC_RUN_INPUT_MISSING' });

  const knownMessage = 'K'.repeat(2_050);
  const known = run([], {
    action: 'known-refusal', code: 'GEMINI_AGENTIC_TEST_REFUSAL',
    message: knownMessage, details: { reason: 'pinned refusal details' }
  });
  assert.equal(known.status, 1, 'a GeminiAgenticError refusal must use the failure exit code');
  assert.deepEqual(packet(known), {
    ok: false,
    code: 'GEMINI_AGENTIC_TEST_REFUSAL',
    message: knownMessage.slice(0, 2_000),
    details: { reason: 'pinned refusal details' }
  });

  const unexpected = run([], { action: 'unexpected-error', message: 'provider exploded' });
  assert.equal(unexpected.status, 1, 'an unexpected exception must use the failure exit code');
  assert.deepEqual(packet(unexpected), {
    ok: false, code: 'GEMINI_AGENTIC_RUN_UNEXPECTED_ERROR', message: 'provider exploded'
  });

  const nonError = run([], { action: 'non-error' });
  assert.equal(nonError.status, 1, 'a thrown non-Error value must use the failure exit code');
  assert.deepEqual(packet(nonError), {
    ok: false, code: 'GEMINI_AGENTIC_RUN_UNEXPECTED_ERROR', message: 'Unknown error.'
  });

  const success = run([], { action: 'success', value: 'fixture receipt' });
  assert.equal(success.status, 0, 'a provider result must preserve the default success exit code');
  assert.deepEqual(packet(success), { ok: true, receipt: 'fixture receipt' });

  process.stdout.write('gemini-agentic-run CLI refusal and exit-code tests passed\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
