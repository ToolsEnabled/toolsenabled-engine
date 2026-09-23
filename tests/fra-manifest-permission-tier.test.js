'use strict';

// The Full Remote Access listener dispatched with no permission session at all,
// so tool-registry.js's tier check never ran on an 8790 call. Guarded cannot
// stand in for it: Guarded admits only local-read/external-read, while a reviewed
// FRA manifest may deliberately include writes. This suite pins the Manifest
// tier against a complete synthetic customer declaration -- every reviewed
// fixture tool still dispatches, and a name outside the reviewed manifest is
// refused by the permission system rather than only by the transport filter.

const isolated = require('./lib/isolated-environment').activate('fra-manifest-permission-tier');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/lib/permission-tier-policy');
const { TOOL_REGISTRY, executeTool } = require('../src/lib/tool-registry');
const { deriveMasterKey } = require('../src/lib/fra-secure-session');
const {
  SCHEMA_VERSION,
  TRANSPORT_POLICY_DESCRIPTOR,
  REQUIRED_EXCLUDED_TOOLS,
  loadManifestDeclaration,
  registryNameDigest,
  toolNameDigest
} = require('../src/lib/fra-capability-manifest');
const { createFullRemoteAccessBridge } = require('../src/full-remote-access-bridge');
const { bridgeTrustOptions, bindableCapabilityProfile } = require('./helpers/fra-binding-fixture');

void isolated;

const HOST = '203.0.113.2';
// FRA resolves a host to a machine -- and a machine to its manifest file and
// its one peer -- through the service registry, whose real copy is an
// untracked, machine-local file. Injecting this two-machine fixture into every
// entry point below means the suite pins the reviewed manifest and the tier
// built on it, not whatever LAN the builder's machine happens to be on.
const LAB_REGISTRY = Object.freeze({
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
});
const SERVICE_REGISTRY_OPTIONS = Object.freeze({ registry: LAB_REGISTRY });
// A customer's reviewed manifest is per-installation and therefore never a
// checkout precondition. This exact fixture covers remote reads, desktop reads,
// and three reviewed writes while remaining independent of any user's file.
const REVIEWED_TOOL_NAMES = Object.freeze([
  'browser.playwright_call',
  'ocr.read',
  'screen.capture',
  'screen.read_capture',
  'system.status',
  'workspace.list',
  'workspace.read',
  'workstation.install_cursor'
].sort());
const REVIEWED_MANIFEST = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  registryNameDigest: registryNameDigest(TOOL_REGISTRY),
  allowedToolNamesDigest: toolNameDigest(REVIEWED_TOOL_NAMES),
  allowedToolCount: REVIEWED_TOOL_NAMES.length,
  allowedTools: REVIEWED_TOOL_NAMES,
  excludedTools: Object.freeze([...REQUIRED_EXCLUDED_TOOLS].sort()),
  desktopCapabilities: Object.freeze({ clipboard: false, ocr: true, screenCapture: true }),
  transportPolicy: TRANSPORT_POLICY_DESCRIPTOR
});
// A closed schema rejects this property, so a probe proves the call reached
// schema validation -- which happens strictly after the tier check -- without
// ever executing the tool. Nothing here has a side effect.
const PROBE_ARGUMENTS = Object.freeze({ __fra_manifest_tier_probe__: true });

let checks = 0;
const check = (description, fn) => { fn(); checks += 1; void description; };

function bridgeFor(capabilityProfile, label) {
  return createFullRemoteAccessBridge({
    ...bridgeTrustOptions(),
    host: HOST,
    masterKey: deriveMasterKey('fra-manifest-permission-tier-test-key'),
    capabilityProfile,
    serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS,
    allowedRemoteRe: /^127\.0\.0\.1$/,
    logFile: path.join(os.tmpdir(), `fra-manifest-permission-tier-${label}.log`),
    auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) }
  });
}

// Drive the listener's real dispatch seam: the same wrapper the socket path
// calls, into the real MCP dispatcher and the real tool registry.
async function dispatchThroughBridge(server, name, id) {
  let response = null;
  await server.dispatchLine(
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: PROBE_ARGUMENTS } }),
    value => { response = value; },
    { agentActor: 'codex' }
  );
  assert.ok(response, `${name}: the bridge produced no response`);
  return response;
}

