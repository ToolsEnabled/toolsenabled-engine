'use strict';

// EVERY GATE MUST NAME AN ENFORCEMENT POINT WITH AN AUTHORITATIVE BOUNDARY.
//
// GATED_CAPABILITIES declares an `enforcedAt` for each capability -- a string
// like 'src/lib/providers/hosted-relay-entitlement.js connect()'. These are
// operator-only admission modules: a customer/self-hosted checkout must not
// contain them. The ratified payload boundary is therefore the local authority
// for their deployment, rather than a stale client-tree existence assertion.
//
// ------------------------------------------------------------------------
// AND A CORRECTION THIS SUITE EXISTS TO MAKE PERMANENT.
//
// docs/PLANNING-BRIEF.md lists "requireCapability() had zero callers" among its
// traps, under "Before trusting any gate, find its caller." As a warning that is
// exactly right. As a DEFECT TO FIX BY WIRING IT, it is wrong, and acting on it
// would open a hole rather than close one.
//
// Measured 2026-08-13:
//   * hosted-relay  is enforced in hosted-relay-entitlement.js connect(), which
//     resolves the licence SERVER-SIDE by pairId out of the operator's own
//     ledger and never reads anything from the customer's machine.
//   * website-access is enforced in paid-surface-entitlement.js admit(), which
//     demands a deployment marker proving operator-only intent, and now has a
//     production caller in entitlement-fulfilment.js.
//   * The one CLIENT-side consumer, anywhere-transport.js, deliberately uses
//     the non-throwing decide() because it is a PRE-FLIGHT that must present a
//     refusal with free alternatives, not crash.
//
// So requireCapability() -- the throwing wrapper that reads the LOCAL install's
// entitlement -- has no production caller because every real gate is operator-
// side and the only client-side use needs the other shape. It is not an unwired
// gate. It is tested public API (see redteam/tier-escalation.test.js ATTACK 8),
// and giving it a production call site would mean gating a paid capability on a
// value the customer's own machine supplies, which is precisely the forgeable
// check the server-side design exists to avoid.
//
// This suite therefore pins the enforcement that IS real, so that "find its
// caller" can be answered mechanically instead of re-litigated from prose.
// ------------------------------------------------------------------------

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const entitlement = require('../src/lib/entitlement');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

const ROOT = path.resolve(__dirname, '..');
const OPERATOR_BOUNDARY_FILE = 'config/payload-boundary.json';
const operatorBoundary = JSON.parse(fs.readFileSync(path.join(ROOT, OPERATOR_BOUNDARY_FILE), 'utf8'));
const paidBoundaryText = Array.isArray(operatorBoundary?.paid?.$comment)
  ? operatorBoundary.paid.$comment.join('\n') : '';

// 'src/lib/providers/x.js someFunction()' -> { file, fn }
function parseEnforcedAt(value) {
  const match = /^(\S+\.js)\s+([A-Za-z_$][\w$]*)\(\)$/.exec(String(value || '').trim());
  return match ? { file: match[1], fn: match[2] } : null;
}

function assertOperatorBoundary(capability, endpoint) {
  assert.deepEqual(capability.enforcement?.side, 'operator-only',
    `${capability.id} must declare operator-only enforcement instead of implying a client gate`);
  assert.equal(capability.enforcement?.boundary, OPERATOR_BOUNDARY_FILE,
    `${capability.id} must point at the ratified payload boundary that owns its operator module`);
  assert.equal(operatorBoundary.status, 'owner-ratified',
    'the operator boundary must remain ratified rather than becoming an unreviewed local exception');
  assert.ok(paidBoundaryText.includes(endpoint.file),
    `${capability.id} names ${endpoint.file}, but the paid boundary does not declare that operator-only module`);
}

check('every gated capability declares a parseable enforcement point', () => {
  const gated = Object.values(entitlement.GATED_CAPABILITIES);
  assert.ok(gated.length > 0, 'the build must gate at least one capability');
  for (const capability of gated) {
    const parsed = parseEnforcedAt(capability.enforcedAt);
    assert.ok(parsed,
      `${capability.id} declares enforcedAt ${JSON.stringify(capability.enforcedAt)}, `
      + 'which does not name a "<file>.js <function>()" pair');
  }
});

check('every enforcement point is declared operator-only in the ratified boundary', () => {
  for (const capability of Object.values(entitlement.GATED_CAPABILITIES)) {
    assertOperatorBoundary(capability, parseEnforcedAt(capability.enforcedAt));
  }
});

check('the customer tree contains no operator-only enforcement module', () => {
  // A local copy would tempt a client-side call site to trust a forged local
  // entitlement.  It also leaks the paid operator implementation into the free
  // payload, so absence here is an affirmative boundary property, not a skip.
  for (const capability of Object.values(entitlement.GATED_CAPABILITIES)) {
    const endpoint = parseEnforcedAt(capability.enforcedAt);
    assertOperatorBoundary(capability, endpoint);
    assert.equal(fs.existsSync(path.join(ROOT, endpoint.file)), false,
      `${capability.id} operator gate ${endpoint.file} leaked into the customer tree; move it back to the operator deployment`);
  }
});

check('every gated capability names at least one free alternative', () => {
  // A gate that cannot say how to get the job done free is a paywall, and the
  // shipped policy is that an unlicensed install is fully functional forever.
  for (const capability of Object.values(entitlement.GATED_CAPABILITIES)) {
    assert.ok(Array.isArray(capability.freeAlternatives) && capability.freeAlternatives.length > 0,
      `${capability.id} gates something without naming a free way to do it`);
  }
});

check('requireCapability has no production caller, and that is recorded as correct', () => {
  // Pins the CORRECTION above. If somebody later wires this into a shipped code
  // path, this check fails and points at why -- rather than the change landing
  // quietly as a "fix" for the planning brief's trap note.
  const offenders = [];
  const roots = ['src', 'tools'];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      // Its own definition and export in entitlement.js are not callers.
      if (path.resolve(full) === path.resolve(ROOT, 'src', 'lib', 'entitlement.js')) continue;
      // A comment mentioning the name is not a call site.
      const calls = source.split('\n').filter(line =>
        /\brequireCapability\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
      if (calls.length) offenders.push(path.relative(ROOT, full));
    }
  };
  for (const directory of roots) walk(path.join(ROOT, directory));

  assert.deepEqual(offenders, [],
    'requireCapability() now has a production caller: '
    + `${offenders.join(', ')}. That gate reads the LOCAL install's entitlement, so a `
    + 'shipped call site gates a paid capability on a value the customer\'s own machine '
    + 'supplies. The real enforcement is server-side by pairId. If this is deliberate, '
    + 'change the design note in this test and in GATED_CAPABILITIES -- do not just delete '
    + 'the assertion.');
});

check('the paid-surface caller is declared operator-only rather than fabricated locally', () => {
  const website = entitlement.GATED_CAPABILITIES['website-access'];
  assert.ok(website, 'website-access must remain a declared paid capability');
  const caller = parseEnforcedAt(website.enforcement?.caller);
  assert.ok(caller,
    'website-access must name the operator-side caller that constructs paid-surface admission');
  assertOperatorBoundary(website, caller);
  assert.equal(fs.existsSync(path.join(ROOT, caller.file)), false,
    `${caller.file} leaked into the customer tree; the paid-surface caller belongs only to the operator deployment`);
});

process.stdout.write(`entitlement-enforcement-points: ${checks} checks passed\n`);
