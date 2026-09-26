// The assertions below require non-empty capability and promise collections so
// an empty export cannot pass vacuously. They use the real entitlement data and
// payload boundary, with no platform skips or mocked enforcement source.

'use strict';

// WHAT THE PRODUCT SELLS vs WHAT IT CAN ACTUALLY GATE.
//
// `enforcedAt` names operator-side admission modules. They intentionally do
// not exist in this customer/self-hosted checkout: config/payload-boundary.json
// is the ratified authority that declares them paid and operator-only. This
// suite is its sibling and covers the two things that boundary must make true:
//
//   S1-S3  each endpoint must be parseable, explicitly declared operator-only
//          in that boundary, absent from the client tree, and never replaced by
//          a client-side pre-flight. A local stub would be both a leak of paid
//          operator code and an invitation to trust customer-controlled state.
//   S4-S8  A8 only looks at capabilities that were declared. It cannot see a
//          promise the page makes that NOTHING enforces, because there is no
//          table row to iterate. `SOLD_PROMISES` is that missing row set, and
//          these checks hold it to the sales sentence in both directions.
//
// NOTHING HERE MAY BE SATISFIED BY SELLING LESS. Every assertion below fails
// toward "the code owes the page something", never toward "delete the promise".
//
// NOT YET WIRED INTO AN AGGREGATE, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT.
// package.json is write-protected (it has a dedicated writer, and STANDING-ORDERS
// Class SYNC rule 7 blocks a hand edit), and it is outside the lane that wrote
// this file. The one line needed is this filename appended next to
// `tests/entitlement.js` in the `test:invocation-orphans` script -- the same
// aggregate that already runs the suite this one extends. Until then
// `tests/test-census.test.js` counts it as an orphan, which is the correct
// signal: a check nothing invokes is the exact defect this suite is about.
//
// Run directly: node tests/entitlement-sold-surface.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const entitlement = require('../src/lib/entitlement');
const OPERATOR_BOUNDARY_FILE = 'config/payload-boundary.json';
const operatorBoundary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, OPERATOR_BOUNDARY_FILE), 'utf8'));
const paidBoundaryText = Array.isArray(operatorBoundary?.paid?.$comment)
  ? operatorBoundary.paid.$comment.join('\n') : '';

let assertions = 0;
let failures = 0;
function test(label, fn) {
  try {
    fn();
    process.stdout.write(`ok   ${label}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${label}\n${(error && error.stack) || error}\n`);
  }
}

// Canonical normalized product-copy contract used to reconcile every promise
// with an enforcement disposition.
const SOLD_SENTENCE =
  'It provides managed non-LAN connectivity, device enrollment, the relay, monitoring, recovery and support.';

// Capabilities that are DECLARED AND ENFORCED but that the sentence above does
// not promise. Listed here rather than inferred, so that the day a third gate
// appears somebody has to state, in a test, whether the page sells it. That is
// the same deliberate friction A8 applies with PRODUCTION_CONSTRUCTORS.
const GATED_BUT_NOT_SOLD = Object.freeze({
  'website-access': 'The page sells six things and this is not one of them. The gap runs the other '
    + 'way -- the product gives more than the page promises -- and the remedy is a sentence on the '
    + 'page, never withdrawal of the gate.'
});

// Promises that must never become capability ids, with the reason each is not a
// gate recorded in SOLD_PROMISES. This array is the tripwire for "a future lane
// invents a gate for support".
const NEVER_A_CAPABILITY = Object.freeze(['monitoring', 'recovery', 'support']);

function parseSoldSentence() {
  const match = /^It provides (.+)\.$/.exec(SOLD_SENTENCE);
  assert.ok(match, 'SOLD_SENTENCE no longer has the shape this suite parses');
  return match[1].split(/,\s*|\s+and\s+/).map(part => part.trim()).filter(Boolean);
}

function endpointFor(capability) {
  const value = capability.enforcedAt;
  assert.ok(typeof value === 'string' && value.trim(),
    `${capability.id} must name where it is enforced`);
  const match = /^(\S+\.js)\s+([A-Za-z_$][\w$]*)\(\)$/.exec(value.trim());
  assert.ok(match, `${capability.id}: enforcedAt must read "<path>.js <function>()"; got ${value}`);
  return { relative: match[1], fn: match[2] };
}

