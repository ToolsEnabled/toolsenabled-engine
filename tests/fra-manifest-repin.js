'use strict';

// B22. The FRA capability manifests pin a digest over the WHOLE tool registry,
// so that adding a tool to the product cannot quietly change what "the
// registry" means underneath a manifest that still looks correct. Re-pinning
// that digest by recomputing it throws away the only thing it was protecting.
//
// These tests hold tools/fra-manifest-repin.js to being an authorization
// instead: it must recover the pinned name list, show the exact delta, and
// refuse every case where it cannot.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RepinError, extractNames, extractorSelfCheck, digestOfNames, recoverBaseline,
  analyse, renderReport, writable, parseCli
} = require('../tools/fra-manifest-repin');
const { TOOL_REGISTRY } = require('../src/lib/tool-registry');
const {
  SCHEMA_VERSION,
  TRANSPORT_POLICY_DESCRIPTOR,
  REQUIRED_EXCLUDED_TOOLS,
  toolNameDigest
} = require('../src/lib/fra-capability-manifest');

function code(fn, expected) {
  assert.throws(fn, error => error instanceof RepinError && error.code === expected);
}

const live = TOOL_REGISTRY.map(entry => entry.name).sort();

// --- the extractor is proved before it is trusted ---------------------------
// Every historical diff this tool prints comes from a static scan of an old
// revision of tool-registry.js. That scan is only believable because it
// reproduces, exactly, the name set the live module actually exports.
assert.equal(extractorSelfCheck(live), live.length);
code(() => extractorSelfCheck([...live, 'phantom.tool']), 'FRA_REPIN_EXTRACTOR_UNTRUSTWORTHY');
code(() => extractorSelfCheck(live.slice(1)), 'FRA_REPIN_EXTRACTOR_UNTRUSTWORTHY');
assert.deepEqual(extractNames("define('alpha.one', x); define(\n  'beta.two', y);"), ['alpha.one', 'beta.two']);
assert.deepEqual(extractNames('define("gamma.three", z);'), [],
  'only the single-quoted registration form this registry actually uses is recognized');

// --- the baseline is found, never inferred ----------------------------------
// recoverBaseline stops at the revision whose extracted names HASH to the
// pinned digest. Equality of a SHA-256 is proof the recovered list is the
// pinned list; nothing weaker would make the printed delta trustworthy.
const liveDigest = digestOfNames(live);
const baselineRevision = 'a'.repeat(40);
const baselineNames = Object.freeze(['alpha.one', 'beta.two']);
const baselineDigest = digestOfNames(baselineNames);
const historyFixture = {
  revisions: [baselineRevision, 'b'.repeat(40)],
  readRevision: revision => revision === baselineRevision ? baselineNames : ['later.tool']
};
const found = recoverBaseline(baselineDigest, historyFixture);
assert.notEqual(found, null, 'an exact historical digest resolves to its exact injected revision');
assert.deepEqual([...found.names], baselineNames);
assert.equal(found.revision, baselineRevision);
assert.equal(recoverBaseline(crypto.createHash('sha256').update('no such registry').digest('hex'), historyFixture), null,
  'a digest that never existed must resolve to no baseline at all');
code(() => digestOfNames(['NotATool']), 'FRA_REPIN_NAMES_INVALID');

