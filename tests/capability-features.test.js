// EXECUTABLE CHANGE
//
// Discrimination report (2026-08-26):
// - EMPTY-LOOP: strengthened the zero-tool regression, absent-rendering, and
//   shipped-probe checks with explicit witness assertions. Mutations and RED
//   output are recorded beside each assertion below.
// - NOT-FOUND exit-status/truthy-return-only assertions: this file spawns no
//   process and makes no exit-status assertion.
// - NOT-FOUND swallowed failures: there is no try/catch or optional chain in a
//   test path that can swallow the failure under test.
// - NOT-FOUND subject mocks: fixtures provide inputs but do not mock exports of
//   capability-features, the subject under test.
// - NOT-FOUND skip/platform guard: every check runs unconditionally.
// - NOT-FOUND same-code oracle: expected values are literals and independently
//   inspected fixture/manifest facts, not results recomputed by the subject.
// - PRECONDITIONS: all mutations and the final green run executed locally; no
//   precondition was unmet. The production source was restored byte-for-byte.

'use strict';

// THE ONBOARDING FEATURE LINE MUST NOT BE ABLE TO LIE.
//
// Owner, 2026-08-13: '[filekepper] [grepsaver] etc should be an onboarding line
// for all the users enabled setting features', then: 'cant we mechanically
// restrict access completely to the parts of the program that a user disabled?'
//
// The answer this suite pins is that the line is a PROJECTION of the resolved
// tool surface, not a config value someone can set. That matters because the
// alternative -- a flag that only decides what a packet prints -- is the exact
// defect class this codebase keeps shipping: requireCapability() with zero
// callers, seatMinimum read nowhere, the purchase reservation the spend path had
// never heard of. A feature line backed by a flag would read as a guarantee and
// enforce nothing.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const features = require('../src/lib/capability-features');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const ROOT = path.resolve(__dirname, '..');

check('the shipped manifest parses and every feature declares a real tier', () => {
  const declared = features.readManifest();
  assert.ok(declared.length > 0, 'the manifest must declare features');
  for (const feature of declared) {
    assert.ok(features.TIERS.includes(feature.tier),
      `${feature.id} declares tier ${feature.tier}, which is not one of ${features.TIERS.join(', ')}`);
  }
  // Both names the owner used must be present, or his line cannot render.
  const ids = declared.map(feature => feature.id);
  assert.ok(ids.includes('grepsaver'), 'grepsaver must be declared');
  assert.ok(ids.includes('filekeeper'), 'filekeeper must be declared');
});

check('a feature whose tools are missing from the session resolves ABSENT', () => {
  // THE PROPERTY THAT MAKES THIS HONEST. A confined permission tier shrinks
  // listTools; the line must shrink with it, without knowing tiers exist.
  const withCloud = features.resolveFeatures({
    toolNames: ['cloud.task_launch', 'cloud.task_diff', 'cloud.task_status', 'cloud.task_list']
  });
  const cloudReady = withCloud.find(feature => feature.id === 'cloud-lane');
  assert.notEqual(cloudReady.state, 'absent', 'with its tools present, cloud-lane is reachable');

  const withoutCloud = features.resolveFeatures({ toolNames: [] });
  const cloudGone = withoutCloud.find(feature => feature.id === 'cloud-lane');
  assert.equal(cloudGone.state, 'absent', 'with its tools gone, cloud-lane must not be advertised');
  assert.match(cloudGone.reason, /tools not in this session/);
});

check('REGRESSION: a zero-tool surface renders NO tool-backed feature', () => {
  // THE EXACT LIE AN ADVERSARIAL REVIEW PROVED BY EXECUTION on 2026-08-13.
  // With toolNames: [] the line still printed
  //   [grepsaver: degraded] [filekeeper] [local-node] [vault]
  // because `tools: []` fell through the old check as "unconditionally
  // satisfied" rather than "unverifiable". The coordinator had told the owner
  // this line could not lie. It could.
  //
  // The fix is that the manifest must DECLARE what would prove each feature.
  // This pins the consequence: nothing claiming tool-backing may survive a
  // surface with no tools.
  const resolved = features.resolveFeatures({ toolNames: [] });
  const manifest = new Map(features.readManifest().map(entry => [entry.id, entry]));
  const toolBacked = resolved.filter(feature => manifest.get(feature.id)?.verifiedBy === 'tools');
  // Mutation: resolveFeatures returned no entries for the zero-tool surface.
  // RED: "AssertionError [ERR_ASSERTION]: the shipped manifest must resolve at least one tool-backed feature"
  assert.ok(toolBacked.length > 0,
    'the shipped manifest must resolve at least one tool-backed feature');
  for (const feature of toolBacked) {
    assert.equal(feature.state, 'absent',
      `${feature.id} is proven by tools, yet reports ${feature.state} against a surface with none`);
  }
  const line = features.featureLine(resolved) || '';
  for (const id of ['cloud-lane', 'audit-ledger', 'purchase-cart', 'search', 'memory', 'scheduler', 'sandbox']) {
    assert.ok(!line.includes(`[${id}`), `${id} must not appear with no tools available; line was: ${line}`);
  }
});

