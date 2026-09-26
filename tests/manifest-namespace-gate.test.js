'use strict';

const { activate } = require('./lib/isolated-environment');
activate('manifest-namespace-gate');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gate = require('../tools/check-manifest-namespaces');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'registry.json');
const GATE = path.join(ROOT, 'tools', 'check-manifest-namespaces.js');
const TOOL_REGISTRY = path.join(ROOT, 'src', 'lib', 'tool-registry.js');

const actual = gate.checkManifestNamespaces({
  manifestPath: MANIFEST,
  toolRegistryPath: TOOL_REGISTRY
});
assert.equal(actual.ok, true, actual.errors.join('\n'));
const liveToolNames = require(TOOL_REGISTRY).TOOL_REGISTRY.map((tool) => tool.name);
const liveNamespaceCount = new Set(liveToolNames.map((name) => name.split('.')[0])).size;
assert.equal(actual.toolCount, liveToolNames.length, 'the gate must inspect every live shipping tool');
assert.equal(actual.registeredNamespaceCount, liveNamespaceCount, 'the gate must inspect every live shipping namespace');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
for (const capability of gate.declaringMcpCapabilities(manifest)) {
  assert.ok(Array.isArray(capability.toolNamespaces) && capability.toolNamespaces.length > 0,
    `${capability.id} has no explicit namespace declaration`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-manifest-namespace-'));
try {
  const mutated = structuredClone(manifest);
  const billing = mutated.capabilities.find((capability) => capability.id === 'billing-verification');
  assert.ok(billing, 'the real billing-verification capability must exist for the mutation check');
  billing.toolNamespaces.push('manifest_fake');
  const mutantPath = path.join(temporary, 'registry.fake-namespace.json');
  fs.writeFileSync(mutantPath, `${JSON.stringify(mutated, null, 2)}\n`, 'utf8');

  const mutationResult = gate.checkManifestNamespaces({
    manifestPath: mutantPath,
    toolRegistryPath: TOOL_REGISTRY
  });
  assert.equal(mutationResult.ok, false, 'declaring a fake namespace must turn the gate red');
  assert.deepEqual(mutationResult.missing, [
    { capabilityId: 'billing-verification', namespace: 'manifest_fake' }
  ]);

  const command = spawnSync(process.execPath, [GATE, '--manifest', mutantPath], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, TOOLSENABLED_TOOL_ALLOWLIST: '' }
  });
  assert.equal(command.status, 1, 'the CLI gate must return a failing process status for the mutant');
  assert.match(command.stderr, /billing-verification declares manifest_fake\.\*/);

  const missingDeclaration = structuredClone(manifest);
  delete missingDeclaration.capabilities.find((capability) => capability.id === 'billing-verification').toolNamespaces;
  const noNamespaces = gate.checkManifestNamespaces({
    manifest: missingDeclaration,
    toolNames: require(TOOL_REGISTRY).TOOL_REGISTRY.map((tool) => tool.name)
  });
  assert.equal(noNamespaces.ok, false, 'an MCP claim cannot evade the gate by omitting toolNamespaces');
  assert.match(noNamespaces.errors.join('\n'), /billing-verification must declare a non-empty toolNamespaces array/);

  const noClaims = gate.checkManifestNamespaces({ manifest: { capabilities: [] }, toolNames: ['example.read'] });
  assert.equal(noClaims.ok, false, 'scanning zero MCP claims must not let the gate pass vacuously');
  assert.match(noClaims.errors.join('\n'), /declares no active or staged MCP capabilities/);

  const noTools = gate.checkManifestNamespaces({ manifest, toolNames: [] });
  assert.equal(noTools.ok, false, 'scanning zero tools must not let the gate pass vacuously');
  assert.match(noTools.errors.join('\n'), /tool registry exposes no tools/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write(
  `manifest-namespace-gate: green on ${actual.toolCount} tools/${actual.registeredNamespaceCount} namespaces; `
  + 'fake manifest_fake.* mutation turned red\n'
);
