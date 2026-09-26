// EXECUTABLE CHANGE
'use strict';

/* DISCRIMINATION REPORT (testcanfail-tests-open-gates-freshness-check-js)
 *
 * EXIT-STATUS-ONLY -- FOUND. The MISSING and UNSTAMPED CLI assertions stayed
 * green when each branch was separately mutated to throw `simulated CLI load
 * failure` before printing its verdict. Their exit status was still 1, but it
 * was Node's runtime failure rather than the subject's decision. The exit-only
 * INDETERMINATE and INCOMPLETE fixtures (BOM/empty/unreadable/absent/order) were
 * likewise strengthened to require their state-specific CLI output; FRESH now
 * pins its own positive marker at every call site. State-branch throw mutations
 * made each strengthened class RED. The observed output was:
 *
 *   AssertionError [ERR_ASSERTION]: the CLI must reach and report its MISSING verdict, not merely fail to load
 *   AssertionError [ERR_ASSERTION]: the CLI must reach and report its UNSTAMPED verdict, not merely fail to load
 *   AssertionError [ERR_ASSERTION]: the CLI must emit its own INDETERMINATE verdict rather than merely exit non-zero
 *   AssertionError [ERR_ASSERTION]: The input did not match the regular expression /STRUCTURALLY INCOMPLETE/. Input:
 *
 * A FRESH-output mutation is independently caught by the exact sentence assertion
 * in its first fixture. Each source mutation was restored byte-for-byte (`cmp`
 * returned 0), after which
 * `node tests/open-gates-freshness-check.js` was green:
 *
 *   open-gates-freshness-check: 20 checks passed
 *
 * EMPTY-ITERATION -- NOT-FOUND for assertions. The only collection loop performs
 * best-effort ACL cleanup and contains no assertion; the explicit `checks >= 19`
 * assertion prevents the test-case collection itself from passing empty.
 * SWALLOWED-FAILURE -- NOT-FOUND. runCli converts a child failure into observable
 * exit/output data, and the unreadable-file try/catch verifies the errno before
 * taking its documented EISDIR fallback.
 * MOCK-OF-SUBJECT -- NOT-FOUND. Fixtures mock only input files; both the library
 * and CLI subjects are the production implementations.
 * SKIP/PRECONDITION-NO-OP -- NOT-FOUND. There are no skips; the Windows ACL path
 * has an asserted cross-platform EISDIR fallback.
 * SAME-CODE EXPECTATION -- NOT-FOUND. Contract-generated valid digests are paired
 * with independently pinned verdicts, and missing/order mutations are explicit.
 * Unmet preconditions: none.
 */

// Pins src/lib/open-gates-freshness.js and its two callers
// (tools/agent-preflight.js and tools/check-open-gates-freshness.js).
//
// WHY THIS EXISTS. reports/OPEN-GATES.md measured 2 revisions stale
// (stamped 730, live ledger 732) on 2026-08-10 with nothing catching it
// automatically -- the only detector (tools/agent-preflight.js) is reachable
// solely by an agent remembering to run it by hand. This test is the proof
// that the extracted check, and the new advisory .githooks/pre-push caller
// built on top of it, actually go red on the drift they claim to catch. A
// guard that has never been shown failing is decoration, not a guard.
//
// Fixtures only -- this suite never reads or writes the real
// reports/OWNER-REQUEST-LEDGER.json or reports/OPEN-GATES.md, matching the
// existing convention noted in tests/agent-preflight.js (state-transition
// coverage belongs against an isolated temp fixture, not the live repo).

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { checkOpenGatesFreshness } = require(path.join(ROOT, 'src', 'lib', 'open-gates-freshness'));
const digestContract = require(path.join(ROOT, 'src', 'lib', 'open-gates-digest-contract'));
const CLI = path.join(ROOT, 'tools', 'check-open-gates-freshness.js');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-gates-freshness-test-'));
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

function writeLedger(name, revision) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, JSON.stringify({ revision, requests: [] }), 'utf8');
  return file;
}

/** A ledger written exactly as-is, for the encoding/corruption cases below. */
function writeRawLedger(name, contents) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

