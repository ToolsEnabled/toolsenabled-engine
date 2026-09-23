'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { preflightFullRemoteAccess: preflightFullRemoteAccessRaw } = require('../src/full-remote-access-bridge');
const {
  REQUIRED_EXCLUDED_TOOLS,
  TRANSPORT_POLICY_DESCRIPTOR,
  registryNameDigest,
  toolNameDigest
} = require('../src/lib/fra-capability-manifest');
const fraTransportBinding = require('../src/lib/fra-transport-binding');
const {
  TEST_POLICY_DIGEST,
  TEST_ROOT_ACCESS_REPORT,
  TEST_ROOT_IDENTITY_REPORT
} = require('./helpers/fra-binding-fixture');

const root = path.resolve(__dirname, '..');
const controlSource = fs.readFileSync(path.join(root, 'tools', 'full-remote-access-control.ps1'), 'utf8');
const registry = [
  { name: 'clipboard.read' },
  { name: 'clipboard.write' },
  { name: 'host.exec' },
  { name: 'host.list_dir' },
  { name: 'host.patch_file' },
  { name: 'host.read_file' },
  { name: 'host.write_file' },
  { name: 'repo.list_dir' },
  { name: 'repo.patch_file' },
  { name: 'repo.read_file' },
  { name: 'repo.write_file' },
  { name: 'system.status' }
];
const names = registry.map(entry => entry.name).sort();
const excludedTools = [
  'clipboard.read', 'clipboard.write',
  'host.exec', 'host.list_dir', 'host.patch_file', 'host.read_file', 'host.write_file',
  'repo.list_dir', 'repo.patch_file', 'repo.read_file', 'repo.write_file'
];
const allowedToolNames = ['system.status'];

// f061ec5 added repo.patch_file to REQUIRED_EXCLUDED_TOOLS and updated the
// manifest fixture next door but not this one, so this preflight then died on
// an opaque FRA_MANIFEST_SAFETY_INVALID from inside the bridge rather than
// saying which list had drifted.  The two literals above stay literal on
// purpose -- built from REQUIRED_EXCLUDED_TOOLS they would be tautological and
// would no longer notice the requirement LOSING a tool -- so assert the
// equality here instead, where the drift can be named in both directions.
const missingFromFixture = [...REQUIRED_EXCLUDED_TOOLS].filter(name => !excludedTools.includes(name));
const staleInFixture = excludedTools.filter(name => !REQUIRED_EXCLUDED_TOOLS.has(name));
const unregisteredExclusions = excludedTools.filter(name => !registry.some(entry => entry.name === name));
assert.deepEqual(
  { missingFromFixture, staleInFixture, unregisteredExclusions },
  { missingFromFixture: [], staleInFixture: [], unregisteredExclusions: [] },
  'FRA excluded-tool drift between this fixture and REQUIRED_EXCLUDED_TOOLS in '
  + 'src/lib/fra-capability-manifest.js. Added to the requirement but not to this fixture: '
  + `[${missingFromFixture.join(', ')}]. Still in this fixture but no longer required (do not `
  + `delete the requirement to get green): [${staleInFixture.join(', ')}]. Excluded here but absent `
  + `from this fixture's injected registry, which the manifest validator also rejects: `
  + `[${unregisteredExclusions.join(', ')}].`
);
// The peer of 203.0.113.1 is resolved through the service registry, so this
// test injects its own two-machine registry rather than reading the live one:
// the preflight contract below is pinned by the fixture, not by whichever
// addresses the builder's machine happens to be configured with.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.1', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.2', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const serviceRegistryOptions = { registry: lab };
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-preflight-'));
const manifestPath = path.join(directory, 'manifest.json');
const readyAudit = { warm: () => ({ valid: true, entries: 1 }) };
const runtimeIntegrityApi = {
  verifyRuntimeIntegrity: () => ({ valid: true, runtimeDigest: 'd'.repeat(64) })
};
function preflightFullRemoteAccess(options) {
  return preflightFullRemoteAccessRaw({
    serviceRegistryOptions,
    ...options,
    runtimeIntegrityApi,
    rootAccessApi: {
      ROOT_ACCESS_POLICY_DIGEST: TEST_ROOT_ACCESS_REPORT.policyDigest,
      verifyFraRootAccess: () => TEST_ROOT_ACCESS_REPORT
    },
    transportBindingApi: {
      ...fraTransportBinding,
      rootIdentityReport: () => TEST_ROOT_IDENTITY_REPORT,
      policyDigestForRoot: () => TEST_POLICY_DIGEST
    }
  });
}

