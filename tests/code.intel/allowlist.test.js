'use strict';

// tests/allowlist.js was already absent when this package runner entered the
// engine history. Keep its registry-profile obligation executable against the
// current shipped registry, alongside the MCP and client-template contracts.
require('../lib/isolated-environment').activate('code-intel-allowlist');

const assert = require('node:assert/strict');
const test = require('node:test');
const registry = require('../../src/lib/tool-registry');
const { TOOL_ALLOWLIST_ENV, parseToolAllowlist } = registry;
const permissionSession = Object.freeze({ origin: 'local', tier: 'full' });
const CODE_TOOLS = [
  'code.status', 'code.goto_definition', 'code.find_references',
  'code.document_symbols', 'code.workspace_symbols', 'code.diagnostics', 'code.hover'
].sort();
const previous = process.env[TOOL_ALLOWLIST_ENV];
test.beforeEach(() => { delete process.env[TOOL_ALLOWLIST_ENV]; });
test.after(() => {
  if (previous === undefined) delete process.env[TOOL_ALLOWLIST_ENV];
  else process.env[TOOL_ALLOWLIST_ENV] = previous;
});
const names = options => registry.listTools(options).map(tool => tool.name).sort();

test('the current parser preserves full-profile absence and exact namespace/name selectors', () => {
  for (const empty of [undefined, null, '', '  ']) assert.equal(parseToolAllowlist(empty), null);
  const parsed = parseToolAllowlist(' code.* , system.status,code.* ');
  assert.deepEqual(parsed, ['code.*', 'system.status']);
  assert.equal(Object.isFrozen(parsed), true);
  assert.throws(() => parsed.push('system.*'), TypeError);
  assert.ok(names().includes('code.hover'), 'the shipped code tool must exist before testing filtering');
  assert.ok(names().includes('system.kill_switch_status'), 'the excluded control tool must exist');
});

test('malformed selectors refuse parsing, discovery, lookup and dispatch instead of widening the profile', async () => {
  for (const invalid of ['*', 'code*', 'code', 'Code.*', 'code.*.hover', 'code.*,', ',code.*', 'code.*,,system.status']) {
    assert.throws(() => parseToolAllowlist(invalid), { code: 'INVALID_TOOL_ALLOWLIST' });
    process.env[TOOL_ALLOWLIST_ENV] = invalid;
    assert.throws(() => names(), { code: 'INVALID_TOOL_ALLOWLIST' });
    assert.throws(() => registry.getTool('code.status'), { code: 'INVALID_TOOL_ALLOWLIST' });
    await assert.rejects(registry.executeTool('code.status', {}, { permissionSession }), { code: 'INVALID_TOOL_ALLOWLIST' });
  }
});

test('code.* exposes exactly the semantic code surface and hides other namespaces', () => {
  process.env[TOOL_ALLOWLIST_ENV] = 'code.*';
  assert.deepEqual(names(), CODE_TOOLS);
  for (const name of CODE_TOOLS) assert.equal(registry.getTool(name)?.name, name);
  assert.equal(registry.getTool('system.kill_switch_status'), null);
});

test('exact selectors are reread per call and a nonmatching namespace exposes no tools', () => {
  process.env[TOOL_ALLOWLIST_ENV] = 'code.status';
  assert.deepEqual(names(), ['code.status']);
  assert.equal(registry.getTool('code.hover'), null);
  process.env[TOOL_ALLOWLIST_ENV] = 'code.hover';
  assert.deepEqual(names(), ['code.hover']);
  assert.equal(registry.getTool('code.status'), null);
  process.env[TOOL_ALLOWLIST_ENV] = 'code_missing_namespace.*';
  assert.deepEqual(names(), []);
});

test('a filtered code tool is refused before its provider can run', async () => {
  const provider = require('../../src/lib/providers/code-intel');
  const original = provider.hover;
  assert.equal(typeof original, 'function', 'the real code.hover provider must exist');
  let calls = 0;
  provider.hover = () => { calls += 1; throw new Error('Filtered code.hover reached its provider'); };
  try {
    process.env[TOOL_ALLOWLIST_ENV] = 'code.status';
    await assert.rejects(registry.executeTool('code.hover', { file: __filename, line: 1, character: 1 }, { permissionSession }), error => {
      assert.equal(error.code, 'TOOL_NOT_ENABLED');
      assert.match(error.message, /code\.hover/);
      assert.ok(error.message.includes(TOOL_ALLOWLIST_ENV), 'the refusal must name the full-profile switch');
      return true;
    });
    assert.equal(calls, 0);
  } finally { provider.hover = original; }
});

test('request-bound exact profiles retain an empty ceiling and reject invalid names', async () => {
  process.env[TOOL_ALLOWLIST_ENV] = 'code.*';
  assert.deepEqual(names({ allowedToolNames: ['code.hover'] }), ['code.hover']);
  assert.deepEqual(names({ allowedToolNames: [] }), []);
  assert.equal(registry.getTool('code.status', { allowedToolNames: [] }), null);
  await assert.rejects(registry.executeTool('code.status', {}, { permissionSession, allowedToolNames: [] }), { code: 'TOOL_NOT_ENABLED' });
  for (const allowedToolNames of [null, ['code.*'], ['code.missing_tool'], ['code.status', 'code.status']]) {
    assert.throws(() => names({ allowedToolNames }), { code: 'INVALID_TOOL_ALLOWLIST' });
  }
});
