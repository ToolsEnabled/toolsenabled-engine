'use strict';

// Refusal contract for the generator itself.  These cases intentionally pass a
// value across every fail-closed branch; deleting any one of the generator's
// assertions must make this file fail.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const generator = require('../tools/generate-agent-activity-contracts');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'generate-agent-activity-contracts.js');

function source() {
  return structuredClone(generator.loadPackage());
}

function validate(value) {
  return generator.validatePackage(
    value.manifest, value.schemas, value.ledger, value.ownership,
    value.identity, value.provenance, value.redaction
  );
}

function refuses(label, mutate, message) {
  const value = source();
  mutate(value);
  assert.throws(() => validate(value), error => {
    assert.match(error.message, message, label);
    return true;
  }, label);
}

// Portable-regex refusals are independent of the package shape.
assert.throws(
  () => generator.validatePortableSchema({ pattern: '\u00e9' }, 'probe'),
  /non-ASCII or oversized pattern/
);
assert.throws(
  () => generator.validatePortableSchema({ pattern: '(?=x)' }, 'probe'),
  /non-portable pattern/
);

const packageCases = [
  ['manifest authority', v => { v.manifest.package = 'other'; }, /manifest must name/],
  ['ownership domain', v => { v.manifest.ownershipDomain = 'other'; }, /ownership domain must be context/],
  ['ownership map', v => { v.ownership.owners = []; }, /ownership map no longer assigns/],
  ['contract list', v => { v.manifest.contracts.pop(); }, /contract list is incomplete/],
  ['browser invariants', v => { v.manifest.browserSafeInvariants.freeText = true; }, /browser-safe invariants changed/],
  ['closed schema', v => { v.schemas.common.additionalProperties = true; }, /common must be a closed object schema/],
  ['schema id', v => { v.schemas.common.$id = 'urn:wrong'; }, /common has an unexpected schema ID/],
  ['edge vocabulary', v => { v.schemas.edge.properties.edgeType.enum.pop(); }, /edge vocabulary changed/],
  ['event vocabulary', v => { v.schemas.event.properties.eventType.enum.pop(); }, /event vocabulary changed/],
  ['browser-forbidden field', v => { v.schemas['browser-event'].properties.agentId = { type: 'string' }; }, /browser-event exposes browser-forbidden field agentId/],
  ['abandoned lane', v => { v.schemas.snapshot.properties.mac = { type: 'string' }; }, /snapshot must not project an abandoned lane entity/],
  ['ledger shape', v => { v.ledger.additionalProperties = true; }, /ledger v2 must be a closed schema/],
  ['ledger authority', v => { v.ledger.properties.intentAuthority.const = 'other'; }, /ledger authority fields changed/],
  ['master link', v => { v.ledger.$defs.masterLink.required.pop(); }, /ledger masterLink is incomplete/],
  ['runtime assignment', v => { v.ledger.runtimeAssignment = {}; }, /ledger must not contain runtime assignment/],
  ['identifier owner', v => { v.identity.policyAuthority = 'other'; }, /identifier policy owner changed/],
  ['identifier encoding', v => { v.identity.idEncoding.randomBytes = 12; }, /must keep 192-bit base64url IDs/],
  ['control timestamp', v => { v.identity.controlTimestamp.timezone = 'local'; }, /control timestamp policy changed/],
  ['canonical hash', v => { v.identity.canonicalHash.algorithm = 'md5'; }, /domain-hash policy changed/],
  ['visible id authority', v => { v.identity.authorization.visiblePrefixGrantsAuthority = true; }, /visible ID authority policy changed/],
  ['safe display', v => { v.provenance.safeDisplay.includeContent = true; }, /safe-display policy changed/],
  ['provenance authorization', v => { v.provenance.authorization.provenanceAllowsAction = true; }, /authorization policy changed/],
  ['redaction policy', v => { v.redaction.replacement = '<hidden>'; }, /redaction policy changed/]
];
for (const [label, mutate, message] of packageCases) refuses(label, mutate, message);

// Pin the template-marker refusal without changing a shipped template.
const readFileSync = fs.readFileSync;
fs.readFileSync = function patchedRead(filename, ...args) {
  const value = readFileSync.call(this, filename, ...args);
  return String(filename).endsWith('.js.tpl') ? value + '\n__UNRESOLVED_MARKER__\n' : value;
};
try {
  assert.throws(() => generator.renderAll(), /has an unresolved generator marker/);
} finally {
  fs.readFileSync = readFileSync;
}

// Pin generated-output drift without touching the visualizer checkout.
const existsSync = fs.existsSync;
fs.existsSync = filename => Object.values(generator.OUTPUTS).includes(filename) ? false : existsSync(filename);
try {
  assert.throws(() => generator.generate({ check: true }), /generated consumer is stale/);
} finally {
  fs.existsSync = existsSync;
}

// The command has two named process outcomes: success (0) and refusal (1).
// Generate first so the test is also runnable in a checkout without the sibling
// visualizer's derived files, then prove that the explicit --check value works.
const generated = spawnSync(process.execPath, [TOOL], { cwd: ROOT, encoding: 'utf8' });
assert.equal(generated.status, 0, generated.stderr);
assert.match(generated.stdout, /contracts generated/);
const checked = spawnSync(process.execPath, [TOOL, '--check'], { cwd: ROOT, encoding: 'utf8' });
assert.equal(checked.status, 0, checked.stderr);
assert.match(checked.stdout, /contracts verified/);
for (const args of [['--unknown'], ['--check', '--unknown']]) {
  const refused = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 1, `unexpected CLI refusal exit for ${args.join(' ')}`);
  assert.match(refused.stderr, /only --check is supported/);
}

console.log(`generate-agent-activity-contracts refusal tests passed (${packageCases.length + 6} checks).`);
