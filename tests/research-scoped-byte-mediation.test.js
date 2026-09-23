'use strict';

const isolation = require('./lib/isolated-environment').activate('research-scoped-byte-mediation');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const host = require('../src/lib/providers/host-control');
const contexts = require('../src/lib/file-tool-context');
const { validateResearchAccess } = require('../src/lib/research-access');

function fixture(t, access = 'read-only') {
  const root = fs.mkdtempSync(path.join(isolation.root, 'research-byte-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, 'safe.txt'), 'safe');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const scope = contexts.createFileToolContext({
    scopeKind: 'owner-host-session', agentId: 'researcher', sessionId: randomUUID(),
  });
  const invocations = [];
  t.after(async () => {
    for (const invocation of invocations) contexts.endFileToolInvocation(invocation);
    await contexts.retireFileToolContext(scope, 'research-test-finished');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const researchAccess = validateResearchAccess({ version: 1, mode: 'folder', root: allowed, access });
  const options = (toolName, overrides = {}) => {
    const invocation = contexts.beginFileToolInvocation(scope, {
      invocationId: 'invocation-' + randomUUID(), toolName,
    });
    invocations.push(invocation);
    return { researchAccess, fileToolContext: scope, fileToolInvocation: invocation,
      requireRecordAsync: async () => ({ durable: true }), ...overrides };
  };
  return { root, allowed, outside, scope, researchAccess, options };
}

function admissionGate() {
  let release, entered = false;
  const pending = new Promise(resolve => { release = resolve; });
  return { release, requireRecordAsync() { entered = true; return pending; },
    assertEntered() { assert.equal(entered, true, 'the real handler must reach audit admission'); } };
}
const refused = { code: 'RESEARCH_ACCESS_REFUSED' };
const swappedRefused = error => { assert.ok(['RESEARCH_ACCESS_REFUSED', 'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT'].includes(error.code), error.code); return true; };
const linkKind = process.platform === 'win32' ? 'junction' : 'dir';

test('research file calls refuse missing or disabled mediation before audit', async t => {
  const f = fixture(t, 'read-write');
  for (const [name, method, args] of [
    ['host.read_file', 'readFile', { path: path.join(f.allowed, 'safe.txt') }],
    ['host.write_file', 'writeFile', { path: path.join(f.allowed, 'new.txt'), content: 'new' }],
    ['host.patch_file', 'patchFile', { path: path.join(f.allowed, 'safe.txt'), oldText: 'safe', newText: 'new' }],
  ]) {
    assert.throws(() => host[method](args, { researchAccess: f.researchAccess }), refused);
    const options = f.options(name);
    const previous = process.env.TOOLSENABLED_HOST_BYTE_MEDIATION;
    try {
      process.env.TOOLSENABLED_HOST_BYTE_MEDIATION = 'off';
      assert.throws(() => host[method](args, options), refused);
    } finally {
      if (previous === undefined) delete process.env.TOOLSENABLED_HOST_BYTE_MEDIATION;
      else process.env.TOOLSENABLED_HOST_BYTE_MEDIATION = previous;
    }
  }
});

test('ordinary mediated read retains its original access and research read uses the same real adapter', async t => {
  const f = fixture(t);
  const ordinary = await host.readFile({ path: path.join(f.outside, 'secret.txt') },
    f.options('host.read_file', { researchAccess: undefined }));
  assert.equal(ordinary.content, 'secret');
  const restricted = await host.readFile({ path: path.join(f.allowed, 'safe.txt') }, f.options('host.read_file'));
  assert.equal(restricted.content, 'safe');
  assert.ok(restricted.receipt);
});

test('research list refuses a folder junction swap during audit admission', async t => {
  const f = fixture(t), gate = admissionGate();
  const listing = host.listDir({ path: f.allowed }, {
    researchAccess: f.researchAccess, requireRecordAsync: gate.requireRecordAsync, recordAsync: async () => {},
  });
  gate.assertEntered();
  fs.renameSync(f.allowed, path.join(f.root, 'allowed-original'));
  fs.symlinkSync(f.outside, f.allowed, linkKind);
  gate.release();
  await assert.rejects(listing, swappedRefused);
});

test('research read refuses a file symlink swap during audit admission', async t => {
  const f = fixture(t), gate = admissionGate();
  const target = path.join(f.allowed, 'safe.txt');
  const read = host.readFile({ path: target }, f.options('host.read_file', { requireRecordAsync: gate.requireRecordAsync }));
  gate.assertEntered();
  fs.renameSync(target, path.join(f.allowed, 'safe-original.txt'));
  fs.symlinkSync(path.join(f.outside, 'secret.txt'), target, 'file');
  gate.release();
  await assert.rejects(read, swappedRefused);
});

test('research write refuses a replaced root before publishing any bytes', async t => {
  const f = fixture(t, 'read-write'), gate = admissionGate();
  const write = host.writeFile({ path: path.join(f.allowed, 'new.txt'), content: 'explicit output' },
    f.options('host.write_file', { requireRecordAsync: gate.requireRecordAsync }));
  gate.assertEntered();
  fs.renameSync(f.allowed, path.join(f.root, 'allowed-original'));
  fs.symlinkSync(f.outside, f.allowed, linkKind);
  gate.release();
  await assert.rejects(write, swappedRefused);
  assert.equal(fs.existsSync(path.join(f.outside, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.outside, 'secret.txt'), 'utf8'), 'secret');
});

test('research list rechecks identity after its result audit', async t => {
  const f = fixture(t);
  const listing = host.listDir({ path: f.allowed }, {
    researchAccess: f.researchAccess, requireRecordAsync: async () => {},
    recordAsync: async () => {
      fs.renameSync(f.allowed, path.join(f.root, 'allowed-original'));
      fs.mkdirSync(f.allowed);
    },
  });
  await assert.rejects(listing, swappedRefused);
});

test('read-write research creates output and edits observed input through real byte coordination', async t => {
  const f = fixture(t, 'read-write');
  const output = path.join(f.allowed, 'output.txt');
  const created = await host.writeFile({ path: output, content: 'explicit output' }, f.options('host.write_file'));
  assert.equal(created.created, true);
  assert.equal(fs.readFileSync(output, 'utf8'), 'explicit output');
  const target = path.join(f.allowed, 'safe.txt');
  const observed = await host.readFile({ path: target }, f.options('host.read_file'));
  assert.equal(observed.content, 'safe');
  await host.patchFile({ path: target, oldText: 'safe', newText: 'reviewed' }, f.options('host.patch_file'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'reviewed');
  await host.writeFile({ path: target, content: 'final' }, f.options('host.write_file'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'final');
  assert.equal(fs.readFileSync(path.join(f.outside, 'secret.txt'), 'utf8'), 'secret');
});
