'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const mirror = require('../src/lib/cloud-agent/cloud-mirror');
const { installationProfileRoot } = require('../src/lib/agent-session-confinement');

assert.equal(process.platform, 'win32', 'Cloud Mirror process containment is a shipped Windows contract');

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the focused Cloud Mirror regression precondition');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

async function foreignObjectDirectoryRefusesBeforeProbe(temp) {
  const source = path.join(temp, 'source');
  fs.mkdirSync(source, { recursive: true });
  const foreignObjects = 'C:\\Users\\fixture-user\\worktree.git\\objects';
  fs.writeFileSync(path.join(source, '.git'), `gitdir: ${path.dirname(foreignObjects)}\n`, 'utf8');
  const originalSpawnSync = childProcess.spawnSync;
  const originalExistsSync = fs.existsSync;
  const originalMkdtempSync = fs.mkdtempSync;
  const networkRoots = [];
  let foreignProbeCount = 0;

  childProcess.spawnSync = function controlledSpawnSync(command, args, options) {
    if (command === 'git') foreignProbeCount += 1;
    return originalSpawnSync.call(this, command, args, options);
  };
  fs.existsSync = function refusedForeignProbe(candidate) {
    if (path.resolve(String(candidate)).toLowerCase() === path.resolve(foreignObjects).toLowerCase()) {
      foreignProbeCount += 1;
      throw new Error('the foreign-profile provenance string reached existsSync');
    }
    return originalExistsSync.call(this, candidate);
  };
  fs.mkdtempSync = function recordedMkdtemp(prefix, options) {
    const created = originalMkdtempSync.call(this, prefix, options);
    if (String(prefix).includes('toolsenabled-cloud-mirror-git-')) networkRoots.push(created);
    return created;
  };

  let refusal;
  try {
    await mirror.defaultNetworkGit(source, ['status']);
  } catch (error) {
    refusal = error;
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    fs.existsSync = originalExistsSync;
    fs.mkdtempSync = originalMkdtempSync;
  }

  assert.equal(refusal && refusal.code, 'CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED');
  assert.equal(foreignProbeCount, 0, 'a redirecting .git file must be refused before any Git process is spawned or foreign path is probed');
  assert.equal(networkRoots.length, 0, 'source metadata is fenced before scratch creation or any Git initialization');
}

