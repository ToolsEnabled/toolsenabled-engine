'use strict';
// TWO LEDGERS, ONE NAME SPACE.
//
// The owner, 2026-08-11 (reports/OWNER-REQUEST-LEDGER.json R1233, verbatim):
//   "Ok but the R issue has come up maybe 10 times and no one ever actually
//    fixes it"
//
// One of the reasons: this machine holds two owner-request ledgers whose id
// spaces overlap but whose entries do not agree. Measured the same day --
// canonical 535 / revision 743, retired tree 253 / revision 305, 251 shared ids,
// SIXTEEN of which carry different request text on the two sides, and two ids
// (R1164, R1165) that exist only in the retired copy and were never merged.
// Nothing on this machine said so out loud until tools/ledger-authority.js.
//
// These checks build a real fork in a temp directory and run the same compare()
// the CLI runs, then confirm the guard is honest about the live machine.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const authority = require('../tools/ledger-authority.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push(name); console.log(`  FAIL ${name}: ${error.stack || error.message}`); }
}

function tree(requests, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-authority-'));
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(
    path.join(root, authority.LEDGER_RELATIVE),
    JSON.stringify({ revision: 1, updatedAt: '2026-08-11', requests, ...extra })
  );
  return root;
}

const R = (id, verbatim, request = '(interpretation) x') => ({ id, verbatim, request, status: 'open' });

check('a clean subset copy is not a fork', () => {
  const canonical = tree([R('R1', 'first'), R('R2', 'second')]);
  const copy = tree([R('R1', 'first')]);
  const result = authority.compare(
    [{ root: canonical, label: 'canonical' }, { root: copy, label: 'copy' }],
    canonical
  );
  assert.strictEqual(result.fork, false);
  assert.strictEqual(result.authoritative.count, 2);
  assert.deepStrictEqual(result.findings[0].onlyHere, []);
  assert.deepStrictEqual(result.findings[0].divergent, []);
});

check('the SAME id meaning different things is a fork', () => {
  const canonical = tree([R('R133', 'Diagnose and restore the dev server')]);
  const retired = tree([R('R133', 'Discover and package all Asian Religious Studies work')]);
  const result = authority.compare(
    [{ root: canonical, label: 'canonical' }, { root: retired, label: 'retired' }],
    canonical
  );
  assert.strictEqual(result.fork, true);
  assert.deepStrictEqual(result.findings[0].divergent, ['R133']);
  assert.ok(/MEAN SOMETHING DIFFERENT/.test(authority.render(result)));
});

check('an id that exists only in a non-authoritative copy is a fork', () => {
  const canonical = tree([R('R1', 'first')]);
  const retired = tree([R('R1', 'first'), R('R1164', 'captured only over there')]);
  const result = authority.compare(
    [{ root: canonical, label: 'canonical' }, { root: retired, label: 'retired' }],
    canonical
  );
  assert.strictEqual(result.fork, true);
  assert.deepStrictEqual(result.findings[0].onlyHere, ['R1164']);
});

check('work that moved on one side only is NOT called a fork', () => {
  // Same request, different status/gates: one tree did the work. That is the
  // normal state of two checkouts and must not raise a false fork, or the
  // signal stops being read.
  const canonical = tree([{ id: 'R1', verbatim: 'same words', request: '(interpretation) x', status: 'open', gates: [] }]);
  const copy = tree([{ id: 'R1', verbatim: 'same words', request: '(interpretation) x', status: 'done', gates: [{ instruction: 'g', met: true, evidence: 'e' }] }]);
  const result = authority.compare([{ root: canonical, label: 'canonical' }, { root: copy, label: 'copy' }], canonical);
  assert.strictEqual(result.fork, false);
});

check('authority is the declared canonical tree, never the newer or larger file', () => {
  const canonical = tree([R('R1', 'first')]);
  const bigger = tree([R('R1', 'first'), R('R2', 'second'), R('R3', 'third')]);
  const result = authority.compare([{ root: canonical, label: 'canonical' }, { root: bigger, label: 'retired' }], canonical);
  assert.strictEqual(result.authoritative.root, canonical,
    'a retired tree with more entries must not be crowned canonical by its own size');
  assert.strictEqual(result.fork, true, 'and its unmerged ids must still be reported');
});

check('an unreadable authority is reported, not silently replaced', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-authority-broken-'));
  fs.mkdirSync(path.join(broken, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(broken, authority.LEDGER_RELATIVE), '{not json');
  const other = tree([R('R1', 'first')]);
  const result = authority.compare([{ root: broken, label: 'canonical' }, { root: other, label: 'copy' }], broken);
  assert.strictEqual(result.authoritative, null);
  assert.strictEqual(result.copies[0].error, 'INVALID_JSON');
  assert.ok(/UNREADABLE/.test(authority.render(result)));
});

