'use strict';

// Synthetic Linux coverage for exact workspace resource identity. Each run
// owns both its workspace and sibling coordination root; teardown removes only
// the fresh root created by that run.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const contexts = require('../src/lib/file-tool-context');
const boundary = require('../src/lib/account-profile-boundary');
const { createByteAuthority } = require('../src/lib/region-holds/byte-authority');
const { FraWorkspaceHandleBroker } = require('../src/lib/providers/fra-workspace-handles');

const LAB = Object.freeze({
  registry: {
    schemaVersion: 1,
    machines: {
      left: { address: '203.0.113.1' },
      right: { address: '203.0.113.2' }
    },
    services: {}
  }
});

function makeRun(label) {
  const runRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'fra-exact-workspace-' + label + '-'
  ));
  const workspace = path.join(runRoot, 'workspace');
  const coordinationRoot = path.join(runRoot, 'coordination');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(coordinationRoot, { mode: 0o700 });
  return { runRoot, workspace, coordinationRoot, scopes: [] };
}

function boundContext(fixture, label) {
  const key = 'fra-exact-workspace-' + label + '-' + crypto.randomUUID();
  const workspaceContext = Object.freeze({
    sessionContextDigest: crypto.createHash('sha256').update(key).digest('hex'),
    generation: 71,
    serverHost: '203.0.113.2',
    clientHost: '203.0.113.1'
  });
  const fileToolContext = contexts.createFraFileToolContext({
    workspaceContext,
    assertCurrent() {}
  });
  const result = { fraWorkspaceContext: workspaceContext, fileToolContext };
  fixture.scopes.push(result);
  return result;
}

function authorityBinding(name) {
  return {
    principal: name,
    runtimeScopeId: 'scope-' + name,
    scopeKind: 'owner-host-session',
    canonicalLaunchId: null,
    laneId: null,
    runId: null,
    rosterRef: null
  };
}

function exactMaterialize(file) {
  if (!path.isAbsolute(file)) throw new Error('exact fixture requires an absolute resource');
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('exact fixture refuses non-regular or linked resources');
  }
  return {
    present: true,
    bytes: fs.readFileSync(file),
    identity: String(stat.dev) + ':' + String(stat.ino)
  };
}

function makeAuthority(root, materializations = null) {
  return createByteAuthority({
    stateRoot: root,
    materialize(file) {
      const materialized = exactMaterialize(file);
      if (materializations) {
        materializations.push({
          file,
          identity: materialized.identity,
          bytes: Buffer.from(materialized.bytes)
        });
      }
      return materialized;
    },
    publish() {
      throw new Error('exact workspace fixture has no write adapter');
    }
  });
}

function brokerFor(fixture, materializations = null) {
  const authority = makeAuthority(fixture.coordinationRoot, materializations);
  const broker = new FraWorkspaceHandleBroker({
    root: fixture.workspace,
    serviceRegistryOptions: LAB,
    authorityFactory: scope => {
      const binding = contexts.requireFileToolContext(scope);
      contexts.onFileToolContextRetired(
        scope,
        authority,
        reason => authority.closeLaunch({ binding, reason })
      );
      return authority;
    },
    auditApi: {
      record: () => ({ durable: true, anchored: true })
    }
  });
  return { broker, authority };
}