/* A ledger this process genuinely cannot read.
 *
 * First choice is a real EACCES via an icacls deny ACE, because that is the
 * production shape (a file locked down, or held open by another process).
 * Where the ACL does not take -- an elevated shell, a filesystem that ignores
 * it -- the fallback is a DIRECTORY path, whose read fails EISDIR. Both land
 * in the same branch under test, and the assertions below are about the
 * module's behaviour on "the read threw", never about which errno arrived, so
 * the fallback cannot make this check silently vacuous.
 *
 * Any deny ACE set here is recorded in `aclCleanups` and reset before the work
 * directory is removed: fs.rmSync(force) cannot delete a file it may not open
 * either, so skipping that would leak a locked file into the temp dir. */
const aclCleanups = [];
function makeUnreadableLedger(name) {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, JSON.stringify({ revision: 12, requests: [] }), 'utf8');
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/deny', `${process.env.USERNAME}:(R)`],
      { encoding: 'utf8', windowsHide: true, shell: false });
    aclCleanups.push(file);
    fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && (error.code === 'EACCES' || error.code === 'EPERM')) return file;
  }
  return workDir; // fallback: reading a directory throws EISDIR
}

/* THE FIXTURE IS A WHOLE DIGEST, NOT A STAMP LINE.
 *
 * It used to be two lines -- a count and a stamp -- which was enough while the
 * only question was "does the stamped revision match". It is not enough now
 * that the check also answers "was this written by the current renderer", and
 * the shortcut would have quietly turned every FRESH case below into
 * INCOMPLETE. Built from the contract rather than hand-typed so a section
 * added to the digest does not silently stop being covered here.
 *
 * `omitSections` is how a digest from an older renderer is simulated: drop one
 * heading and everything else stays byte-identical, which is exactly the shape
 * of the 2026-08-12 miss. */
function writeDigest(name, stampLine, { omitSections = [], bom = false } = {}) {
  const file = path.join(workDir, name);
  const lines = ['Open gates: 0', 'Authorizations in force: 0 grants, 0 prohibitions (0 clauses undeclared)'];
  if (stampLine) lines.push(stampLine);
  lines.push('');
  for (const section of digestContract.OPEN_GATES_SECTIONS) {
    if (omitSections.includes(section.id)) continue;
    lines.push(section.heading, '', 'None.', '');
  }
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + lines.join('\n'), 'utf8');
  return file;
}

function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, shell: false });
    return { exitCode: 0, stdout: out };
  } catch (error) {
    return { exitCode: error.status, stdout: (error.stdout || '') + (error.stderr || '') };
  }
}

// --- FRESH: stamped revision matches the live ledger exactly -----------
check('FRESH when the digest stamp equals the live ledger revision', () => {
  const ledger = writeLedger('ledger-fresh.json', 5);
  const digest = writeDigest('digest-fresh.md', 'Ledger revision: 5 (updated 2026-08-10)');
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'FRESH');
  assert.equal(result.liveRevision, 5);
  assert.equal(result.digestRevision, 5);
  assert.equal(result.message, null);

  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 0, 'the CLI must exit 0 on a fresh digest');
  /* /fresh/i MATCHES "not fresh".
   *
   * This asserted the FRESH wording with a pattern its own negation satisfies, so
   * it could not tell the verdict from its opposite. MEASURED: making the FRESH
   * branch print "reports/OPEN-GATES.md is not fresh" left this suite green at
   * 7/7 -- every fresh push would have told the reader the digest was stale, and
   * the guard for that sentence was this line.
   *
   * Pin the whole FRESH sentence, then exclude the negation explicitly. The
   * positive match comes first and is on the same subject, so the exclusion below
   * is a measurement rather than a pattern that happens not to appear. */
  assert.match(cli.stdout, /\[open-gates\] fresh -- reports\/OPEN-GATES\.md matches ledger revision 5\./);
  assert.doesNotMatch(cli.stdout, /not fresh/i);
});

