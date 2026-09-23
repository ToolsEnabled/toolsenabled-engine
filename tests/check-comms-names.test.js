'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'check-comms-names.js');
const {
  check,
  parseArgs,
  reservedProviderNamespaces,
  validateManifest
} = require('../tools/check-comms-names');

const VALID_MANIFEST = {
  schemaVersion: 1,
  systems: [
    { id: 'agent-comms' },
    { id: 'secure-agent-channel' },
    { id: 'reserved-external-provider-namespaces' }
  ]
};
const POLICY = { providers: { instagram: {}, slack: {} } };

function run(...args) {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  assert.equal(result.error, undefined, `tool did not start: ${result.error}`);
  assert.equal(typeof result.status, 'number', 'tool must return a numeric exit code');
  return result;
}

function expectError(fn, message) {
  assert.throws(fn, error => error instanceof Error && error.message === message);
}

// Pin each policy refusal input, rather than merely checking the source for its
// error-code text. These values cover every rejected part of the required
// policy.providers object path.
for (const policy of [null, 'policy', {}, { providers: null }]) {
  expectError(
    () => reservedProviderNamespaces(policy),
    'COMMS_NAMES_POLICY_INVALID: policy.providers must be an object.'
  );
}

// The first manifest refusal has four independently removable predicates.
for (const manifest of [
  null,
  { schemaVersion: 2, systems: VALID_MANIFEST.systems },
  { schemaVersion: 1, systems: {} },
  { schemaVersion: 1, systems: VALID_MANIFEST.systems.slice(0, 2) }
]) {
  expectError(
    () => validateManifest(manifest),
    'COMMS_NAMES_MANIFEST_INVALID: expected exactly three canonical layers.'
  );
}

expectError(
  () => validateManifest({
    schemaVersion: 1,
    systems: [VALID_MANIFEST.systems[1], VALID_MANIFEST.systems[0], VALID_MANIFEST.systems[2]]
  }),
  'COMMS_NAMES_MANIFEST_INVALID: canonical layer order is invalid.'
);

expectError(
  () => parseArgs(['--unknown', 'value']),
  'COMMS_NAMES_USAGE: unsupported flag --unknown.'
);
for (const argv of [['--identifier'], ['--branch', '--historical']]) {
  expectError(
    () => parseArgs(argv),
    `COMMS_NAMES_USAGE: ${argv[0]} requires a value.`
  );
}
expectError(
  () => parseArgs(['--historical']),
  'COMMS_NAMES_USAGE: provide at least one identifier, branch, doc, or label.'
);

// Exercise collision refusal for every accepted value-bearing flag. Removing
// the refusal, or silently exempting any input kind, makes this loop red.
for (const flag of ['--identifier', '--branch', '--doc', '--label']) {
  const parsed = parseArgs([flag, 'release/internal-instagram/name']);
  const result = check(parsed.inputs, { manifest: VALID_MANIFEST, policy: POLICY });
  assert.equal(result.ok, false, `${flag} must refuse a reserved namespace`);
  assert.deepEqual(result.collisions, [{
    kind: flag.slice(2),
    value: 'release/internal-instagram/name',
    namespace: 'instagram'
  }]);
}

// Drive the executable itself to pin both named exit codes and their refusal
// diagnostics. Green controls prevent an executable that always fails from
// satisfying a refusal-only suite.
const collision = run('--identifier', 'internal-instagram');
assert.equal(collision.status, 1, collision.stderr);
assert.match(collision.stderr, /^COMMS_NAMES_COLLISION:/m);

const usage = run('--identifier');
assert.equal(usage.status, 2, usage.stderr);
assert.match(usage.stderr, /^COMMS_NAMES_USAGE: --identifier requires a value\.$/m);

const allowed = run('--identifier', 'agent-comms');
assert.equal(allowed.status, 0, allowed.stderr);
assert.match(allowed.stdout, /^COMMS_NAMES_OK: no reserved provider namespace collision$/m);

const historical = run('--historical', '--label', 'internal-instagram');
assert.equal(historical.status, 0, historical.stderr);
assert.match(historical.stdout, /^COMMS_NAMES_OK: historical-or-archived$/m);

process.stdout.write('check-comms-names refusals and exit codes passed.\n');
