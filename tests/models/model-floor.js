// Executable policy and drift checks for the model-floor authority.

'use strict';

// Pins the configured model floor: config/model-floor.json is the authoritative
// source, a below-floor model is a REFUSAL rather than a fallback, no purpose
// (including a planning pass) lowers it, and no other file in the repo may
// declare a contradicting model list without this test failing.
// Run: node tests/models/model-floor.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modelFloor = require('../../src/lib/model-floor');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

// --- the authority loads and is internally coherent --------------------------

check('config/model-floor.json loads and declares every distinct fixed lane backend', () => {
  const doc = modelFloor.loadFloor({ force: true });
  assert.equal(doc.schemaVersion, 'model-floor-v1');
  assert.deepEqual(modelFloor.backendIds().sort(), ['subscription', 'vertex', 'vertex-seat']);
});

check('each backend default is itself on that backend floor', () => {
  for (const backend of modelFloor.backendIds()) {
    assert.ok(modelFloor.allowedFor(backend).includes(modelFloor.defaultFor(backend)));
  }
});

check('the floor admits no flash tier on any backend', () => {
  for (const model of modelFloor.allowedUnion()) {
    assert.ok(!/flash/i.test(model),
      `the configured policy excludes flash tiers, but "${model}" is on a floor`);
  }
});

check('published model policy carries no stale private directives or environment claims', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const policyText = [
    fs.readFileSync(path.join(repoRoot, 'config', 'model-floor.json'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'config', 'agent-allotment.json'), 'utf8')
  ].join('\n');
  const modelCoreText = [
    policyText,
    fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'model-floor.js'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'src', 'lib', 'tool-registry.js'), 'utf8')
  ].join('\n');
  const staleRequestIds = new RegExp(`\\b(?:${['R', '95'].join('')}|${['R', '58'].join('')})\\b`, 'i');
  assert.doesNotMatch(modelCoreText, staleRequestIds);
  for (const forbidden of [
    new RegExp(['owner', ' request'].join(''), 'i'),
    new RegExp(['oauth', '-personal'].join(''), 'i'),
    new RegExp(['promotional', '-credit'].join(''), 'i'),
    new RegExp(['gemini', '-cli\\s+\\d'].join(''), 'i'),
    new RegExp(['verified', ' live'].join(''), 'i'),
    new RegExp(['agent', ' territory'].join(''), 'i')
  ]) {
    assert.doesNotMatch(policyText, forbidden);
  }
});

// --- the refusal --------------------------------------------------------------

check('a below-floor flash model is REFUSED, not downgraded to', () => {
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'subscription', model: 'gemini-3.5-flash' }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.match(error.message, /below the subscription model floor/);
      // The refusal must teach the rule from the error itself.
      assert.match(error.message, /Configured model floor policy/);
      assert.match(error.message, /config\/model-floor\.json/);
      return true;
    }
  );
});

check('an unknown below-floor id is refused with its configured reason', () => {
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'subscription', model: 'gemini-3.6-flash' }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.match(error.message, /Unknown and below the configured model floor/);
      return true;
    }
  );
});

check('a PLANNING purpose does not buy an exception', () => {
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'subscription', model: 'gemini-3.5-flash', purpose: 'planning' }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.match(error.message, /purpose "planning" does not lower the configured model floor/);
      assert.match(error.message, /including planning passes/);
      return true;
    }
  );
});

check('every declared purpose is refused a below-floor model, none excepted', () => {
  const doc = modelFloor.loadFloor();
  assert.ok(Array.isArray(doc.policy.purposes) && doc.policy.purposes.length > 0,
    'the floor must declare at least one purpose to test');
  for (const purpose of doc.policy.purposes) {
    assert.throws(
      () => modelFloor.assertModelAllowed({ backend: 'vertex', model: 'gemini-2.5-flash', purpose }),
      (error) => ['MODEL_FLOOR_REFUSED', 'MODEL_NOT_SERVABLE'].includes(error.code),
      `purpose "${purpose}" did not refuse a below-floor model`
    );
  }
});

check('a non-servable model reports THAT, not a generic downgrade message', () => {
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'vertex', model: 'gemini-2.5-flash' }),
    (error) => {
      assert.equal(error.code, 'MODEL_NOT_SERVABLE');
      assert.match(error.message, /not servable through the configured Vertex route/);
      return true;
    }
  );
});

check('an unknown backend is refused rather than defaulted', () => {
  assert.throws(
    () => modelFloor.assertModelAllowed({ backend: 'not-a-backend', model: 'gemini-3.1-pro-preview' }),
    (error) => error.code === 'MODEL_BACKEND_UNKNOWN'
  );
});