check('a feature cannot claim tool-backing while naming no tools', () => {
  // The shape that produced the lie, refused at load so it cannot recur.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-empty-tools-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [{ id: 'thing', title: 't', tier: 'gated', verifiedBy: 'tools', probeFiles: [], tools: [] }]
  }), 'utf8');
  assert.throws(
    () => features.readManifest({ manifestFile }),
    error => error.code === 'FEATURE_MANIFEST_INVALID' && /declares none/.test(error.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check('an undeclared verifiedBy is refused, like an undeclared tier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-verify-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [{ id: 'thing', title: 't', tier: 'gated', verifiedBy: 'vibes', probeFiles: [], tools: [] }]
  }), 'utf8');
  assert.throws(
    () => features.readManifest({ manifestFile }),
    error => error.code === 'FEATURE_MANIFEST_INVALID' && /verifiedBy/.test(error.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a probe-backed feature must have a probe that actually exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-probe-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [{ id: 'no-such-probe', title: 't', tier: 'gated', verifiedBy: 'probe', probeFiles: [], tools: [] }]
  }), 'utf8');
  assert.throws(
    () => features.readManifest({ manifestFile }),
    error => error.code === 'FEATURE_MANIFEST_INVALID' && /no probe is implemented/.test(error.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check('the rendered line never names an absent feature', () => {
  const resolved = features.resolveFeatures({ toolNames: [] });
  const line = features.featureLine(resolved) || '';
  // Mutation: resolveFeatures returned no entries for the zero-tool surface.
  // RED: "AssertionError [ERR_ASSERTION]: a zero-tool surface must provide absent features to test against"
  assert.ok(resolved.some(feature => feature.state === 'absent'),
    'a zero-tool surface must provide absent features to test against');
  for (const feature of resolved) {
    if (feature.state === 'absent') {
      assert.ok(!line.includes(`[${feature.id}]`),
        `${feature.id} is absent but the line advertises it`);
    }
  }
});

check('a feature that is installed but has nothing to serve reports DEGRADED', () => {
  // GrepSaver, measured in canonical 2026-08-12: the tool is present and wired,
  // and its index declares exactly one card, still pending-review. Advertising
  // it flat would route an agent to an empty index and cost the very lookup the
  // feature exists to save.
  const emptyIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-features-'));
  const manifestFile = path.join(emptyIndexDir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [{
      id: 'grepsaver', title: 'cards', tier: 'unregistered', verifiedBy: 'command',
      entry: 'node tools/grepsaver-orient.js "<topic>"',
      probeFiles: ['tools/grepsaver-orient.js'], cardIndex: 'cards.json', tools: []
    }]
  }), 'utf8');

  // the fixture is 'command'-verified, so its probe file must exist in ITS root
  fs.mkdirSync(path.join(emptyIndexDir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(emptyIndexDir, 'tools', 'grepsaver-orient.js'), '// fixture\n', 'utf8');
  fs.writeFileSync(path.join(emptyIndexDir, 'cards.json'),
    JSON.stringify({ systems: [{ id: 'toolsenabled', state: 'pending-review' }] }), 'utf8');
  const pending = features.resolveFeatures({ toolNames: [], manifestFile, root: emptyIndexDir });
  assert.equal(pending[0].state, 'degraded');
  assert.match(pending[0].reason, /none is approved/);
  assert.equal(features.featureLine(pending), '[grepsaver: degraded]',
    'a degraded feature must be marked in the line, not printed as if it were stocked');

  fs.writeFileSync(path.join(emptyIndexDir, 'cards.json'),
    JSON.stringify({ systems: [{ id: 'toolsenabled', state: 'FRESH' }] }), 'utf8');
  const approved = features.resolveFeatures({ toolNames: [], manifestFile, root: emptyIndexDir });
  assert.equal(approved[0].state, 'ready');
  assert.equal(features.featureLine(approved), '[grepsaver]');

  fs.rmSync(emptyIndexDir, { recursive: true, force: true });
});

check('an undeclared tier is refused rather than defaulted', () => {
  // A settings screen must never get to invent its own meaning for "off".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-tier-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [{ id: 'thing', title: 't', tier: 'sort-of-off', probeFiles: [], tools: [] }]
  }), 'utf8');
  assert.throws(
    () => features.readManifest({ manifestFile }),
    error => error.code === 'FEATURE_MANIFEST_INVALID' && /must be one of/.test(error.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a duplicate feature id is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-dupe-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({
    schemaVersion: 1,
    features: [
      { id: 'thing', title: 't', tier: 'gated', verifiedBy: 'tools', probeFiles: [], tools: ['a.b'] },
      { id: 'thing', title: 't', tier: 'gated', verifiedBy: 'tools', probeFiles: [], tools: ['a.b'] }
    ]
  }), 'utf8');
  assert.throws(
    () => features.readManifest({ manifestFile }),
    error => error.code === 'FEATURE_MANIFEST_INVALID' && /declared twice/.test(error.message)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

check('every probeFile the shipped manifest names exists in this tree', () => {
  // A probe pointed at a path that moved reports a present feature as absent,
  // which is the same lie in the other direction. Caught here rather than by a
  // reader wondering why the vault vanished.
  const declared = features.readManifest();
  const probeCount = declared.reduce(
    (count, feature) => count + (feature.probeFiles || []).length, 0);
  // Mutation: readManifest returned the shipped entries with every probeFiles
  // array emptied. RED: "AssertionError [ERR_ASSERTION]: the shipped manifest must declare at least one probeFile"
  assert.ok(probeCount > 0, 'the shipped manifest must declare at least one probeFile');
  for (const feature of declared) {
    for (const relative of (feature.probeFiles || [])) {
      assert.ok(fs.existsSync(path.join(ROOT, relative)),
        `${feature.id} probes ${relative}, which does not exist -- fix the probe, do not delete it`);
    }
  }
});

process.stdout.write(`capability-features: ${checks} checks passed\n`);
