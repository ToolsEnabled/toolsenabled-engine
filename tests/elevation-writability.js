// EXECUTABLE CHANGE
// testcanfail-tests-elevation-writability-js
//
// Strengthened assertion: the classificationIsOffending table now asserts its
// cardinality before iterating and asserts the number of executed cases after
// iterating. Mutation: classificationIsOffending returned false unconditionally.
// RED: "AssertionError [ERR_ASSERTION]: broad-group must offend"
//      "false !== true"
//
// Additional mutation observations (the assertions already discriminated):
// - dangerousRightsIn returned []; RED: "Expected values to be strictly
//   deep-equal" with actual [] and expected ['Modify'].
// - evaluateElevationWritability omitted its targets.length > 0 condition;
//   RED: "zero discovered targets must NOT report ok" / "true !== false".
//
// Shape census:
// 1 EMPTY-ITERATION: FIXED below with pre/post execution-count assertions.
// 2 EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND (this test spawns no process).
// 3 SWALLOWED-FAILURE: NOT-FOUND (no try/catch or optional chain).
// 4 SUBJECT-MOCK: NOT-FOUND (the real exported library functions are called).
// 5 SKIP/PRECONDITION-GUARD: NOT-FOUND (the fixtures are platform-neutral).
// 6 SAME-CODE EXPECTATION: NOT-FOUND (expected values are literal or regex).
// Preconditions unmet: none.
// Restoration: src/lib/elevation-writability.js SHA-256 was
// 1d957b981abc40213bff1086176317bae721d10b45cf1d29476493916e88f990 both
// before mutation and after restoration. Restored GREEN output concludes:
// "Elevation writability tests passed."

'use strict';

// B27: nobody who is not an administrator may rewrite a program that Windows
// runs with administrator rights.
//
// Every case here is a synthetic access-control list, so the suite is
// deterministic, offline, runs on any OS, and needs no elevated rights and no
// scheduled task. tools/check-elevation-writability.js supplies the real ACLs
// to the same evaluator on Windows.
//
// The negative cases are the point of this file. This check exists because the
// live machine measured FAIL on 2026-08-11, so a version of it that cannot
// return false would be worse than no check at all: it would convert a real
// privilege escalation into a green tick.

const assert = require('node:assert/strict');

const {
  classificationIsOffending,
  classifyPrincipal,
  dangerousRightsIn,
  evaluateElevationWritability,
  evaluateTarget,
  formatReport,
} = require('../src/lib/elevation-writability');

const SYSTEM = { sid: 'S-1-5-18', name: 'NT AUTHORITY\\SYSTEM' };
const ADMINS = { sid: 'S-1-5-32-544', name: 'BUILTIN\\Administrators' };
const USERS = { sid: 'S-1-5-32-545', name: 'BUILTIN\\Users' };
const AUTHED = { sid: 'S-1-5-11', name: 'NT AUTHORITY\\Authenticated Users' };
const TASK_ACCOUNT_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const TASK_ACCOUNT = { sid: TASK_ACCOUNT_SID, name: 'EXAMPLE\\owner' };
const SANDBOX = { sid: 'S-1-5-21-1111111111-2222222222-3333333333-1055', name: 'EXAMPLE\\SandboxUsers' };
const FOREIGN = { sid: 'S-1-5-21-9999999999-8888888888-7777777777-1000', name: 'S-1-5-21-9999999999-8888888888-7777777777-1000' };

const allow = (principal, rights, inherited = false) => ({ principal, rights, type: 'Allow', inherited });

// --- rights selection -------------------------------------------------------

(() => {
  assert.deepEqual(dangerousRightsIn('ReadAndExecute, Synchronize'), [],
    'read and execute alone cannot change what the elevated process runs');
  assert.deepEqual(dangerousRightsIn(['ReadPermissions', 'WriteAttributes']), [],
    'attributes and permission-reads do not change file content');
  assert.deepEqual(dangerousRightsIn('Modify, Synchronize'), ['Modify']);
  assert.deepEqual(dangerousRightsIn(['TakeOwnership']), ['TakeOwnership'],
    'ownership is write access one step removed');
  assert.deepEqual(dangerousRightsIn('Delete'), ['Delete'],
    'deleting the program lets an attacker put their own in its place');
  console.log('OK: only rights that can change the executed bytes are treated as dangerous');
})();

