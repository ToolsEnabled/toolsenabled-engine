'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const {
  REQUIRED_EXCLUDED_TOOLS,
  SCHEMA_VERSION,
  TRANSPORT_POLICY_DESCRIPTOR,
  registryNameDigest,
  toolNameDigest,
  validateDeclaration,
  validateManifest
} = require('../src/lib/fra-capability-manifest');

const root = path.resolve(__dirname, '..');
const additions = [
  'browser.playwright_call',
  'browser.playwright_status',
  'browser.playwright_tools',
  'ocr.read',
  'screen.capture',
  'screen.capture_monitor',
  'screen.capture_region',
  'screen.capture_window',
  'screen.list_monitors',
  'screen.read_capture',
  'workstation.configure_agent_clients',
  'workstation.initialize_cursor_state',
  'workstation.install_cursor',
  'workstation.launch_cursor',
  'workstation.status',
  'workstation.sync_cursor_extensions'
].sort();
const reviewedFixtureTools = [...additions, 'workspace.list', 'workspace.read'].sort();
const manifest = validateManifest({
  schemaVersion: SCHEMA_VERSION,
  registryNameDigest: registryNameDigest(TOOL_REGISTRY),
  allowedToolNamesDigest: toolNameDigest(reviewedFixtureTools),
  allowedToolCount: reviewedFixtureTools.length,
  allowedTools: reviewedFixtureTools,
  excludedTools: [...REQUIRED_EXCLUDED_TOOLS].sort(),
  desktopCapabilities: { clipboard: false, ocr: true, screenCapture: true },
  transportPolicy: TRANSPORT_POLICY_DESCRIPTOR
}, { registry: TOOL_REGISTRY });
const allowed = new Set(manifest.allowedToolNames);

assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
assert.equal(manifest.allowedToolNames.length, reviewedFixtureTools.length);
assert.equal(manifest.desktopCapabilities.screenCapture, true);
assert.equal(manifest.desktopCapabilities.ocr, true);
assert.equal(manifest.desktopCapabilities.clipboard, false);
assert.deepEqual(Object.keys(manifest.desktopCapabilities).sort(), ['clipboard', 'ocr', 'screenCapture']);
const { allowedToolNames: _computedNames, ...declaration } = manifest;
for (const obsoleteRequestId of ['R1', 'R731', 'R999999999']) {
  assert.throws(
    () => validateDeclaration({
      ...declaration,
      desktopCapabilities: {
        ...manifest.desktopCapabilities,
        [['authorization', 'RequestId'].join('')]: obsoleteRequestId
      }
    }),
    error => error?.code === 'FRA_MANIFEST_SCHEMA_INVALID',
    `${obsoleteRequestId} must be rejected, never treated as desktop authority`
  );
}
assert.equal(allowed.has('host.exec'), false);
assert.equal([...allowed].some(name => name.startsWith('clipboard.')), false);
for (const name of ['host.list_dir', 'host.read_file', 'host.write_file', 'repo.list_dir', 'repo.read_file', 'repo.write_file']) {
  assert.equal(allowed.has(name), false, `${name} must remain local-client-only`);
}
for (const name of ['workspace.list', 'workspace.read']) {
  assert.equal(allowed.has(name), true, `${name} must expose only the opaque session-bound workspace surface`);
}
// The unrelated topology transfer surface must not re-enter the FRA profile.
for (const name of ['topology_games.snapshot_manifest', 'topology_games.read_chunk']) {
  assert.equal(allowed.has(name), false, `${name} was removed from the product and must not return`);
}
assert.deepEqual([...allowed].filter(name => /^(?:workstation|screen|ocr)\.|^browser\.playwright_/.test(name)).sort(), additions);

function schemaFields(schema, prefix = '', rows = []) {
  if (!schema || typeof schema !== 'object') return rows;
  for (const [name, value] of Object.entries(schema.properties || {})) {
    const field = prefix ? `${prefix}.${name}` : name;
    rows.push(field);
    schemaFields(value, field, rows);
  }
  if (schema.items) schemaFields(schema.items, `${prefix}[]`, rows);
  return rows;
}

const rawAuthorityField = /(?:password|secret|credential|apiKey|accessToken|refreshToken|command|shell|executable|argv|uac|elevation|administrator)/i;
const registryByName = new Map(TOOL_REGISTRY.map(entry => [entry.name, entry]));
for (const name of additions) {
  const entry = registryByName.get(name);
  assert.ok(entry, `${name} must remain registered`);
  assert.deepEqual(schemaFields(entry.baseInputSchema || entry.inputSchema).filter(field => rawAuthorityField.test(field)), [],
    `${name} must not accept raw credential, command, shell, UAC, or elevation input`);
}

const allSensitiveFields = [];
for (const entry of TOOL_REGISTRY.filter(item => allowed.has(item.name))) {
  for (const field of schemaFields(entry.baseInputSchema || entry.inputSchema)) {
    if (rawAuthorityField.test(field)) allSensitiveFields.push(`${entry.name}:${field}`);
  }
}
assert.deepEqual(allSensitiveFields.sort(), []);

const workstationSource = fs.readFileSync(path.join(root, 'src', 'lib', 'providers', 'workstation.js'), 'utf8');
assert.doesNotMatch(workstationSource, /\b(?:set|clear)RunAsAdmin\b/);
assert.doesNotMatch(workstationSource, /commandSummary\('reg\.exe',\s*\[(?:'add'|'delete')/);
assert.doesNotMatch(workstationSource, /\b(?:Start-Process|runas\.exe|schtasks(?:\.exe)?|-Verb\s+RunAs)\b/i);
assert.doesNotMatch(workstationSource, /\b(?:getSecret|vault|credentialValue|password)\b/i);
assert.match(workstationSource, /commandSummary\('reg\.exe',\s*\['query'/);

const remotePlaywrightSource = fs.readFileSync(path.join(root, 'src', 'lib', 'providers', 'remote-playwright.js'), 'utf8');
const playwrightCallSource = fs.readFileSync(path.join(root, 'tools', 'playwright-call.js'), 'utf8');
assert.doesNotMatch(remotePlaywrightSource, /cdpEndpoint|cookies?|browser profile|host\.exec/i);
assert.match(remotePlaywrightSource, /executeOneShot/);
assert.match(remotePlaywrightSource, /listTools/);
assert.match(playwrightCallSource, /SAFE_BROWSER_TOOL_NAMES/);

console.log(JSON.stringify({
  ok: true,
  allowedToolCount: manifest.allowedToolNames.length,
  newlyExposedCount: additions.length,
  elevationOrUacMutationInputs: 0,
  rawCommandOrShellInputs: 0,
  rawCredentialValueInputs: 0,
  opaqueCredentialSelectors: allSensitiveFields.sort(),
  explicitlyExcluded: [
    'host.exec', 'host.list_dir', 'host.read_file', 'host.write_file',
    'repo.list_dir', 'repo.read_file', 'repo.write_file',
    'clipboard.read', 'clipboard.write'
  ],
  ownerAuthorizedDesktopObservation: additions.filter(name => /^(?:screen|ocr)\./.test(name))
}));