// --- the live tree ----------------------------------------------------------
// Capability manifests are customer-owned per-installation files. Exercise the
// real machine-id resolution and manifest parser with a complete temporary
// installation instead of requiring one developer's untracked config files.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-manifest-repin-'));
const fixtureConfig = path.join(fixtureRoot, 'config');
fs.mkdirSync(fixtureConfig, { recursive: true });
const fixtureRegistry = Object.freeze({
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '192.0.2.10', root: 'C:\\fixture\\machine-a', role: 'development-host' },
    'machine-b': { address: '192.0.2.11', root: 'C:\\fixture\\machine-b', role: 'disconnected-peer' }
  },
  services: {}
});
const fixtureAllowed = Object.freeze([
  'browser.playwright_call', 'ocr.read', 'screen.capture', 'system.status',
  'workspace.list', 'workstation.install_cursor'
].sort());
const fixtureExcluded = Object.freeze([...REQUIRED_EXCLUDED_TOOLS].sort());
const fixtureManifest = {
  schemaVersion: SCHEMA_VERSION,
  registryNameDigest: liveDigest,
  allowedToolNamesDigest: toolNameDigest(fixtureAllowed),
  allowedToolCount: fixtureAllowed.length,
  allowedTools: fixtureAllowed,
  excludedTools: fixtureExcluded,
  desktopCapabilities: { clipboard: false, ocr: true, screenCapture: true },
  transportPolicy: TRANSPORT_POLICY_DESCRIPTOR
};
for (const machineId of ['machine-a', 'machine-b']) {
  fs.writeFileSync(path.join(fixtureConfig, `fra-capability-manifest.${machineId}.json`),
    `${JSON.stringify(fixtureManifest, null, 2)}\n`, 'utf8');
}
let report;
try {
  report = analyse({ serviceRegistryOptions: { registry: fixtureRegistry }, manifestRoot: fixtureRoot });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
assert.equal(report.currentRegistryDigest, liveDigest);
assert.equal(report.currentRegistryCount, live.length);
assert.equal(report.manifests.length >= 2, true, 'every registry machine gets a manifest row');
for (const manifest of report.manifests) {
  assert.match(manifest.file, /fra-capability-manifest\.[a-z0-9-]+\.json$/);
  assert.equal(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(manifest.file), false,
    'the re-pin tool resolves manifests by machine identity, never by address');
  assert.equal(manifest.state, 'current',
    `${manifest.machineId} must pin the live registry; run "node tools/fra-manifest-repin.js --check"`);
  // A re-pin changes the registry pin and nothing else. If these ever move,
  // the change is a capability change and must be reviewed as one.
  assert.equal(manifest.allowedToolCount, fixtureAllowed.length);
  assert.equal(manifest.excludedToolCount, fixtureExcluded.length);
}
assert.match(renderReport(report), /live registry digest\s+[a-f0-9]{64}/);

// --- the refusals, which are the whole point --------------------------------
const staleRow = {
  machineId: 'machine-a', state: 'stale', baselineRevision: 'a'.repeat(40),
  removedFromPinnedSurface: [], addedIntoPinnedSurface: []
};
assert.equal(writable({ manifests: [{ ...staleRow, state: 'current' }] }).code, 'FRA_REPIN_NOTHING_TO_DO');
assert.equal(writable({ manifests: [staleRow] }).ok, true);

// Without the pinned name list there is no delta, and a write would be exactly
// the rubber stamp the digest exists to prevent.
assert.equal(writable({ manifests: [{ ...staleRow, baselineRevision: null }] }).code,
  'FRA_REPIN_BASELINE_NOT_FOUND');

// A tool the manifest NAMES having vanished is a capability change wearing a
// digest change's clothes. It goes to a human, not through this tool.
assert.equal(writable({
  manifests: [{ ...staleRow, removedFromPinnedSurface: ['screen.capture'] }]
}).code, 'FRA_REPIN_SURFACE_TOOL_REMOVED');

// --- the operator has to state what they reviewed ---------------------------
assert.equal(parseCli([]).mode, 'check');
assert.equal(parseCli(['--check']).mode, 'check');
code(() => parseCli(['--write']), 'FRA_REPIN_CLI_INVALID');
code(() => parseCli(['--write', '--acknowledge-registry-digest', 'not-a-digest']), 'FRA_REPIN_CLI_INVALID');
code(() => parseCli(['--yolo']), 'FRA_REPIN_CLI_INVALID');
const acknowledged = parseCli(['--write', '--acknowledge-registry-digest', liveDigest]);
assert.equal(acknowledged.mode, 'write');
assert.equal(acknowledged.acknowledge, liveDigest);

console.log(JSON.stringify({
  ok: true,
  registryToolCount: live.length,
  registryNameDigest: liveDigest,
  baselineRevision: found.revision,
  manifests: report.manifests.map(manifest => ({ machineId: manifest.machineId, state: manifest.state }))
}));