// --- principal classification ----------------------------------------------

(() => {
  const opts = { taskAccountSid: TASK_ACCOUNT_SID };
  assert.equal(classifyPrincipal(SYSTEM, opts), 'admin-equivalent');
  assert.equal(classifyPrincipal(ADMINS, opts), 'admin-equivalent');
  assert.equal(classifyPrincipal(TASK_ACCOUNT, opts), 'task-account');
  assert.equal(classifyPrincipal(USERS, opts), 'broad-group');
  assert.equal(classifyPrincipal(AUTHED, opts), 'broad-group');
  assert.equal(classifyPrincipal(SANDBOX, opts), 'other-principal');
  assert.equal(classifyPrincipal(FOREIGN, opts), 'unresolved-sid',
    'an SID that resolves only to itself names an account this machine cannot identify');

  assert.equal(classificationIsOffending('admin-equivalent'), false);
  assert.equal(classificationIsOffending('task-account'), false,
    'UAC is not a boundary between a user and their own elevated token');
  const offendingClassifications = ['broad-group', 'other-principal', 'unresolved-sid'];
  assert.equal(offendingClassifications.length, 3,
    'the offending-classification assertion table must not become empty or lose a case');
  let offendingClassificationAssertions = 0;
  for (const c of offendingClassifications) {
    assert.equal(classificationIsOffending(c), true, `${c} must offend`);
    offendingClassificationAssertions += 1;
  }
  assert.equal(offendingClassificationAssertions, 3,
    'all offending-classification assertions must execute');

  // Case-insensitivity: icacls and Get-Acl disagree on SID letter case.
  assert.equal(classifyPrincipal({ sid: 's-1-5-18', name: 'x' }, opts), 'admin-equivalent');
  console.log('OK: principals are classified by SID, and only admins and the task account may write');
})();

// --- a clean target passes ---------------------------------------------------

