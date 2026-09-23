// EXECUTABLE CHANGE
// testcanfail-tests-fra-runtime-integrity-js
//
// Mutation report: canonicalManifest was temporarily mutated to serialize
// `algorithm` before `schemaVersion`.  The former self-derived expectation
// (`canonicalManifest(JSON.parse(originalAnchor))`) remained green; the
// independent byte expectation below went RED with:
//   AssertionError [ERR_ASSERTION]: the manifest writer must emit the independently specified canonical byte layout
//   + actual - expected
//   + '{"algorithm":"sha256","schemaVersion":"fra-runtime-integrity.v2",...'
//   - '{"schemaVersion":"fra-runtime-integrity.v2","algorithm":"sha256",...'
// The source mutation was restored byte-for-byte (the SHA-256 before and after
// was 44aaccd4f8cc7098f3219c13eaa54d405fc7669df975486343f9e30964ec4904).
//
// Shape census: empty collection loops NOT-FOUND (all literal loops are
// non-empty, and both TOP_LEVEL_FILES loops are preceded by its exact length
// assertion); exit-status/truthy process evidence NOT-FOUND; swallowed target
// failure NOT-FOUND (the two nested catches are cleanup only); subject mock
// NOT-FOUND; whole-file skip/platform guard NOT-FOUND; same-code expectation
// FOUND and fixed below.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RUNTIME_ROOTS,
  EPHEMERAL_RUNTIME_DIRECTORY_NAMES,
  TOP_LEVEL_FILES,
  SCHEMA_VERSION,
  anchoredTopLevelFiles,
  capabilityManifestEntries,
  canonicalManifest,
  buildRuntimeManifest,
  manifestPathForHost,
  resolveAnchorPath,
  readRuntimeIntegrityDeclaration,
  verifyRuntimeIntegrity,
  writeRuntimeManifest
} = require('../src/lib/fra-runtime-integrity');

assert.deepEqual(RUNTIME_ROOTS, []);
assert.deepEqual(EPHEMERAL_RUNTIME_DIRECTORY_NAMES, ['__pycache__']);
for (const mutable of ['config', 'packages', 'scripts', 'sidecars', 'state', 'vault', 'logs', 'profiles', 'reports']) {
  assert.equal(RUNTIME_ROOTS.includes(mutable), false, `${mutable} must not be an anchored directory root`);
}
for (const required of [
  'config/fra-capability-manifest.this-machine.json',
  'config/service-registry.json',
  'config/toolsenabled.policy.json',
  'config/uac-delegation-allowlist.json',
  'src/full-remote-access-bridge.js',
  'src/lib/action-guards.js',
  'src/lib/approvals.js',
  'src/lib/fra-machine-identity.js',
  'src/lib/fra-runtime-integrity.js',
  'src/lib/policy-authorizations.js',
  'src/lib/scoped-approvals.js',
  'src/lib/service-registry.js',
  'src/lib/state-store.js',
  'src/lib/fra-secure-session.js',
  'src/lib/fra-transport-binding.js',
  'src/lib/fra-workspace-policy.js',
  'src/mcp-server.js',
  'tools/fra-root-access-control.ps1',
  'tools/fra-root-access-probe.ps1',
  'tools/full-remote-access-control.ps1',
  'tools/full-remote-access-listener-host.js',
  'tools/full-remote-access-enroll-peer.js',
  'tools/full-remote-access-enroll-token.js',
  'tools/lib/service-registry.ps1',
  'tools/fra-peer-identity-probe.js',
  'tools/secrets.ps1'
]) assert.ok(TOP_LEVEL_FILES.includes(required), `${required} must be anchored exactly`);

// The anchor takes immutable executable inputs only. A narrative document is
// not one: agents are required to edit STANDING-ORDERS.md and its machine
// mirror every time the owner gives an instruction, and no code in the FRA
// request path reads either. Anchoring them made routine correct work break the
// link, which on 2026-08-02 cost nineteen hours. These two assertions exist so
// nobody can put them back without deleting a test that says why.
// This checkout declares one machine, so the public default contains the 49
// reviewed static inputs plus one registry-derived capability manifest. The
// former 52-entry ratchet also counted an already-missing cutover script and a
// retired one-shot credential receiver; the r204 identity probe was renamed,
// not duplicated. Keep those removals explicit so lowering the count cannot
// conceal an accidentally unanchored replacement.
assert.equal(TOP_LEVEL_FILES.length, 50,
  'the anchored set is 49 reviewed static inputs plus this registry\'s one capability manifest');