// --- STALE: this is the exact incident that was measured this session --
check('STALE (and the CLI goes red, exit 1) when the digest lags the live ledger', () => {
  const staleLedger = writeLedger('ledger-stale.json', 9);
  const digest = writeDigest('digest-fresh.md', 'Ledger revision: 5 (updated 2026-08-10)'); // reuse: stamped 5
  const result = checkOpenGatesFreshness({ ledgerPath: staleLedger, digestPath: digest });
  assert.equal(result.state, 'STALE');
  assert.equal(result.liveRevision, 9);
  assert.equal(result.digestRevision, 5);
  assert.match(result.message, /4 revision\(s\) behind/);
  assert.match(result.message, /ledger-query\.js open --gates --write/);

  const cli = runCli(['--ledger', staleLedger, '--digest', digest]);
  assert.equal(cli.exitCode, 1, 'the CLI must exit non-zero on a stale digest -- this is the guard proving it can fail');
  assert.match(cli.stdout, /not fresh/i);
});

// --- MISSING: the digest file does not exist at all ---------------------
check('MISSING when the digest file is absent, and the CLI exits non-zero', () => {
  const ledger = writeLedger('ledger-for-missing.json', 1);
  const missingDigest = path.join(workDir, 'does-not-exist.md');
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: missingDigest });
  assert.equal(result.state, 'MISSING');
  assert.match(result.message, /does not exist/);

  const cli = runCli(['--ledger', ledger, '--digest', missingDigest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /reports\/OPEN-GATES\.md does not exist/,
    'the CLI must reach and report its MISSING verdict, not merely fail to load');
});

// --- UNSTAMPED: a digest predating the R1162 P1 stamp --------------------
check('UNSTAMPED when the digest has no ledger-revision stamp line', () => {
  const ledger = writeLedger('ledger-for-unstamped.json', 1);
  const digest = writeDigest('digest-unstamped.md', '');
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'UNSTAMPED');
  assert.match(result.message, /no ledger-revision stamp/);

  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /no ledger-revision stamp/,
    'the CLI must reach and report its UNSTAMPED verdict, not merely fail to load');
});

// --- INDETERMINATE: the ledger itself is unreadable, so freshness cannot --
// be confirmed even though an unreadable ledger is not evidence of drift.
check('INDETERMINATE makes the CLI fail when the live ledger has no readable revision field', () => {
  const brokenLedger = path.join(workDir, 'ledger-broken.json');
  fs.writeFileSync(brokenLedger, '{ not json', 'utf8');
  const digest = writeDigest('digest-for-indeterminate.md', 'Ledger revision: 5 (updated 2026-08-10)');
  const result = checkOpenGatesFreshness({ ledgerPath: brokenLedger, digestPath: digest });
  assert.equal(result.state, 'INDETERMINATE');
  assert.equal(result.digestRevision, 5);

  const cli = runCli(['--ledger', brokenLedger, '--digest', digest]);
  assert.equal(cli.exitCode, 1, 'an unreadable ledger must not let an unverified digest pass as fresh');
  assert.match(cli.stdout, /\[open-gates\] INDETERMINATE/,
    'the CLI must emit its own INDETERMINATE verdict rather than merely exit non-zero');
});

/* === AN UNREADABLE LEDGER MUST NOT ANSWER A QUESTION THAT NEVER NEEDED IT ===
 *
 * MEASURED 2026-08-13, before the fix, with ONE digest (stamp current, the
 * "Authorizations on file" section missing) and four ledgers:
 *
 *   valid ledger      -> INCOMPLETE, CLI exit 1     <- correct
 *   BOM-prefixed      -> INDETERMINATE, CLI exit 0  <- the defect
 *   empty (0 bytes)   -> INDETERMINATE, CLI exit 0  <- the defect
 *   EACCES            -> INDETERMINATE, CLI exit 0  <- the defect
 *
 * The INDETERMINATE early return sat above the shape check, and the shape check
 * reads only the digest. So corrupting a file the failing check does not even
 * consult turned a red gate green. On Windows that corruption is one careless
 * save away: PowerShell writes a UTF-8 BOM by default.
 *
 * Each check below is written to go RED against the pre-fix module. */