check('an absent copy is absent, not a fork', () => {
  const canonical = tree([R('R1', 'first')]);
  const result = authority.compare(
    [{ root: canonical, label: 'canonical' }, { root: path.join(os.tmpdir(), 'no-such-tree-8fc1a3'), label: 'gone' }],
    canonical
  );
  assert.strictEqual(result.fork, false);
  assert.strictEqual(result.copies[1].present, false);
});

check('a known tree with a missing ledger refuses instead of answering clean', () => {
  const canonical = tree([R('R1', 'first')]);
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-authority-missing-'));
  assert.throws(
    () => authority.compare([{ root: canonical, label: 'canonical' }, { root: missing, label: 'copy' }], canonical),
    error => error instanceof authority.LedgerAuthorityError
      && error.exitCode === 4
      && /MISSING_LEDGER/.test(error.message)
  );
});

check('an unreadable copy refuses instead of answering no fork', () => {
  const canonical = tree([R('R1', 'first')]);
  const broken = tree([R('R1', 'first')]);
  fs.writeFileSync(path.join(broken, authority.LEDGER_RELATIVE), '{not json');
  assert.throws(
    () => authority.compare([{ root: canonical, label: 'canonical' }, { root: broken, label: 'copy' }], canonical),
    error => error instanceof authority.LedgerAuthorityError
      && error.exitCode === 4
      && /INVALID_JSON/.test(error.message)
  );
});

check('a request without an id makes the ledger unreadable instead of disappearing', () => {
  const canonical = tree([R('R1', 'first')]);
  const malformed = tree([R('R1', 'first'), { verbatim: 'could hide an unmerged request' }]);
  assert.throws(
    () => authority.compare([{ root: canonical, label: 'canonical' }, { root: malformed, label: 'copy' }], canonical),
    error => error instanceof authority.LedgerAuthorityError
      && error.exitCode === 4
      && /INVALID_REQUEST_ID/.test(error.message)
  );
});

check('the guard never writes: the fixture files are byte-identical after compare()', () => {
  const canonical = tree([R('R1', 'first')]);
  const retired = tree([R('R1', 'different words')]);
  const before = [canonical, retired].map(root => fs.readFileSync(path.join(root, authority.LEDGER_RELATIVE), 'utf8'));
  authority.compare([{ root: canonical, label: 'canonical' }, { root: retired, label: 'retired' }], canonical);
  const after = [canonical, retired].map(root => fs.readFileSync(path.join(root, authority.LEDGER_RELATIVE), 'utf8'));
  assert.deepStrictEqual(after, before, 'a detector that repairs a fork hides it');
});

check('the only default root is this checkout, derived rather than guessed', () => {
  assert.equal(authority.CANONICAL_ROOT, path.resolve(__dirname, '..'));
  assert.deepStrictEqual(
    authority.KNOWN_ROOTS.map(entry => path.resolve(entry.root)),
    [authority.CANONICAL_ROOT],
    'default operation must not explore Desktop, OneDrive, siblings, or any other guessed root'
  );
});

check('additional installation roots are accepted only when explicitly absolute', () => {
  const copy = path.resolve(os.tmpdir(), 'explicit-ledger-copy');
  const parsed = authority.parseArguments(['--json', '--copy-root', copy]);
  assert.strictEqual(parsed.json, true);
  assert.strictEqual(parsed.roots.length, 2);
  assert.strictEqual(parsed.roots[1].root, copy);
  assert.strictEqual(parsed.roots[1].required, true);
  assert.throws(
    () => authority.parseArguments(['--copy-root', 'relative-copy']),
    error => error instanceof authority.LedgerAuthorityError && /must be absolute/.test(error.message)
  );
});

check('an explicitly named root that is absent refuses instead of disappearing', () => {
  const canonical = tree([R('R1', 'first')]);
  const absent = path.join(os.tmpdir(), `absent-explicit-ledger-root-${process.pid}`);
  assert.throws(
    () => authority.compare([
      { root: canonical, label: 'canonical' },
      { root: absent, label: 'explicit copy', required: true }
    ], canonical),
    error => error instanceof authority.LedgerAuthorityError
      && error.exitCode === 4
      && /EXPLICIT_ROOT_ABSENT/.test(error.message)
  );
});

check('duplicate or missing canonical declarations fail closed as ambiguous', () => {
  assert.throws(
    () => authority.parseArguments(['--copy-root', authority.CANONICAL_ROOT]),
    error => error instanceof authority.LedgerAuthorityError && /ambiguous duplicate/.test(error.message)
  );
  const elsewhere = path.resolve(os.tmpdir(), 'only-noncanonical-ledger-root');
  assert.throws(
    () => authority.validatedRoots([{ root: elsewhere, label: 'copy' }], authority.CANONICAL_ROOT),
    error => error instanceof authority.LedgerAuthorityError && /exactly one declared root/.test(error.message)
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