function assertOperatorBoundary(capability, endpoint) {
  assert.equal(capability.enforcement?.side, 'operator-only',
    `${capability.id} must explicitly declare operator-only enforcement`);
  assert.equal(capability.enforcement?.boundary, OPERATOR_BOUNDARY_FILE,
    `${capability.id} must name the ratified boundary that owns its operator gate`);
  assert.equal(operatorBoundary.status, 'owner-ratified',
    'operator enforcement must remain in the ratified payload boundary');
  assert.ok(paidBoundaryText.includes(endpoint.relative),
    `${capability.id}: ${endpoint.relative} is absent from the paid-boundary declaration`);
}

// ===========================================================================
// S1-S3 -- an enforcedAt string is a claim about real, reachable enforcement
// ===========================================================================

test('S1 every enforcedAt names an operator-only endpoint declared in the ratified boundary', () => {
  const declared = Object.values(entitlement.GATED_CAPABILITIES);
  assert.ok(declared.length >= 1, 'there must be at least one declared paid capability');
  for (const capability of declared) {
    const endpoint = endpointFor(capability);
    assertOperatorBoundary(capability, endpoint);
    assertions += 6;
  }
});

test('S2 every operator endpoint remains absent from the customer tree', () => {
  // A copied local module is not more test coverage. It would expose a paid
  // admission implementation and create a tempting, forgeable client gate.
  const declared = Object.values(entitlement.GATED_CAPABILITIES);
  assert.ok(declared.length >= 1, 'S2 requires at least one declared paid capability to inspect');
  assertions += 1;
  for (const capability of declared) {
    const endpoint = endpointFor(capability);
    assertOperatorBoundary(capability, endpoint);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, endpoint.relative)), false,
      `${capability.id}: ${endpoint.relative} leaked into the customer tree`);
    assertions += 2;
  }
});

test('S3 enforcement is operator-side; a client-side pre-flight may never be named as the gate', () => {
  // WHY THIS IS AN ASSERTION AND NOT ADVICE. `anywhere-transport.js
  // decideTransport()` is the one function in this repository that looks like a
  // connectivity gate. It documents itself as a PRE-FLIGHT that "can never
  // admit anything, because the server-side check runs regardless" -- a local
  // check that could grant access would be a licence check on the honour
  // system. Naming it in an enforcedAt would produce a capability that refuses
  // early, admits nothing, and is enforced by nobody.
  const declared = Object.values(entitlement.GATED_CAPABILITIES);
  assert.ok(declared.length >= 1, 'S3 requires at least one declared paid capability to inspect');
  assertions += 1;
  for (const capability of declared) {
    const endpoint = endpointFor(capability);
    assertOperatorBoundary(capability, endpoint);
    assert.ok(endpoint.relative.startsWith('src/lib/providers/'),
      `${capability.id}: enforcedAt names ${endpoint.relative}. A gate runs on machines WE operate, under `
      + 'src/lib/providers/; a check on the customer\'s own computer cannot be the authority for it.');
    assert.notEqual(endpoint.relative, 'src/lib/anywhere-transport.js',
      `${capability.id}: anywhere-transport.js is a pre-flight that cannot admit, so it cannot be a gate`);
    assertions += 5;
  }
});

// ===========================================================================
// S4-S8 -- the sold surface and the gate table, reconciled in both directions
// ===========================================================================

test('S4 every row of SOLD_PROMISES is well formed and quotes an exact normalized fragment', () => {
  const DISPOSITIONS = new Set(['gated', 'gated-as', 'operational', 'policy-review']);
  const rows = entitlement.SOLD_PROMISES;
  assert.ok(Array.isArray(rows) && rows.length >= 1, 'SOLD_PROMISES must be a non-empty array');
  assert.ok(Object.isFrozen(rows), 'SOLD_PROMISES must be frozen');
  assertions += 2;

  const seen = new Set();
  for (const row of rows) {
    assert.ok(Object.isFrozen(row), `the row for "${row.promise}" must be frozen`);
    assert.ok(typeof row.promise === 'string' && row.promise.trim(), 'every row must quote a promise');
    assert.ok(!seen.has(row.promise), `"${row.promise}" is recorded twice`);
    seen.add(row.promise);
    assert.ok(DISPOSITIONS.has(row.disposition),
      `"${row.promise}" has an unknown disposition ${JSON.stringify(row.disposition)}`);
    // A row that does not say WHY is the prose problem with extra steps.
    assert.ok(typeof row.why === 'string' && row.why.length > 120,
      `"${row.promise}" must explain its disposition, not merely assert it`);
    assert.ok(SOLD_SENTENCE.includes(row.promise),
      `"${row.promise}" is not an exact normalized fragment of the product-copy contract`);
    assertions += 6;
  }
});