const BROKEN_STAMP = 'Ledger revision: 12 (updated 2026-08-13)';
const brokenShapeDigest = () => writeDigest('digest-broken-shape.md', BROKEN_STAMP, {
  omitSections: ['authorizations']
});

check('a BOM-prefixed ledger does NOT hide a structurally broken digest (CLI still exits 1)', () => {
  // The regression test named in the directive: pre-fix this was
  // INDETERMINATE / exit 0 with the identical digest that exits 1 beside a
  // plain-encoded ledger.
  const ledger = writeRawLedger('ledger-bom.json', `\uFEFF${JSON.stringify({ revision: 12, requests: [] })}`);
  const digest = brokenShapeDigest();
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INCOMPLETE', 'a BOM on the LEDGER cannot make a broken DIGEST acceptable');
  assert.deepEqual(result.sections.missing, ['authorizations']);
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1,
    'exit 0 here is the defect: a corrupt ledger turning a failing freshness check into a passing one');
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('a BOM-prefixed but otherwise valid ledger parses -- it is an encoding label, not corruption', () => {
  // PowerShell's Set-Content/Out-File emit this by default and this repo's
  // tooling is full of PowerShell. Calling such a ledger unreadable would be a
  // bug in the reader. Both axes are answerable here, so the verdict is FRESH.
  const ledger = writeRawLedger('ledger-bom-valid.json', `\uFEFF${JSON.stringify({ revision: 7, requests: [] })}`);
  const digest = writeDigest('digest-bom-valid.md', 'Ledger revision: 7 (updated 2026-08-13)');
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'FRESH');
  assert.equal(result.liveRevision, 7, 'the revision must be read THROUGH the BOM, not lost to it');
  assert.equal(result.ledger.state, 'OK');
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 0);
  assert.match(cli.stdout, /\[open-gates\] fresh --/);
});

check('a BOM-prefixed DIGEST does not report its own present header line as missing', () => {
  // The mirror of the case above, and a false RED rather than a false green:
  // pre-fix the BOM glued itself to "Open gates:" so the header-line contract
  // said a line that is plainly there was absent.
  const ledger = writeLedger('ledger-bom-digest.json', 4);
  const digest = writeDigest('digest-with-bom.md', 'Ledger revision: 4 (updated 2026-08-13)', { bom: true });
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.deepEqual(result.sections.missingLines, [], 'the BOM is an encoding artefact, not a missing line');
  assert.equal(result.state, 'FRESH');
});