for (const retired of [
  'tools/launch-fra-cutover-maintenance.ps1',
  'tools/r204-probe-a-fra-identity.js',
  'tools/special-session-credential-receiver.js'
]) {
  assert.equal(TOP_LEVEL_FILES.includes(retired), false,
    `${retired} is retired and must not return to the executable runtime anchor`);
}
for (const forbidden of ['STANDING-ORDERS.md', 'config/standing-orders.json']) {
  assert.equal(TOP_LEVEL_FILES.includes(forbidden), false,
    `${forbidden} is a routinely edited policy document and must never be anchored`);
}
for (const entry of TOP_LEVEL_FILES) {
  assert.equal(/\.(?:md|markdown|txt|rst)$/i.test(entry), false,
    `${entry}: no document file belongs in the runtime anchor`);
  // Per-machine capability manifests are created by enrollment and are
  // deliberately absent from a fresh default tree. Every immutable static
  // executable input, however, must already be present and regular.
  if (!entry.startsWith('config/fra-capability-manifest.')) {
    assert.equal(fs.lstatSync(path.join(__dirname, '..', ...entry.split('/'))).isFile(), true,
      `${entry}: every static runtime anchor input must exist as a regular file`);
  }
}

// B26. Not one anchored path may name an address. The two capability manifests
// used to be listed here by IP, which froze this lab's subnet into every
// install's anchor: a customer's own manifest was unanchored while ours were
// anchored in their tree forever, and moving networks broke both.
for (const entry of TOP_LEVEL_FILES) {
  assert.equal(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(entry), false,
    `${entry}: no IP address may appear in the anchored set`);
}
// ...and the manifest entries follow whatever machines the registry declares,
// rather than being enumerated for this lab.
assert.deepEqual(
  capabilityManifestEntries({
    registry: {
      schemaVersion: 1,
      machines: { 'first-box': { address: '10.1.1.1' }, 'second-box': { address: '10.1.1.2' } },
      services: {}
    }
  }),
  ['config/fra-capability-manifest.first-box.json', 'config/fra-capability-manifest.second-box.json']);
assert.equal(
  anchoredTopLevelFiles().includes('config/fra-capability-manifest.this-machine.json'), true,
  'the anchored set names the manifests this registry actually declares');