function refusalCode(response) {
  const serialized = JSON.stringify(response);
  const match = /"code":"(PERMISSION_[A-Z_]+)"/.exec(serialized);
  return match ? match[1] : null;
}

async function main() {
  const declaration = loadManifestDeclaration({
    manifestPath: 'synthetic-customer-manifest.json',
    readFile: () => JSON.stringify(REVIEWED_MANIFEST)
  });
  const manifestNames = [...declaration.allowedTools];
  assert.deepEqual(manifestNames, REVIEWED_TOOL_NAMES,
    'the permission lane consumes the complete reviewed customer declaration');
  const capabilityProfile = bindableCapabilityProfile({
    allowedTools: manifestNames,
    excludedTools: [...declaration.excludedTools],
    desktopCapabilities: declaration.desktopCapabilities
  });
  assert.equal(capabilityProfile.allowedToolNamesDigest, declaration.allowedToolNamesDigest,
    'the listener profile must carry the digest the reviewed manifest pinned');

  const manifestSession = policy.manifestSession({
    allowedToolNames: manifestNames,
    allowedToolNamesDigest: capabilityProfile.allowedToolNamesDigest
  });

  check('the Manifest tier is a first-class tier, remote-only and binding-bound', () => {
    assert.ok(policy.TIERS.includes('manifest'));
    assert.equal(manifestSession.origin, 'remote');
    assert.equal(manifestSession.tier, 'manifest');
    assert.throws(() => policy.session({ origin: 'local', tier: 'manifest', manifest: manifestSession.manifest }),
      error => error?.code === 'PERMISSION_MANIFEST_ORIGIN_REFUSED');
    assert.throws(() => policy.session({ origin: 'remote', tier: 'manifest' }),
      error => error?.code === 'PERMISSION_MANIFEST_BINDING_REFUSED');
    assert.throws(() => policy.manifestSession({
      allowedToolNames: [],
      allowedToolNamesDigest: toolNameDigest([])
    }), error => error?.code === 'PERMISSION_MANIFEST_BINDING_REFUSED');
    assert.throws(() => policy.manifestSession({
      allowedToolNames: [...manifestNames, 'host.exec'],
      allowedToolNamesDigest: capabilityProfile.allowedToolNamesDigest
    }), error => error?.code === 'PERMISSION_MANIFEST_DIGEST_REFUSED');
  });

  // 1. NO REGRESSION. Every reviewed tool is still admitted, at the exact
  // enforcement point tool-registry.js calls.
  check('the tier admits exactly the reviewed fixture tools and nothing else', () => {
    const byName = new Map(TOOL_REGISTRY.map(entry => [entry.name, entry]));
    for (const name of manifestNames) {
      const entry = byName.get(name);
      assert.ok(entry, `${name} is not a registered tool`);
      assert.doesNotThrow(() => policy.assertToolAllowed(entry, manifestSession), `${name} must remain dispatchable`);
    }
    assert.deepEqual([...policy.allowedToolNames(TOOL_REGISTRY, manifestSession)].sort(), [...manifestNames].sort());
  });

  check('Guarded stays a different, narrower surface -- 8788 and 8790 are not collapsed', () => {
    const guarded = new Set(policy.allowedToolNames(TOOL_REGISTRY, { origin: 'remote', tier: 'guarded' }));
    const refusedByGuarded = manifestNames.filter(name => !guarded.has(name)).sort();
    assert.deepEqual(refusedByGuarded, [
      'browser.playwright_call', 'screen.capture', 'workstation.install_cursor'
    ], 'Guarded still refuses these reviewed FRA tools; the Manifest tier is why FRA keeps working');
  });

  // The listener really hands the dispatcher a Manifest-tier session bound to
  // the reviewed digest -- not an absent session, which is what 8790 sent
  // before and why the generic tier check never ran on it.
  let wired = null;
  const spyServer = createFullRemoteAccessBridge({
    ...bridgeTrustOptions(),
    host: HOST,
    masterKey: deriveMasterKey('fra-manifest-permission-tier-test-key'),
    capabilityProfile,
    serviceRegistryOptions: SERVICE_REGISTRY_OPTIONS,
    allowedRemoteRe: /^127\.0\.0\.1$/,
    logFile: path.join(os.tmpdir(), 'fra-manifest-permission-tier-spy.log'),
    auditApi: { requireRecord: () => ({ ok: true }), record: () => ({ ok: true }) },
    dispatchLine: async (line, respond, dispatchOptions) => { wired = dispatchOptions; }
  });
  await spyServer.dispatchLine('{}', () => {}, { agentActor: 'codex' });
  check('the listener binds its dispatches to the reviewed manifest', () => {
    assert.equal(wired.permissionSession.origin, 'remote');
    assert.equal(wired.permissionSession.tier, 'manifest');
    assert.equal(wired.permissionSession.manifest.allowedToolNamesDigest, declaration.allowedToolNamesDigest);
    assert.deepEqual([...wired.permissionSession.manifest.allowedToolNames].sort(), [...manifestNames].sort());
  });

  const server = bridgeFor(capabilityProfile, 'reviewed');
  let index = 0;
  for (const name of manifestNames) {
    index += 1;
    const response = await dispatchThroughBridge(server, name, `probe-${index}`);
    assert.equal(refusalCode(response), null, `${name}: the Manifest tier must not refuse a reviewed FRA tool`);
    assert.ok(response.error && response.error.code === -32602
      && /__fra_manifest_tier_probe__/.test(String(response.error.message)),
      `${name}: the probe must stop at schema validation, which runs after the tier check`);
    checks += 1;
  }

  // 2. THE NEW MECHANISM ACTUALLY DOES SOMETHING. A registered tool that is not
  // in the reviewed manifest is refused by the tier itself, with no help from
  // the transport's request-scoped tool view.
  await assert.rejects(
    () => executeTool('gmail.send', PROBE_ARGUMENTS, { permissionSession: manifestSession }),
    error => error?.code === 'PERMISSION_MANIFEST_TOOL_REFUSED' && error.details?.tool === 'gmail.send'
  );
  await assert.rejects(
    () => executeTool('host.exec', PROBE_ARGUMENTS, { permissionSession: manifestSession }),
    error => error?.code === 'PERMISSION_MANIFEST_EXCLUSION_REFUSED'
  );
  await assert.rejects(
    () => executeTool('not.registered.escape', PROBE_ARGUMENTS, { permissionSession: manifestSession }),
    error => error?.code === 'UNKNOWN_TOOL'
  );
  checks += 3;

  // A planted entry: a capability profile widened past the reviewed manifest,
  // so the transport's own name filter would let it through. Before this tier
  // that was the ONLY gate on an 8790 call.
  const plantedNames = [...manifestNames, 'host.exec', 'repo.write_file'].sort();
  const plantedProfile = bindableCapabilityProfile({
    allowedTools: plantedNames,
    excludedTools: ['clipboard.read', 'clipboard.write']
  });
  const plantedServer = bridgeFor(plantedProfile, 'planted');
  for (const planted of ['host.exec', 'repo.write_file']) {
    const response = await dispatchThroughBridge(plantedServer, planted, `planted-${planted}`);
    assert.equal(refusalCode(response), 'PERMISSION_MANIFEST_EXCLUSION_REFUSED',
      `${planted}: a widened profile must not be able to reach an excluded tool through FRA`);
    checks += 1;
  }
  // The same widened view WITHOUT a permission session. This used to assert
  // that the call REACHED SCHEMA VALIDATION -- i.e. that the tier check had not
  // run and the tool would have dispatched -- which documented the pre-change
  // 8790 behaviour as a fact about the system.
  //
  // That fact is now false on purpose. tool-registry.js#executeTool() refuses a
  // dispatch that states no permission session at all, so an unbound caller no
  // longer gets to the schema, let alone the handler. The assertion is inverted
  // rather than deleted, because "an unbound call cannot reach a tool" is the
  // property worth pinning here: this test's whole subject is a widened profile
  // failing to reach an excluded tool, and omitting the session was the last
  // way left to do exactly that.
  await assert.rejects(
    () => executeTool('host.exec', PROBE_ARGUMENTS, { allowedToolNames: plantedNames }),
    error => error?.code === 'PERMISSION_SESSION_REQUIRED'
  );
  checks += 1;

  console.log(`FRA manifest permission tier tests passed (${checks} checks, ${manifestNames.length} reviewed tools dispatched).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