check('an EMPTY ledger does not hide a structurally broken digest, and is reported as EMPTY', () => {
  const ledger = writeRawLedger('ledger-empty.json', '');
  const digest = brokenShapeDigest();
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(result.ledger.state, 'EMPTY');
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('an UNREADABLE ledger does not hide a structurally broken digest, and is reported as UNREADABLE', () => {
  const ledger = makeUnreadableLedger('ledger-denied.json');
  const digest = brokenShapeDigest();
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(result.ledger.state, 'UNREADABLE');
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('an ABSENT ledger does not hide a structurally broken digest either', () => {
  const ledger = path.join(workDir, 'ledger-never-written.json');
  const digest = brokenShapeDigest();
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INCOMPLETE');
  assert.equal(result.ledger.state, 'ABSENT');
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('the INCOMPLETE message says the revision axis was NOT verified when the ledger is unreadable', () => {
  // Without this the reader is told "its ledger revision stamp is current",
  // which is a claim the check did not earn -- the file may be stale too and
  // an unreadable ledger cannot show that either way.
  const digest = brokenShapeDigest();
  const unverified = checkOpenGatesFreshness({
    ledgerPath: writeRawLedger('ledger-empty-msg.json', ''), digestPath: digest
  });
  assert.match(unverified.message, /could NOT be verified/);
  assert.match(unverified.message, /empty/);
  assert.doesNotMatch(unverified.message, /revision stamp is current/);

  // ...and still says exactly that when the ledger DID answer the revision axis.
  const verified = checkOpenGatesFreshness({
    ledgerPath: writeLedger('ledger-msg-ok.json', 12), digestPath: digest
  });
  assert.match(verified.message, /revision stamp is current/);
});

check('EMPTY, UNREADABLE, MALFORMED, NO_REVISION and ABSENT are five distinct reported facts', () => {
  // Only one of these is ever routine, and a single "unreadable" bucket cannot
  // tell a truncated write from a permissions problem from a schema fault.
  const digest = writeDigest('digest-ledger-facts.md', BROKEN_STAMP);
  const at = ledgerPath => checkOpenGatesFreshness({ ledgerPath, digestPath: digest });
  assert.equal(at(writeRawLedger('ledger-fact-empty.json', '   ')).ledger.state, 'EMPTY');
  assert.equal(at(writeRawLedger('ledger-fact-bad.json', '{ not json')).ledger.state, 'MALFORMED');
  assert.equal(at(writeRawLedger('ledger-fact-norev.json', '{"requests":[]}')).ledger.state, 'NO_REVISION');
  assert.equal(at(path.join(workDir, 'ledger-fact-absent.json')).ledger.state, 'ABSENT');
  assert.equal(at(makeUnreadableLedger('ledger-fact-denied.json')).ledger.state, 'UNREADABLE');
  assert.equal(at(writeLedger('ledger-fact-ok.json', 12)).ledger.state, 'OK');

  // All five faults still leave the digest verdict answerable on its own axis.
  assert.equal(at(writeRawLedger('ledger-fact-empty2.json', '   ')).state, 'INDETERMINATE',
    'a complete digest beside an unreadable ledger is genuinely unknown on the revision axis -- and only that axis');
});

check('INDETERMINATE names the specific unanswered question, not a blanket stop', () => {
  const digest = writeDigest('digest-indeterminate-msg.md', BROKEN_STAMP);
  const ledger = makeUnreadableLedger('ledger-indeterminate-msg.json');
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INDETERMINATE');
  assert.match(result.message, /revision axis only/);
  assert.ok(result.sections.complete, 'the shape axis must still have been evaluated and reported');
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1,
    'genuinely unknown freshness must fail closed rather than pass like FRESH');
  assert.match(cli.stdout, /\[open-gates\] INDETERMINATE/);
});

// --- INCOMPLETE: THIS IS THE MISS THAT SHIPPED GREEN ON 2026-08-12 --------
//
// tools/ledger-query.js grew an "Authorizations on file" section. The
// published reports/OPEN-GATES.md carried 0 occurrences of it. This suite
// exited 0 -- correctly on the only axis it had, because the digest's stamped
// revision equalled the live ledger's. A feature existed in code and was
// absent from the surface agents read, with every gate green. The digest below
// is byte-identical to a fresh one except that one section is missing, so
// nothing but the shape check can tell it apart.
check('INCOMPLETE (CLI exit 1) when the digest is current but was written by an older renderer', () => {
  const ledger = writeLedger('ledger-incomplete.json', 12);
  const digest = writeDigest('digest-incomplete.md', 'Ledger revision: 12 (updated 2026-08-12)', {
    omitSections: ['authorizations']
  });
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });

  // The revision axis is satisfied -- that is the entire point of this case.
  assert.equal(result.liveRevision, 12);
  assert.equal(result.digestRevision, 12);
  assert.equal(result.state, 'INCOMPLETE', 'a digest at the right revision with a missing section is not FRESH');
  assert.deepEqual(result.sections.missing, ['authorizations']);
  assert.match(result.message, /Authorizations on file/);
  assert.match(result.message, /ledger-query\.js open --gates --write/);

  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1, 'the guard must be able to go red on this -- it could not before');
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('INCOMPLETE when the permissions section renders BELOW the task list', () => {
  // Ordering is part of the contract. A reader who stops at the first task
  // list has not been told what they are allowed to do, which is the same
  // outcome as the section being absent.
  const ledger = writeLedger('ledger-order.json', 3);
  const stamp = 'Ledger revision: 3 (updated 2026-08-12)';
  const complete = fs.readFileSync(writeDigest('digest-order-src.md', stamp), 'utf8');
  const permissions = digestContract.heading('authorizations');
  const tasks = digestContract.heading('active');
  const swapped = complete
    .replace(`${permissions}\n\nNone.\n`, '@@MOVED@@\n')
    .replace(`${tasks}\n\nNone.\n`, `${tasks}\n\nNone.\n\n${permissions}\n\nNone.\n`)
    .replace('@@MOVED@@\n', '');
  const digest = path.join(workDir, 'digest-order.md');
  fs.writeFileSync(digest, swapped, 'utf8');

  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'INCOMPLETE');
  assert.deepEqual(result.sections.missing, [], 'the section is present -- it is in the wrong place');
  assert.deepEqual(result.sections.outOfOrder, ['active must render after authorizations']);
  const cli = runCli(['--ledger', ledger, '--digest', digest]);
  assert.equal(cli.exitCode, 1);
  assert.match(cli.stdout, /STRUCTURALLY INCOMPLETE/);
});

check('STALE still wins over INCOMPLETE, so the message names the fault a reader must act on first', () => {
  const ledger = writeLedger('ledger-both.json', 40);
  const digest = writeDigest('digest-both.md', 'Ledger revision: 31 (updated 2026-08-10)', {
    omitSections: ['authorizations']
  });
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'STALE', 'a digest 9 revisions behind is missing DIRECTIVES, not just a section');
  // The shape verdict is still reported rather than dropped: one regeneration
  // fixes both, and a caller must not have to run the check twice to find out.
  assert.deepEqual(result.sections.missing, ['authorizations']);
});

// --- Cross-file contract with the writer side -----------------------------
check('the digest tools/ledger-query.js actually renders satisfies the contract this check enforces', () => {
  const { processOpenGates, renderOpenGatesDigest } = require(path.join(ROOT, 'tools', 'ledger-query.js'));
  const markdown = renderOpenGatesDigest(processOpenGates([]), { revision: 5, updatedAt: '2026-08-12' });
  const shape = digestContract.checkDigestSections(markdown);
  assert.deepEqual(shape.missing, [], 'the renderer must emit every section this check requires');
  assert.deepEqual(shape.outOfOrder, []);
  assert.deepEqual(shape.missingLines, []);
  assert.ok(shape.complete);
  // Rendered on an EMPTY ledger. An empty corpus must still publish the
  // permissions section saying "none on file" -- a section that is simply not
  // printed is what lets a reader conclude "none exist".
  assert.match(markdown, /## Authorizations on file/);
  assert.match(markdown, /None on file\.|None declared\./);
});

check('accepts exactly what tools/ledger-query.js stampLedgerRevision() writes', () => {
  const { stampLedgerRevision } = require(path.join(ROOT, 'tools', 'ledger-query.js'));
  const stamp = stampLedgerRevision({ revision: 41, updatedAt: '2026-08-10' });
  const ledger = writeLedger('ledger-contract.json', 41);
  const digest = writeDigest('digest-contract.md', stamp);
  const result = checkOpenGatesFreshness({ ledgerPath: ledger, digestPath: digest });
  assert.equal(result.state, 'FRESH', `stampLedgerRevision's own output must satisfy the freshness parser: "${stamp}"`);
});

// --- tools/agent-preflight.js must delegate to this exact module, not a ---
// re-forked copy of the detection logic.
check('tools/agent-preflight.js reports the same shape this module produces against the live repo', () => {
  const report = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools', 'agent-preflight.js'), '--json'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000
  }));
  const live = checkOpenGatesFreshness();
  assert.deepEqual(report.openGatesFreshness, live, 'agent-preflight.js must delegate to checkOpenGatesFreshness(), not a divergent copy');
});

// Deny ACEs first: fs.rmSync(force) still has to be allowed to touch the file.
for (const file of aclCleanups) {
  try { execFileSync('icacls', [file, '/reset'], { encoding: 'utf8', windowsHide: true, shell: false }); } catch { /* best effort */ }
}
fs.rmSync(workDir, { recursive: true, force: true });

assert.ok(checks >= 19, `expected at least 19 checks to run, ran ${checks}`);
console.log(`open-gates-freshness-check: ${checks} checks passed`);
