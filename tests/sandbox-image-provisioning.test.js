'use strict';
require('./lib/isolated-environment').activate('sandbox-image-provisioning');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sandbox = require('../src/lib/providers/agent-sandbox');
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'image-lock.json');
  const calls = [], audits = [];
  const image = { Id: `sha256:${'a'.repeat(64)}`, Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Labels: {
    'org.toolsenabled.sandbox.contract': sandbox.CONTRACT,
    'org.toolsenabled.sandbox.playwright': sandbox.PLAYWRIGHT_VERSION,
    'org.toolsenabled.sandbox.base-digest': sandbox.BASE_DIGEST,
  } } };
  let present = options.present !== false;
  let provider;
  const transport = { runDocker(args, opts) {
    calls.push({ args, opts });
    options.onDocker?.(args, provider);
    const reply = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    if (args[0] === 'version') return reply({ Os: 'linux', Arch: 'amd64', Version: options.incompatible ? '27.0' : '29.8' });
    if (args[0] === 'info') return reply({ MemoryLimit: true, PidsLimit: true });
    if (args[0] === 'image') return present ? reply([image]) : { status: 1, stderr: 'No such image', stdout: '' };
    if (args[0] === 'build') {
      if (options.buildError) return { status: null, error: { code: 'ETIMEDOUT' }, stderr: '' };
      present = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected Docker operation ${args[0]}`);
  } };
  provider = sandbox.createSandboxProvider({ platform: 'linux', linuxWorkspace: transport, imageLockPath: lock, disposableRoot: path.join(root, 'disposable'), onImageBuildStart: options.onImageBuildStart,
    audit: { redact: String, requireRecord(...args) {
      audits.push(args); options.onAudit?.(); return { durable: !options.auditFailure };
    } } });
  return { provider, lock, calls, audits, image };
}
test('verified existing image provisions isolated profile lock without build', t => {
  const f = fixture(t), result = f.provider.prepareImage();
  assert.equal(result.status, 'ready'); assert.equal(result.built, false);
  assert.equal(result.interactiveCancellationSupported, false);
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).imageId, f.image.Id);
  assert.equal(f.calls.some(c => c.args[0] === 'build'), false);
  assert.equal(f.audits[0][0], 'sandbox.image.prepare.intent');
});
test('missing image refuses without explicit boolean build authorization and writes nothing', t => {
  const f = fixture(t, { present: false });
  assert.throws(() => f.provider.prepareImage(), { code: 'SANDBOX_IMAGE_BUILD_REQUIRED' });
  assert.equal(fs.existsSync(f.lock), false); assert.equal(f.audits.length, 0);
  assert.equal(f.calls.some(c => c.args[0] === 'build'), false);
});
test('approved build uses the owned context tag and bounded pinned transport then verifies lock', t => {
  const f = fixture(t, { present: false });
  assert.equal(f.provider.prepareImage({ allowBuild: true }).built, true);
  const build = f.calls.find(c => c.args[0] === 'build');
  assert.deepEqual(build.args.slice(0, 4), ['build', '--pull', '--tag', f.provider.imageTag()]);
  assert.notEqual(build.args[3], sandbox.IMAGE_TAG, 'a DEV build must never retag the existing LIVE image');
  assert.equal(build.args[4], path.resolve(__dirname, '../docker/agent-sandbox'));
  assert.equal(build.opts.timeoutMs, 1200000); assert.equal(build.opts.maxBuffer, 4194304);
  assert.equal(f.provider.doctor().imageReady, true);
});
for (const input of [{ allowBuild: 'true' }, { image: 'other' }, { context: '/outside' }, { command: 'anything' }, { signal: {} }]) {
  test(`unsupported caller controls refuse before transport: ${JSON.stringify(input)}`, t => {
    const f = fixture(t); assert.throws(() => f.provider.prepareImage(input), { code: 'SANDBOX_INPUT_INVALID' });
    assert.equal(f.calls.length, 0);
  });
}
test('incompatible daemon and failed audit never build or write a lock', t => {
  for (const options of [{ incompatible: true }, { auditFailure: true }]) {
    const f = fixture(t, { present: false, ...options });
    assert.throws(() => f.provider.prepareImage({ allowBuild: true }));
    assert.equal(fs.existsSync(f.lock), false); assert.equal(f.calls.some(c => c.args[0] === 'build'), false);
  }
});
test('timeout does not produce readiness or a lock', t => {
  const f = fixture(t, { present: false, buildError: true });
  assert.throws(() => f.provider.prepareImage({ allowBuild: true }), { code: 'SANDBOX_DOCKER_TIMEOUT' });
  assert.equal(fs.existsSync(f.lock), false);
});
test('untrusted existing image is not rebuilt or locked even with build approval', t => {
  const f = fixture(t); f.image.Config.User = '0';
  assert.throws(() => f.provider.prepareImage({ allowBuild: true }), { code: 'SANDBOX_IMAGE_UNTRUSTED' });
  assert.equal(fs.existsSync(f.lock), false); assert.equal(f.calls.some(c => c.args[0] === 'build'), false);
});
test('reentrant preparation refuses; reservation releases after failure', t => {
  let reentered = 0;
  const f = fixture(t, { onDocker(_args, provider) {
    assert.throws(() => provider.prepareImage(), { code: 'SANDBOX_IMAGE_PREPARATION_BUSY' }); reentered++;
  } });
  f.provider.prepareImage(); f.provider.prepareImage(); assert.ok(reentered > 0);
});
test('verified-transport refusal never reaches image lock', t => {
  const f = fixture(t, { present: false, onDocker(args) {
    if (args[0] === 'build') throw Object.assign(new Error('Endpoint identity changed'), { code: 'SANDBOX_LINUX_WORKSPACE_REFUSED' });
  } });
  assert.throws(() => f.provider.prepareImage({ allowBuild: true }));
  assert.equal(fs.existsSync(f.lock), false);
});
test('lock publication failure is not reported as ready and releases preparation guard', t => {
  const f = fixture(t);
  fs.mkdirSync(f.lock);
  assert.throws(() => f.provider.prepareImage());
  fs.rmdirSync(f.lock);
  assert.equal(f.provider.prepareImage().status, 'ready');
});
test('trusted build lifecycle marking follows durable audit and precedes Docker; failure prevents build', t => {
  const events = [];
  const f = fixture(t, { present: false, onAudit: () => events.push('audit'),
    onImageBuildStart: () => { events.push('mark'); }, onDocker: args => { if (args[0] === 'build') events.push('build'); } });
  f.provider.prepareImage({ allowBuild: true });
  assert.deepEqual(events, ['audit', 'mark', 'build']);
  const g = fixture(t, { present: false, onImageBuildStart: () => { throw new Error('Cannot durably mark preparation'); } });
  assert.throws(() => g.provider.prepareImage({ allowBuild: true }));
  assert.equal(g.calls.some(c => c.args[0] === 'build'), false);
  assert.equal(fs.existsSync(g.lock), false);
});
test('known prebuild failures never mark daemon work started; renderer cannot supply lifecycle hook', t => {
  for (const options of [{ present: false, incompatible: true }, { present: false, auditFailure: true }, { present: true }]) {
    let marks = 0;
    const f = fixture(t, { ...options, onImageBuildStart: () => marks++ });
    try { f.provider.prepareImage({ allowBuild: true }); } catch { /* expected preflight refusals */ }
    assert.equal(marks, 0);
    assert.throws(() => f.provider.prepareImage({ allowBuild: true, onImageBuildStart() {} }), { code: 'SANDBOX_INPUT_INVALID' });
  }
});

test('independent sessions build distinct tags and keep LIVE immutable image verification valid', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-parallel-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], images = new Map();
  const metadata = id => ({ Id: id, Os: 'linux', Architecture: 'amd64', Config: { User: '10001:10001', Labels: {
    'org.toolsenabled.sandbox.contract': sandbox.CONTRACT,
    'org.toolsenabled.sandbox.playwright': sandbox.PLAYWRIGHT_VERSION,
    'org.toolsenabled.sandbox.base-digest': sandbox.BASE_DIGEST,
  } } });
  const oldId = `sha256:${'0'.repeat(64)}`, legacyImage = metadata(oldId);
  images.set(oldId, legacyImage); images.set(sandbox.IMAGE_TAG, legacyImage);
  let serial = 1;
  const transport = { runDocker(args) {
    calls.push([...args]);
    const reply = value => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
    if (args[0] === 'version') return reply({ Os: 'linux', Arch: 'amd64', Version: '29.8' });
    if (args[0] === 'info') return reply({ MemoryLimit: true, PidsLimit: true });
    if (args[0] === 'image' && args[1] === 'inspect') return images.has(args[2])
      ? reply([images.get(args[2])]) : { status: 1, stdout: '', stderr: 'No such image' };
    if (args[0] === 'build') {
      const image = metadata(`sha256:${String(serial++).repeat(64)}`);
      images.set(image.Id, image); images.set(args[3], image);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected image operation ${args[0]}`);
  } };
  function session(name) {
    const folder = path.join(root, name), lock = path.join(folder, 'image-lock.json');
    const provider = sandbox.createSandboxProvider({ platform: 'linux', linuxWorkspace: transport,
      imageLockPath: lock, disposableRoot: path.join(folder, 'disposable'),
      audit: { redact: String, requireRecord: () => ({ durable: true }) } });
    return { provider, lock };
  }
  const live = session('live'), dev = session('dev'), cut = session('cut');
  live.provider.imageLockWrite();
  const liveBefore = fs.readFileSync(live.lock, 'utf8');
  const first = dev.provider.prepareImage({ allowBuild: true });
  const second = cut.provider.prepareImage({ allowBuild: true });
  assert.notEqual(dev.provider.imageTag(), cut.provider.imageTag());
  assert.notEqual(first.imageId, second.imageId);
  assert.equal(images.get(sandbox.IMAGE_TAG).Id, oldId, 'parallel preparation must never retag LIVE');
  assert.equal(fs.readFileSync(live.lock, 'utf8'), liveBefore);
  assert.equal(live.provider.verifyImage().imageId, oldId);
  assert.equal(dev.provider.verifyImage().imageId, first.imageId);
  assert.equal(cut.provider.verifyImage().imageId, second.imageId);
  assert.equal(JSON.parse(fs.readFileSync(dev.lock)).version, 2);
  assert.notEqual(JSON.parse(fs.readFileSync(dev.lock)).scope, JSON.parse(fs.readFileSync(cut.lock)).scope);
  assert.equal(calls.filter(args => args[0] === 'build').length, 2);
  assert.equal(calls.some(args => args[0] === 'build' && args[3] === sandbox.IMAGE_TAG), false);

  images.set(dev.provider.imageTag(), images.get(second.imageId));
  assert.throws(() => dev.provider.verifyImage(), { code: 'SANDBOX_IMAGE_LOCK_STALE' },
    'scoping a tag must not weaken the exact immutable-image check');
  images.set(dev.provider.imageTag(), images.get(first.imageId));
  images.get(first.imageId).Config.Labels['org.toolsenabled.sandbox.base-digest'] = 'sha256:untrusted';
  assert.throws(() => dev.provider.verifyImage(), { code: 'SANDBOX_IMAGE_UNTRUSTED' });
  assert.equal(live.provider.verifyImage().imageId, oldId);
});
