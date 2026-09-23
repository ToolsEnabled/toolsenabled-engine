/* EXECUTABLE CHANGE
Test-can-fail report: testcanfail-tests-providers-sandbox-agent-sandbox-js

STRENGTHENED — artifact-root link rejection (formerly guarded by
`if (artifactLinkCreated)`). Mutation: in a scratch edit of
src/lib/providers/agent-sandbox.js, disabled both artifact-root link/realpath
rejection conditions. RED output:
"AssertionError [ERR_ASSERTION]: Missing expected exception: an artifact-root
link must never expose host files outside the workspace"

STRENGTHENED — resource-limit assertions that previously derived expectations
from exported RESOURCE_LIMITS. Mutation: changed the product's browser pids
limit from 256 to 255 in a scratch edit. RED output:
"AssertionError [ERR_ASSERTION]: resource-limit expectations must be independent
of the exported values under test" with "+ pids: 255" / "- pids: 256".

RESTORATION — src/lib/providers/agent-sandbox.js was restored byte-for-byte;
SHA-256 before and after both mutations was
7c51671d502be73430a808b28b94fc8da1f411054c2971cd6de3ebb4bf75d6df.
The restored run was GREEN and printed:
"Agent sandbox provider tests passed."

SHAPE 1 (assertion loop over possibly empty collection): NOT-FOUND.
SHAPE 2 (non-zero exit/truthy return without subject output): NOT-FOUND.
SHAPE 3 (try/catch or optional chain swallows target failure): FOUND and fixed
for the artifact-link setup; the remaining cleanup fallback does not swallow
the assertion or product failure.
SHAPE 4 (assertion against mock of subject): NOT-FOUND; fakeDocker is the
provider's injected boundary and assertions measure provider behavior/calls.
SHAPE 5 (skip/precondition guard makes test a no-op): FOUND and fixed for
directory-link creation.
SHAPE 6 (expected value computed by checked code): FOUND and fixed for
RESOURCE_LIMITS with an independent literal contract.

PRECONDITIONS: Node >=22 (met with Node v22.22.2) and permission to create a
directory link (met). Unmet preconditions: NONE.
*/
'use strict';

require('../lib/isolated-environment').activate('agent-sandbox');

// This legacy suite exercises required audit intent and refusal contracts.
const operationAudit = require('../../src/lib/operation-audit');
const requiredAuditPolicy = operationAudit.capturePolicy({ loadSettings: () => ({
  values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: []
}) });
operationAudit.withPolicy(requiredAuditPolicy, () => {
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BASE_DIGEST,
  CONTRACT,
  IMAGE_TAG,
  PLAYWRIGHT_VERSION,
  OPERATION_TYPE,
  RESOURCE_LIMITS,
  contextDigest,
  createSandboxProvider
} = require('../../src/lib/providers/agent-sandbox');
const { createStateStore, hashInput } = require('../../src/lib/state-store');
const { withSandboxAdmissionLock } = require('../../src/lib/sandbox-admission-lock');

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;

// A standard Windows token can consume an owned file symlink but may not have
// permission to create one. A native QA driver may provision these two exact
// relative links in its private run directory before starting this test. The
// links are moved, never followed/copied, and still exercise real file links.
function fileSymlinkFixture(target, destination, fixtureName) {
  const supplied = process.env.TOOLSENABLED_SANDBOX_FILE_SYMLINK_FIXTURES;
  if (supplied === undefined) fs.symlinkSync(target, destination, 'file');
  else {
    assert.equal(path.isAbsolute(supplied), true, 'file-link fixture directory must be absolute');
    const directory = fs.lstatSync(supplied);
    assert.equal(directory.isDirectory() && !directory.isSymbolicLink(), true);
    const source = path.join(supplied, fixtureName);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true, 'the supplied fixture must be a real symlink');
    const relative = fs.readlinkSync(source);
    assert.equal(path.isAbsolute(relative), false, 'supplied file links must be relative');
    assert.equal(path.normalize(relative), path.relative(path.dirname(destination), target),
      'the supplied file link must name this exact test-owned target');
    fs.renameSync(source, destination);
  }
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(fs.statSync(destination).isFile(), true, 'directory links cannot substitute for file-link coverage');
  assert.equal(fs.realpathSync(destination), fs.realpathSync(target));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function labels(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--label') continue;
    const [name, ...value] = args[index + 1].split('=');
    result[name] = value.join('=');
  }
  return result;
}