(() => {
  const target = {
    path: 'C:\\example\\helper.js',
    reason: 'scheduled task "Example" runs it at RunLevel=Highest',
    aces: [
      allow(SYSTEM, 'FullControl'),
      allow(ADMINS, 'FullControl'),
      allow(TASK_ACCOUNT, 'FullControl'),
      allow(USERS, 'ReadAndExecute, Synchronize'),
    ],
  };
  const r = evaluateTarget(target, { taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(r.ok, true);
  assert.deepEqual(r.offenders, []);
  console.log('OK: admins plus the task account plus read-only for everyone else passes');
})();

// --- THE NEGATIVE CASES: each of these must fail ----------------------------

(() => {
  // This is the exact live defect measured on 2026-08-11: an inherited
  // BUILTIN\Users Modify ACE on the program a Highest-RunLevel task executes.
  const target = {
    path: 'C:\\example\\uac-delegation-helper.js',
    reason: 'scheduled task runs it at RunLevel=Highest',
    aces: [
      allow(SYSTEM, 'FullControl'),
      allow(ADMINS, 'FullControl'),
      allow(TASK_ACCOUNT, 'FullControl'),
      allow(USERS, 'Modify, Synchronize', true),
    ],
  };
  const r = evaluateTarget(target, { taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(r.ok, false, 'an inherited BUILTIN\\Users Modify ACE MUST fail this check');
  assert.equal(r.offenders.length, 1);
  assert.equal(r.offenders[0].principal, 'BUILTIN\\Users');
  assert.equal(r.offenders[0].classification, 'broad-group');
  assert.deepEqual(r.offenders[0].rights, ['Modify']);
  assert.equal(r.offenders[0].inherited, true,
    'inherited must be reported: it tells the owner to fix the parent, not the file');
  console.log('OK: the live defect (inherited BUILTIN\\Users Modify) is caught and named');
})();

(() => {
  // A sandbox principal is a DIFFERENT account, so write access here is a
  // sandbox escape to administrator, not a same-user UAC prompt.
  const r = evaluateTarget({
    path: 'C:\\example\\helper.js',
    aces: [allow(ADMINS, 'FullControl'), allow(SANDBOX, 'Modify')],
  }, { taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(r.ok, false, 'a sandbox principal with Modify is an escape to administrator');
  assert.equal(r.offenders[0].classification, 'other-principal');
  console.log('OK: a non-admin sandbox principal with write access fails');
})();

(() => {
  const r = evaluateTarget({
    path: 'C:\\example\\helper.js',
    aces: [allow(ADMINS, 'FullControl'), allow(FOREIGN, 'Modify', true)],
  }, { taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(r.ok, false, 'an unresolvable SID with Modify must fail');
  assert.equal(r.offenders[0].classification, 'unresolved-sid');
  console.log('OK: an SID from another machine holding write access fails');
})();

(() => {
  // Deny entries must not be mistaken for grants, and must not mask a grant.
  const r = evaluateTarget({
    path: 'C:\\example\\helper.js',
    aces: [
      allow(ADMINS, 'FullControl'),
      { principal: USERS, rights: 'FullControl', type: 'Deny' },
    ],
  }, { taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(r.ok, true, 'a Deny entry grants nothing and must not be reported as an offender');
  console.log('OK: Deny entries are not counted as grants');
})();

// --- aggregate + the empty-discovery trap -----------------------------------

(() => {
  const clean = { path: 'a', aces: [allow(ADMINS, 'FullControl')] };
  const dirty = { path: 'b', aces: [allow(USERS, 'Write')] };

  const good = evaluateElevationWritability({ targets: [clean], taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(good.ok, true);
  assert.equal(good.checked, 1);
  assert.equal(good.offenderCount, 0);

  const bad = evaluateElevationWritability({ targets: [clean, dirty], taskAccountSid: TASK_ACCOUNT_SID });
  assert.equal(bad.ok, false, 'one offending target must fail the whole run');
  assert.equal(bad.checked, 2);
  assert.equal(bad.offenderCount, 1);
  assert.equal(bad.offenders[0].path, 'b');

  // A run that discovered nothing is not a pass. This is the failure mode that
  // makes a security check worthless: discovery breaks, zero targets are
  // examined, and the check reports success.
  const none = evaluateElevationWritability({ targets: [] });
  assert.equal(none.ok, false, 'zero discovered targets must NOT report ok');
  assert.equal(none.empty, true);
  assert.match(formatReport(none), /not a pass/,
    'the report must say plainly that nothing was checked');

  const unreadable = evaluateElevationWritability({ targets: [{ path: 'unreadable' }] });
  assert.equal(unreadable.ok, false,
    'a target whose ACL could not be supplied must not become a clean empty ACL');
  assert.equal(unreadable.unknownCount, 1);
  assert.match(formatReport(unreadable), /^UNKNOWN {2}unreadable/m);
  assert.match(formatReport(unreadable), /writability was not measured/);

  console.log('OK: one bad target fails the run, and absent discovery or ACL evidence is not a pass');
})();

// --- report text ------------------------------------------------------------

(() => {
  const bad = evaluateElevationWritability({
    targets: [{ path: 'C:\\example\\helper.js', reason: 'RunLevel=Highest', aces: [allow(USERS, 'Modify', true)] }],
    taskAccountSid: TASK_ACCOUNT_SID,
  });
  const text = formatReport(bad);
  assert.match(text, /^FAIL {2}C:\\example\\helper\.js/m);
  assert.match(text, /BUILTIN\\Users holds Modify \(inherited\)/);
  assert.match(text, /FAIL: 1 offending grant/);

  const good = formatReport(evaluateElevationWritability({
    targets: [{ path: 'x', aces: [allow(ADMINS, 'FullControl')] }],
    taskAccountSid: TASK_ACCOUNT_SID,
  }));
  assert.match(good, /^PASS: 1 elevation target/m);
  assert.doesNotMatch(good, /FAIL/);
  console.log('OK: the report names the file, the principal, the right, and whether it was inherited');
})();

console.log('Elevation writability tests passed.');
