'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, assessStatusResponse, parseArgs, run } = require('../tools/code-intel-handshake');

const ROOT_STATUS = Object.freeze({
  tool: 'code.status',
  workspaceRoot: ROOT,
  rootError: null,
  languages: [
    { language: 'typescript', available: true },
    { language: 'python', available: false }
  ],
  implementedMethods: ['goto_definition']
});

function envelope(structuredContent, isError = false) {
  return { result: { structuredContent, isError } };
}

(async () => {
  const ready = assessStatusResponse(envelope(ROOT_STATUS), ROOT);
  assert.deepEqual(ready, {
    ok: true,
    code: 'CODE_INTEL_READY',
    workspaceRoot: ROOT,
    languages: ['typescript'],
    implementedMethods: ['goto_definition']
  });

  assert.equal(assessStatusResponse(envelope({ ...ROOT_STATUS, rootError: 'missing' }), ROOT).code,
    'CODE_INTEL_ROOT_INVALID');
  assert.equal(assessStatusResponse(envelope({ ...ROOT_STATUS, workspaceRoot: path.dirname(ROOT) }), ROOT).code,
    'CODE_INTEL_ROOT_UNCONFIRMED');
  assert.equal(assessStatusResponse(envelope({ ...ROOT_STATUS, languages: [{ language: 'typescript', available: false }] }), ROOT).code,
    'CODE_INTEL_SERVER_UNAVAILABLE');
  assert.equal(assessStatusResponse({ result: { isError: true, structuredContent: { error: { code: 'TOOL_NOT_FOUND' } } } }, ROOT).code,
    'CODE_INTEL_TOOL_UNREACHABLE');
  assert.equal(assessStatusResponse(envelope({ tool: 'wrong' }), ROOT).code, 'CODE_INTEL_STATUS_INVALID');
  assert.equal(assessStatusResponse(envelope({ ...ROOT_STATUS, implementedMethods: null }), ROOT).code,
    'CODE_INTEL_STATUS_INVALID');
  assert.equal(assessStatusResponse(envelope({ ...ROOT_STATUS, languages: [
    { language: 'typescript', available: true },
    { language: 'python' }
  ] }), ROOT).code, 'CODE_INTEL_STATUS_INVALID');

  assert.deepEqual(parseArgs([]), { root: ROOT });
  assert.equal(parseArgs(['--root', '.']).root, path.resolve('.'));
  assert.throws(() => parseArgs(['--root']), /CODE_INTEL_HANDSHAKE_USAGE/);

  const invokes = [];
  const runReady = await run(['--root', ROOT], async request => {
    invokes.push(request);
    return envelope(ROOT_STATUS);
  });
  assert.equal(runReady.code, 'CODE_INTEL_READY');
  assert.deepEqual(invokes, [{ tool: 'code.status', arguments: { root: ROOT } }]);

  const unavailable = await run([], async () => { throw new Error('transport down'); });
  assert.equal(unavailable.code, 'CODE_INTEL_MCP_UNREACHABLE');
  assert.equal((await run(['unexpected'])).code, 'CODE_INTEL_HANDSHAKE_USAGE');

  console.log('Code-intel handshake tests passed: 13 assertions.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