check('an on-floor model is returned unchanged', () => {
  assert.equal(modelFloor.assertModelAllowed({ backend: 'subscription', model: 'gemini-3.1-pro-preview' }), 'gemini-3.1-pro-preview');
  assert.equal(modelFloor.assertModelAllowed({ backend: 'vertex', model: 'gemini-2.5-pro' }), 'gemini-2.5-pro');
  assert.equal(modelFloor.assertModelAllowed({ backend: 'vertex' }), 'gemini-2.5-pro'); // null -> backend default
});

check('assertOnSomeFloor refuses backend-independently and accepts any floor model', () => {
  assert.equal(modelFloor.assertOnSomeFloor('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(modelFloor.assertOnSomeFloor('gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
  assert.throws(
    () => modelFloor.assertOnSomeFloor('gemini-3.1-flash-lite', { tool: 'task.submit', field: 'scope.executionModel' }),
    (error) => {
      assert.equal(error.code, 'MODEL_FLOOR_REFUSED');
      assert.match(error.message, /Tool 'task\.submit' argument scope\.executionModel/);
      return true;
    }
  );
});

// --- serve-side: what was SERVED, not only what was asked ---------------------

check('servedBelowFloor catches a silent downgrade and reports unknown as null', () => {
  assert.deepEqual(modelFloor.servedBelowFloor('subscription', ['gemini-3.1-flash-lite']), ['gemini-3.1-flash-lite']);
  assert.deepEqual(modelFloor.servedBelowFloor('subscription', ['gemini-3.1-pro-preview']), []);
  // Honest-unknown: silence about what was served is NOT a pass.
  assert.equal(modelFloor.servedBelowFloor('subscription', []), null);
  assert.equal(modelFloor.servedBelowFloor('subscription', undefined), null);
});

// --- argument scanning is narrow, not greedy ---------------------------------

check('findModelArguments matches whole values only, never a mention in prose', () => {
  const found = modelFloor.findModelArguments({
    scope: { executionModel: 'gemini-3.5-flash' },
    prompt: 'please compare gemini-3.5-flash against the pro tier and report',
    idempotencyKey: 'gemini-envelope-smoke-v1',
    nested: [{ model: 'gemini-2.5-pro' }]
  });
  const keys = found.map((entry) => entry.key).sort();
  assert.deepEqual(keys, ['nested[0].model', 'scope.executionModel']);
  assert.ok(!keys.includes('prompt'), 'a prompt merely mentioning a model must not count as selecting one');
  assert.ok(!keys.includes('idempotencyKey'), 'an opaque idempotency key is not a model selection');
});

check('findModelArguments tolerates junk without throwing', () => {
  assert.deepEqual(modelFloor.findModelArguments(null), []);
  assert.deepEqual(modelFloor.findModelArguments(undefined), []);
  assert.deepEqual(modelFloor.findModelArguments({ a: 1, b: true, c: { d: null } }), []);
});

// --- the anti-reintroduction mechanism ---------------------------------------

check('a floor file that allows and refuses the same id fails validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-floor-'));
  const file = path.join(dir, 'floor.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 'model-floor-v1',
    policy: { purposesCannotLowerTheFloor: true, purposes: ['lane'] },
    backends: { subscription: { allowed: ['gemini-3.1-pro-preview'], default: 'gemini-3.1-pro-preview' } },
    refusedIds: { 'gemini-3.1-pro-preview': 'contradiction' }
  }));
  assert.throws(() => modelFloor.loadFloor({ floorPath: file, force: true }), /allows .* while refusedIds also refuses it/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('flipping purposesCannotLowerTheFloor is not a supported way back in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-floor-'));
  const file = path.join(dir, 'floor.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 'model-floor-v1',
    policy: { purposesCannotLowerTheFloor: false, purposes: ['planning'] },
    backends: { subscription: { allowed: ['gemini-3.1-pro-preview'], default: 'gemini-3.1-pro-preview' } }
  }));
  assert.throws(() => modelFloor.loadFloor({ floorPath: file, force: true }), /configured model floor policy forbids per-purpose exceptions/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('checkDeclarationDrift flags a contradicting declaration site', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-floor-root-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'drifted.js'), "const LANE_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.5-flash'];\n");
  fs.writeFileSync(path.join(root, 'src', 'clean.js'), "const LANE_MODELS = ['gemini-3.1-pro-preview'];\n");
  const floorFile = path.join(root, 'floor.json');
  fs.writeFileSync(floorFile, JSON.stringify({
    schemaVersion: 'model-floor-v1',
    policy: { purposesCannotLowerTheFloor: true, purposes: ['lane'] },
    backends: { subscription: { allowed: ['gemini-3.1-pro-preview'], default: 'gemini-3.1-pro-preview' } },
    refusedIds: { 'gemini-3.5-flash': 'flash tier' },
    declarationSites: [
      { id: 'drifted', file: 'src/drifted.js', kind: 'js-const', symbols: ['LANE_MODELS'] },
      { id: 'clean', file: 'src/clean.js', kind: 'js-const', symbols: ['LANE_MODELS'] },
      { id: 'renamed', file: 'src/clean.js', kind: 'js-const', symbols: ['GONE_AWAY'] }
    ]
  }));
  const result = modelFloor.checkDeclarationDrift({ floorPath: floorFile, root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.drifted.map((site) => site.id), ['drifted']);
  assert.deepEqual(result.drifted[0].offending, ['gemini-3.5-flash']);
  // Honest-unknown: a symbol that vanished is UNKNOWN, never silently compliant.
  assert.deepEqual(result.unknown.map((site) => site.id), ['renamed']);
  assert.match(result.unknown[0].reason, /refuses to report a site it can no longer see as compliant/);
  fs.rmSync(root, { recursive: true, force: true });
});