try {
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 5,
    registryNameDigest: registryNameDigest(registry),
    allowedToolNamesDigest: toolNameDigest(allowedToolNames),
    allowedToolCount: allowedToolNames.length,
    allowedTools: allowedToolNames,
    excludedTools,
    desktopCapabilities: {
      clipboard: false, ocr: false, screenCapture: false
    },
    transportPolicy: TRANSPORT_POLICY_DESCRIPTOR
  }), 'utf8');

  const ready = preflightFullRemoteAccess({
    host: '203.0.113.1', toolRegistry: registry, manifestPath,
    baseToken: '0123456789abcdef', auditApi: readyAudit
  });
  assert.equal(ready.host, '203.0.113.1');
  assert.equal(ready.peerHost, '203.0.113.2');
  assert.equal(ready.allowedToolCount, allowedToolNames.length);
  assert.equal(ready.auditWarmReady, true);
  assert.equal(ready.runtimeIntegrityReady, true);
  assert.equal(ready.runtimeDigest, 'd'.repeat(64));

  assert.throws(() => preflightFullRemoteAccessRaw({
    host: '203.0.113.1', toolRegistry: registry, manifestPath, serviceRegistryOptions,
    baseToken: '0123456789abcdef', auditApi: readyAudit,
    runtimeIntegrityApi: { verifyRuntimeIntegrity: () => { throw Object.assign(new Error('drift'), { code: 'FRA_RUNTIME_FILE_HASH_MISMATCH' }); } }
  }), error => error && error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');

  const failClosedScript = String.raw`
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const forbidden = [
      'remote-agent-bridge', 'tool-registry', 'mcp-server',
      'providers/fra-workspace-handles'
    ];
    const loaded = [];
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      const normalized = String(request).replaceAll('\\\\', '/');
      const providerModule = normalized.includes('lib/providers/');
      const safeLaunchEnvironment = /lib\/providers\/subscription-launch-env(?:\.js)?$/.test(normalized);
      if (forbidden.some(value => normalized.includes(value))
          || (providerModule && !safeLaunchEnvironment)) loaded.push(normalized);
      return originalLoad.call(this, request, parent, isMain);
    };
    const fra = require('./src/full-remote-access-bridge');
    // Same injected registry as the parent, for the same reason: start()'s port
    // default reads the registry before it ever reaches the integrity check.
    const serviceRegistryOptions = { registry: ${JSON.stringify(lab)} };
    let vaultReads = 0;
    const integrityFailure = {
      verifyRuntimeIntegrity() {
        throw Object.assign(new Error('drift'), { code: 'FRA_RUNTIME_FILE_HASH_MISMATCH' });
      }
    };
    for (const action of [
      () => fra.preflightFullRemoteAccess({
        host: '203.0.113.1', serviceRegistryOptions, runtimeIntegrityApi: integrityFailure,
        loadBaseToken() { vaultReads += 1; return 'must-not-load'; }
      }),
      () => fra.start({
        host: '203.0.113.1', serviceRegistryOptions,
        stopFile: './definitely-absent-fra-stop-file',
        runtimeIntegrityApi: integrityFailure,
        loadBaseToken() { vaultReads += 1; return 'must-not-load'; }
      })
    ]) {
      assert.throws(action, error => error && error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');
    }
    assert.equal(vaultReads, 0);
    assert.deepEqual(loaded, []);
  `;
  const failClosed = spawnSync(process.execPath, ['-e', failClosedScript], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 30_000
  });
  assert.equal(failClosed.status, 0, failClosed.stderr || failClosed.stdout);

  assert.throws(() => preflightFullRemoteAccess({
    host: '203.0.113.1', toolRegistry: [...registry, { name: 'model.status' }], manifestPath,
    baseToken: '0123456789abcdef', auditApi: readyAudit
  }), error => error && error.code === 'FRA_MANIFEST_DIGEST_MISMATCH');

  assert.throws(() => preflightFullRemoteAccess({
    host: '203.0.113.1', toolRegistry: registry, manifestPath,
    baseToken: '0123456789abcdef', auditApi: { warm: () => { throw new Error('test warm failure'); } }
  }), error => error && error.code === 'FRA_AUDIT_WARM_FAILED');

  const restartStart = controlSource.indexOf('function Invoke-Restart');
  const restartBody = controlSource.slice(restartStart, controlSource.indexOf('\ntry {', restartStart));
  assert.ok(restartStart >= 0, 'restart helper must exist');
  assert.ok(restartBody.indexOf('Invoke-FraPreflight') >= 0, 'restart must preflight');
  assert.ok(restartBody.indexOf('Invoke-FraPreflight') < restartBody.indexOf('Invoke-Stop'), 'restart must preflight before stopping');
  assert.match(controlSource, /function Start-OwnedListener[\s\S]*?if \(-not \$PreflightValidated\) \{ Invoke-FraPreflight \| Out-Null \}/);
  assert.match(controlSource, /Start-Process -FilePath \$Node -ArgumentList @\(\$Server, '--preflight'\)/);
  assert.match(controlSource, /WaitForExit\(\$PreflightTimeoutMs\)/);
  assert.match(controlSource, /if \(\$timedOut\) \{ throw 'FRA_PREFLIGHT_TIMEOUT' \}/);
  assert.match(controlSource, /\$healthDeadline = \[DateTime\]::UtcNow\.AddMilliseconds\(\$StartHealthTimeoutMs\)/);
  assert.match(controlSource, /while \(\[DateTime\]::UtcNow -lt \$healthDeadline\) \{\s*Start-Sleep -Milliseconds 250/);

  console.log('FRA preflight preserves the live listener on manifest failure contract passed.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
