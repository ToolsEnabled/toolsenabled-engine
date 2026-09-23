'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = process.env.T1018_SOURCE || path.join(__dirname, '../src/mcp-server.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function subject() {
  const redactions = [];
  const effects = [];
  const forbidden = label => () => { effects.push(label); throw new Error('Unexpected test boundary: ' + label); };
  const inertModule = Object.freeze({});
  const inertDependencies = new Set([
    './lib/error-taxonomy', './lib/mcp-tool-surface', './lib/file-tool-context',
    './lib/agent-tool-summary', './lib/schema-validator', './lib/tool-registry',
    './lib/throughput-mode', './lib/research-access', './lib/runtime-state-root'
  ]);
  const module = { exports: {} };
  function requireInVm(name) {
    if (name === '../package.json') return { name: 'inert-test', version: '0.0.0' };
    if (name === './lib/audit') return { redact(value) {
      assert.equal(typeof value, 'string', 'the public boundary passes a string to the existing redactor');
      redactions.push(value);
      return value.replaceAll('INERT_REDACT_MARKER', '[REDACTED]');
    } };
    if (name === 'node:path' || name === 'node:v8') return require(name);
    if (name === 'node:fs' || name === 'node:readline') return new Proxy({}, { get(_target, key) { return forbidden(name + '.' + String(key)); } });
    if (inertDependencies.has(name)) return inertModule;
    throw new Error('Unreviewed dependency in public-message test: ' + name);
  }
  requireInVm.main = null;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: requireInVm,
    __filename: sourcePath, __dirname: path.dirname(sourcePath),
    Buffer, process: { env: {}, argv: [], stdout: { write: forbidden('stdout') }, stderr: { write: forbidden('stderr') }, on: forbidden('process.on') },
    setInterval: forbidden('setInterval'), setTimeout: forbidden('setTimeout'),
    clearInterval: forbidden('clearInterval'), clearTimeout: forbidden('clearTimeout')
  }, { filename: sourcePath, timeout: 1000 });
  return { ...module.exports, redactions, effects };
}
function render(error) {
  const api = subject();
  let response;
  assert.doesNotThrow(() => { response = api.errorResponse('inert-request', error); });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 'inert-request');
  assert.equal(response.error.code, -32603);
  assert.equal(typeof response.error.message, 'string');
  assert.ok(response.error.message.length > 0 && response.error.message.length <= 2000);
  assert.equal(api.redactions.length, 1);
  assert.deepEqual(api.effects, []);
  return response.error.message;
}
for (const [name, value, marker] of [
  ['string', 'INERT_THROWN_MARKER', 'INERT_THROWN_MARKER'],
  ['number', 137, '137'],
  ['boolean', true, 'true'],
  ['bigint', 137n, '137'],
  ['symbol', Symbol('INERT_SYMBOL_MARKER'), 'INERT_SYMBOL_MARKER'],
  ['null', null, null],
  ['undefined', undefined, null]
]) test('JSON-RPC refusal contains a thrown ' + name, () => {
  const message = render(value);
  if (marker) assert.equal(message.includes(marker), false);
  else assert.notEqual(message, String(value));
});
test('raw Buffer is not rendered as public text', () => {
  assert.equal(render(Buffer.from('INERT_BUFFER_MARKER')).includes('INERT_BUFFER_MARKER'), false);
});
test('opaque thrown object is not coerced', () => {
  let calls = 0;
  render({ toString() { calls++; throw new Error('INERT_COERCION_MARKER'); } });
  assert.equal(calls, 0);
});
test('throwing diagnostic getter still produces a JSON-RPC refusal', () => {
  let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { reads++; throw new Error('INERT_GETTER_MARKER'); } });
  assert.equal(render(error).includes('INERT_GETTER_MARKER'), false);
  assert.ok(reads <= 1);
});
test('changing diagnostic getter is read once', () => {
  let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { return ++reads === 1 ? 'The operation could not complete.' : 'INERT_SECOND_READ'; } });
  assert.equal(render(error), 'The operation could not complete.');
  assert.equal(reads, 1);
});
test('opaque message is not coerced', () => {
  let calls = 0;
  const message = { toString() { calls++; return 'INERT_MESSAGE_MARKER'; } };
  assert.equal(render({ message }).includes('INERT_MESSAGE_MARKER'), false);
  assert.equal(calls, 0);
});
test('empty diagnostic remains a named refusal', () => { render({ message: '' }); });
test('ordinary Error message is retained', () => {
  assert.equal(render(new Error('The operation could not complete.')), 'The operation could not complete.');
});
test('existing audit redaction is applied before publication', () => {
  assert.equal(render(new Error('The operation INERT_REDACT_MARKER failed.')), 'The operation [REDACTED] failed.');
});
for (const suffix of [
  '\nAt INERT_SCRIPT_LOCATION\n+ internal command',
  '\nCategoryInfo : INERT_INTERNAL_CATEGORY',
  '\nFullyQualifiedErrorId : INERT_INTERNAL_IDENTIFIER'
]) test('PowerShell diagnostic suffix is removed: ' + suffix.split(':')[0].trim(), () => {
  assert.equal(render(new Error('The operation could not complete.' + suffix)), 'The operation could not complete.');
});
test('public message remains bounded at 2000 characters', () => {
  const input = 'Readable diagnostic. '.repeat(200);
  assert.equal(render(new Error(input)).length, 2000);
});
test('public messages retain safe multiline diagnostic content', () => {
  assert.equal(render(new Error('  First reason.\nSecond reason.  ')), 'First reason.\nSecond reason.');
});
test('formatter never reads captured streams', () => {
  let reads = 0;
  const error = new Error('The operation could not complete.');
  for (const key of ['stdout', 'stderr']) Object.defineProperty(error, key, { get() { reads++; throw new Error('INERT_STREAM_MARKER'); } });
  render(error);
  assert.equal(reads, 0);
});
test('ordinary typed RPC code, data and null request binding remain intact', () => {
  const api = subject();
  const error = new api.RpcError(-32602, 'The request is invalid.', { synthetic: true });
  const response = api.errorResponse(undefined, error);
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32602);
  assert.equal(response.error.message, 'The request is invalid.');
  assert.equal(response.error.data.synthetic, true);
  assert.deepEqual(api.effects, []);
});
