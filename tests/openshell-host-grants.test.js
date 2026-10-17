'use strict';

// The grants of the ToolsEnabled host outside the OpenShell sandboxes
// (src/lib/openshell-host-grants.js) and the list of tools it serves
// (src/lib/openshell-host-tools.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const grants = require('../src/lib/openshell-host-grants');
const { OPENSHELL_HOST_TOOLS, withoutHostTools } = require('../src/lib/openshell-host-tools');
const { OPENSHELL_TOOLS } = require('../src/lib/openshell-surface');

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-host-grants-'));
}

test('the host serves only tools the sandbox list already has, and never the person\'s own decisions', () => {
  for (const name of OPENSHELL_HOST_TOOLS) assert.ok(OPENSHELL_TOOLS.includes(name), `${name} is not an OpenShell tool`);
  for (const personOnly of ['a_ledger.answer', 'a_ledger.decline', 't_ledger.remove', 'settings.set', 'settings.write', 'p_ledger.decide']) {
    assert.equal(OPENSHELL_HOST_TOOLS.includes(personOnly), false, `${personOnly} must stay a command on the host`);
  }
  assert.ok(Object.isFrozen(OPENSHELL_HOST_TOOLS));
  assert.deepEqual(withoutHostTools(['task.list', 'settings.read', 'host.read_file', 'audit.verify']), ['task.list', 'host.read_file']);
});

