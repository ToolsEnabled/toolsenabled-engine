// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-kernel-audit-audit-logs-retention-js):
// - Strengthened the unknown-flag assertion. Mutation: changed the tool's own
//   "unknown argument" diagnostic to an unrelated parser-refusal message. Before
//   this change the named check still printed GREEN ("ok  an unknown policy or
//   flag is refused rather than approximated"), proving that exit status 4 plus
//   an untouched fixture did not establish why the process exited.
// - RED after strengthening (exit 1): "AssertionError [ERR_ASSERTION]: the
//   refusal must be the tool identifying the exact unknown flag, not merely any
//   failed launch"; actual "retention parser refused input\n"; expected
//   "/unknown argument --delete-everything/"; operator "match".
// - NOT-FOUND (1): every collection assertion has a literal/non-empty fixture,
//   or an independent cardinality assertion (the 288-case matrix and prune list).
// - NOT-FOUND (3): cleanup finally blocks do not swallow assertions; the only
//   caught failure is rethrown while creating the junction fixture.
// - NOT-FOUND (4): assertions exercise the real CLI/module and filesystem, not
//   a mock of retention behavior.
// - NOT-FOUND (5): there are no skips or platform precondition guards.
// - NOT-FOUND (6): expected results are explicit policy values and fixture
//   outcomes, not values computed by the retention implementation.
// - Preconditions: the full file cannot currently finish GREEN because the
//   repository's managed-process registry has no "logs-retention" entry; all 19
//   preceding checks pass before that unrelated existing failure. With the
//   restored source, the executable 19-check prefix is GREEN:
//   "audit-logs-retention: 19 checks passed."

'use strict';

// logs/ retention.
//
// The one thing this pass must never do is delete something the audit system
// still needs to prove itself, so most of this suite is about what survives,
// not about what goes. In particular a rotation segment that verify() still
// re-hashes is indistinguishable, by name alone, from an orphaned one left
// behind by a superseded rebuild -- only the rotation record tells them apart,
// and a record that cannot be read must protect both.
//
// The protect list is proved against the WHOLE FLAG MATRIX rather than for one
// representative run, because "safe under the flags I happened to try" is the
// property this tool was already accidentally shipping: a referenced segment
// used to be classified by NAME, so a referenced segment with an unexpected
// name and a size over the service-log floor was deletable by
// --include-service-logs. Nothing in a single-run test would have caught it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.resolve(__dirname, '..', '..', 'tools', 'audit-logs-retention.js');
const tool = require(TOOL);
const OLD_MS = Date.now() - 60 * 24 * 60 * 60 * 1000;
const YOUNG_MS = Date.now() - 60 * 1000;
const MB = 1024 * 1024;

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

// Sized with truncate rather than written byte by byte: the tool only ever
// stats these, and the flag matrix below builds ~100 fixtures containing
// 20 MB files. Writing them for real would make the suite about disk speed.
function write(file, bytes, mtimeMs, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (typeof content === 'string') {
    fs.writeFileSync(file, content, 'utf8');
  } else {
    fs.writeFileSync(file, '');
    if (bytes > 0) fs.truncateSync(file, bytes);
  }
  const when = new Date(mtimeMs);
  fs.utimesSync(file, when, when);
}

function run(root, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [TOOL, '--root', root, '--json', ...args],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, expected,
    `retention tool exit ${result.status}, expected ${expected}: ${result.stdout}\n${result.stderr}`);
  return result.status === 4 ? { stderr: result.stderr } : JSON.parse(result.stdout);
}