// Every host below is resolved through this INJECTED registry rather than the
// machine-local one on disk, so the test describes a fixed two-machine lab and
// no longer depends on the builder's own addresses.
const lab = {
  schemaVersion: 1,
  machines: {
    'machine-a': { address: '203.0.113.2', root: 'C:\\a', role: 'development-host' },
    'machine-b': { address: '203.0.113.1', root: 'C:\\b', role: 'disconnected-peer' }
  },
  services: {}
};
const labRegistry = { registry: lab };

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-runtime-integrity-'));
const roots = ['config', 'src'];
const topLevelFiles = ['package.json'];
const host = '203.0.113.1';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verify() {
  return verifyRuntimeIntegrity({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
}

try {
  fs.mkdirSync(path.join(directory, 'config'));
  fs.mkdirSync(path.join(directory, 'src'));
  fs.writeFileSync(path.join(directory, 'config', 'policy.json'), '{"enabled":true}\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'src', 'a.js'), "'use strict';\n", 'utf8');
  fs.mkdirSync(path.join(directory, 'src', '__pycache__'));
  fs.writeFileSync(path.join(directory, 'src', '__pycache__', 'derived.pyc'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(directory, 'src', 'anchored.pyc'), Buffer.from([4, 5, 6, 7]));
  fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"fixture"}\n', 'utf8');

  const firstBuild = buildRuntimeManifest({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  const secondBuild = buildRuntimeManifest({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  assert.equal(canonicalManifest(firstBuild), canonicalManifest(secondBuild));
  assert.deepEqual(firstBuild.roots, roots);
  assert.deepEqual(firstBuild.topLevelFiles, topLevelFiles);
  assert.equal(firstBuild.files.some(file => file.path.startsWith('../')), false);
  assert.equal(firstBuild.directories.includes('src/__pycache__'), false);
  assert.equal(firstBuild.files.some(file => file.path.startsWith('src/__pycache__/')), false);
  assert.equal(firstBuild.files.some(file => file.path === 'src/anchored.pyc'), true,
    'only the conventional mutable cache directory is excluded');

  const written = writeRuntimeManifest({
    root: directory, host, expectedPreimage: 'absent',
    expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  assert.equal(written.valid, true);
  assert.equal(written.secretValuesEmitted, false);
  const anchor = manifestPathForHost(directory, host, labRegistry);
  const originalAnchor = fs.readFileSync(anchor, 'utf8');
  const parsedAnchor = JSON.parse(originalAnchor);
  const independentlyCanonicalAnchor = `${JSON.stringify({
    schemaVersion: parsedAnchor.schemaVersion,
    algorithm: parsedAnchor.algorithm,
    machine: parsedAnchor.machine,
    roots: parsedAnchor.roots,
    topLevelFiles: parsedAnchor.topLevelFiles,
    directoryCount: parsedAnchor.directoryCount,
    directories: parsedAnchor.directories,
    fileCount: parsedAnchor.fileCount,
    files: parsedAnchor.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    runtimeDigest: parsedAnchor.runtimeDigest
  })}\n`;
  assert.equal(originalAnchor, independentlyCanonicalAnchor,
    'the manifest writer must emit the independently specified canonical byte layout');
  assert.equal(verify().runtimeDigest, written.runtimeDigest);

  // A failed content read means integrity could not be established; a close
  // failure after the complete, identity-checked read does not turn that
  // established positive into either "did not happen" or an unknown result.
  // Name and exercise that distinction so cleanup-only catches cannot conceal
  // a future read failure.
  const unreadableFs = Object.create(fs);
  unreadableFs.readSync = () => { throw new Error('injected content-read failure'); };
  assert.throws(() => verifyRuntimeIntegrity({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry, fsApi: unreadableFs
  }), error => error && error.code === 'FRA_RUNTIME_FILE_READ_FAILED',
  'could not be established is a named read failure, never a definite negative');
  const closeFailureFs = Object.create(fs);
  closeFailureFs.closeSync = handle => {
    fs.closeSync(handle);
    throw new Error('injected post-close cleanup failure');
  };
  assert.equal(verifyRuntimeIntegrity({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry, fsApi: closeFailureFs
  }).valid, true, 'a cleanup failure after an established read preserves the definite positive');

  const declaration = readRuntimeIntegrityDeclaration({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  assert.equal(declaration.declared, true);
  assert.equal(declaration.runtimeDigest, written.runtimeDigest);
  assert.throws(() => writeRuntimeManifest({
    root: directory, host, expectedPreimage: 'f'.repeat(64),
    expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  }), error => error && error.code === 'FRA_RUNTIME_PREIMAGE_CHANGED');

  fs.appendFileSync(path.join(directory, 'src', 'a.js'), '// drift\n', 'utf8');
  assert.equal(readRuntimeIntegrityDeclaration({
    root: directory, host, expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  }).runtimeDigest, written.runtimeDigest, 'peer declaration validation does not rescan local bytes');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');
  fs.writeFileSync(path.join(directory, 'src', 'a.js'), "'use strict';\n", 'utf8');
  assert.equal(verify().valid, true);

  fs.writeFileSync(path.join(directory, 'src', '__pycache__', 'derived.pyc'), Buffer.from([9, 8, 7, 6, 5]));
  assert.equal(verify().valid, true, 'mutable derived Python cache bytes do not invalidate the Node runtime anchor');
  fs.writeFileSync(path.join(directory, 'src', 'anchored.pyc'), Buffer.from([9, 9, 9]));
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_FILE_HASH_MISMATCH');
  fs.writeFileSync(path.join(directory, 'src', 'anchored.pyc'), Buffer.from([4, 5, 6, 7]));
  assert.equal(verify().valid, true);

  fs.writeFileSync(path.join(directory, 'src', 'extra.js'), 'extra\n', 'utf8');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_LAYOUT_MISMATCH');
  fs.rmSync(path.join(directory, 'src', 'extra.js'));
  assert.equal(verify().valid, true);

  fs.renameSync(path.join(directory, 'src', 'a.js'), path.join(directory, 'src', 'gone.js'));
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_LAYOUT_MISMATCH');
  fs.renameSync(path.join(directory, 'src', 'gone.js'), path.join(directory, 'src', 'a.js'));

  const canonical = JSON.parse(originalAnchor);
  fs.writeFileSync(anchor, JSON.stringify(canonical, null, 2), 'utf8');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_MANIFEST_NONCANONICAL');
  fs.writeFileSync(anchor, originalAnchor, 'utf8');

  const escaped = JSON.parse(originalAnchor);
  escaped.files[0].path = '../escape';
  fs.writeFileSync(anchor, canonicalManifest(escaped), 'utf8');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_PATH_INVALID');
  fs.writeFileSync(anchor, originalAnchor, 'utf8');

  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-runtime-external-'));
  const junction = path.join(directory, 'src', 'reparse');
  try {
    fs.symlinkSync(external, junction, 'junction');
    assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_REPARSE_REFUSED');
  } finally {
    try { fs.rmSync(junction, { force: true }); } catch {}
    fs.rmSync(external, { recursive: true, force: true });
  }
  assert.equal(verify().valid, true);

  const intermediateFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-runtime-intermediate-'));
  const realTools = path.join(intermediateFixture, 'real-tools');
  const toolsJunction = path.join(intermediateFixture, 'tools');
  try {
    fs.mkdirSync(path.join(intermediateFixture, 'src'));
    fs.mkdirSync(realTools);
    fs.writeFileSync(path.join(intermediateFixture, 'src', 'entry.js'), 'entry\n', 'utf8');
    fs.writeFileSync(path.join(realTools, 'policy.js'), 'policy\n', 'utf8');
    fs.symlinkSync(realTools, toolsJunction, 'junction');
    assert.throws(() => buildRuntimeManifest({
      root: intermediateFixture,
      host,
      expectedRoots: ['src'],
      expectedTopLevelFiles: ['tools/policy.js'],
      serviceRegistryOptions: labRegistry
    }), error => error && error.code === 'FRA_RUNTIME_REPARSE_REFUSED');
  } finally {
    try { fs.rmSync(toolsJunction, { force: true }); } catch {}
    fs.rmSync(intermediateFixture, { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(directory, 'src', 'new-reviewed.js'), 'reviewed\n', 'utf8');
  const preimage = sha256(anchor);
  const updated = writeRuntimeManifest({
    root: directory, host, expectedPreimage: preimage,
    expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  assert.equal(updated.valid, true);
  assert.notEqual(sha256(anchor), preimage);
  assert.equal(JSON.parse(fs.readFileSync(anchor, 'utf8')).files.some(file => file.path === 'src/new-reviewed.js'), true);

  const peerAnchor = manifestPathForHost(directory, '203.0.113.2', labRegistry);
  fs.copyFileSync(anchor, peerAnchor);
  assert.throws(() => verifyRuntimeIntegrity({
    root: directory, host: '203.0.113.2', expectedRoots: roots,
    expectedTopLevelFiles: topLevelFiles, serviceRegistryOptions: labRegistry
  }), error => error && error.code === 'FRA_RUNTIME_MANIFEST_INVALID');
  fs.rmSync(peerAnchor);

  // ---- B26: the anchor identifies its machine, not its address ------------
  assert.equal(SCHEMA_VERSION, 'fra-runtime-integrity.v2');
  assert.match(anchor, /fra-runtime-integrity\.machine-b\.json$/);
  const anchorObject = JSON.parse(fs.readFileSync(anchor, 'utf8'));
  assert.equal(anchorObject.machine, 'machine-b');
  assert.equal(Object.hasOwn(anchorObject, 'host'), false,
    'the anchor must not identify its machine by an address that a network move invalidates');
  const impersonated = canonicalManifest({ ...anchorObject, machine: 'machine-a' });
  fs.writeFileSync(anchor, impersonated, 'utf8');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_MANIFEST_INVALID');
  fs.writeFileSync(anchor, canonicalManifest(anchorObject), 'utf8');
  assert.equal(verify().valid, true);

  // ---- B26: the network move, without a network move ----------------------
  // Same machine, same declared root, an entirely different subnet. The owner
  // has said this will happen before testing and that "the server will remain
  // the same". Nothing may be renamed and nothing may be re-cut: the anchor
  // written on the old network must verify unchanged on the new one.
  const movedRegistry = {
    schemaVersion: 1,
    machines: {
      'machine-a': { address: '203.0.113.41', root: 'C:\\example\\engine-checkout', role: 'development-host' },
      'machine-b': { address: '203.0.113.42', root: 'C:\\elsewhere', role: 'disconnected-peer' }
    },
    services: {}
  };
  const moved = { registry: movedRegistry };
  assert.equal(manifestPathForHost(directory, '203.0.113.42', moved), anchor,
    'the same machine on a new address must resolve to the same anchor file');
  const afterMove = verifyRuntimeIntegrity({
    root: directory, host: '203.0.113.42', expectedRoots: roots,
    expectedTopLevelFiles: topLevelFiles, serviceRegistryOptions: moved
  });
  assert.equal(afterMove.valid, true, 'an anchor cut before the move still verifies after it');
  assert.equal(afterMove.machine, 'machine-b');
  assert.equal(afterMove.host, '203.0.113.42');
  assert.equal(afterMove.runtimeDigest, verify().runtimeDigest, 'moving networks changes no runtime digest');
  // ...and the address it used to have now belongs to nobody, which is a
  // refusal rather than a silent fallback.
  assert.throws(() => verifyRuntimeIntegrity({
    root: directory, host: '203.0.113.1', expectedRoots: roots,
    expectedTopLevelFiles: topLevelFiles, serviceRegistryOptions: moved
  }), error => error && error.code === 'FRA_RUNTIME_HOST_INVALID');

  // ---- an anchor must never appear inside an anchor ------------------------
  // This guard is a regex over the anchor FILENAME, so a rename is exactly how
  // it fails open: a dotted-quad-only pattern silently stops matching the
  // identity-keyed name, and collectRuntimeLayout starts pulling anchor files
  // into the very anchor being written -- a self-referential digest that can
  // never be satisfied. Both naming conventions must stay excluded, and the
  // fixture roots below include config/, so this is measured, not asserted.
  const decoyAnchors = [
    path.join(directory, 'config', 'fra-runtime-integrity.machine-a.json'),
    path.join(directory, 'config', 'fra-runtime-integrity.203.0.113.7.json')
  ];
  for (const decoy of decoyAnchors) fs.writeFileSync(decoy, 'not a real anchor\n', 'utf8');
  assert.equal(verify().valid, true,
    'anchor-shaped files under an anchored root must be excluded under BOTH naming conventions');
  const notAnAnchor = path.join(directory, 'config', 'fra-runtime-integrity-notes.json');
  fs.writeFileSync(notAnAnchor, 'anchor-adjacent, but not an anchor\n', 'utf8');
  assert.throws(verify, error => error && error.code === 'FRA_RUNTIME_LAYOUT_MISMATCH');
  fs.rmSync(notAnAnchor);
  for (const decoy of decoyAnchors) fs.rmSync(decoy);
  assert.equal(verify().valid, true);

  // ---- B26: migration ramp for the two existing IP-named files ------------
  const legacyAnchor = path.join(directory, 'config', 'fra-runtime-integrity.203.0.113.1.json');
  fs.renameSync(anchor, legacyAnchor);
  assert.equal(fs.existsSync(anchor), false);
  assert.equal(manifestPathForHost(directory, host, labRegistry), legacyAnchor,
    'a tree that still carries the legacy address-named anchor keeps working');
  assert.equal(resolveAnchorPath(directory, host, labRegistry).keying, 'legacy-address');
  assert.equal(verify().valid, true, 'the legacy-named anchor still verifies');
  // A write is how a tree migrates itself forward: it always targets the
  // identity name, never the legacy one it was just read from.
  const migrated = writeRuntimeManifest({
    root: directory, host, expectedPreimage: 'absent',
    expectedRoots: roots, expectedTopLevelFiles: topLevelFiles,
    serviceRegistryOptions: labRegistry
  });
  assert.equal(migrated.valid, true);
  assert.equal(fs.existsSync(anchor), true, 'writing migrates the anchor to the identity-keyed name');
  assert.equal(manifestPathForHost(directory, host, labRegistry), anchor, 'once present, the identity-keyed anchor wins');
  assert.equal(resolveAnchorPath(directory, host, labRegistry).keying, 'machine-id');
  fs.rmSync(legacyAnchor);
  assert.equal(verify().valid, true);

  console.log(JSON.stringify({
    ok: true,
    fileCount: updated.fileCount,
    directoryCount: updated.directoryCount,
    runtimeDigest: updated.runtimeDigest,
    reparseRejected: true,
    preimageFenced: true
  }));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
