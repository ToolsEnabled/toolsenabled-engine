/*
 * Mutation check: replaced both BigInt(value) version-component conversions
 * with Number(value) in src/lib/mission-bridge/codex-native-pair.js.
 * The edit landed (the module SHA-256 changed), and this isolated file went red.
 * The original module was restored and its SHA-256 matched afterward.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  EXPECTED_SIGNER,
  MissionCodexNativePairError,
  compareStableVersions,
  defaultNpmRoots,
  resolveMissionCodexNativePair,
  verifyAuthenticode
} = require('../src/lib/mission-bridge/codex-native-pair');

let assertions = 0;
function check(label, fn) {
  try {
    fn();
    assertions += 1;
    console.log(`  ok: ${label}`);
  } catch (error) {
    console.error(`  FAIL: ${label}\n${error.stack}`);
    process.exitCode = 1;
  }
}

console.log('codex native pair exported behaviour');

check('stable versions are ordered numerically, including large components', () => {
  assert.equal(compareStableVersions('1.10.0', '1.9.99'), 1);
  assert.equal(compareStableVersions('1.9.99', '1.10.0'), -1);
  assert.equal(compareStableVersions('99999999999999999999.2.3', '99999999999999999998.99.99'), 1);
  assert.equal(compareStableVersions('7.8.9', '7.8.9'), 0);
});

check('default npm roots use case-insensitive environment names and deduplicate paths', () => {
  const roots = defaultNpmRoots({
    environment: {
      NPM_CONFIG_PREFIX: '/opt/npm',
      appdata: '/profiles/person',
      PATH: ['/opt/npm', '/extra/node_modules'].join(path.delimiter)
    },
    globalPaths: ['/OPT/NPM/node_modules', '/global/modules'],
    execPath: '/runtime/bin/node'
  });
  assert.deepEqual(roots, [
    path.resolve('/opt/npm/node_modules'),
    path.resolve('/profiles/person/npm/node_modules'),
    path.resolve('/extra/node_modules/node_modules'),
    path.resolve('/extra/node_modules'),
    path.resolve('/global/modules'),
    path.resolve('/runtime/bin/node_modules')
  ]);
  assert.ok(Object.isFrozen(roots));
});

check('non-Windows resolution fails with the exported typed error', () => {
  assert.throws(
    () => resolveMissionCodexNativePair({ platform: 'linux', npmRoots: [] }),
    error => error instanceof MissionCodexNativePairError
      && error.code === 'CODEX_NATIVE_PAIR_PLATFORM_UNSUPPORTED'
      && /Windows-only/.test(error.message)
  );
});

check('a busy filesystem is not reported as absence or latched, while ENOENT stays unavailable', () => {
  let probes = 0;
  const couldNotTellCodes = ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT'];
  const fsImpl = {
    realpathSync() {
      probes += 1;
      const error = new Error(probes <= couldNotTellCodes.length ? 'busy' : 'missing');
      error.code = couldNotTellCodes[probes - 1] || 'ENOENT';
      throw error;
    }
  };
  for (const code of couldNotTellCodes) {
    assert.throws(
      () => resolveMissionCodexNativePair({ platform: 'win32', arch: 'x64', npmRoots: ['/npm'], fsImpl }),
      error => error instanceof MissionCodexNativePairError
        && error.code === 'CODEX_NATIVE_PAIR_LOOKUP_INDETERMINATE'
        && error.details?.causeCode === code
        && /does NOT claim that Codex is absent/.test(error.message)
    );
  }
  assert.throws(
    () => resolveMissionCodexNativePair({ platform: 'win32', arch: 'x64', npmRoots: ['/npm'], fsImpl }),
    error => error instanceof MissionCodexNativePairError
      && error.code === 'CODEX_NATIVE_PAIR_UNAVAILABLE'
      && error.details?.rejected.includes('CODEX_NATIVE_PAIR_NPM_ROOT_INVALID')
  );
  assert.equal(probes, couldNotTellCodes.length + 1, 'indeterminate results are retried rather than cached or latched');
});

check('Authenticode verification calls the system verifier and returns frozen results', () => {
  const files = ['/packages/codex.exe', '/packages/codex-command-runner.exe', '/packages/codex-sandbox.exe'];
  const calls = [];
  const signatures = files.map(() => ({ status: 'Valid', signer: EXPECTED_SIGNER }));
  const result = verifyAuthenticode(files, {
    environment: { SystemRoot: '/Windows' },
    fsImpl: {
      lstatSync(file) {
        assert.equal(file, path.join('/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
        return { isFile: () => true, isSymbolicLink: () => false };
      }
    },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify(signatures) };
    },
    timeoutMs: 321
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, 321);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.TOOLSENABLED_CODEX_SIGNATURE_FILES, files.join('\n'));
  assert.deepEqual(result, signatures);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every(Object.isFrozen));
});

check('Authenticode verification rejects a non-OpenAI signer', () => {
  assert.throws(() => verifyAuthenticode(['/a.exe', '/b.exe', '/c.exe'], {
    environment: { SystemRoot: '/Windows' },
    fsImpl: { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }) },
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify([
        { status: 'Valid', signer: EXPECTED_SIGNER },
        { status: 'Valid', signer: 'Someone Else' },
        { status: 'Valid', signer: EXPECTED_SIGNER }
      ])
    })
  }), error => error instanceof MissionCodexNativePairError
    && error.code === 'CODEX_NATIVE_PAIR_SIGNATURE_INVALID');
});

function writeFixture(root, mutate = () => {}) {
  const version = '1.2.3';
  const packageRoot = path.join(root, '@openai', 'codex');
  const nativeRoot = path.join(packageRoot, 'node_modules', '@openai', 'codex-win32-x64');
  const vendorRoot = path.join(nativeRoot, 'vendor', 'x86_64-pc-windows-msvc');
  const fixture = {
    packageManifest: {
      name: '@openai/codex',
      version,
      optionalDependencies: { '@openai/codex-win32-x64': `npm:@openai/codex@${version}-win32-x64` }
    },
    nativeManifest: {
      name: '@openai/codex', version: `${version}-win32-x64`, os: ['win32'], cpu: ['x64']
    },
    layout: {
      layoutVersion: 1, version, target: 'x86_64-pc-windows-msvc', variant: 'codex',
      entrypoint: 'bin/codex.exe', resourcesDir: 'codex-resources'
    },
    files: {
      command: path.join(vendorRoot, 'bin', 'codex.exe'),
      commandRunner: path.join(vendorRoot, 'codex-resources', 'codex-command-runner.exe'),
      sandboxSetup: path.join(vendorRoot, 'codex-resources', 'codex-windows-sandbox-setup.exe')
    }
  };
  mutate(fixture);
  fs.mkdirSync(vendorRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'),
    fixture.packageManifestRaw ?? JSON.stringify(fixture.packageManifest));
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, 'package.json'),
    fixture.nativeManifestRaw ?? JSON.stringify(fixture.nativeManifest));
  fs.writeFileSync(path.join(vendorRoot, 'codex-package.json'),
    fixture.layoutRaw ?? JSON.stringify(fixture.layout));
  for (const [name, file] of Object.entries(fixture.files)) {
    if (file === null) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === fixture.invalidPe ? 'NO' : 'MZfixture');
  }
  return fixture;
}

function assertResolverRefusal(code, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-pair-'));
  let spawns = 0;
  let signatureChecks = 0;
  let writes = 0;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync'].includes(property)) {
        return () => { writes += 1; throw new Error(`resolver attempted ${property}`); };
      }
      return target[property];
    }
  });
  try {
    writeFixture(root, mutate);
    assert.throws(() => resolveMissionCodexNativePair({
      platform: 'win32',
      arch: 'x64',
      npmRoots: [root],
      fsImpl,
      spawnSyncImpl() { spawns += 1; return { status: 0, stdout: 'codex-cli 1.2.3' }; },
      verifySignaturesImpl() { signatureChecks += 1; return []; }
    }), error => error instanceof MissionCodexNativePairError
      && error.code === 'CODEX_NATIVE_PAIR_UNAVAILABLE'
      && error.details?.rejected.includes(code));
    assert.equal(spawns, 0, `${code} must refuse before spawning the executable`);
    assert.equal(writes, 0, `${code} must not write to the installation`);
    if (code !== 'CODEX_NATIVE_PAIR_VERSION_MISMATCH') {
      assert.equal(signatureChecks, 0, `${code} must refuse before signature verification`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

check('resolver drives package, manifest, layout, and executable refusals without spawning', () => {
  assertResolverRefusal('CODEX_NATIVE_PAIR_UNSTABLE', fixture => { fixture.packageManifest.version = '1.2.3-beta.1'; });
  assertResolverRefusal('CODEX_NATIVE_PAIR_DEPENDENCY_MISMATCH', fixture => {
    fixture.packageManifest.optionalDependencies['@openai/codex-win32-x64'] = 'npm:@openai/codex@9.9.9-win32-x64';
  });
  assertResolverRefusal('CODEX_NATIVE_PAIR_MANIFEST_INVALID', fixture => { fixture.packageManifestRaw = '{'; });
  assertResolverRefusal('CODEX_NATIVE_PAIR_LAYOUT_MISMATCH', fixture => { fixture.layout.entrypoint = '../codex.exe'; });
  assertResolverRefusal('CODEX_NATIVE_PAIR_FILE_MISSING', fixture => { fixture.files.command = null; });
  assertResolverRefusal('CODEX_NATIVE_PAIR_FILE_INVALID', fixture => {
    fixture.files.command = path.join(fixture.files.command, 'directory');
  });
  assertResolverRefusal('CODEX_NATIVE_PAIR_PE_INVALID', fixture => { fixture.invalidPe = 'command'; });
});

check('resolver drives version mismatch only after signature checks, without a successful launch result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-pair-version-'));
  let spawns = 0;
  let signatureChecks = 0;
  let writes = 0;
  try {
    writeFixture(root);
    assert.throws(() => resolveMissionCodexNativePair({
      platform: 'win32', arch: 'x64', npmRoots: [root],
      fsImpl: new Proxy(fs, {
        get(target, property) {
          if (['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync'].includes(property)) {
            return () => { writes += 1; throw new Error(`resolver attempted ${property}`); };
          }
          return target[property];
        }
      }),
      verifySignaturesImpl() { signatureChecks += 1; return []; },
      spawnSyncImpl() { spawns += 1; return { status: 0, stdout: 'codex-cli 9.9.9' }; }
    }), error => error instanceof MissionCodexNativePairError
      && error.code === 'CODEX_NATIVE_PAIR_UNAVAILABLE'
      && error.details?.rejected.includes('CODEX_NATIVE_PAIR_VERSION_MISMATCH'));
    assert.equal(signatureChecks, 1);
    assert.equal(spawns, 1);
    assert.equal(writes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('invalid npm roots are rejected without filesystem access, signature checks, or spawning', () => {
  let touched = 0;
  assert.throws(() => resolveMissionCodexNativePair({
    platform: 'win32', arch: 'x64', npmRoots: ['relative'],
    fsImpl: new Proxy({}, { get() { touched += 1; throw new Error('filesystem touched'); } }),
    verifySignaturesImpl() { touched += 1; },
    spawnSyncImpl() { touched += 1; }
  }), error => error instanceof MissionCodexNativePairError
    && error.code === 'CODEX_NATIVE_PAIR_UNAVAILABLE'
    && error.details?.rejected.includes('CODEX_NATIVE_PAIR_NPM_ROOT_INVALID'));
  assert.equal(touched, 0);
});

check('missing Windows signature verifier refuses without spawning', () => {
  let spawns = 0;
  assert.throws(() => verifyAuthenticode(['/a.exe', '/b.exe', '/c.exe'], {
    environment: {},
    fsImpl: new Proxy({}, { get() { throw new Error('filesystem touched'); } }),
    spawnSyncImpl() { spawns += 1; }
  }), error => error instanceof MissionCodexNativePairError
    && error.code === 'CODEX_NATIVE_PAIR_SIGNATURE_UNAVAILABLE');
  assert.equal(spawns, 0);
});

if (process.exitCode) {
  console.error(`\n❌ codex native pair: failed after ${assertions} passing checks`);
} else {
  console.log(`\n✅ codex native pair: ${assertions} checks passed`);
}
