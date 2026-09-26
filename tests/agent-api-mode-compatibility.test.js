'use strict';

const { activate } = require('./lib/isolated-environment');
const isolated = activate('api-mode-compatibility');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
process.env.TOOLSENABLED_SETTINGS_PATH = path.join(isolated.root, 'settings.json');
const settings = require('../src/lib/settings');
const api = require('../src/lib/agent-api-policy');
const modes = require('../src/lib/agent-api-mode');
const compat = require('../src/lib/tool-mode');
const cli = require('../tools/settings-set');
const file = process.env.TOOLSENABLED_SETTINGS_PATH;
const ID = modes.AGENT_API_SETTING_ID, ALIAS = modes.TOOL_MODE_SETTING_ID;
function store(values, provenance = {}) {
  fs.writeFileSync(file, JSON.stringify({ revision: 7, values, provenance: {
    ...Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: 12, directive: null }])),
    ...provenance
  } }));
}
function expectMode(expected) {
  const before = fs.readFileSync(file, 'utf8');
  const resolved = settings.loadSettings();
  assert.equal(resolved.values[ID], expected);
  assert.equal(resolved.values[ALIAS], modes.TOOL_MODES[expected]);
  assert.equal(api.agentApiMode(), expected);
  assert.equal(compat.modeFromSettings(resolved), modes.TOOL_MODES[expected]);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'reads preserve the original document');
  return resolved;
}

for (const canonical of modes.AGENT_API_MODES) {
  test(`stored canonical ${canonical} wins every stale alias and retains its provenance`, () => {
    for (const alias of [...Object.values(modes.TOOL_MODES), 'obsolete', null]) {
      store({ [ID]: canonical, [ALIAS]: alias }, {
        [ID]: { source: 'installer', atMs: 7, directive: 'fixture' },
        [ALIAS]: { source: 'untrusted', atMs: 99 }
      });
      const result = expectMode(canonical);
      assert.deepEqual(result.provenance[ID], { source: 'installer', atMs: 7, directive: 'fixture' });
    }
    for (const alias of Object.values(modes.TOOL_MODES)) {
      store({ [ID]: canonical, [ALIAS]: alias });
      expectMode(canonical);
    }
  });
}

test('alias-only and the three legacy pairs migrate before false loses its raw origin', () => {
  for (const canonical of modes.AGENT_API_MODES) {
    store({ [ALIAS]: modes.TOOL_MODES[canonical] });
    assert.equal(expectMode(canonical).provenance[ID].migratedFrom, ALIAS);
    store({ [ID]: canonical === 'Only', [ALIAS]: modes.TOOL_MODES[canonical] });
    expectMode(canonical);
  }
  store({ [ID]: false, [ALIAS]: modes.TOOL_MODES.Disabled }); expectMode('Disabled');
  store({ [ID]: 'Enabled', [ALIAS]: modes.TOOL_MODES.Disabled }); expectMode('Enabled');
  for (const [raw, expected] of [[true, 'Only'], [false, 'Enabled']]) {
    store({ [ID]: raw }); expectMode(expected);
  }
  store({}); expectMode('Only');
});

test('contradictory or rejected controlling values and unreadable documents refuse launch', () => {
  const cases = [
    [{ [ID]: true, [ALIAS]: modes.TOOL_MODES.Enabled }],
    [{ [ID]: true, [ALIAS]: modes.TOOL_MODES.Disabled }],
    [{ [ID]: false, [ALIAS]: modes.TOOL_MODES.Only }],
    [{ [ID]: 'invalid', [ALIAS]: modes.TOOL_MODES.Enabled }],
    [{ [ID]: null, [ALIAS]: modes.TOOL_MODES.Only }],
    [{ [ALIAS]: 'invalid' }],
    [{ [ALIAS]: modes.TOOL_MODES.Disabled }, { [ALIAS]: null }],
    [{ [ID]: 'Only', [ALIAS]: modes.TOOL_MODES.Enabled }, { [ID]: { source: 'agent' } }],
  ];
  for (const [values, provenance] of cases) {
    store(values, provenance);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => api.agentApiMode(), { code: 'AGENT_API_MODE_UNAVAILABLE' });
    assert.throws(() => compat.modeFromSettings(settings.loadSettings()), { code: 'AGENT_API_MODE_UNAVAILABLE' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  for (const raw of ['{invalid', 'null', JSON.stringify({ revision: 1, values: [] })]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => api.agentApiMode(), { code: 'AGENT_API_MODE_UNAVAILABLE' });
  }
  fs.unlinkSync(file);
  assert.equal(api.agentApiMode(), 'Only');
});

test('human and installer CLI writes use canonical atomic mirrors and preserve the channel gate', () => {
  let output = '';
  const streams = { stdin: { isTTY: false }, stdout: { isTTY: false, write: s => { output += s; } },
    stderr: { write: s => { output += s; } } };
  store({ 'agent.tool_summary': true });
  const env = { ...process.env, TOOLSENABLED_INSTALLER: '1' };
  for (const [id, raw, expected] of [
    ...modes.AGENT_API_MODES.map(mode => [ID, mode, mode]),
    ...modes.AGENT_API_MODES.map(mode => [ALIAS, modes.TOOL_MODES[mode], mode]),
    [ID, 'false', 'Enabled'], [ID, 'true', 'Only']
  ]) {
    const previous = JSON.parse(fs.readFileSync(file));
    assert.equal(cli.main([id, raw, '--source', 'installer'], env, streams), 0, output);
    const saved = JSON.parse(fs.readFileSync(file));
    assert.equal(saved.revision, previous.revision + 1);
    assert.equal(saved.values[ID], expected);
    assert.equal(saved.values[ALIAS], modes.TOOL_MODES[expected]);
    assert.deepEqual(saved.provenance[ID], saved.provenance[ALIAS]);
    assert.equal(saved.values['agent.tool_summary'], true);
    expectMode(expected);
  }
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => cli.main([ID, 'Disabled'], env, streams), /changed by a person/);
  assert.throws(() => cli.main([ALIAS, modes.TOOL_MODES.Disabled, '--source', 'installer'], {}, streams), /requires/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  output = '';
  assert.equal(cli.main(['--list'], env, streams), 0);
  assert.ok(output.includes(ID));
  assert.ok(!output.includes(ALIAS), 'the compatibility name does not create a second listed row');
});

test('bound representations must agree and an explicit binding outranks ambient settings', () => {
  store({ [ID]: 'Enabled' });
  assert.throws(() => compat.assertToolsEnabled({ agentApiMode: 'Disabled', toolMode: modes.TOOL_MODES.Disabled }), { code: 'TOOL_API_DISABLED' });
  for (const context of [{ agentApiMode: 'Only', toolMode: modes.TOOL_MODES.Enabled },
    { agentApiMode: null }, { toolMode: null }, { toolMode: 'unknown' }, { agentApiMode: 'unknown' }]) {
    assert.throws(() => compat.executionToolMode(context), { code: 'AGENT_TOOL_MODE_INVALID' });
  }
  store({ [ID]: 'Disabled' });
  assert.equal(compat.executionToolMode({ agentApiMode: 'Enabled' }), modes.TOOL_MODES.Enabled);
});