check('a site claiming status:"derived" must actually reference the authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-floor-root-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'liar.js'), "const LANE_MODELS = [];\n");
  const floorFile = path.join(root, 'floor.json');
  fs.writeFileSync(floorFile, JSON.stringify({
    schemaVersion: 'model-floor-v1',
    policy: { purposesCannotLowerTheFloor: true, purposes: ['lane'] },
    backends: { subscription: { allowed: ['gemini-3.1-pro-preview'], default: 'gemini-3.1-pro-preview' } },
    declarationSites: [{ id: 'liar', file: 'src/liar.js', kind: 'js-const', symbols: ['LANE_MODELS'], status: 'derived' }]
  }));
  const result = modelFloor.checkDeclarationDrift({ floorPath: floorFile, root });
  assert.equal(result.ok, false);
  assert.match(result.drifted[0].reason, /unverifiable derivation claim is refused/);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- the LIVE repo: this is what makes reintroduction impossible --------------
//
// ZERO tolerance, no pinned allowance. An earlier revision of this test pinned
// a KNOWN_OPEN_DRIFT list of sites permitted to contradict the floor while the
// suite still exited 0 -- a recorded violation that decorated the build instead
// of breaking it, indistinguishable from health (postmortem class 5). That
// allowance is deleted: ANY declaration site that contradicts
// config/model-floor.json, or that can no longer be read, fails this suite and
// names the site. Fixing a site needs no edit here; opening one turns the
// build red.

check('the live repo has ZERO sites contradicting config/model-floor.json', () => {
  const result = modelFloor.checkDeclarationDrift();
  const describe = (site) => `${site.id} (${site.file}): `
    + (Array.isArray(site.offending) && site.offending.length
      ? `declares off-floor model(s) ${site.offending.join(', ')}`
      : site.reason);
  assert.equal(result.ok, true,
    'checkDeclarationDrift().ok must be true -- open drift sites:\n  '
    + [...result.drifted, ...result.unknown].map(describe).join('\n  '));
});

check('dynamic dispatch enforces the floor without a stale static model declaration', () => {
  const result = modelFloor.checkDeclarationDrift();
  // Dispatch now accepts dynamic model IDs and validates them with the policy;
  // it no longer declares a static executionModel enum for the drift registry.
  const { assertModelFloor } = require('../../src/lib/tool-registry');
  for (const model of modelFloor.allowedUnion()) {
    assert.doesNotThrow(() => assertModelFloor({ name: 'task.submit' },
      { scope: { executionModel: model } }, 'model-floor-test'));
  }
  assert.throws(() => assertModelFloor({ name: 'task.submit' },
    { scope: { executionModel: 'gemini-3.5-flash' } }, 'model-floor-test'),
  error => error && error.code === 'MODEL_FLOOR_REFUSED');
  assert.equal(result.sites.some((entry) => entry.file === 'config/agent-org.json'), false,
    'obsolete provider-policy declaration site must not remain in the model-floor registry');
});

console.log(`Model-floor tests passed (${checks} checks; below-floor + unknown + non-servable models refuse, `
  + 'no purpose including planning buys an exception, and zero live sites contradict the floor).');