test('a new grant returns its token once and stores only the token\'s hash, owner-only', () => {
  const root = freshRoot();
  const { grant, token } = grants.createGrant(root, { id: 'claude-dev', actor: 'claude', tools: 'settings.read,a_ledger.file' });
  assert.match(token, /^te-host-[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(grant.tools, ['settings.read', 'a_ledger.file']);
  assert.equal(grant.tokenSha256, grants.tokenHash(token));
  const file = grants.grantsPath(root);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.includes(token), false, 'the grants file must never hold the token');
  assert.equal(text.includes(token.slice(8, 30)), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(grants.readGrants(root).map((item) => item.id), ['claude-dev']);
});

test('a token finds its own grant and nothing else does', () => {
  const root = freshRoot();
  const claude = grants.createGrant(root, { id: 'claude-dev', actor: 'claude', tools: ['settings.read'] });
  const codex = grants.createGrant(root, { id: 'codex-dev', actor: 'codex', tools: ['ledger.read', 't_ledger.file'] });
  const list = grants.readGrants(root);
  assert.equal(grants.grantForToken(list, claude.token).id, 'claude-dev');
  assert.equal(grants.grantForToken(list, codex.token).actor, 'codex');
  assert.equal(grants.grantForToken(list, `te-host-${'A'.repeat(43)}`), null);
  assert.equal(grants.grantForToken(list, 'openshell:resolve:env:TE_HOST_CLAUDE'), null);
  assert.equal(grants.grantForToken(list, `${claude.token}x`), null);
  assert.equal(grants.grantForToken(list, undefined), null);
});

test('grant ids, actors and tools are checked, and ids are unique', () => {
  const root = freshRoot();
  const refused = (fields, code) => assert.throws(() => grants.createGrant(root, fields), { code });
  refused({ id: 'Claude', actor: 'claude', tools: 'settings.read' }, 'HOST_GRANT_ID_INVALID');
  refused({ id: '../x', actor: 'claude', tools: 'settings.read' }, 'HOST_GRANT_ID_INVALID');
  refused({ id: 'a'.repeat(33), actor: 'claude', tools: 'settings.read' }, 'HOST_GRANT_ID_INVALID');
  refused({ id: 'w1', actor: 'coordinator', tools: 'settings.read' }, 'HOST_GRANT_ACTOR_INVALID');
  refused({ id: 'w1', actor: 'claude', tools: '' }, 'HOST_GRANT_TOOLS_EMPTY');
  refused({ id: 'w1', actor: 'claude', tools: 'settings.read,host.exec' }, 'HOST_GRANT_TOOL_UNKNOWN');
  refused({ id: 'w1', actor: 'claude', tools: 'a_ledger.answer' }, 'HOST_GRANT_TOOL_UNKNOWN');
  refused({ id: 'w1', actor: 'claude', tools: 'settings.read,settings.read' }, 'HOST_GRANT_TOOLS_REPEATED');
  grants.createGrant(root, { id: 'w1', actor: 'claude', tools: 'settings.read' });
  refused({ id: 'w1', actor: 'codex', tools: 'settings.read' }, 'HOST_GRANT_EXISTS');
});

test('removing a grant stops its token from finding it', () => {
  const root = freshRoot();
  const { token } = grants.createGrant(root, { id: 'w1', actor: 'codex', tools: 'ledger.read' });
  assert.equal(grants.removeGrant(root, 'w1'), 'w1');
  assert.equal(grants.grantForToken(grants.readGrants(root), token), null);
  assert.throws(() => grants.removeGrant(root, 'w1'), { code: 'HOST_GRANT_UNKNOWN' });
});

test('a missing grants file means no grants; a damaged one serves nothing', () => {
  const root = freshRoot();
  assert.deepEqual(grants.readGrants(root), []);
  const file = grants.grantsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const damaged of [
    'not json',
    JSON.stringify({ format: 'other', grants: [] }),
    JSON.stringify({ format: grants.FORMAT, grants: [{ id: 'w1', actor: 'claude', tools: ['settings.read'], tokenSha256: 'x', createdAt: 'now' }] }),
    JSON.stringify({ format: grants.FORMAT, grants: [{ id: 'w1', actor: 'claude', tools: ['host.exec'], tokenSha256: 'a'.repeat(64), createdAt: 'now' }] }),
    JSON.stringify({ format: grants.FORMAT, grants: [{ id: 'w1', actor: 'claude', tools: 'settings.read', tokenSha256: 'a'.repeat(64), createdAt: 'now' }] }),
    JSON.stringify({ format: grants.FORMAT, grants: [{ id: 'w1', actor: 'claude', tools: ['settings.read'], tokenSha256: 'a'.repeat(64), createdAt: 'now', token: 'te-host-x' }] }),
    JSON.stringify({ format: grants.FORMAT, grants: [
      { id: 'w1', actor: 'claude', tools: ['settings.read'], tokenSha256: 'a'.repeat(64), createdAt: 'now' },
      { id: 'w1', actor: 'codex', tools: ['settings.read'], tokenSha256: 'b'.repeat(64), createdAt: 'now' }
    ] })
  ]) {
    fs.writeFileSync(file, damaged);
    assert.throws(() => grants.readGrants(root), { code: 'HOST_GRANTS_INVALID' }, damaged);
  }
  assert.throws(() => grants.grantsPath('relative/root'), { code: 'HOST_ROOT_INVALID' });
});

test('each described agent, including a personal descriptor, gets its own grant and token', () => {
  const root = freshRoot();
  const old = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = root;
  try {
    const registry = require('../src/lib/agents/registry');
    const personal = JSON.parse(fs.readFileSync(path.join(registry.BUNDLED_DIR, 'gemini.json'), 'utf8'));
    personal.id = 'personal-agent'; personal.name = 'Personal agent'; personal.command = 'personal-agent';
    personal.models.choices = { 'personal-default': { tier: 'standard', model: 'personal-default', cliModel: '' } }; personal.models.defaults = {};
    fs.mkdirSync(path.join(root, 'agents'));
    fs.writeFileSync(path.join(root, 'agents', 'personal-agent.json'), JSON.stringify(personal));
    const ids = registry.activeRegistry().ids;
    assert.ok(ids.includes('personal-agent'));
    const issued = ids.map((actor, index) => grants.createGrant(root, { id: `agent-${index}`, actor, tools: 'ledger.read' }));
    const read = grants.readGrants(root);
    assert.deepEqual(read.map(grant => grant.actor), ids);
    for (const { grant, token } of issued) assert.deepEqual(grants.grantForToken(read, token), grant);
    assert.equal(new Set(issued.map(value => value.token)).size, ids.length);
    assert.throws(() => grants.createGrant(root, { id: 'unknown', actor: 'missing-descriptor', tools: 'ledger.read' }), { code: 'HOST_GRANT_ACTOR_INVALID' });
  } finally { if (old === undefined) delete process.env.TOOLSENABLED_STATE_ROOT; else process.env.TOOLSENABLED_STATE_ROOT = old; }
});