test('S5 no promise on the page is silently missing from the record', () => {
  // The direction that matters most. A promise nobody wrote a row for is a
  // promise nobody decided anything about, and it would be invisible to every
  // other check in this file.
  const promised = parseSoldSentence();
  const recorded = entitlement.SOLD_PROMISES.map(row => row.promise);
  assert.deepEqual(recorded, promised,
    'SOLD_PROMISES must carry one row per promise, in the order the page makes them. '
    + 'If the page changed, add the row -- do not trim the sentence to match the code.');
  assertions += 1;
});

test('S6 a gated/gated-as row names a real capability, and an ungated row names none', () => {
  const rows = entitlement.SOLD_PROMISES;
  const declaredIds = Object.keys(entitlement.GATED_CAPABILITIES);
  assert.ok(rows.length >= 1, 'S6 requires at least one sold promise to reconcile');
  assert.ok(declaredIds.length >= 1, 'S6 requires at least one declared paid capability to reconcile');
  assertions += 2;
  for (const row of rows) {
    if (row.disposition === 'gated' || row.disposition === 'gated-as') {
      assert.ok(Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, row.capability),
        `"${row.promise}" claims to be enforced by "${row.capability}", which is not declared`);
    } else {
      assert.equal(row.capability, null,
        `"${row.promise}" is not gated, so it must not name a capability`);
    }
    assertions += 1;
  }

  // The other direction: a declared gate must be one the page sells, or must be
  // listed above as knowingly gated-and-unsold.
  const enforcing = new Set(entitlement.SOLD_PROMISES.map(row => row.capability).filter(Boolean));
  for (const id of declaredIds) {
    assert.ok(enforcing.has(id) || Object.prototype.hasOwnProperty.call(GATED_BUT_NOT_SOLD, id),
      `"${id}" is gated but no promise on the page names it and it is not recorded in `
      + 'GATED_BUT_NOT_SOLD. Say which it is: sold and unrecorded, or gated and unsold.');
    assertions += 1;
  }
});

test('S7 monitoring, recovery and support are service commitments and can never become gates', () => {
  // THE POINT OF THIS TEST, FOR WHOEVER TRIPS IT. These three have no moment
  // where a subject asks and code could answer no. If you are here because you
  // added one to GATED_CAPABILITIES, the thing you actually want to gate is
  // admission to whatever surface DELIVERS it -- `website-access` or a declared
  // sibling with its own real enforcedAt. Do not delete this assertion.
  for (const promise of NEVER_A_CAPABILITY) {
    const row = entitlement.SOLD_PROMISES.find(entry => entry.promise === promise);
    assert.ok(row, `"${promise}" must be recorded in SOLD_PROMISES`);
    assert.equal(row.disposition, 'operational',
      `"${promise}" must stay recorded as a service commitment, not an entitlement gate`);
    assert.ok(!Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, promise),
      `"${promise}" has been declared as a gated capability. It has no enforcement point; `
      + 'gate the surface that delivers it instead.');
    assertions += 3;
  }
});

test('S8 the device-enrollment policy conflict remains fail-closed', () => {
  // Product copy names device enrollment while NEVER_GATED protects peer
  // enrollment. Until current product policy reconciles those declarations,
  // no entitlement gate may be invented for it.
  const row = entitlement.SOLD_PROMISES.find(entry => entry.promise === 'device enrollment');
  assert.ok(row, 'the device-enrollment conflict must be recorded');
  assert.equal(row.disposition, 'policy-review');
  assert.equal(row.resolved, false, 'unresolved policy must not authorize an entitlement gate');
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'options'), false,
    'private commercial alternatives must not ship in the engine contract');
  assertions += 4;

  // Side one: the doctrine still forbids it.
  const clause = entitlement.NEVER_GATED.find(entry => /peer enrollment/.test(entry));
  assert.ok(clause,
    'NEVER_GATED no longer protects enrollment; update the policy record and this check together.');
  // Side two: no gate has appeared for it.
  assert.ok(!Object.prototype.hasOwnProperty.call(entitlement.GATED_CAPABILITIES, 'device-enrollment'),
    'a device-enrollment capability was declared while NEVER_GATED still forbids it. '
    + 'Those two cannot both be right.');
  assertions += 2;
});

process.stdout.write(`\n${assertions} assertions, ${failures} failure(s)\n`);
if (failures > 0) process.exit(1);