function loadWindowsBoundary() {
  const sourcePath = path.join(__dirname, '..', 'src', 'lib', 'account-profile-boundary.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const module = { exports: {} };
  const sandboxProcess = {
    ...process,
    platform: 'win32',
    env: { ...process.env, SystemRoot: 'C:\\Windows' },
    execPath: 'C:\\Windows\\System32\\node.exe'
  };
  const sandboxRequire = specifier => require(specifier);
  const context = vm.createContext({
    Buffer,
    console,
    module,
    process: sandboxProcess,
    require: sandboxRequire,
    __filename: sourcePath,
    __dirname: path.dirname(sourcePath)
  });
  vm.runInContext(
    `(function (require, module, exports, __filename, __dirname) {\n${source}\n})`,
    context,
    { filename: sourcePath }
  )(sandboxRequire, module, module.exports, sourcePath, path.dirname(sourcePath));
  return module.exports;
}

async function readFile(broker, bound, entry) {
  const invocation = contexts.beginFileToolInvocation(bound.fileToolContext, {
    invocationId: 'invocation-' + crypto.randomUUID(),
    toolName: 'workspace.read'
  });
  try {
    return await broker.read({
      fileHandle: entry.handle,
      expectedVersion: entry.version,
      encoding: 'utf8'
    }, { ...bound, fileToolInvocation: invocation });
  } finally {
    contexts.endFileToolInvocation(invocation);
  }
}

async function withRun(label, callback) {
  const fixture = makeRun(label);
  try {
    return await callback(fixture);
  } finally {
    await Promise.all(fixture.scopes.map(value => contexts.retireFileToolContext(
      value.fileToolContext,
      'exact-workspace-fixture-finished'
    )));
    fs.rmSync(fixture.runRoot, { recursive: true, force: true });
    const absent = !fs.existsSync(fixture.runRoot);
    process.stdout.write('# fixture-root=' + JSON.stringify(fixture.runRoot)
      + ' absent=' + absent + '\n');
    assert.equal(absent, true, 'same-run synthetic root must be absent after ' + label);
  }
}

test('trailing-space and ordinary siblings retain distinct handles and bytes', async t => {
  if (process.platform !== 'linux') {
    return t.skip('Linux exact trailing-space proof; Windows extended NT proof is deferred');
  }
  await withRun('siblings', async fixture => {
    const ordinaryPath = path.join(fixture.workspace, 'space.txt');
    const exactPath = ordinaryPath + ' ';
    fs.writeFileSync(ordinaryPath, 'synthetic ordinary basename');
    fs.writeFileSync(exactPath, 'synthetic trailing-space basename');
    const materializations = [];
    const { broker, authority } = brokerFor(fixture, materializations);
    const directExact = await authority.observeRead({
      binding: authorityBinding('direct-exact'),
      resource: exactPath,
      exactWorkspace: true
    });
    const directTrimmed = await authority.observeRead({
      binding: authorityBinding('direct-trimmed'),
      resource: exactPath
    });
    assert.equal(directExact.receipt.resource, exactPath);
    assert.deepEqual(directExact.bytes, Buffer.from('synthetic trailing-space basename'));
    assert.equal(directTrimmed.receipt.resource, ordinaryPath);
    assert.deepEqual(directTrimmed.bytes, Buffer.from('synthetic ordinary basename'));
    const exactMaterializations = materializations.filter(value => value.file === exactPath);
    const ordinaryMaterializations = materializations.filter(value => value.file === ordinaryPath);
    assert.ok(exactMaterializations.length > 0, 'exact observeRead must materialize the exact resource');
    assert.ok(ordinaryMaterializations.length > 0, 'trimmed observeRead must materialize the trimmed resource');
    assert.ok(
      exactMaterializations.every(value => value.bytes.equals(Buffer.from('synthetic trailing-space basename'))),
      'exact materialization calls must read the trailing-space sibling'
    );
    assert.ok(
      ordinaryMaterializations.every(value => value.bytes.equals(Buffer.from('synthetic ordinary basename'))),
      'trimmed materialization calls must read the ordinary sibling'
    );
    assert.notEqual(
      exactMaterializations[0].identity,
      ordinaryMaterializations[0].identity,
      'distinct sibling materializations must retain distinct filesystem identities'
    );
    assert.equal(
      exactMaterializations[0].file,
      directExact.receipt.resource,
      'exact receipt resource must equal the exact materializer argument'
    );

    const bound = boundContext(fixture, 'siblings');
    const listed = broker.list({ limit: 10 }, bound);
    const ordinary = listed.entries.find(value => value.name === 'space.txt');
    const exact = listed.entries.find(value => value.name === 'space.txt ');
    assert.ok(ordinary, 'ordinary sibling must be listed');
    assert.ok(exact, 'trailing-space sibling must be listed');
    assert.notEqual(ordinary.handle, exact.handle);
    assert.notEqual(ordinary.version, exact.version);
    const ordinaryRead = await readFile(broker, bound, ordinary);
    const exactRead = await readFile(broker, bound, exact);
    assert.equal(ordinaryRead.content, 'synthetic ordinary basename');
    assert.equal(exactRead.content, 'synthetic trailing-space basename');
  });
});

test('exact workspace admission keeps ordinary trim semantics but refuses other whitespace', async t => {
  if (process.platform !== 'linux') {
    return t.skip('Linux boundary parity proof; Windows extended NT proof is deferred');
  }
  await withRun('boundary', async fixture => {
    const ordinaryPath = path.join(fixture.workspace, 'space.txt');
    const exactPath = ordinaryPath + ' ';
    fs.writeFileSync(ordinaryPath, 'synthetic ordinary basename');
    fs.writeFileSync(exactPath, 'synthetic trailing-space basename');
    assert.equal(
      boundary.assertAccountProfilePath(exactPath, { field: 'ordinary resource' }),
      ordinaryPath
    );
    assert.equal(
      boundary.assertAccountProfilePath(exactPath, {
        field: 'exact workspace resource',
        exactWorkspace: true
      }),
      exactPath
    );
    assert.equal(
      boundary.assertAccountProfilePath(' ' + ordinaryPath, { field: 'ordinary resource' }),
      ordinaryPath,
      'ordinary callers continue to trim surrounding whitespace'
    );
    for (const suffix of ['\t', '\n', ' \t']) {
      assert.throws(
        () => boundary.assertAccountProfilePath(ordinaryPath + suffix, {
          field: 'exact workspace resource',
          exactWorkspace: true
        }),
        error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_PATH_INVALID'
      );
    }
    assert.throws(
      () => boundary.assertAccountProfilePath('relative/space.txt ', {
        field: 'ordinary resource'
      }),
      error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_PATH_INVALID'
    );
    assert.throws(
      () => boundary.assertAccountProfilePath('relative/space.txt ', {
        field: 'exact workspace resource',
        exactWorkspace: true
      }),
      error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_PATH_INVALID'
    );
  });
});

function mockedWindowsFileSystem({ reparsePaths = [], unavailablePaths = [] } = {}) {
  const refused = new Set(reparsePaths.map(value => path.win32.normalize(value).toLowerCase()));
  const unavailable = new Set(unavailablePaths.map(value => path.win32.normalize(value).toLowerCase()));
  const realpathSync = value => value;
  realpathSync.native = realpathSync;
  return {
    lstatSync(value) {
      const normalized = path.win32.normalize(value).toLowerCase();
      if (unavailable.has(normalized)) {
        throw Object.assign(new Error('synthetic denied local metadata'), { code: 'EACCES' });
      }
      return { isSymbolicLink: () => refused.has(normalized) };
    },
    realpathSync
  };
}

test('inert Windows policy mocks preserve trimmed and exact refusal parity', async t => {
  const windowsBoundary = loadWindowsBoundary();
  // Synthetic Windows profile paths, assembled at runtime so the source carries no
  // literal user path.
  const profileRoot = ['C:', 'Users', 'ToolsEnabled', 'profile'].join('\\');
  const base = path.win32.join(profileRoot, 'workspace', 'space.txt');
  const exact = base + ' ';
  const remote = '\\\\unknown-host\\share\\space.txt ';
  const field = 'mocked exact workspace resource';
  assert.throws(
    () => windowsBoundary.assertAccountProfilePath(exact, {
      field,
      profileRoot,
      exactWorkspace: true,
      fileSystem: mockedWindowsFileSystem({ reparsePaths: [base] }),
      resolveProfileShortPath: () => null
    }),
    error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT',
    'a reparsed trimmed spelling refuses an otherwise safe exact sibling'
  );
  assert.doesNotThrow(() => windowsBoundary.assertAccountProfilePath(base, {
    field,
    profileRoot,
    fileSystem: mockedWindowsFileSystem(),
    resolveProfileShortPath: () => null
  }));
  assert.doesNotThrow(() => windowsBoundary.assertAccountProfilePath(exact, {
    field,
    profileRoot,
    exactWorkspace: true,
    fileSystem: mockedWindowsFileSystem(),
    resolveProfileShortPath: () => null
  }));
  assert.throws(
    () => windowsBoundary.assertAccountProfilePath(exact, {
      field,
      profileRoot,
      exactWorkspace: true,
      fileSystem: mockedWindowsFileSystem({ reparsePaths: [exact] }),
      resolveProfileShortPath: () => null
    }),
    error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT',
    'an exact spelling that is reparsed refuses after the trimmed spelling passes'
  );
  assert.throws(
    () => windowsBoundary.assertAccountProfilePath(exact, {
      field,
      profileRoot,
      exactWorkspace: true,
      fileSystem: mockedWindowsFileSystem({ unavailablePaths: [base] }),
      resolveProfileShortPath: () => null
    }),
    error => error && error.code === 'AGENT_CONFINEMENT_PROFILE_PATH_UNAVAILABLE',
    'ambiguous local metadata refuses before exact admission'
  );
  assert.throws(
    () => windowsBoundary.assertAccountProfilePath(['C:', 'Users', 'Other', 'profile', 'space.txt '].join('\\'), {
      field,
      profileRoot,
      exactWorkspace: true,
      fileSystem: mockedWindowsFileSystem(),
      resolveProfileShortPath: () => null
    }),
    error => error && error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE',
    'foreign profile spelling refuses without probing the foreign path'
  );
  assert.equal(
    windowsBoundary.assertAccountProfilePath(remote, {
      field,
      profileRoot,
      fileSystem: mockedWindowsFileSystem(),
      resolveProfileShortPath: () => null
    }),
    remote.trim(),
    'ordinary remote UNC admission retains its historical trimmed semantics'
  );
  assert.equal(
    windowsBoundary.assertAccountProfilePath(remote, {
      field,
      profileRoot,
      exactWorkspace: true,
      fileSystem: mockedWindowsFileSystem(),
      resolveProfileShortPath: () => null
    }),
    remote,
    'exact workspace admission retains the admitted remote UNC identity'
  );
});