function linkedWorktreeMetadataIsParsedAndFenced(temp) {
  const common = path.join(temp, 'linked-common', '.git');
  const gitDirectory = path.join(common, 'worktrees', 'linked');
  const source = path.join(temp, 'linked-source');
  fs.mkdirSync(path.join(common, 'objects'), { recursive: true });
  fs.mkdirSync(gitDirectory, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(common, 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(gitDirectory, 'commondir'), '../..\n', 'utf8');
  fs.writeFileSync(path.join(source, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8');
  const metadata = mirror.sourceGitMetadata(source);
  assert.equal(path.resolve(metadata.gitDirectory), path.resolve(gitDirectory));
  assert.equal(path.resolve(metadata.commonDirectory), path.resolve(common));
  assert.equal(path.resolve(metadata.objects), path.resolve(common, 'objects'));
}

function redirectedLinkedMetadataRefusesWithoutForeignProbe(temp) {
  const cases = [];
  const foreign = 'C:\\Users\\fixture-user\\git-metadata';

  const commonSource = path.join(temp, 'foreign-common-source');
  const commonGit = path.join(temp, 'foreign-common-git');
  fs.mkdirSync(commonSource, { recursive: true });
  fs.mkdirSync(commonGit, { recursive: true });
  fs.writeFileSync(path.join(commonSource, '.git'), `gitdir: ${commonGit}\n`, 'utf8');
  fs.writeFileSync(path.join(commonGit, 'commondir'), `${foreign}\n`, 'utf8');
  cases.push(commonSource);

  const alternateSource = path.join(temp, 'foreign-alternate-source');
  fs.mkdirSync(path.join(alternateSource, '.git', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(alternateSource, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(alternateSource, '.git', 'objects', 'info', 'alternates'), `${foreign}\n`, 'utf8');
  cases.push(alternateSource);

  const chainedSource = path.join(temp, 'foreign-chained-source');
  const chainedAlternate = path.join(temp, 'first-hop-objects');
  fs.mkdirSync(path.join(chainedSource, '.git', 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(chainedAlternate, 'info'), { recursive: true });
  fs.writeFileSync(path.join(chainedSource, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  fs.writeFileSync(path.join(chainedSource, '.git', 'objects', 'info', 'alternates'), `${chainedAlternate}\n`, 'utf8');
  fs.writeFileSync(path.join(chainedAlternate, 'info', 'alternates'), `${foreign}\n`, 'utf8');
  cases.push(chainedSource);

  const linkedSource = path.join(temp, 'foreign-link-source');
  fs.mkdirSync(linkedSource, { recursive: true });
  fs.symlinkSync(foreign, path.join(linkedSource, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  cases.push(linkedSource);

  const originalLstat = fs.lstatSync;
  let foreignProbes = 0;
  fs.lstatSync = function trackedLstat(candidate, ...args) {
    if (path.resolve(String(candidate)).toLowerCase().startsWith(path.resolve(foreign).toLowerCase())) foreignProbes += 1;
    return originalLstat.call(this, candidate, ...args);
  };
  try {
    for (const source of cases) {
      assert.throws(() => mirror.sourceGitMetadata(source), error => error
        && ['CLOUD_MIRROR_ACCOUNT_BOUNDARY_REFUSED', 'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE'].includes(error.code));
    }
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(foreignProbes, 0, 'foreign commondir and alternates are refused lexically before lstat');
}

function ambientGitControlsAreRemoved(temp) {
  const originalSpawnSync = childProcess.spawnSync;
  const prior = {};
  const controls = [
    'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE',
    'GIT_NO_REPLACE_OBJECTS', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
    'GIT_CONFIG_GLOBAL'
  ];
  let observed;
  try {
    for (const key of controls) {
      prior[key] = process.env[key];
      process.env[key] = 'C:\\Users\\fixture-user\\redirect';
    }
    childProcess.spawnSync = (command, args, options) => {
      observed = options.env;
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    assert.equal(mirror.runGitSync(temp, ['status']), 'ok');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    for (const key of controls) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
  for (const key of controls) {
    if (key === 'GIT_CONFIG_GLOBAL' || key === 'GIT_NO_REPLACE_OBJECTS') {
      assert.notEqual(observed[key], 'C:\\Users\\fixture-user\\redirect');
    }
    else assert.equal(Object.hasOwn(observed, key), false, `${key} must not reach local Git`);
  }
  assert.equal(observed.GIT_OPTIONAL_LOCKS, '0', 'local plumbing cannot refresh the customer checkout index');
  assert.equal(observed.GIT_NO_LAZY_FETCH, '1', 'local object reads cannot turn a partial clone into a network fetch');
  assert.equal(observed.GIT_NO_REPLACE_OBJECTS, '1', 'replacement refs cannot substitute another object graph under the real source commit id');
  assert.equal(observed.GIT_CONFIG_COUNT, '2');
  assert.equal(observed.GIT_CONFIG_KEY_0, 'core.fsmonitor');
  assert.equal(observed.GIT_CONFIG_VALUE_0, 'false', 'checkout-local fsmonitor process authority is disabled at command scope');
  assert.equal(observed.GIT_CONFIG_KEY_1, 'commit.gpgSign');
  assert.equal(observed.GIT_CONFIG_VALUE_1, 'false', 'local signing policy cannot make commit-tree spawn a configured signer');
}

function runGit(repo, args, options = {}) {
  const result = childProcess.spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
  assert.equal(result.error, undefined, `git ${args[0]} did not spawn`);
  return result;
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function maliciousFsmonitorCannotRunOrRefreshIndex(temp) {
  const source = path.join(temp, 'fsmonitor-source');
  const hook = path.join(temp, 'hostile-fsmonitor.sh');
  const marker = path.join(temp, 'fsmonitor-invoked');
  fs.mkdirSync(source, { recursive: true });
  assert.equal(childProcess.spawnSync('git', ['init', source], { encoding: 'utf8', windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'tracked bytes\n', 'utf8');
  assert.equal(runGit(source, ['add', '--', 'tracked.txt']).status, 0);
  assert.equal(runGit(source, ['-c', 'user.name=Cloud Mirror oracle', '-c', 'user.email=oracle@example.invalid', 'commit', '-m', 'fixture']).status, 0);

  fs.writeFileSync(hook, `#!/bin/sh\nprintf invoked > ${shellQuote(shellPath(marker))}\nexit 0\n`, 'utf8');
  assert.equal(runGit(source, ['config', 'core.fsmonitor', shellPath(hook)]).status, 0);
  assert.equal(runGit(source, ['status', '--porcelain']).status, 0, 'precondition: ordinary Git can invoke the configured fsmonitor hook');
  assert.equal(fs.existsSync(marker), true, 'precondition: the malicious checkout hook is executable');
  fs.unlinkSync(marker);

  const index = path.join(source, '.git', 'index');
  const indexBefore = fileSha256(index);
  const trackedBefore = fileSha256(path.join(source, 'tracked.txt'));
  mirror.runGitSync(source, ['status', '--porcelain', '-z']);
  assert.equal(fs.existsSync(marker), false, 'Cloud Mirror local status must not execute the checkout fsmonitor hook');
  assert.equal(fileSha256(index), indexBefore, 'Cloud Mirror local status must not refresh or rewrite the real index');
  assert.equal(fileSha256(path.join(source, 'tracked.txt')), trackedBefore, 'Cloud Mirror local status must not change checkout bytes');
}

function configuredWorktreeCannotRedirectStatus(temp) {
  for (const mode of ['config', 'config.worktree']) {
    const source = path.join(temp, `worktree-source-${mode.replace('.', '-')}`);
    const outside = path.join(temp, `worktree-outside-${mode.replace('.', '-')}`);
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    assert.equal(childProcess.spawnSync('git', ['init', source], { encoding: 'utf8', windowsHide: true }).status, 0);
    fs.writeFileSync(path.join(source, 'tracked.txt'), 'selected checkout\n', 'utf8');
    assert.equal(runGit(source, ['add', '--', 'tracked.txt']).status, 0);
    assert.equal(runGit(source, ['-c', 'user.name=Cloud Mirror oracle', '-c', 'user.email=oracle@example.invalid', 'commit', '-m', 'fixture']).status, 0);
    fs.writeFileSync(path.join(outside, 'tracked.txt'), 'redirected checkout\n', 'utf8');

    if (mode === 'config') {
      assert.equal(runGit(source, ['config', 'core.worktree', shellPath(outside)]).status, 0);
    } else {
      assert.equal(runGit(source, ['config', 'extensions.worktreeConfig', 'true']).status, 0);
      assert.equal(runGit(source, ['config', '--worktree', 'core.worktree', shellPath(outside)]).status, 0);
    }

    const ordinary = runGit(source, ['status', '--porcelain']);
    assert.equal(ordinary.status, 0);
    assert.match(ordinary.stdout, /tracked\.txt/, `precondition: ${mode} redirects ordinary status away from the selected checkout`);
    const index = path.join(source, '.git', 'index');
    const indexBefore = fileSha256(index);
    const protectedStatus = String(mirror.runGitSync(source, ['status', '--porcelain']));
    assert.equal(protectedStatus, '', `Cloud Mirror must pin the selected work tree over ${mode}`);
    assert.equal(fileSha256(index), indexBefore, `Cloud Mirror must not mutate the real index under ${mode}`);
    assert.equal(fs.readFileSync(path.join(outside, 'tracked.txt'), 'utf8'), 'redirected checkout\n');
  }
}

function commitTreeCannotInvokeConfiguredSigner(temp) {
  const source = path.join(temp, 'signing-source');
  const signer = path.join(temp, 'hostile-signer.sh');
  const marker = path.join(temp, 'signer-invoked');
  fs.mkdirSync(source, { recursive: true });
  assert.equal(childProcess.spawnSync('git', ['init', source], { encoding: 'utf8', windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(source, 'tracked.txt'), 'tracked bytes\n', 'utf8');
  assert.equal(runGit(source, ['add', '--', 'tracked.txt']).status, 0);
  const tree = runGit(source, ['write-tree']).stdout.trim();
  fs.writeFileSync(signer, `#!/bin/sh\nprintf invoked > ${shellQuote(shellPath(marker))}\nexit 1\n`, 'utf8');
  assert.equal(runGit(source, ['config', 'commit.gpgSign', 'true']).status, 0);
  assert.equal(runGit(source, ['config', 'user.signingKey', 'fixture']).status, 0);
  assert.equal(runGit(source, ['config', 'gpg.program', shellPath(signer)]).status, 0);

  const commit = String(mirror.runGitSync(source, [
    '-c', 'user.name=Cloud Mirror oracle', '-c', 'user.email=oracle@example.invalid',
    'commit-tree', tree, '-m', 'contained publication'
  ])).trim();
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  assert.equal(fs.existsSync(marker), false, 'repository signing config must not execute a program during Cloud Mirror commit-tree');
}

async function promisorLazyFetchCannotReachNetworkOrCredentialHelper(temp) {
  const source = path.join(temp, 'promisor-source');
  const serverScript = path.join(temp, 'promisor-server.js');
  const helperScript = path.join(temp, 'credential-helper.js');
  const readyFile = path.join(temp, 'promisor-server-ready.json');
  const countFile = path.join(temp, 'promisor-server-count');
  const helperMarker = path.join(temp, 'credential-helper-invoked');
  fs.mkdirSync(source, { recursive: true });
  assert.equal(childProcess.spawnSync('git', ['init', source], { encoding: 'utf8', windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(source, 'promised.txt'), 'promised fixture bytes\n', 'utf8');
  assert.equal(runGit(source, ['add', '--', 'promised.txt']).status, 0);
  assert.equal(runGit(source, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'known promised blob']).status, 0);
  const missingObject = runGit(source, ['rev-parse', 'HEAD:promised.txt']).stdout.trim();
  const looseObject = path.join(source, '.git', 'objects', missingObject.slice(0, 2), missingObject.slice(2));
  assert.equal(fs.existsSync(looseObject), true, 'precondition: the promised fixture blob starts as a loose local object');
  fs.unlinkSync(looseObject);

  fs.writeFileSync(serverScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    'let count = 0;',
    'const server = http.createServer((_request, response) => {',
    '  fs.writeFileSync(process.argv[3], String(++count));',
    "  response.writeHead(401, { 'www-authenticate': 'Basic realm=cloud-mirror-oracle', connection: 'close' });",
    "  response.end('credentials required');",
    '});',
    "server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[2], JSON.stringify(server.address())));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(helperScript, [
    "'use strict';",
    "require('node:fs').writeFileSync(process.argv[2], 'invoked');",
    "process.stdout.write('username=fixture\\npassword=fixture\\n');",
    ''
  ].join('\n'), 'utf8');

  const server = childProcess.spawn(process.execPath, [serverScript, readyFile, countFile], {
    windowsHide: true,
    stdio: 'ignore'
  });
  try {
    await waitUntil(() => fs.existsSync(readyFile));
    const address = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
    const remote = `http://127.0.0.1:${address.port}/fixture.git`;
    const helper = `!${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(helperScript))} ${shellQuote(shellPath(helperMarker))}`;
    for (const [key, value] of [
      ['core.repositoryFormatVersion', '1'],
      ['extensions.partialClone', 'origin'],
      ['remote.origin.url', remote],
      ['remote.origin.promisor', 'true'],
      ['remote.origin.partialCloneFilter', 'blob:none'],
      ['credential.helper', helper],
      ['http.proxy', '']
    ]) assert.equal(runGit(source, ['config', key, value]).status, 0);

    const ordinary = runGit(source, ['cat-file', '-e', missingObject], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_ALLOW_PROTOCOL: 'http',
        GIT_TERMINAL_PROMPT: '0',
        NO_PROXY: '127.0.0.1',
        no_proxy: '127.0.0.1'
      }
    });
    assert.notEqual(ordinary.status, 0, 'precondition: the server has no requested object');
    await waitUntil(() => fs.existsSync(countFile));
    assert.equal(fs.existsSync(helperMarker), true,
      `precondition: ordinary promisor lookup must invoke the configured credential helper; stderr=${String(ordinary.stderr || '').trim()}`);
    const requestsBefore = Number(fs.readFileSync(countFile, 'utf8'));
    assert.ok(requestsBefore > 0, 'precondition: ordinary promisor lookup reached the configured remote');
    fs.unlinkSync(helperMarker);

    assert.throws(() => mirror.runGitSync(source, ['cat-file', '-e', missingObject]), error => error
      && error.code === 'CLOUD_MIRROR_GIT_FAILED');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(helperMarker), false, 'Cloud Mirror missing-object reads must not invoke a checkout credential helper');
    assert.equal(Number(fs.readFileSync(countFile, 'utf8')), requestsBefore,
      'Cloud Mirror missing-object reads must not make a promisor network request');
  } finally {
    try { server.kill(); } catch { /* exact local oracle process already exited */ }
    await waitUntil(() => server.exitCode !== null || server.signalCode !== null).catch(() => {});
  }
}

function alternateTraversalIsBounded(temp) {
  const source = path.join(temp, 'bounded-alternate-source');
  const primary = path.join(source, '.git', 'objects');
  fs.mkdirSync(path.join(primary, 'info'), { recursive: true });
  fs.writeFileSync(path.join(source, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n', 'utf8');
  let previous = primary;
  for (let index = 0; index < 12; index += 1) {
    const next = path.join(temp, `bounded-alternate-${index}`);
    fs.mkdirSync(path.join(next, 'info'), { recursive: true });
    fs.writeFileSync(path.join(previous, 'info', 'alternates'), `${next}\n`, 'utf8');
    previous = next;
  }
  assert.throws(() => mirror.sourceGitMetadata(source), error => error
    && error.code === 'CLOUD_MIRROR_GIT_ALTERNATE_LIMIT');
}

function systemCredentialHelperDiscoveryDisablesIncludes() {
  const originalSpawnSync = childProcess.spawnSync;
  let discoveryArgs = null;
  childProcess.spawnSync = (command, args) => {
    if (command === 'git' && args[0] === 'config') {
      discoveryArgs = args.slice();
      return { status: 1, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'controlled init refusal' };
  };
  try {
    assert.throws(() => mirror.defaultNetworkGit(null, ['status']), error => error
      && error.code === 'CLOUD_MIRROR_GIT_DESTINATION_UNPROVABLE');
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.deepEqual(discoveryArgs,
    ['config', '--system', '--no-includes', '--get-all', 'credential.helper']);
}

async function timeoutTerminatesTreeBeforeScratchCleanup(temp) {
  const descendantScript = path.join(temp, 'descendant.js');
  const rootScript = path.join(temp, 'root.js');
  const rootPidFile = path.join(temp, 'root.pid');
  const descendantPidFile = path.join(temp, 'descendant.pid');
  const descendantReady = path.join(temp, 'descendant.ready');
  fs.writeFileSync(descendantScript, [
    "'use strict';",
    `require('node:fs').writeFileSync(${JSON.stringify(descendantReady)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(rootScript, [
    "'use strict';",
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid));`,
    `const child = spawn(process.execPath, [${JSON.stringify(descendantScript)}], { detached: true, windowsHide: true, stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
    'child.unref();',
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'), 'utf8');

  const originalMkdtempSync = fs.mkdtempSync;
  const networkRoots = [];
  fs.mkdtempSync = function recordedMkdtemp(prefix, options) {
    const created = originalMkdtempSync.call(this, prefix, options);
    if (String(prefix).includes('toolsenabled-cloud-mirror-git-')) networkRoots.push(created);
    return created;
  };

  let rootPid = null;
  let descendantPid = null;
  try {
    const alias = `!${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(rootScript))}`;
    const operation = mirror.defaultNetworkGit(null, ['-c', `alias.cloud-mirror-timeout=${alias}`, 'cloud-mirror-timeout'], {
      timeoutMs: 5_000
    });
    await waitUntil(() => fs.existsSync(rootPidFile) && fs.existsSync(descendantReady), 4_000);
    rootPid = Number(fs.readFileSync(rootPidFile, 'utf8'));
    descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
    assert.equal(alive(rootPid), true, 'precondition: the Git alias helper is running');
    assert.equal(alive(descendantPid), true, 'precondition: its detached descendant is running');

    const result = await operation;
    assert.equal(result.timedOut, true);
    await waitUntil(() => !alive(rootPid) && !alive(descendantPid));
    assert.equal(networkRoots.length, 1);
    assert.equal(fs.existsSync(networkRoots[0]), false,
      'the scratch repository is removed only after the contained process tree reaches zero');
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
    for (const pid of [descendantPid, rootPid]) {
      if (alive(pid)) {
        try { process.kill(pid); } catch { /* exact focused-test process already exited */ }
      }
    }
    for (const root of networkRoots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* report comes from assertions above */ }
    }
  }
}

(async () => {
  const accountTemp = path.join(installationProfileRoot(), 'AppData', 'Local', 'Temp');
  const temp = fs.mkdtempSync(path.join(accountTemp, 'toolsenabled-cloud-mirror-containment-'));
  try {
    await foreignObjectDirectoryRefusesBeforeProbe(temp);
    linkedWorktreeMetadataIsParsedAndFenced(temp);
    redirectedLinkedMetadataRefusesWithoutForeignProbe(temp);
    ambientGitControlsAreRemoved(temp);
    maliciousFsmonitorCannotRunOrRefreshIndex(temp);
    configuredWorktreeCannotRedirectStatus(temp);
    commitTreeCannotInvokeConfiguredSigner(temp);
    await promisorLazyFetchCannotReachNetworkOrCredentialHelper(temp);
    alternateTraversalIsBounded(temp);
    systemCredentialHelperDiscoveryDisablesIncludes();
    await timeoutTerminatesTreeBeforeScratchCleanup(temp);
    process.stdout.write('cloud-mirror-network-containment: path fence, inert checkout config, offline promisor reads, and timeout tree cleanup passed\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  process.stderr.write(`${error && (error.stack || error.message || error)}\n`);
  process.exitCode = 1;
});
