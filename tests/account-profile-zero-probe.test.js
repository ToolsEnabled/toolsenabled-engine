'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

// Actual Windows boundary code, with synthetic names and filesystem responses.
// No Alice/Bob/8.3 spelling below is ever handed to the operating system.
const sourceFile = path.resolve(__dirname, '../src/lib/account-profile-boundary.js');
const boundaryModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
  module: boundaryModule, exports: boundaryModule.exports, require: createRequire(sourceFile),
  __dirname: path.dirname(sourceFile), Buffer,
  process: { platform: 'win32', execPath: 'C:\\agent-apps\\node-v22.19.0\\node.exe', env: { SystemRoot: 'C:\\Windows' } }
}, { filename: sourceFile, timeout: 1000 });
const boundary = boundaryModule.exports;
const OWNER = 'C:\\Users\\Alpha Person';
const SHORT = 'C:\\Users\\ALPHAP~1';

function noProbeFileSystem() {
  const calls = [];
  return { calls, fileSystem: {
    lstatSync(value) { calls.push(['lstat', value]); throw new Error('unexpected filesystem access'); },
    realpathSync(value) { calls.push(['realpath', value]); throw new Error('unexpected filesystem access'); }
  } };
}

test('hostile profile paths refuse lexically with zero filesystem probes', () => {
  for (const value of [
    'C:\\Users\\Bob\\AppData\\Local',
    `${OWNER}\\..\\Bob\\AppData\\Local`,
    'C:\\Users\\ALPHAP~2\\AppData\\Local',
    `${SHORT}-other\\AppData\\Local`,
    '\\\\localhost\\C$\\Users\\Bob\\AppData\\Local',
    '\\\\?\\C:\\Users\\Bob\\AppData\\Local',
    '\\\\remote.invalid\\C$\\Users\\Alpha Person\\AppData\\Local'
  ]) {
    const f = noProbeFileSystem();
    const queries = [];
    assert.throws(() => boundary.assertAccountProfilePath(value, {
      profileRoot: OWNER, requireOwnedProfile: true, fileSystem: f.fileSystem,
      resolveProfileShortPath(profile) { queries.push(profile); return SHORT; }
    }), error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE');
    assert.deepEqual(f.calls, [], `foreign candidate must never be probed: ${value}`);
    assert.ok(queries.every(value => value === OWNER), 'alias metadata may concern only the trusted owner');
    if (!value.includes('~')) assert.deepEqual(queries, [], 'an ordinary foreign name needs no native lookup');
  }
});

test('unbound installation modules and wrong principals cannot trigger a candidate lookup', () => {
  for (const moduleDirectory of [
    'C:\\Users\\Bob\\src\\engine\\src\\lib',
    'C:\\Users\\ALPHAP~2\\src\\engine\\src\\lib',
    'C:\\Program Files\\ToolsEnabled\\resources\\capability\\src\\lib',
    'D:\\Builds\\toolsenabled\\src\\lib'
  ]) {
    const f = noProbeFileSystem();
    assert.throws(() => boundary.installationProfileRoot({
      platform: 'win32', moduleDirectory, executablePath: 'C:\\agent-apps\\node.exe',
      userInfo: () => ({ homedir: OWNER }), fileSystem: f.fileSystem,
      resolveProfileShortPath: () => SHORT
    }), error => error.code === 'AGENT_CONFINEMENT_ACCOUNT_PROFILE_UNAVAILABLE');
    assert.deepEqual(f.calls, []);
  }
  const f = noProbeFileSystem();
  assert.throws(() => boundary.installationProfileRoot({ platform: 'win32',
    moduleDirectory: 'C:\\Users\\Bob\\AppData\\Local\\Programs\\toolsenabled\\src\\lib',
    executablePath: 'C:\\agent-apps\\node.exe', userInfo: () => ({ homedir: OWNER }),
    fileSystem: f.fileSystem, resolveProfileShortPath: () => SHORT
  }), error => error.code === 'AGENT_CONFINEMENT_WRONG_PRINCIPAL');
  assert.deepEqual(f.calls, []);
});

function ownedFileSystem({ junction = null, missingFrom = null } = {}) {
  const calls = [];
  const approved = value => value === 'C:\\' || value === 'C:\\Users' || boundary.windowsPathInside(value, OWNER);
  const absent = value => missingFrom && boundary.windowsPathInside(value, missingFrom);
  const fileSystem = {
    lstatSync(value) {
      calls.push(['lstat', value]);
      assert.ok(approved(value), `lstat received an unapproved spelling: ${value}`);
      if (absent(value)) throw Object.assign(new Error('fixture missing tail'), { code: 'ENOENT' });
      return { isSymbolicLink: () => value === junction };
    },
    realpathSync(value) {
      calls.push(['realpath', value]);
      assert.ok(boundary.windowsPathInside(value, OWNER), `realpath received an unapproved spelling: ${value}`);
      if (absent(value)) throw Object.assign(new Error('fixture missing tail'), { code: 'ENOENT' });
      return value;
    }
  };
  return { calls, fileSystem };
}

test('an authoritative owner alias is translated before walking an existing or nonexistent path', () => {
  for (const tail of ['AppData\\Local\\Temp\\existing', 'AppData\\Local\\Temp\\new\\deeper']) {
    const f = ownedFileSystem({ missingFrom: `${OWNER}\\AppData\\Local\\Temp\\new` });
    const queries = [];
    const answer = boundary.assertAccountProfilePath(`${SHORT}\\${tail}`, {
      profileRoot: OWNER, requireOwnedProfile: true, fileSystem: f.fileSystem,
      resolveProfileShortPath(profile) { queries.push(profile); return SHORT; }
    });
    assert.equal(answer, `${OWNER}\\${tail}`);
    assert.deepEqual(queries, [OWNER]);
    assert.ok(f.calls.length > 0, 'the canonical/reparse check still executes');
    assert.ok(f.calls.every(([, value]) => !value.includes('~')), 'no alias spelling reaches filesystem access');
  }
});

test('owner-alias compatibility cannot bypass reparse refusal or rescue unknown alias metadata', () => {
  const junction = `${OWNER}\\AppData\\Local\\Temp\\linked`;
  const f = ownedFileSystem({ junction });
  assert.throws(() => boundary.assertAccountProfilePath(`${SHORT}\\AppData\\Local\\Temp\\linked\\secret`, {
    profileRoot: OWNER, fileSystem: f.fileSystem, resolveProfileShortPath: () => SHORT
  }), error => error.code === 'AGENT_CONFINEMENT_PROFILE_REPARSE_POINT');
  assert.equal(f.calls.some(([kind]) => kind === 'realpath'), false, 'a reparse point refuses before expansion/traversal');
  for (const resolveProfileShortPath of [() => null, () => { throw new Error('metadata unavailable'); }]) {
    const denied = noProbeFileSystem();
    assert.throws(() => boundary.assertAccountProfilePath(`${SHORT}\\new`, {
      profileRoot: OWNER, fileSystem: denied.fileSystem, resolveProfileShortPath
    }), error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE');
    assert.deepEqual(denied.calls, []);
  }
});

test('owned short-form installed and scratch module paths retain their OS owner', () => {
  for (const suffix of ['AppData\\Local\\Programs\\toolsenabled\\src\\lib', 'AppData\\Local\\Temp\\scratch\\src\\lib']) {
    const f = noProbeFileSystem();
    assert.equal(boundary.installationProfileRoot({ platform: 'win32',
      moduleDirectory: `${SHORT}\\${suffix}`, executablePath: 'C:\\agent-apps\\node.exe',
      userInfo: () => ({ homedir: OWNER }), fileSystem: f.fileSystem,
      resolveProfileShortPath: profile => { assert.equal(profile, OWNER); return SHORT; }
    }), OWNER);
    assert.deepEqual(f.calls, [], 'owner binding does not probe the module/alias candidate');
  }
});

test('the native metadata helper queries only the OS owner with a closed, bounded environment', () => {
  const calls = [];
  const answer = boundary.readOwnedProfileShortPath(OWNER, {
    platform: 'win32', userInfo: () => ({ homedir: OWNER }), systemRoot: 'C:\\Windows',
    execFileSync(executable, args, options) { calls.push({ executable, args, options }); return SHORT; }
  });
  assert.equal(answer, SHORT);
  assert.equal(calls.length, 1);
  const { executable, args, options } = calls[0];
  assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(options.cwd, 'C:\\Windows', 'the helper never inherits a foreign working directory');
  assert.equal(options.windowsHide, true);
  assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 5000);
  assert.ok(Number.isFinite(options.maxBuffer) && options.maxBuffer > 0 && options.maxBuffer <= 8192);
  assert.equal(args[args.indexOf('-WindowStyle') + 1], 'Hidden');
  assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(script, /GetShortPathName\(\$env:TOOLSENABLED_PROFILE_ALIAS_QUERY,/);
  assert.deepEqual(JSON.parse(JSON.stringify(options.env)), {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', USERPROFILE: OWNER,
    APPDATA: `${OWNER}\\AppData\\Roaming`, LOCALAPPDATA: `${OWNER}\\AppData\\Local`,
    TEMP: `${OWNER}\\AppData\\Local\\Temp`, TMP: `${OWNER}\\AppData\\Local\\Temp`,
    TOOLSENABLED_PROFILE_ALIAS_QUERY: OWNER
  }, 'no ambient profile, PATH, credential, or child-runtime injection is inherited');
  assert.ok(!args.some(value => value.includes(SHORT)), 'the guessed alias is never an input to the native query');
});

test('native metadata failures or another principal never grant alias authority', () => {
  let calls = 0;
  const fakeExec = () => { calls += 1; return SHORT; };
  for (const overrides of [
    { platform: 'linux' },
    { userInfo: () => ({ homedir: 'C:\\Users\\Bob' }) },
    { userInfo: () => { throw new Error('OS identity unavailable'); } },
    { systemRoot: `${OWNER}\\Windows` },
    { systemRoot: '\\\\remote.invalid\\Windows' }
  ]) {
    assert.equal(boundary.readOwnedProfileShortPath(OWNER, {
      platform: 'win32', userInfo: () => ({ homedir: OWNER }), systemRoot: 'C:\\Windows',
      execFileSync: fakeExec, ...overrides
    }), null);
  }
  assert.equal(calls, 0, 'a foreign requested principal or untrusted executable path cannot launch a helper');
  for (const output of ['', 'C:\\', 'C:\\Users', 'D:\\Users\\ALPHAP~1',
    'C:\\Users\\Bob', `${SHORT}\\child`, `${SHORT}\n`, '\\\\remote.invalid\\Users\\ALPHAP~1']) {
    assert.equal(boundary.readOwnedProfileShortPath(OWNER, {
      platform: 'win32', userInfo: () => ({ homedir: OWNER }), systemRoot: 'C:\\Windows',
      execFileSync: () => output
    }), null, `malformed metadata is not authority: ${JSON.stringify(output)}`);
    const f = noProbeFileSystem();
    assert.throws(() => boundary.assertAccountProfilePath(`${SHORT}\\new`, {
      profileRoot: OWNER, fileSystem: f.fileSystem, resolveProfileShortPath: () => output
    }), error => error.code === 'AGENT_CONFINEMENT_FOREIGN_PROFILE');
    assert.deepEqual(f.calls, []);
  }
  assert.equal(boundary.readOwnedProfileShortPath(OWNER, {
    platform: 'win32', userInfo: () => ({ homedir: OWNER }), systemRoot: 'C:\\Windows',
    execFileSync: () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }
  }), null);
});

test('ordinary long owned paths never require a native lookup', () => {
  const f = ownedFileSystem();
  let queries = 0;
  const resolveProfileShortPath = () => { queries += 1; throw new Error('must remain lazy'); };
  assert.equal(boundary.assertAccountProfilePath(`${OWNER}\\new`, {
    profileRoot: OWNER, fileSystem: f.fileSystem, resolveProfileShortPath
  }), `${OWNER}\\new`);
  assert.equal(boundary.installationProfileRoot({ platform: 'win32',
    moduleDirectory: `${OWNER}\\source\\src\\lib`, executablePath: 'C:\\agent-apps\\node.exe',
    userInfo: () => ({ homedir: OWNER }), resolveProfileShortPath
  }), OWNER);
  assert.equal(queries, 0);
});