function fakeDocker() {
  const containers = new Map();
  const networks = new Map();
  const calls = [];
  let nextExecResult = null;
  let restartFailures = 0;
  let ignoreIsolatedGateway = false;
  let containerMutator = null;
  let server = { Version: '29.4.3', Os: 'linux', Arch: 'amd64' };
  let info = {
    MemoryLimit: true, PidsLimit: true, NCPU: 16, MemTotal: 24 * 1024 * 1024 * 1024
  };
  const image = {
    Id: IMAGE_ID,
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      User: '10001:10001',
      Labels: {
        'org.toolsenabled.sandbox.contract': CONTRACT,
        'org.toolsenabled.sandbox.playwright': PLAYWRIGHT_VERSION,
        'org.toolsenabled.sandbox.base-digest': BASE_DIGEST
      }
    }
  };
  function missing(kind, id) {
    return { status: 1, stdout: '', stderr: `Error: No such ${kind}: ${id}` };
  }
  function run(args) {
    calls.push([...args]);
    if (args[0] === 'version') {
      return { status: 0, stdout: JSON.stringify(server), stderr: '' };
    }
    if (args[0] === 'info') {
      return { status: 0, stdout: JSON.stringify(info), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (args[2] !== IMAGE_ID && args[2] !== IMAGE_TAG) return missing('image', args[2]);
      return { status: 0, stdout: JSON.stringify([image]), stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'create') {
      const name = args.at(-1);
      networks.set(name, {
        Id: `${name}-network-id`,
        Name: name,
        Driver: 'bridge',
        Internal: args.includes('--internal'),
        Labels: labels(args),
        Options: {
          'com.docker.network.bridge.gateway_mode_ipv4': !ignoreIsolatedGateway && argValue(args, '--opt')
            && argValue(args, '--opt').split('=').at(-1)
        }
      });
      return { status: 0, stdout: `${name}\n`, stderr: '' };
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const network = networks.get(args[2]);
      return network ? { status: 0, stdout: JSON.stringify([network]), stderr: '' } : missing('network', args[2]);
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      const found = [...networks.entries()].find(([name, network]) => name === args[2] || network.Id === args[2]);
      if (!found) return missing('network', args[2]);
      networks.delete(found[0]);
      return { status: 0, stdout: `${args[2]}\n`, stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      const names = [...containers.entries()]
        .filter(([, container]) => container.Config.Labels['org.toolsenabled.sandbox.role'] === 'browser')
        .map(([name]) => name);
      return { status: 0, stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
    }
    if (args[0] === 'run') {
      const name = argValue(args, '--name');
      const capDrop = [];
      const securityOpt = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--cap-drop') capDrop.push(args[index + 1]);
        if (args[index] === '--security-opt') securityOpt.push(args[index + 1]);
      }
      const memory = Number(argValue(args, '--memory'));
      const cpus = Number(argValue(args, '--cpus'));
      const tmpfs = {};
      const ulimits = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--tmpfs') {
          const [destination, ...options] = args[index + 1].split(':');
          tmpfs[destination] = options.join(':');
        }
        if (args[index] === '--ulimit') {
          const [name, values] = args[index + 1].split('=');
          const [soft, hard] = values.split(':').map(Number);
          ulimits.push({ Name: name, Soft: soft, Hard: hard });
        }
      }
      const container = {
        Id: `${name}-container-id`,
        Image: IMAGE_ID,
        Config: { Labels: labels(args), User: argValue(args, '--user') },
        State: { Running: true },
        Mounts: argValue(args, '--mount') ? [{
          Source: argValue(args, '--mount').match(/src=([^,]+)/)[1],
          Destination: '/workspace',
          Type: 'bind',
          RW: true
        }] : [],
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: args.includes('--read-only'),
          CapDrop: capDrop,
          SecurityOpt: securityOpt,
          PidsLimit: Number(argValue(args, '--pids-limit')),
          Memory: memory,
          MemorySwap: Number(argValue(args, '--memory-swap')),
          NanoCpus: Math.round(cpus * 1_000_000_000),
          ShmSize: Number(argValue(args, '--shm-size')),
          NetworkMode: argValue(args, '--network'),
          Ulimits: ulimits,
          Tmpfs: tmpfs,
          Devices: [],
          DeviceRequests: [],
          PortBindings: {}
        },
        NetworkSettings: { Ports: {} }
      };
      if (containerMutator) containerMutator(container, args);
      containers.set(name, container);
      return { status: 0, stdout: `${name}-container-id\n`, stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const container = containers.get(args[2]);
      return container ? { status: 0, stdout: JSON.stringify([container]), stderr: '' } : missing('container', args[2]);
    }
    if (args[0] === 'container' && args[1] === 'rm') {
      const identifier = args.at(-1);
      const found = [...containers.entries()].find(([name, container]) => name === identifier || container.Id === identifier);
      if (!found) return missing('container', identifier);
      containers.delete(found[0]);
      return { status: 0, stdout: `${identifier}\n`, stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'exec') {
      if (nextExecResult) {
        const selected = nextExecResult;
        nextExecResult = null;
        return selected;
      }
      return { status: 0, stdout: '{"ok":true}\\n', stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'restart') {
      const identifier = args.at(-1);
      if (restartFailures > 0) {
        restartFailures -= 1;
        return { status: 1, stdout: '', stderr: 'injected restart failure' };
      }
      const found = [...containers.entries()].find(([name, container]) => name === identifier || container.Id === identifier);
      if (!found) return missing('container', identifier);
      return { status: 0, stdout: `${identifier}\n`, stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `Unexpected Docker command: ${args.join(' ')}` };
  }
  return {
    calls,
    containers,
    networks,
    run,
    failNextExec(error) {
      nextExecResult = { status: null, stdout: '', stderr: '', error };
    },
    failRestarts(count = 1) {
      restartFailures = count;
    },
    ignoreGatewayMode(value = true) {
      ignoreIsolatedGateway = value;
    },
    mutateContainers(mutator) {
      containerMutator = mutator;
    },
    setServer(value) {
      server = { ...value };
    },
    setInfo(value) {
      info = { ...value };
    }
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-agent-sandbox-'));
let now = Date.UTC(2026, 6, 26, 12, 0, 0);
const store = createStateStore({
  file: path.join(root, 'state.sqlite3'),
  clock: () => now,
  ownerId: 'sandbox-test'
});
const docker = fakeDocker();
const auditEvents = [];
const imageLockPath = path.join(root, 'image-lock.json');
fs.writeFileSync(imageLockPath, `${JSON.stringify({
  version: 1,
  contract: CONTRACT,
  tag: IMAGE_TAG,
  imageId: IMAGE_ID,
  baseDigest: BASE_DIGEST,
  playwrightVersion: PLAYWRIGHT_VERSION,
  contextSha256: contextDigest(),
  lockedAt: new Date(now).toISOString()
})}\n`);
const testAudit = {
  redact: value => String(value),
  requireRecord(event, target, details) {
    auditEvents.push({ event, target, details });
    return { durable: true };
  }
};
function providerUsing(dockerInstance, stateInstance = store, fileSystem = fs) {
  return createSandboxProvider({
    fs: fileSystem,
    state: stateInstance,
    runDocker: dockerInstance.run,
    linuxWorkspace: { runDocker: dockerInstance.run, prepare() {}, pinnedEndpoint: 'synthetic-only' },
    imageLockPath,
    admissionGuardPath: path.join(root, 'admission.sqlite3'),
    disposableRoot: path.join(root, 'disposable'),
    authRoot: path.join(root, 'auth'),
    now: () => now,
    getOrCreateSecret: () => Buffer.alloc(32, 7).toString('base64url'),
    audit: testAudit
  });
}
const provider = providerUsing(docker);

try {
  const buildScript = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'build-agent-sandbox.ps1'), 'utf8');
  assert.match(buildScript, /MemoryLimit -ne \$true/);
  assert.match(buildScript, /PidsLimit -ne \$true/);
  assert.match(buildScript, /docker build --pull/);

  const doctor = provider.doctor();
  assert.equal(doctor.available, true);
  assert.equal(doctor.compatible, true);
  assert.equal(doctor.docker.isolatedGatewaySupported, true);
  assert.equal(doctor.imageReady, true);
  assert.deepEqual(doctor.networkModes.sort(), ['fixture', 'none']);
  assert.equal(doctor.authenticatedContainerSignInEstablished, false);
  assert.deepEqual(doctor.capacity, { maxActiveSandboxes: 4, maxActivePerAgent: 2 });

  for (const errorCode of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT', undefined]) {
    const retryDocker = fakeDocker();
    let versionCalls = 0;
    const retryProvider = providerUsing({
      run(args) {
        if (args[0] === 'version' && versionCalls++ === 0) {
          return {
            status: null,
            stdout: '',
            stderr: '',
            ...(errorCode ? { error: Object.assign(new Error(errorCode), { code: errorCode }) } : {})
          };
        }
        return retryDocker.run(args);
      }
    });
    const unknown = retryProvider.doctor();
    assert.equal(unknown.available, null, `${errorCode || 'unanswered child'} must not mean Docker is absent`);
    assert.equal(unknown.compatible, null);
    assert.equal(unknown.code, 'SANDBOX_DOCKER_STATUS_UNKNOWN');
    assert.match(unknown.message, /does not claim that Docker is absent or stopped/);
    assert.equal(retryProvider.doctor().available, true,
      `${errorCode || 'unanswered child'} must not be cached or latched`);
    assert.equal(versionCalls, 2);
  }

  const unansweredInfoDocker = fakeDocker();
  let infoCalls = 0;
  const unansweredInfoProvider = providerUsing({
    run(args) {
      if (args[0] === 'info' && infoCalls++ === 0) return { status: null, stdout: '', stderr: '' };
      return unansweredInfoDocker.run(args);
    }
  });
  const unknownInfo = unansweredInfoProvider.doctor();
  assert.equal(unknownInfo.available, true);
  assert.equal(unknownInfo.compatible, null, 'an unanswered info child must not mean Docker is incompatible');
  assert.equal(unknownInfo.imageReady, false, 'an unknown compatibility probe must not continue to image inspection');
  assert.match(unknownInfo.message, /does not claim that Docker is absent, stopped, or incompatible/);
  assert.equal(unansweredInfoProvider.doctor().compatible, true, 'an unanswered info probe must not be latched');
  assert.equal(infoCalls, 2);

  const absentDocker = { run: () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  }) };
  const absent = providerUsing(absentDocker).doctor();
  assert.equal(absent.available, false, 'CONTROL: ENOENT must retain the legitimate absent answer');
  assert.equal(absent.compatible, false);
  assert.equal(absent.code, 'SANDBOX_DOCKER_UNAVAILABLE');
  assert.deepEqual(RESOURCE_LIMITS, {
    browser: {
      cpus: 1,
      memoryBytes: 1_073_741_824,
      pids: 256,
      shmBytes: 268_435_456,
      tmpBytes: 134_217_728,
      cacheBytes: 134_217_728,
      nofileSoft: 1024,
      nofileHard: 2048
    },
    fixture: {
      cpus: 0.25,
      memoryBytes: 134_217_728,
      pids: 64,
      shmBytes: 67_108_864,
      tmpBytes: 16_777_216,
      nofileSoft: 256,
      nofileHard: 512
    }
  }, 'resource-limit expectations must be independent of the exported values under test');

  const oldDocker = fakeDocker();
  oldDocker.setServer({ Version: '27.5.1', Os: 'linux', Arch: 'amd64' });
  const oldDockerProvider = providerUsing(oldDocker);
  assert.equal(oldDockerProvider.doctor().compatible, false);
  assert.throws(() => oldDockerProvider.create({
    agent: 'codex',
    taskKey: 'task.sandbox.old.docker',
    sandboxKey: 'sandbox.old.docker',
    networkMode: 'none',
    leaseSeconds: 30
  }), error => error && error.code === 'SANDBOX_DOCKER_INCOMPATIBLE');
  assert.equal(oldDocker.calls.some(call => call[0] === 'run'
    || (call[0] === 'network' && call[1] === 'create')), false,
  'incompatible Docker must be rejected before any sandbox resource is created');

  const noLimitsDocker = fakeDocker();
  noLimitsDocker.setInfo({ PidsLimit: true, NCPU: 16, MemTotal: 1 });
  const noLimitsProvider = providerUsing(noLimitsDocker);
  assert.deepEqual(noLimitsProvider.doctor().incompatibilityReasons, ['memoryLimit']);
  assert.throws(() => noLimitsProvider.create({
    agent: 'codex',
    taskKey: 'task.sandbox.no.limits',
    sandboxKey: 'sandbox.no.limits',
    networkMode: 'none',
    leaseSeconds: 30
  }), error => error && error.code === 'SANDBOX_DOCKER_INCOMPATIBLE');

  const guardedDocker = fakeDocker();
  const guardedRoot = path.join(root, 'guard-release-distinction');
  const guardedPath = path.join(guardedRoot, '.create.guard.json');
  const guardReleaseFailure = Object.assign(new Error('injected guard unlink failure'), { code: 'EACCES' });
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'unlinkSync') {
        return file => {
          if (file === guardedPath) throw guardReleaseFailure;
          return target.unlinkSync(file);
        };
      }
      return target[property];
    }
  });
  const guardedProvider = createSandboxProvider({
    state: store,
    runDocker: guardedDocker.run,
    linuxWorkspace: { runDocker: guardedDocker.run, prepare() {}, pinnedEndpoint: 'synthetic-only' },
    fs: guardedFs,
    imageLockPath,
    createGuardPath: guardedPath,
    admissionGuardPath: path.join(root, 'admission.sqlite3'),
    disposableRoot: path.join(guardedRoot, 'disposable'),
    authRoot: path.join(guardedRoot, 'auth'),
    now: () => now,
    getOrCreateSecret: () => Buffer.alloc(32, 7).toString('base64url'),
    audit: testAudit
  });
  assert.throws(() => guardedProvider.create({
    agent: 'claude',
    taskKey: 'task.sandbox.guard.release',
    sandboxKey: 'sandbox.guard.release',
    networkMode: 'none',
    leaseSeconds: 120
  }), error => error && error.code === 'SANDBOX_CREATE_GUARD_RELEASE_FAILED',
  'creation that happened but whose guard release could not be established must not report definite success');
  fs.unlinkSync(guardedPath);

  const created = provider.create({
    agent: 'codex',
    taskKey: 'task.sandbox.unit',
    sandboxKey: 'sandbox.unit.none',
    networkMode: 'none',
    leaseSeconds: 120
  });
  assert.match(created.sandboxId, /^sbx-[a-f0-9]{20}$/);
  assert.equal(created.isolation.rootFilesystemReadOnly, true);
  assert.equal(created.isolation.hostDockerSocket, false);
  assert.equal(created.isolation.hostSecrets, false);
  assert.equal(created.isolation.hostBrowserProfile, false);
  assert.equal(created.networkMode, 'none');
  assert.equal(fs.existsSync(created.workspacePath), true);
  assert.ok(created.handle.expiresAtMs - now >= 240_000,
    'creation widens a caller-short lease across all Docker provisioning steps');

  const browserRun = docker.calls.find(call => call[0] === 'run' && argValue(call, '--name') === `${created.sandboxId}-browser`);
  assert.ok(browserRun);
  assert.equal(browserRun.includes('--privileged'), false);
  assert.equal(browserRun.includes('--read-only'), true);
  assert.deepEqual(browserRun.slice(browserRun.indexOf('--cap-drop'), browserRun.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.ok(browserRun.includes('no-new-privileges:true'));
  assert.equal(argValue(browserRun, '--pids-limit'), String(RESOURCE_LIMITS.browser.pids));
  assert.equal(argValue(browserRun, '--memory'), String(RESOURCE_LIMITS.browser.memoryBytes));
  assert.equal(argValue(browserRun, '--network'), 'none');
  assert.doesNotMatch(browserRun.join(' '), /docker\.sock|profiles|vault|127\.0\.0\.1|host\.docker\.internal/i);
  assert.ok(browserRun.includes(IMAGE_ID), 'runtime uses the immutable local image ID, not a mutable tag');

  const wrote = provider.workspaceWrite({
    handle: created.handle,
    path: 'checks/example.js',
    content: 'process.stdout.write("ok")'
  });
  assert.equal(wrote.bytes, 26);
  const read = provider.workspaceRead({ handle: wrote.handle, path: 'checks/example.js' });
  assert.equal(read.content, 'process.stdout.write("ok")');
  assert.equal(read.contentTrust, 'untrusted');
  assert.throws(() => provider.workspaceWrite({
    handle: read.handle,
    path: '../escape.js',
    content: 'bad'
  }), error => error && error.code === 'SANDBOX_PATH_INVALID');

  const executed = provider.execute({
    handle: read.handle,
    scriptPath: 'checks/example.js',
    timeoutSeconds: 5
  });
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.contentTrust, 'untrusted');
  const execCall = docker.calls.find(call => call[0] === 'container' && call[1] === 'exec');
  assert.deepEqual(execCall.slice(-3), ['5000', 'node', '/workspace/checks/example.js']);
  assert.equal(execCall.includes('sh'), false);
  const resetCall = docker.calls.find(call => call[0] === 'container' && call[1] === 'restart');
  assert.deepEqual(resetCall.slice(-3), ['--time', '1', `${created.sandboxId}-browser-container-id`]);
  assert.equal(fs.existsSync(path.join(path.dirname(created.workspacePath), '.exec.lock.json')), false);
  const timeoutError = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  docker.failNextExec(timeoutError);
  const resetsBeforeTimeout = docker.calls.filter(call => call[0] === 'container' && call[1] === 'restart').length;
  assert.throws(() => provider.execute({
    handle: executed.handle,
    scriptPath: 'checks/example.js',
    timeoutSeconds: 1
  }), error => error && error.code === 'SANDBOX_DOCKER_TIMEOUT');
  assert.equal(
    docker.calls.filter(call => call[0] === 'container' && call[1] === 'restart').length,
    resetsBeforeTimeout + 1,
    'a timed-out command must still reset the whole container'
  );
  assert.equal(fs.existsSync(path.join(path.dirname(created.workspacePath), '.exec.lock.json')), false);
  const staleExecLock = path.join(path.dirname(created.workspacePath), '.exec.lock.json');
  fs.writeFileSync(staleExecLock, JSON.stringify({
    version: 1, pid: 999999, createdAtMs: now - 121_000
  }));
  const resetsBeforeRecovery = docker.calls.filter(call => call[0] === 'container' && call[1] === 'restart').length;
  provider.execute({
    handle: executed.handle,
    scriptPath: 'checks/example.js',
    timeoutSeconds: 1
  });
  assert.equal(
    docker.calls.filter(call => call[0] === 'container' && call[1] === 'restart').length,
    resetsBeforeRecovery + 2,
    'stale execution recovery must reset before and after the next bounded command'
  );
  assert.equal(fs.existsSync(staleExecLock), false);

  fs.writeFileSync(path.join(created.workspacePath, 'artifacts', 'shot.png'), Buffer.from([1, 2, 3]));
  const listed = provider.artifacts({ handle: executed.handle });
  assert.deepEqual(listed.artifacts.map(item => item.name), ['shot.png']);
  assert.equal(listed.artifacts[0].bytes, 3);
  const artifactRoot = path.join(created.workspacePath, 'artifacts');
  const zlib = require('node:zlib');
  const pngChunk = (kind, data) => {
    const block = Buffer.alloc(data.length + 12);
    block.writeUInt32BE(data.length); block.write(kind, 4, 4, 'ascii'); data.copy(block, 8);
    block.writeUInt32BE(zlib.crc32(block.subarray(4, -4)), block.length - 4);
    return block;
  };
  const makePng = (width = 1, pixels = Buffer.from([0, 255, 0, 0, 255])) => {
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
    return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  };
  const shotPath = path.join(artifactRoot, 'shot.png');
  const validPng = makePng();
  fs.writeFileSync(shotPath, validPng);
  const image = provider.artifactRead({ handle: listed.handle, name: 'shot.png' });
  assert.equal(image.width, 1); assert.equal(image.height, 1);
  assert.deepEqual(image.__mcpImage, validPng);
  assert.equal(Object.keys(image).includes('__mcpImage'), false);
  assert.equal(image.grantsAuthority, false);
  assert.equal(image.contentTrust, 'untrusted');
  assert.equal(JSON.stringify(image).includes(shotPath), false);
  const wire = require('../../src/mcp-server').toolResult(image);
  assert.equal(wire.content[1].type, 'image');
  assert.equal(wire.content[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(wire.content[1].data, 'base64'), validPng);
  assert.equal(JSON.stringify(wire.structuredContent).includes('__mcpImage'), false);
  for (const changed of [{ token: 'invalid-test-token' }, { ownerId: 'other-test-owner' }, { fence: listed.handle.fence + 1 }]) {
    assert.throws(() => provider.artifactRead({ handle: { ...listed.handle, ...changed }, name: 'shot.png' }),
      e => /LEASE|OPERATION/.test(e.code), 'unowned or stale lease must refuse image reads');
  }
  for (const name of ['../shot.png', '/shot.png', 'artifacts/shot.png', 'shot.svg', 'C:\\shot.png']) {
    assert.throws(() => provider.artifactRead({ handle: listed.handle, name }), e => e.code === 'SANDBOX_INPUT_INVALID');
  }
  for (const bad of [Buffer.from('not png'), makePng(4097), makePng(1, Buffer.alloc(100)), Buffer.concat([validPng, Buffer.from([0])])]) {
    fs.writeFileSync(shotPath, bad);
    assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_IMAGE_INVALID');
  }
  const badCrc = Buffer.from(validPng); badCrc[29] ^= 1;
  fs.writeFileSync(shotPath, badCrc);
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_IMAGE_INVALID');
  fs.writeFileSync(shotPath, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_FILE_TOO_LARGE');
  fs.writeFileSync(shotPath, validPng);
  const linked = path.join(artifactRoot, 'linked.png');
  fs.linkSync(shotPath, linked);
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(linked);
  fileSymlinkFixture(shotPath, linked, 'artifact-file.symlink');
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'linked.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'linked.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.rmdirSync(linked);
  const raceFs = Object.create(fs);
  raceFs.openSync = (target, ...args) => {
    if (target === shotPath) { fs.renameSync(shotPath, linked); fs.writeFileSync(shotPath, validPng); }
    return fs.openSync(target, ...args);
  };
  const racingProvider = providerUsing(docker, store, raceFs);
  assert.throws(() => racingProvider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(linked);
  const readRaceFs = Object.create(fs);
  let changedDuringRead = false;
  readRaceFs.readSync = (...args) => {
    const count = fs.readSync(...args);
    if (!changedDuringRead) { changedDuringRead = true; fs.renameSync(shotPath, linked); fs.writeFileSync(shotPath, validPng); }
    return count;
  };
  assert.throws(() => providerUsing(docker, store, readRaceFs).artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  assert.equal(changedDuringRead, true);
  fs.unlinkSync(linked);
  const outsideArtifacts = path.join(root, 'outside-artifacts');
  fs.mkdirSync(outsideArtifacts);
  fs.writeFileSync(path.join(outsideArtifacts, 'private.txt'), 'must-not-escape');
  fs.rmSync(artifactRoot, { recursive: true, force: false });
  let artifactLinkCreated = false;
  try {
    fs.symlinkSync(outsideArtifacts, artifactRoot, process.platform === 'win32' ? 'junction' : 'dir');
    artifactLinkCreated = true;
  } catch (error) {
    assert.notEqual(error.code, 'EPERM',
      'PRECONDITION: creating a directory link is required to exercise artifact-root escape rejection');
    throw error;
  }
  assert.equal(artifactLinkCreated, true,
    'PRECONDITION: the artifact-root directory link must exist before testing escape rejection');
  assert.throws(() => provider.artifacts({ handle: listed.handle }),
    error => error && error.code === 'SANDBOX_PATH_INVALID',
    'an artifact-root link must never expose host files outside the workspace');
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_PATH_INVALID');
  try { fs.unlinkSync(artifactRoot); } catch { fs.rmdirSync(artifactRoot); }
  fs.mkdirSync(artifactRoot);

  const current = provider.status({ sandboxId: created.sandboxId });
  assert.equal(current.running, true);
  assert.equal(current.observed.readOnlyRootfs, true);
  assert.deepEqual(current.observed.capDrop, ['ALL']);
  assert.ok(current.observed.securityOpt.includes('no-new-privileges:true'));
  assert.equal(current.observed.pidsLimit, RESOURCE_LIMITS.browser.pids);
  assert.deepEqual(current.observed.mountDestinations, ['/workspace']);
  assert.equal(current.observed.hostDockerSocketMounted, false);
  assert.equal(current.observed.publishedPorts, false);
  assert.equal(current.observed.boundaryValid, true);
  assert.equal(current.operation.status, 'executing');
  const execLock = path.join(path.dirname(created.workspacePath), '.exec.lock.json');
  fs.writeFileSync(execLock, JSON.stringify({ version: 1, pid: process.pid, createdAtMs: now }));
  assert.throws(() => provider.workspaceRead({ handle: listed.handle, path: 'checks/example.js' }),
    error => error && error.code === 'SANDBOX_EXEC_BUSY');
  assert.throws(() => provider.workspaceWrite({
    handle: listed.handle, path: 'checks/blocked.js', content: 'blocked'
  }), error => error && error.code === 'SANDBOX_EXEC_BUSY');
  assert.throws(() => provider.artifacts({ handle: listed.handle }),
    error => error && error.code === 'SANDBOX_EXEC_BUSY');
  assert.throws(() => provider.artifactRead({ handle: listed.handle, name: 'shot.png' }),
    error => error && error.code === 'SANDBOX_EXEC_BUSY');
  assert.throws(() => provider.cleanup({ handle: listed.handle }), error => error && error.code === 'SANDBOX_EXEC_BUSY');
  fs.unlinkSync(execLock);
  const secondCodex = provider.create({
    agent: 'codex',
    taskKey: 'task.sandbox.unit.second',
    sandboxKey: 'sandbox.unit.none.second',
    networkMode: 'none',
    leaseSeconds: 120
  });
  assert.throws(() => provider.create({
    agent: 'codex',
    taskKey: 'task.sandbox.unit.third',
    sandboxKey: 'sandbox.unit.none.third',
    networkMode: 'none',
    leaseSeconds: 120
  }), error => error && error.code === 'SANDBOX_AGENT_CAPACITY_REACHED');
  provider.cleanup({ handle: secondCodex.handle });

  const cleaned = provider.cleanup({ handle: listed.handle });
  assert.equal(cleaned.cleaned, true);
  assert.deepEqual(cleaned.removed, { browser: true, fixture: false, network: false, workspace: true });
  assert.equal(provider.status({ sandboxId: created.sandboxId }).exists, false);
  assert.equal(fs.existsSync(created.workspacePath), false);

  const fixture = provider.create({
    agent: 'gemini',
    taskKey: 'task.sandbox.fixture',
    sandboxKey: 'sandbox.unit.fixture',
    networkMode: 'fixture',
    leaseSeconds: 120
  });
  const fixtureRun = docker.calls.find(call => call[0] === 'run' && argValue(call, '--name') === `${fixture.sandboxId}-fixture`);
  const fixtureNetwork = docker.calls.find(call => call[0] === 'network' && call[1] === 'create' && call.at(-1) === `${fixture.sandboxId}-net`);
  assert.ok(fixtureRun);
  assert.ok(fixtureNetwork.includes('--internal'));
  assert.ok(fixtureNetwork.includes('com.docker.network.bridge.gateway_mode_ipv4=isolated'));
  assert.equal(fixtureRun.includes('--privileged'), false);
  assert.equal(argValue(fixtureRun, '--memory'), String(RESOURCE_LIMITS.fixture.memoryBytes));
  assert.equal(provider.status({ sandboxId: fixture.sandboxId }).fixtureRunning, true);
  assert.equal(provider.status({ sandboxId: fixture.sandboxId }).observed.networkInternal, true);
  assert.equal(provider.status({ sandboxId: fixture.sandboxId }).observed.networkGatewayModeIpv4, 'isolated');
  provider.cleanup({ handle: fixture.handle });

  const ignoredNetworkDocker = fakeDocker();
  ignoredNetworkDocker.ignoreGatewayMode();
  const ignoredNetworkProvider = providerUsing(ignoredNetworkDocker);
  assert.throws(() => ignoredNetworkProvider.create({
    agent: 'gemini',
    taskKey: 'task.sandbox.ignored.gateway',
    sandboxKey: 'sandbox.ignored.gateway',
    networkMode: 'fixture',
    leaseSeconds: 30
  }), error => error && error.code === 'SANDBOX_NETWORK_ISOLATION_FAILED',
  'create must inspect and reject a daemon that ignores isolated gateway enforcement');
  assert.equal(ignoredNetworkDocker.containers.size, 0);
  assert.equal(ignoredNetworkDocker.networks.size, 0);

  const weakenedContainerDocker = fakeDocker();
  weakenedContainerDocker.mutateContainers((container, args) => {
    if (labels(args)['org.toolsenabled.sandbox.role'] === 'browser') {
      container.HostConfig.PidsLimit = 0;
    }
  });
  const weakenedContainerProvider = providerUsing(weakenedContainerDocker);
  assert.throws(() => weakenedContainerProvider.create({
    agent: 'gemini',
    taskKey: 'task.sandbox.weakened.container',
    sandboxKey: 'sandbox.weakened.container',
    networkMode: 'none',
    leaseSeconds: 30
  }), error => error && error.code === 'SANDBOX_CONTAINER_ISOLATION_FAILED',
  'create must inspect the resulting container rather than trusting CLI flags');
  assert.equal(weakenedContainerDocker.containers.size, 0);

  const leaseDocker = fakeDocker();
  const heartbeatLeaseMs = [];
  const leaseState = new Proxy(store, {
    get(target, property) {
      const value = target[property];
      if (property === 'heartbeatOperation') {
        return (handle, options) => {
          heartbeatLeaseMs.push(options.leaseMs);
          return value.call(target, handle, options);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const leaseProvider = providerUsing(leaseDocker, leaseState);
  const boundedLease = leaseProvider.create({
    agent: 'claude',
    taskKey: 'task.sandbox.lease.bounds',
    sandboxKey: 'sandbox.lease.bounds',
    networkMode: 'none',
    leaseSeconds: 30
  });
  assert.ok(boundedLease.handle.expiresAtMs - now >= 240_000);
  const leaseWrite = leaseProvider.workspaceWrite({
    handle: boundedLease.handle,
    path: 'lease.js',
    content: 'process.stdout.write("lease")',
    leaseSeconds: 30
  });
  assert.ok(heartbeatLeaseMs.includes(90_000), 'workspace access must hold a reset-safe lease');
  now += 120_000;
  const leaseExec = leaseProvider.execute({
    handle: leaseWrite.handle,
    scriptPath: 'lease.js',
    timeoutSeconds: 60,
    leaseSeconds: 30
  });
  assert.ok(leaseExec.handle.expiresAtMs - now >= 150_000,
    'exec lease must span the command plus pre/post-reset recovery margin');
  leaseProvider.cleanup({ handle: leaseExec.handle });
  assert.ok(heartbeatLeaseMs.includes(180_000), 'cleanup must hold a lease across all bounded removals');

  const quarantined = provider.create({
    agent: 'gemini',
    taskKey: 'task.sandbox.reset.quarantine',
    sandboxKey: 'sandbox.reset.quarantine',
    networkMode: 'none',
    leaseSeconds: 30
  });
  const quarantineWrite = provider.workspaceWrite({
    handle: quarantined.handle,
    path: 'quarantine.js',
    content: 'process.stdout.write("done")'
  });
  docker.failRestarts(1);
  assert.throws(() => provider.execute({
    handle: quarantineWrite.handle,
    scriptPath: 'quarantine.js',
    timeoutSeconds: 1
  }), error => error && error.code === 'SANDBOX_CONTAINER_RESET_FAILED');
  const quarantineStatus = provider.status({ sandboxId: quarantined.sandboxId });
  assert.equal(quarantineStatus.exists, false);
  assert.equal(quarantineStatus.quarantined, true);
  assert.equal(quarantineStatus.reapRequired, true);
  assert.equal(store.getOperation({ id: quarantined.handle.operationId }).status, 'uncertain');
  assert.throws(() => provider.workspaceRead({
    handle: quarantineWrite.handle,
    path: 'quarantine.js'
  }), error => error && error.code === 'SANDBOX_QUARANTINED',
  'a reset-failed handle must never be reusable');
  assert.throws(() => provider.artifactRead({ handle: quarantineWrite.handle, name: 'shot.png' }), e => e.code === 'SANDBOX_QUARANTINED');
  const quarantineReap = provider.reap({
    sandboxId: quarantined.sandboxId,
    confirmSandboxId: quarantined.sandboxId
  });
  assert.equal(quarantineReap.reaped, true);
  assert.equal(fs.existsSync(quarantined.workspacePath), false);

  const crashedBrowser = provider.create({
    agent: 'gemini',
    taskKey: 'task.sandbox.crashed',
    sandboxKey: 'sandbox.unit.crashed',
    networkMode: 'none',
    leaseSeconds: 120
  });
  docker.containers.delete(`${crashedBrowser.sandboxId}-browser`);
  assert.throws(() => provider.reap({
    sandboxId: crashedBrowser.sandboxId,
    confirmSandboxId: crashedBrowser.sandboxId
  }), error => error && error.code === 'SANDBOX_LEASE_ACTIVE',
  'a browser crash must not make an actively leased workspace reapable');
  provider.cleanup({ handle: crashedBrowser.handle });

  const expiredSandbox = provider.create({
    agent: 'claude',
    taskKey: 'task.sandbox.expired',
    sandboxKey: 'sandbox.unit.expired',
    networkMode: 'none',
    leaseSeconds: 120
  });
  now += 241_000;
  assert.throws(() => provider.artifactRead({ handle: expiredSandbox.handle, name: 'shot.png' }),
    e => /LEASE|OPERATION/.test(e.code), 'expired lease must refuse before any file read');
  const reaped = provider.reap({
    sandboxId: expiredSandbox.sandboxId,
    confirmSandboxId: expiredSandbox.sandboxId
  });
  assert.equal(reaped.reaped, true);
  assert.equal(provider.status({ sandboxId: expiredSandbox.sandboxId }).exists, false);

  // One daemon, separate application state stores: a fresh DEV/CUT session must
  // be able to use the same logical key while LIVE remains independently owned.
  const sharedDocker = fakeDocker();
  const scopedStores = [];
  function scopedFixture(name) {
    const scopeRoot = path.join(root, 'independent-sessions', name);
    const scopeStore = createStateStore({ file: path.join(scopeRoot, 'state.sqlite3'),
      clock: () => now, ownerId: name });
    scopedStores.push(scopeStore);
    const dependencies = {
      state: scopeStore, runDocker: sharedDocker.run,
      linuxWorkspace: { runDocker: sharedDocker.run, prepare() {}, pinnedEndpoint: 'synthetic-only' },
      imageLockPath, disposableRoot: path.join(scopeRoot, 'disposable'),
      admissionGuardPath: path.join(root, 'admission.sqlite3'),
      authRoot: path.join(scopeRoot, 'auth'), now: () => now, audit: testAudit,
    };
    return { root: scopeRoot, store: scopeStore, provider: createSandboxProvider(dependencies),
      reopen: () => createSandboxProvider(dependencies) };
  }
  try {
    const live = scopedFixture('live'), dev = scopedFixture('dev'), cut = scopedFixture('cut');
    const request = { agent: 'codex', taskKey: 'task.shared.logical.key', sandboxKey: 'sandbox.shared.logical.key',
      networkMode: 'fixture', leaseSeconds: 120 };
    withSandboxAdmissionLock(path.join(root, 'admission.sqlite3'), () => {
      assert.throws(() => dev.provider.create(request), error => error.code === 'SANDBOX_CREATE_BUSY');
      assert.equal(sharedDocker.containers.size, 0, 'a busy shared admission guard must prevent container creation');
      assert.equal(sharedDocker.networks.size, 0, 'a busy shared admission guard must prevent network creation');
    });
    const liveSandbox = live.provider.create(request), devSandbox = dev.provider.create(request);
    assert.notEqual(liveSandbox.sandboxId, devSandbox.sandboxId,
      'independent state roots must not select the same daemon container/network names');
    const liveMarkerPath = path.join(path.dirname(liveSandbox.workspacePath), '.sandbox-owner.json');
    const devMarkerPath = path.join(path.dirname(devSandbox.workspacePath), '.sandbox-owner.json');
    const liveMarker = JSON.parse(fs.readFileSync(liveMarkerPath));
    const devMarker = JSON.parse(fs.readFileSync(devMarkerPath));
    assert.notEqual(liveMarker.scope, devMarker.scope);
    assert.equal(sharedDocker.networks.get(`${liveSandbox.sandboxId}-net`).Labels['org.toolsenabled.sandbox.scope'], liveMarker.scope);
    assert.equal(sharedDocker.containers.size, 4);
    assert.equal(sharedDocker.networks.size, 2);
    assert.equal(live.reopen().status({ sandboxId: liveSandbox.sandboxId }).observed.boundaryValid, true,
      'same state root after a restart must retain its persisted Docker ownership');

    const mutationCount = () => sharedDocker.calls.filter(call => ['run', 'build'].includes(call[0])
      || ['rm', 'create', 'exec', 'restart'].includes(call[1])).length;
    const beforeForeignCleanup = mutationCount();
    assert.throws(() => dev.provider.reap({ sandboxId: liveSandbox.sandboxId, confirmSandboxId: liveSandbox.sandboxId }),
      error => error.code === 'SANDBOX_OWNERSHIP_MISMATCH');
    assert.throws(() => dev.provider.cleanup({ handle: { ...devSandbox.handle, sandboxId: liveSandbox.sandboxId } }),
      error => error.code === 'SANDBOX_OWNERSHIP_MISMATCH');
    assert.equal(mutationCount(), beforeForeignCleanup, 'a foreign ID must refuse before any Docker mutation');

    // A copied marker/database must not turn a DEV path into LIVE's owner.
    const copiedPath = path.join(dev.root, 'disposable', liveSandbox.sandboxId);
    fs.mkdirSync(copiedPath, { recursive: true });
    fs.writeFileSync(path.join(copiedPath, '.sandbox-owner.json'), JSON.stringify(liveMarker));
    assert.throws(() => dev.provider.reap({ sandboxId: liveSandbox.sandboxId, confirmSandboxId: liveSandbox.sandboxId }),
      error => error.code === 'SANDBOX_OWNERSHIP_MISMATCH');
    assert.equal(mutationCount(), beforeForeignCleanup);

    assert.throws(() => cut.provider.create(request), error => error.code === 'SANDBOX_AGENT_CAPACITY_REACHED',
      'independent namespaces must still share the two-per-agent host quota');
    const more = [live.provider.create({ ...request, agent: 'claude' }), dev.provider.create({ ...request, agent: 'claude' })];
    assert.throws(() => cut.provider.create({ ...request, agent: 'gemini' }), error => error.code === 'SANDBOX_CAPACITY_REACHED',
      'the four-sandbox host budget must still count all profile namespaces');
    live.provider.cleanup({ handle: more[0].handle }); dev.provider.cleanup({ handle: more[1].handle });

    // A replaced network with a wrong generation cannot be deleted by cleanup.
    const devNetwork = sharedDocker.networks.get(`${devSandbox.sandboxId}-net`);
    const originalOperation = devNetwork.Labels['org.toolsenabled.sandbox.operation'];
    devNetwork.Labels['org.toolsenabled.sandbox.operation'] = liveSandbox.handle.operationId;
    assert.throws(() => dev.provider.cleanup({ handle: devSandbox.handle }), error => error.code === 'SANDBOX_OWNERSHIP_MISMATCH');
    assert.equal(sharedDocker.networks.has(`${devSandbox.sandboxId}-net`), true);
    assert.equal(live.provider.status({ sandboxId: liveSandbox.sandboxId }).observed.boundaryValid, true);
    devNetwork.Labels['org.toolsenabled.sandbox.operation'] = originalOperation;
    dev.provider.cleanup({ handle: devSandbox.handle });
    assert.equal(sharedDocker.containers.has(`${liveSandbox.sandboxId}-browser`), true);
    assert.equal(sharedDocker.networks.has(`${liveSandbox.sandboxId}-net`), true);

    // Seed an explicit pre-namespace v2 record, old names and real durable
    // operation. Its same-owner lookup/cleanup/reap must survive the upgrade.
    function legacyFixture(sandboxKey) {
      const legacyId = `sbx-${crypto.createHash('sha256').update(`${CONTRACT}\0codex\0${sandboxKey}`).digest('hex').slice(0, 20)}`;
      const reserved = live.store.reserveOperation({ type: OPERATION_TYPE, key: `codex:${sandboxKey}`,
        inputHash: hashInput({ contract: CONTRACT, sandboxId: legacyId, agent: 'codex', networkMode: 'fixture',
          limits: RESOURCE_LIMITS, imageId: IMAGE_ID }), leaseMs: 240000, ownerId: 'legacy-live' });
      const { handle } = live.store.markOperationExecuting(reserved.handle, { leaseMs: 240000 });
      const workspace = path.join(live.root, 'disposable', legacyId, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(path.dirname(workspace), '.sandbox-owner.json'), JSON.stringify({
        version: 2, contract: CONTRACT, sandboxId: legacyId, operationId: handle.operationId,
        agent: 'codex', networkMode: 'fixture', imageId: IMAGE_ID, createdAt: new Date(now).toISOString(),
      }));
      for (const role of ['browser', 'fixture']) {
        const resource = structuredClone(sharedDocker.containers.get(`${liveSandbox.sandboxId}-${role}`));
        resource.Id = `${legacyId}-${role}-legacy-id`;
        resource.Config.Labels['org.toolsenabled.sandbox.id'] = legacyId;
        resource.Config.Labels['org.toolsenabled.sandbox.operation'] = handle.operationId;
        delete resource.Config.Labels['org.toolsenabled.sandbox.scope'];
        resource.HostConfig.NetworkMode = `${legacyId}-net`;
        if (role === 'browser') resource.Mounts[0].Source = workspace;
        sharedDocker.containers.set(`${legacyId}-${role}`, resource);
      }
      const network = structuredClone(sharedDocker.networks.get(`${liveSandbox.sandboxId}-net`));
      network.Name = `${legacyId}-net`; network.Id = `${legacyId}-legacy-network-id`;
      network.Labels['org.toolsenabled.sandbox.id'] = legacyId;
      delete network.Labels['org.toolsenabled.sandbox.scope'];
      delete network.Labels['org.toolsenabled.sandbox.operation'];
      sharedDocker.networks.set(network.Name, network);
      return { sandboxId: legacyId, handle: { sandboxId: legacyId, ...handle } };
    }
    const legacy = legacyFixture('sandbox.legacy.cleanup');
    assert.equal(live.reopen().status({ sandboxId: legacy.sandboxId }).observed.boundaryValid, true);
    assert.throws(() => dev.provider.reap({ sandboxId: legacy.sandboxId, confirmSandboxId: legacy.sandboxId }),
      error => error.code === 'SANDBOX_OWNERSHIP_MISMATCH');
    assert.equal(live.reopen().cleanup({ handle: legacy.handle }).cleaned, true);
    const expiredLegacy = legacyFixture('sandbox.legacy.reap');
    live.provider.cleanup({ handle: liveSandbox.handle });
    now += 241000;
    assert.equal(live.reopen().reap({ sandboxId: expiredLegacy.sandboxId, confirmSandboxId: expiredLegacy.sandboxId }).reaped, true);
    assert.equal(sharedDocker.containers.size, 0);
    assert.equal(sharedDocker.networks.size, 0);
  } finally { for (const scopeStore of scopedStores) scopeStore.close(); }

  const authProfile = provider.createAuthProfile({ account: 'accta', purpose: 'agent-browser' });
  assert.match(authProfile.profileId, /^auth-[a-f0-9]{20}$/);
  assert.equal(authProfile.encryptedAtRest, true);
  assert.equal(authProfile.signInRequired, true);
  assert.equal(authProfile.cookieExportSupported, false);
  assert.equal(provider.createAuthProfile({ account: 'accta', purpose: 'agent-browser' }).replayed, true);
  const encryptedPath = path.join(root, 'auth', authProfile.profileId, 'profile.enc.json');
  const encryptedText = fs.readFileSync(encryptedPath, 'utf8');
  const envelopeOther = path.join(root, 'synthetic-envelope-copy.json');
  fs.renameSync(encryptedPath, envelopeOther);
  fileSymlinkFixture(envelopeOther, encryptedPath, 'auth-file.symlink');
  assert.throws(() => provider.authProfileStatus({ profileId: authProfile.profileId }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(encryptedPath);
  fs.linkSync(envelopeOther, encryptedPath);
  assert.throws(() => provider.authProfileStatus({ profileId: authProfile.profileId }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(encryptedPath);
  fs.renameSync(envelopeOther, encryptedPath);
  const envelopeRaceFs = Object.create(fs);
  envelopeRaceFs.openSync = (target, ...args) => {
    if (target === encryptedPath) { fs.renameSync(encryptedPath, envelopeOther); fs.writeFileSync(encryptedPath, encryptedText); }
    return fs.openSync(target, ...args);
  };
  assert.throws(() => providerUsing(docker, store, envelopeRaceFs).authProfileStatus({ profileId: authProfile.profileId }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(envelopeOther);
  const envelopeReadRaceFs = Object.create(fs);
  envelopeReadRaceFs.readSync = (...args) => {
    const count = fs.readSync(...args);
    fs.renameSync(encryptedPath, envelopeOther); fs.writeFileSync(encryptedPath, encryptedText);
    return count;
  };
  assert.throws(() => providerUsing(docker, store, envelopeReadRaceFs).authProfileStatus({ profileId: authProfile.profileId }), e => e.code === 'SANDBOX_PATH_INVALID');
  fs.unlinkSync(envelopeOther);
  const profileRoot = path.dirname(encryptedPath), movedProfile = path.join(root, 'moved-profile');
  fs.renameSync(profileRoot, movedProfile);
  fs.symlinkSync(movedProfile, profileRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => provider.createAuthProfile({ account: 'accta', purpose: 'agent-browser' }), e => e.code === 'SANDBOX_PATH_INVALID');
  assert.equal(fs.existsSync(path.join(movedProfile, '.lease.guard.json')), false);
  fs.unlinkSync(profileRoot); fs.renameSync(movedProfile, profileRoot);
  assert.doesNotMatch(encryptedText, /files/i, 'profile manifest is not stored in plaintext');
  const tamperedEnvelope = JSON.parse(encryptedText);
  tamperedEnvelope.tag = `${tamperedEnvelope.tag[0] === 'A' ? 'B' : 'A'}${tamperedEnvelope.tag.slice(1)}`;
  fs.writeFileSync(encryptedPath, `${JSON.stringify(tamperedEnvelope)}\n`, 'utf8');
  assert.throws(() => provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'claude',
    taskKey: 'task.auth.tampered',
    leaseSeconds: 120
  }), error => error && error.code === 'SANDBOX_AUTH_PROFILE_DECRYPT_FAILED');
  fs.writeFileSync(encryptedPath, encryptedText, 'utf8');

  const authLease = provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'claude',
    taskKey: 'task.auth.profile',
    leaseSeconds: 120
  });
  assert.equal(authLease.browserStarted, false);
  assert.equal(authLease.profile.signInRequired, true);
  const authLeasePath = path.join(root, 'auth', authProfile.profileId, 'lease.json');
  const intactLeaseRecord = fs.readFileSync(authLeasePath, 'utf8');
  const missingOperationRecord = JSON.parse(intactLeaseRecord);
  missingOperationRecord.operationId = 'operation-missing-state';
  fs.writeFileSync(authLeasePath, `${JSON.stringify(missingOperationRecord)}\n`, 'utf8');
  assert.throws(() => provider.authProfileStatus({ profileId: authProfile.profileId }),
    error => error && error.code === 'SANDBOX_AUTH_PROFILE_STATE_UNKNOWN');
  assert.throws(() => provider.revokeAuthProfile({
    profileId: authProfile.profileId,
    confirmProfileId: authProfile.profileId
  }), error => error && error.code === 'SANDBOX_AUTH_PROFILE_STATE_UNKNOWN',
  'unknown durable lease state must fail closed instead of deleting the profile');
  fs.writeFileSync(authLeasePath, intactLeaseRecord, 'utf8');
  assert.throws(() => provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'codex',
    taskKey: 'task.auth.second',
    leaseSeconds: 120
  }), error => error && error.code === 'SANDBOX_AUTH_PROFILE_LEASED');
  const released = provider.releaseAuthProfile({ handle: authLease.handle });
  assert.equal(released.released, true);
  assert.equal(released.operation.status, 'succeeded');
  const nextLease = provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'codex',
    taskKey: 'task.auth.second',
    leaseSeconds: 120
  });
  assert.ok(nextLease.handle.slotFence > authLease.handle.slotFence);
  assert.throws(() => provider.revokeAuthProfile({
    profileId: authProfile.profileId,
    confirmProfileId: authProfile.profileId
  }), error => error && error.code === 'SANDBOX_AUTH_PROFILE_LEASED');
  provider.releaseAuthProfile({ handle: nextLease.handle });
  const expiringLease = provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'gemini',
    taskKey: 'task.auth.expiring',
    leaseSeconds: 120
  });
  now += 121_000;
  const reclaimedLease = provider.leaseAuthProfile({
    profileId: authProfile.profileId,
    agent: 'gemini',
    taskKey: 'task.auth.reclaimed',
    leaseSeconds: 120
  });
  assert.ok(reclaimedLease.handle.slotFence > expiringLease.handle.slotFence,
    'an expired no-browser reservation must be safely reclaimable with a higher fence');
  assert.throws(() => provider.releaseAuthProfile({ handle: expiringLease.handle }),
    error => error && error.code === 'SANDBOX_AUTH_PROFILE_LEASE_LOST');
  provider.releaseAuthProfile({ handle: reclaimedLease.handle });
  const revoked = provider.revokeAuthProfile({
    profileId: authProfile.profileId,
    confirmProfileId: authProfile.profileId
  });
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.recoverable, false);
  assert.equal(provider.authProfileStatus({ profileId: authProfile.profileId }).exists, false);

  assert.ok(auditEvents.some(item => item.event === 'sandbox.container.create.intent'));
  assert.ok(auditEvents.some(item => item.event === 'sandbox.container.remove.intent'));
  assert.ok(auditEvents.some(item => item.event === 'sandbox.auth_profile.revoke.intent'));
  assert.doesNotMatch(JSON.stringify(auditEvents), /accta/i,
    'account identity must not be copied into durable audit details');
  assert.equal(docker.calls.some(call => call[0] === 'image' && ['rm', 'prune'].includes(call[1])), false);
  assert.equal(docker.calls.some(call => call[0] === 'volume' && ['rm', 'prune'].includes(call[1])), false);

  console.log('Agent sandbox provider tests passed.');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}

});