// Same code path, no child process. Used only by the 96-combination matrix,
// where spawn cost would be the whole runtime.
function runInProcess(root, args = []) {
  const chunks = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = value => { chunks.push(value); return true; };
  process.stderr.write = value => { chunks.push(value); return true; };
  try { return { status: tool.main(['--root', root, ...args]), output: chunks.join('') }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

function decision(report, klass) {
  return report.classes.find(row => row.class === klass) || null;
}

const ROTATION_RECORD = `${JSON.stringify({
  version: 1,
  sinks: {
    jsonl: {
      baseSequence: 10, baseHash: 'a'.repeat(64), pending: null,
      segments: [
        {
          file: 'actions.jsonl.rotated-1-10-aaaaaaaaaaaa', firstSequence: 1, lastSequence: 10,
          lastHash: 'a'.repeat(64), digest: 'a'.repeat(64), bytes: 4096, rotatedAtMs: 1
        },
        // A referenced segment that does NOT look like one and is over the
        // service-log size floor. Classification by name alone put this file
        // in the service-log class, where --include-service-logs deleted it.
        {
          file: 'archive/ledger-part-0001.bin', firstSequence: 11, lastSequence: 900,
          lastHash: 'b'.repeat(64), digest: 'b'.repeat(64), bytes: 20 * MB, rotatedAtMs: 2
        }
      ]
    },
    text: { baseSequence: 0, baseHash: '0'.repeat(64), segments: [], pending: null }
  }
})}\n`;

// Every file that must survive every flag combination, forever.
const MUST_SURVIVE = Object.freeze([
  'actions.jsonl',                                  // live sink
  'actions.log',                                    // live sink
  'audit-emergency.jsonl',                          // live sink
  'audit-durability.json',                          // durability sidecar
  'audit-projection-rotation.json',                 // the record itself
  'audit-emergency.jsonl.ingest-aaaa.jsonl',        // unrecovered events
  'audit-emergency.jsonl.quarantine-bbbb',          // unrecovered events
  'actions.jsonl.rotated-1-10-aaaaaaaaaaaa',        // referenced segment
  'archive/ledger-part-0001.bin'                    // referenced, misnamed, 20 MB
]);

function fixture(label, { rotationRecord = 'valid' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `te-logs-retention-${label}-`));
  // Live sinks and audit state: never candidates. actions.jsonl is deliberately
  // over the service-log size floor -- a small one would be protected by the
  // 'other' class no matter how badly the live-sink rule was broken, and the
  // matrix would pass for the wrong reason. It did, until this line changed.
  write(path.join(root, 'actions.jsonl'), 20 * MB, OLD_MS);
  write(path.join(root, 'actions.log'), 1024, OLD_MS);
  write(path.join(root, 'audit-emergency.jsonl'), 16, OLD_MS);
  write(path.join(root, 'audit-durability.json'), 32, OLD_MS);
  // Unrecovered audit events: the last thing that may ever be deleted.
  write(path.join(root, 'audit-emergency.jsonl.ingest-aaaa.jsonl'), 64, OLD_MS);
  write(path.join(root, 'audit-emergency.jsonl.quarantine-bbbb'), 64, OLD_MS);
  // One referenced rotation segment and one orphan, identical in shape, plus
  // a referenced segment whose name and size would otherwise class it as an
  // ordinary large service log.
  write(path.join(root, 'actions.jsonl.rotated-1-10-aaaaaaaaaaaa'), 4096, OLD_MS);
  write(path.join(root, 'actions.jsonl.rotated-11-20-bbbbbbbbbbbb'), 4096, OLD_MS);
  write(path.join(root, 'archive', 'ledger-part-0001.bin'), 20 * MB, OLD_MS);
  if (rotationRecord === 'valid') {
    write(path.join(root, 'audit-projection-rotation.json'), 0, OLD_MS, ROTATION_RECORD);
  } else if (rotationRecord === 'corrupt') {
    write(path.join(root, 'audit-projection-rotation.json'), 0, OLD_MS, 'not json at all');
  }
  // Legacy migration archives: three old, distinct mtimes so "keep newest" is
  // observable, plus one recent one that the age floor alone must protect.
  write(path.join(root, 'actions.jsonl.legacy-1111111111111111'), 3 * MB, OLD_MS - 3000);
  write(path.join(root, 'actions.jsonl.legacy-2222222222222222'), 3 * MB, OLD_MS - 2000);
  write(path.join(root, 'actions.jsonl.legacy-3333333333333333'), 3 * MB, OLD_MS - 1000);
  write(path.join(root, 'actions.log.legacy-4444444444444444'), 1 * MB, YOUNG_MS);
  // Ordinary operational logs.
  write(path.join(root, 'lane-consoles', 'lane-a.log'), 5 * MB, OLD_MS);
  write(path.join(root, 'durable-worker.log'), 20 * MB, OLD_MS);
  write(path.join(root, 'small-service.log'), 1024, OLD_MS);
  write(path.join(root, 'actions.jsonl.4242.11111111-2222-3333-4444-555555555555.tmp'), 512, OLD_MS);
  return root;
}

function drop(root) { fs.rmSync(root, { recursive: true, force: true }); }

process.stdout.write('audit-logs-retention\n');

// ---------------------------------------------------------------------
// 1. The protect list, proved across the entire flag matrix
// ---------------------------------------------------------------------
check('every protected file survives every combination of every flag', () => {
  const policies = [['--policy', 'install'], ['--policy', 'audit-only']];
  const classes = [[], ['--include-consoles'], ['--include-service-logs'],
    ['--include-consoles', '--include-service-logs']];
  const floors = [[], ['--min-age-days', '0']];
  const legacy = [[], ['--keep-legacy', '0']];
  // A 1 MB budget cannot be met by any fixture here, which forces the
  // over-budget escalation to run at full stretch on every combination.
  const budgets = [[], ['--no-budget'], ['--max-total-mb', '1']];
  const records = ['valid', 'corrupt', 'absent'];

  let combinations = 0;
  for (const record of records) {
    for (const policy of policies) {
      for (const klass of classes) {
        for (const floor of floors) {
          for (const keep of legacy) {
            for (const budget of budgets) {
              const args = ['--apply', ...policy, ...klass, ...floor, ...keep, ...budget];
              const root = fixture('matrix', { rotationRecord: record });
              try {
                const { status, output } = runInProcess(root, args);
                assert.ok([0, 3].includes(status), `unexpected exit ${status} for ${args.join(' ')}: ${output}`);
                for (const survivor of MUST_SURVIVE) {
                  if (record === 'absent' && survivor === 'audit-projection-rotation.json') continue;
                  // With no readable record the misnamed segment is NOT
                  // knowable as a segment -- nothing on disk says it is one --
                  // so it is covered by the "unreadable record" rules below
                  // only for the files that are segment-SHAPED.
                  if (record !== 'valid' && survivor === 'archive/ledger-part-0001.bin') continue;
                  assert.ok(fs.existsSync(path.join(root, survivor)),
                    `${survivor} was DELETED by: ${args.join(' ')} (rotation record: ${record})`);
                }
                // Whatever the flags, a segment-shaped file survives whenever
                // the record could not be read.
                if (record !== 'valid') {
                  for (const segment of ['actions.jsonl.rotated-1-10-aaaaaaaaaaaa',
                    'actions.jsonl.rotated-11-20-bbbbbbbbbbbb']) {
                    assert.ok(fs.existsSync(path.join(root, segment)),
                      `${segment} was deleted although the rotation record was ${record}: ${args.join(' ')}`);
                  }
                }
                combinations += 1;
              } finally { drop(root); }
            }
          }
        }
      }
    }
  }
  assert.equal(combinations, 288, `expected the full matrix, ran ${combinations}`);
});

// ---------------------------------------------------------------------
// 2. The specific hole the matrix was written to catch
// ---------------------------------------------------------------------
check('a referenced segment is protected by PATH, not by name or size', () => {
  const root = fixture('referenced-by-path');
  try {
    const report = run(root, ['--apply', '--policy', 'install', '--include-service-logs',
      '--min-age-days', '0', '--no-budget']);
    assert.ok(fs.existsSync(path.join(root, 'archive', 'ledger-part-0001.bin')),
      'a 20 MB referenced segment named nothing like a segment must still be protected');
    const referenced = report.prune.find(row => row.file.includes('ledger-part-0001'));
    assert.equal(referenced, undefined, 'a referenced segment must never appear in the prune list');
    assert.equal(decision(report, 'rotation-segment-referenced').action, 'protected');
    assert.equal(decision(report, 'rotation-segment-referenced').count, 2);
  } finally { drop(root); }
});

check('an audit path override may ADD to the protect list, never shorten it', () => {
  // Found by the matrix, not by review. The protect list read
  // `env.TOOLSENABLED_AUDIT_JSONL_PATH || <root>/actions.jsonl`, so any harness
  // or second install that set the override removed the conventional name from
  // the list -- and a 300 MB actions.jsonl fell through to the size-based
  // service-log class and was deleted.
  const root = fixture('env-override');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-elsewhere-'));
  try {
    const result = spawnSync(process.execPath, [TOOL, '--root', root, '--json', '--apply',
      '--policy', 'install', '--include-service-logs', '--min-age-days', '0', '--no-budget'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, TOOLSENABLED_AUDIT_JSONL_PATH: path.join(elsewhere, 'actions.jsonl') }
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl')),
      'a 20 MB actions.jsonl in the target logs directory must stay protected even when the '
      + 'environment points the live sink somewhere else');
    const report = JSON.parse(result.stdout);
    assert.equal(report.prune.some(row => row.file === 'actions.jsonl'), false);
  } finally { drop(root); drop(elsewhere); }
});

// ---------------------------------------------------------------------
// 3. The default run reports and deletes nothing
// ---------------------------------------------------------------------
check('a default run deletes nothing and still names what it would take', () => {
  const root = fixture('dry-run');
  try {
    const before = fs.readdirSync(root).length;
    const report = run(root, []);
    assert.equal(report.applied, false);
    assert.equal(report.removedFiles, 0, 'a default run must never delete anything');
    assert.ok(report.prunableBytes > 0, 'the fixture must have something worth reclaiming');
    assert.ok(report.prune.length > 0, 'the report must name the files, not just count them');
    assert.ok(report.prune.every(row => typeof row.file === 'string' && row.bytes >= 0),
      'each candidate must be named with its size, so a human can check the list before --apply');
    assert.equal(fs.readdirSync(root).length, before, 'a dry run must not change the directory');
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 4. audit-only: audit residue is prunable, operational logs are not
// ---------------------------------------------------------------------
check('audit-only prunes audit residue and leaves operational logs alone', () => {
  const root = fixture('audit-only');
  try {
    const report = run(root, ['--apply', '--policy', 'audit-only']);
    assert.equal(report.applied, true);
    assert.deepEqual(report.failures, []);

    for (const survivor of [...MUST_SURVIVE,
      'actions.jsonl.legacy-3333333333333333',      // newest of its family
      'actions.log.legacy-4444444444444444',        // younger than the floor
      'lane-consoles/lane-a.log', 'durable-worker.log', 'small-service.log'
    ]) {
      assert.ok(fs.existsSync(path.join(root, survivor)), `${survivor} must survive an audit-only pass`);
    }
    for (const gone of [
      'actions.jsonl.rotated-11-20-bbbbbbbbbbbb',
      'actions.jsonl.legacy-1111111111111111',
      'actions.jsonl.legacy-2222222222222222',
      'actions.jsonl.4242.11111111-2222-3333-4444-555555555555.tmp'
    ]) {
      assert.ok(!fs.existsSync(path.join(root, gone)), `${gone} should have been pruned`);
    }
    assert.equal(decision(report, 'rotation-segment-orphan').action, 'prune');
    assert.equal(decision(report, 'emergency-spool').action, 'protected');
    assert.equal(decision(report, 'live-sink').action, 'protected');
    assert.equal(report.ages['lane-console'], null);
    assert.equal(report.ages['service-log'], null);
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 5. install: the defaults a customer machine gets with nobody thinking
// ---------------------------------------------------------------------
check('install defaults take stale consoles and stale service logs by themselves', () => {
  const root = fixture('install-defaults');
  try {
    const report = run(root, ['--apply']);
    assert.equal(report.policy, 'install');
    assert.equal(report.ages['lane-console'], 7);
    assert.equal(report.ages['service-log'], 30);
    assert.equal(report.maxTotalMb, 256);
    assert.ok(!fs.existsSync(path.join(root, 'lane-consoles', 'lane-a.log')),
      'a 60-day-old lane console must not need a flag on a customer machine');
    assert.ok(!fs.existsSync(path.join(root, 'durable-worker.log')),
      'a 60-day-old 20 MB service log must not need a flag on a customer machine');
    assert.ok(fs.existsSync(path.join(root, 'small-service.log')),
      'a small log stays below the service-log size floor and is never an automatic candidate');
    for (const survivor of MUST_SURVIVE) {
      assert.ok(fs.existsSync(path.join(root, survivor)), `${survivor} must survive the install policy`);
    }
  } finally { drop(root); }
});

check('a fresh console and a fresh service log are inside the install floors', () => {
  const root = fixture('install-young');
  try {
    write(path.join(root, 'lane-consoles', 'lane-live.log'), 5 * MB, Date.now() - 2 * 86400000);
    write(path.join(root, 'busy-service.log'), 20 * MB, Date.now() - 20 * 86400000);
    run(root, ['--apply', '--no-budget']);
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'lane-live.log')),
      'a 2-day-old console is inside the 7-day floor and must not be raced');
    assert.ok(fs.existsSync(path.join(root, 'busy-service.log')),
      'a 20-day-old service log is inside the 30-day floor');
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 6. The rotation record: the three ways it can fail to tell us anything
// ---------------------------------------------------------------------
check('an unparseable rotation record protects EVERY segment', () => {
  const root = fixture('corrupt-rotation-record', { rotationRecord: 'corrupt' });
  try {
    const report = run(root, ['--apply', '--policy', 'install', '--min-age-days', '0', '--no-budget']);
    assert.equal(report.rotationRecordReadable, false);
    assert.match(report.rotationRecordReason, /not valid JSON/);
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl.rotated-1-10-aaaaaaaaaaaa')));
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl.rotated-11-20-bbbbbbbbbbbb')),
      'an unreadable rotation record must protect even a segment that looks orphaned');
    assert.equal(decision(report, 'rotation-segment-unknown').action, 'protected');
    assert.equal(decision(report, 'rotation-segment-orphan'), null);
  } finally { drop(root); }
});

check('an ABSENT rotation record with segments on disk protects EVERY segment', () => {
  // The dangerous case, and the one the first version got wrong: ENOENT was
  // read as "no segments are referenced", so a record that had been lost or
  // moved made every surviving segment an orphan and deleted it.
  const root = fixture('absent-rotation-record', { rotationRecord: 'absent' });
  try {
    const report = run(root, ['--apply', '--policy', 'install', '--min-age-days', '0', '--no-budget']);
    assert.equal(report.rotationRecordReadable, false);
    assert.match(report.rotationRecordReason, /ABSENT while 2 segment-shaped file\(s\) exist/);
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl.rotated-1-10-aaaaaaaaaaaa')));
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl.rotated-11-20-bbbbbbbbbbbb')));
    assert.equal(decision(report, 'rotation-segment-orphan'), null);
  } finally { drop(root); }
});

check('an absent rotation record with no segments on disk is not a false alarm', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-clean-'));
  try {
    write(path.join(root, 'actions.jsonl'), 2048, OLD_MS);
    write(path.join(root, 'actions.jsonl.legacy-1111111111111111'), 3 * MB, OLD_MS - 2000);
    write(path.join(root, 'actions.jsonl.legacy-2222222222222222'), 3 * MB, OLD_MS - 1000);
    const report = run(root, ['--apply']);
    assert.equal(report.rotationRecordReadable, true,
      'no record and no segments is a genuinely empty case, not an unknown one');
    assert.ok(!fs.existsSync(path.join(root, 'actions.jsonl.legacy-1111111111111111')),
      'a knowable state must still let ordinary residue be pruned');
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 7. Reparse points
// ---------------------------------------------------------------------
check('a junction inside the logs root is neither followed nor deleted', () => {
  // This repo has already had a recursive delete empty a shared node_modules
  // through a junction, and this machine carries ~250 worktrees with junctions.
  // The guard is dirent.isSymbolicLink(), which is only correct because Windows
  // reports a junction as a link dirent -- asserted here rather than assumed.
  const root = fixture('junction');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-outside-'));
  try {
    write(path.join(outside, 'precious.log'), 30 * MB, OLD_MS);
    const link = path.join(root, 'lane-consoles', 'linked');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    try { fs.symlinkSync(outside, link, 'junction'); }
    catch (error) { throw new Error(`could not create a junction to test against: ${error.message}`); }

    const dirent = fs.readdirSync(path.dirname(link), { withFileTypes: true })
      .find(entry => entry.name === 'linked');
    assert.equal(dirent.isSymbolicLink(), true,
      'the whole reparse-point guard rests on Windows reporting a junction as a link dirent');

    const report = run(root, ['--apply', '--policy', 'install', '--include-consoles',
      '--include-service-logs', '--min-age-days', '0', '--keep-legacy', '0', '--no-budget']);
    assert.ok(fs.existsSync(path.join(outside, 'precious.log')),
      'a file behind a junction must never be reached, let alone deleted');
    assert.equal(report.prune.some(row => row.file.includes('linked')), false,
      'nothing behind a junction may even appear as a candidate');
    assert.ok(fs.existsSync(link), 'the junction itself is not a file and must not be unlinked');
  } finally { drop(root); drop(outside); }
});

// ---------------------------------------------------------------------
// 8. --root is the one way to aim this somewhere else
// ---------------------------------------------------------------------
check('--root refuses a directory with no evidence of being a logs directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-not-logs-'));
  try {
    write(path.join(root, 'important.docx'), 40 * MB, OLD_MS);
    const result = spawnSync(process.execPath, [TOOL, '--root', root, '--apply',
      '--include-service-logs', '--min-age-days', '0'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 4, `expected a refusal, got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /no evidence this is a ToolsEnabled logs directory/);
    assert.ok(fs.existsSync(path.join(root, 'important.docx')), 'a refused root must be untouched');
  } finally { drop(root); }
});

check('--root accepts a directory named logs, and one holding audit artefacts', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'te-root-shapes-'));
  try {
    const named = path.join(base, 'logs');
    write(path.join(named, 'whatever.log'), 16, OLD_MS);
    assert.equal(tool.safeRootProblem(named), null, 'a directory named logs is evidence enough');
    const byArtefact = path.join(base, 'somewhere-else');
    write(path.join(byArtefact, 'actions.jsonl'), 16, OLD_MS);
    assert.equal(tool.safeRootProblem(byArtefact), null, 'actions.jsonl is evidence enough');
    assert.match(String(tool.safeRootProblem(path.parse(base).root)), /filesystem root/);
  } finally { drop(base); }
});

// ---------------------------------------------------------------------
// 9. The size budget: a ceiling an age table alone cannot promise
// ---------------------------------------------------------------------
check('the budget takes the OLDEST eligible file first and stops at the ceiling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-budget-'));
  try {
    write(path.join(root, 'actions.jsonl'), 4 * MB, Date.now());
    // All three are inside the 7-day console floor, so only the budget can
    // reach them, and only oldest-first.
    write(path.join(root, 'lane-consoles', 'oldest.log'), 20 * MB, Date.now() - 6 * 86400000);
    write(path.join(root, 'lane-consoles', 'middle.log'), 20 * MB, Date.now() - 5 * 86400000);
    write(path.join(root, 'lane-consoles', 'newest.log'), 20 * MB, Date.now() - 4 * 86400000);
    const report = run(root, ['--apply', '--max-total-mb', '45']);
    assert.equal(report.budgetMet, true);
    assert.equal(report.budgetTakenFiles, 1, 'the budget must stop as soon as it is met');
    assert.ok(!fs.existsSync(path.join(root, 'lane-consoles', 'oldest.log')));
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'middle.log')));
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'newest.log')));
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl')));
  } finally { drop(root); }
});

check('the budget never goes below the hard age floor, however far over it is', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-floor-'));
  try {
    write(path.join(root, 'actions.jsonl'), 1024, Date.now());
    write(path.join(root, 'lane-consoles', 'live.log'), 40 * MB, Date.now() - 3600000);
    write(path.join(root, 'lane-consoles', 'yesterday.log'), 40 * MB, Date.now() - 1.5 * 86400000);
    write(path.join(root, 'lane-consoles', 'three-days.log'), 40 * MB, Date.now() - 3 * 86400000);
    const report = run(root, ['--apply', '--max-total-mb', '1'], 3);
    assert.equal(report.budgetMet, false, 'an unreachable budget must be reported, not chased');
    assert.equal(report.budgetHardFloorDays, 2);
    assert.ok(!fs.existsSync(path.join(root, 'lane-consoles', 'three-days.log')));
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'yesterday.log')),
      'a 1.5-day-old console is inside the hard floor and disk pressure is not a reason to race a writer');
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'live.log')));
  } finally { drop(root); }
});

check('an unreachable budget still refuses to touch protected state, and exits 3', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-logs-retention-unreachable-'));
  try {
    write(path.join(root, 'actions.jsonl'), 300 * MB, OLD_MS);          // protected, over budget alone
    write(path.join(root, 'playwright', 'trace.zip'), 4096, OLD_MS);    // class 'other'
    const report = run(root, ['--apply', '--max-total-mb', '10'], 3);
    assert.equal(report.budgetMet, false);
    assert.ok(fs.existsSync(path.join(root, 'actions.jsonl')),
      'the ledger being the reason the budget cannot be met is not a licence to delete the ledger');
    assert.ok(fs.existsSync(path.join(root, 'playwright', 'trace.zip')),
      'an unclassified file is reported, never deleted under size pressure');
    assert.ok(report.protectedBytes >= 300 * MB);
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 10. Flag semantics that could quietly widen the blast radius
// ---------------------------------------------------------------------
check('--min-age-days lowers a floor but never enables a class', () => {
  const root = fixture('min-age-not-optin');
  try {
    run(root, ['--apply', '--policy', 'audit-only', '--min-age-days', '0', '--keep-legacy', '0']);
    assert.ok(fs.existsSync(path.join(root, 'lane-consoles', 'lane-a.log')),
      '--min-age-days 0 must not turn an excluded class into a candidate');
    assert.ok(fs.existsSync(path.join(root, 'durable-worker.log')));
    assert.ok(!fs.existsSync(path.join(root, 'actions.log.legacy-4444444444444444')),
      'with both legacy floors removed the newest archive of a family is finally eligible');
  } finally { drop(root); }
});

check('the opt-in flags are one class each', () => {
  const root = fixture('opt-in-classes');
  try {
    run(root, ['--apply', '--policy', 'audit-only', '--include-consoles']);
    assert.ok(!fs.existsSync(path.join(root, 'lane-consoles', 'lane-a.log')));
    assert.ok(fs.existsSync(path.join(root, 'durable-worker.log')),
      '--include-consoles must not also take service logs');
    const report = run(root, ['--apply', '--policy', 'audit-only', '--include-service-logs']);
    assert.ok(!fs.existsSync(path.join(root, 'durable-worker.log')));
    assert.ok(fs.existsSync(path.join(root, 'small-service.log')));
    assert.deepEqual(report.failures, []);
  } finally { drop(root); }
});

check('an unknown policy or flag is refused rather than approximated', () => {
  const root = fixture('bad-flags');
  try {
    const bad = spawnSync(process.execPath, [TOOL, '--root', root, '--policy', 'aggressive', '--apply'],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(bad.status, 4);
    assert.match(bad.stderr, /unknown --policy aggressive/);
    const unknown = spawnSync(process.execPath, [TOOL, '--root', root, '--delete-everything', '--apply'],
      { encoding: 'utf8', windowsHide: true });
    assert.equal(unknown.status, 4);
    assert.match(unknown.stderr, /unknown argument --delete-everything/,
      'the refusal must be the tool identifying the exact unknown flag, not merely any failed launch');
    assert.equal(fs.readdirSync(path.join(root, 'lane-consoles')).length, 1, 'a refused run deletes nothing');
  } finally { drop(root); }
});

// ---------------------------------------------------------------------
// 11. The wiring: a mechanism nothing runs is the defect being fixed
// ---------------------------------------------------------------------
check('the managed-process registry declares this tool, its state, and its stop switch', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const registry = require(path.join(repoRoot, 'src', 'lib', 'managed-processes.js'));
  const entry = registry.getProcess('logs-retention');
  assert.equal(entry.entryPoint, 'tools/audit-logs-retention.js');
  assert.equal(entry.registrar, 'tools/logs-retention-task.ps1');
  assert.ok(fs.existsSync(path.join(repoRoot, entry.registrar)), 'the declared registrar must exist');
  assert.equal(path.resolve(repoRoot, entry.stateFile), tool.STATE_FILE,
    'the registry state file and the file the tool writes must be the same path');
  assert.equal(path.resolve(repoRoot, entry.stopSentinel), tool.STOP_FILE,
    'the registry stop sentinel and the file the tool honours must be the same path');
  assert.ok(entry.declaredArgv.includes('--apply'),
    'a scheduled retention pass that never applies is the mechanism-wired-to-nothing defect again');
  assert.ok(entry.declaredArgv.includes('--heartbeat'),
    'without --heartbeat the functioning rung can never observe a run');
  assert.equal(entry.rungs.functioning.stateField, 'generatedAt');
});

process.stdout.write(`\naudit-logs-retention: ${passed} checks passed.\n`);
