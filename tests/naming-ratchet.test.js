'use strict';

// Tests for tools/check-naming.js -- and specifically for the thing it could not do
// until 2026-08-25: notice a RENAME.
//
// WHAT WAS WRONG
// --------------
// Every rule produced a NUMBER and the baseline pinned that number. The rule literally
// called `interface-name-renamed` therefore passed on a rename, because removing
// 'coordinator.old' and adding 'coordinator.new' in one change leaves the count where it was.
// Measured in this tree on 2026-08-25 against the committed baseline of the day:
// renaming the hash domain at src/lib/coordinator-audit-events.js:332 from
// 'coordinator.audit.capability-profile.v1' to 'coordinator.audit.capability-dossier.v1' -- which
// changes every capability-profile hash ever persisted -- held the count at 113 and the
// gate printed "naming ratchet OK", exit 0.
//
// The pinned floor was also 99 against a tree measuring 113, so DELETING a domain
// outright (113 -> 112) exited 0 as well, and the gate described the deletion as "new
// domains added".
//
// So this file pins BOTH directions, because the failure mode of a fix like this is an
// over-firing gate that someone deletes a week later, after which nothing is checked at
// all:
//   * a rename must FAIL, and must name the identifier that left AND the one that
//     arrived -- naming only one leaves the reader to guess whether it was a rename or a
//     deletion, which is the question the gate exists to answer;
//   * the tree as it stands must PASS.
//
// HOW IT IS TESTED. Exit codes are driven through the real tool as a child process,
// because an exit code is the entire product of a gate and is not observable from the
// inside. Set arithmetic is driven through the exported pure `rate()`, because the
// orientations that matter most (a domain deleted from the SOURCE while the baseline
// still lists it) cannot be produced without either editing tracked source or giving the
// tool a --root flag, and a gate should not grow a flag that exists only for its test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'tools', 'check-naming.js');
const gate = require('../tools/check-naming.js');
const { rate, EXIT_OK, EXIT_RATCHET, EXIT_UNTRUSTED } = gate;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-ratchet-spec-'));
let checks = 0;

function runGate(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function fixture(name, value) {
  const filePath = path.join(workspace, name);
  fs.writeFileSync(filePath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

/** A baseline object whose named sets are whatever the caller says. */
function baselineOf(names) {
  return {
    present: true,
    legacy: false,
    problems: [],
    names: Object.fromEntries(Object.entries(names).map(([id, list]) => [id, new Set(list)]))
  };
}

const CLEAN_MEASURED = {
  'source-basename-not-kebab': [],
  'test-dir-singular': [],
  'interface-name-renamed': ['coordinator.audit.capability-profile.v1', 'coordinator.feed', 'coordinator.status']
};
const CLEAN_NAMES = {
  'source-basename-not-kebab': [],
  'test-dir-singular': [],
  'interface-name-renamed': [...CLEAN_MEASURED['interface-name-renamed']]
};

// ---------------------------------------------------------------------------
// THE ARITHMETIC THE OLD GATE COULD NOT DO
// ---------------------------------------------------------------------------

{
  // THE HEADLINE. A rename: one identity out, one in, count unmoved.
  const measured = {
    ...CLEAN_MEASURED,
    'interface-name-renamed': ['coordinator.audit.capability-dossier.v1', 'coordinator.feed', 'coordinator.status']
  };
  // The premise of the whole fix, asserted rather than asserted-about: the counts are
  // EQUAL, so a count-pinned gate has nothing to compare and passes.
  assert.equal(
    measured['interface-name-renamed'].length,
    CLEAN_NAMES['interface-name-renamed'].length,
    'the fixture must be count-neutral, or it does not reproduce the defect'
  );

  const verdict = rate({ measured, baseline: baselineOf(CLEAN_NAMES) });
  assert.equal(verdict.code, EXIT_RATCHET, 'a rename of a persisted hash domain must fail');
  const text = verdict.lines.join('\n');
  assert.ok(
    text.includes("'coordinator.audit.capability-profile.v1'"),
    `the identifier that LEFT must be named:\n${text}`
  );
  assert.ok(
    text.includes("'coordinator.audit.capability-dossier.v1'"),
    `the identifier that ARRIVED must be named:\n${text}`
  );
  assert.ok(/RENAME/.test(text), `the report must say the shape is a rename:\n${text}`);
  assert.ok(
    verdict.regressions.some((line) => line.includes('coordinator.audit.capability-profile.v1')),
    'the departure, not the arrival, is the regression'
  );
  checks += 5;
}

{
  // Deletion with no replacement -- what the 14-name cushion used to swallow.
  const measured = { ...CLEAN_MEASURED, 'interface-name-renamed': ['coordinator.feed', 'coordinator.status'] };
  const verdict = rate({ measured, baseline: baselineOf(CLEAN_NAMES) });
  assert.equal(verdict.code, EXIT_RATCHET, 'deleting a persisted hash domain must fail');
  assert.ok(
    verdict.regressions.join('\n').includes('coordinator.audit.capability-profile.v1'),
    'the deleted identifier must be named'
  );
  checks += 2;
}

{
  // A new identity is not a defect, but it must be recorded or it is deletable for free
  // tomorrow. check-chain-runner blocks on the same shape ("lower the baseline").
  const measured = {
    ...CLEAN_MEASURED,
    'interface-name-renamed': [...CLEAN_MEASURED['interface-name-renamed'], 'coordinator.brand.new.v1']
  };
  const verdict = rate({ measured, baseline: baselineOf(CLEAN_NAMES) });
  assert.equal(verdict.code, EXIT_RATCHET, 'an unrecorded new identity must block until it is pinned');
  assert.equal(verdict.regressions.length, 0, 'a new identity is not a REGRESSION; it is an unrecorded improvement');
  assert.ok(verdict.repins.join('\n').includes('coordinator.brand.new.v1'), 'the new identity must be named');
  checks += 3;
}

{
  // The same count-blindness on a violations rule: one bad filename fixed, one added.
  const measured = { ...CLEAN_MEASURED, 'source-basename-not-kebab': ['src/lib/badName.js'] };
  const baseline = baselineOf({ ...CLEAN_NAMES, 'source-basename-not-kebab': ['src/lib/oldBad.js'] });
  const verdict = rate({ measured, baseline });
  assert.equal(verdict.code, EXIT_RATCHET, 'a new camelCase file must fail even when another was fixed');
  assert.ok(verdict.regressions.join('\n').includes('src/lib/badName.js'), 'the new violation must be named');
  assert.ok(verdict.repins.join('\n').includes('src/lib/oldBad.js'), 'the fixed violation must be named too');
  checks += 3;
}

{
  // Identical sets pass. Without this the suite would accept a gate that always fails.
  const verdict = rate({ measured: CLEAN_MEASURED, baseline: baselineOf(CLEAN_NAMES) });
  assert.equal(verdict.code, EXIT_OK, `an unchanged tree must pass:\n${verdict.lines.join('\n')}`);
  checks += 1;
}

// ---------------------------------------------------------------------------
// ABSENCE IS NOT CONSENT
// ---------------------------------------------------------------------------

{
  // A rule with no record at all must not read as "nothing to compare, therefore fine".
  const baseline = baselineOf({ 'source-basename-not-kebab': [], 'test-dir-singular': [] });
  const verdict = rate({ measured: CLEAN_MEASURED, baseline });
  assert.equal(verdict.code, EXIT_RATCHET, 'a rule missing from the baseline must block');
  assert.ok(verdict.regressions.join('\n').includes('interface-name-renamed'), 'the unrecorded rule must be named');
  checks += 2;
}

{
  // A baselined id matching no rule is immunity granted to nothing -- until someone adds
  // a rule back under that id, at which point it is immunity granted invisibly.
  const baseline = baselineOf({ ...CLEAN_NAMES, 'rule-that-was-deleted': ['whatever'] });
  const verdict = rate({ measured: CLEAN_MEASURED, baseline });
  assert.equal(verdict.code, EXIT_RATCHET, 'a stale baseline rule id must block');
  assert.ok(verdict.regressions.join('\n').includes('rule-that-was-deleted'), 'the stale id must be named');
  checks += 2;
}

{
  // A baseline that cannot be trusted rules on nothing, even over a spotless tree.
  const verdict = rate({
    measured: CLEAN_MEASURED,
    baseline: { present: false, legacy: false, names: {}, problems: ['broken'] }
  });
  assert.equal(verdict.code, EXIT_UNTRUSTED, 'an untrustworthy baseline must not pass a clean tree');
  checks += 1;
}

// ---------------------------------------------------------------------------
// THE REAL TOOL, REAL EXIT CODES
// ---------------------------------------------------------------------------

{
  // The tree AS IT STANDS, against its committed record. An over-firing gate gets
  // switched off, and then nothing is checked at all.
  const clean = runGate([]);
  assert.equal(clean.code, EXIT_OK, `the committed tree must pass its committed baseline:\n${clean.output}`);
  assert.ok(/naming ratchet OK/.test(clean.output), `expected a green verdict:\n${clean.output}`);
  checks += 2;
}

{
  // A missing record must REFUSE, and must not write itself from the run it would then
  // be judging. This is the defect removed from tests/capability-recall-eval.js the same
  // day, and the refusal the audit found sound here.
  const absent = path.join(workspace, 'not-created.json');
  const missing = runGate(['--baseline', absent]);
  assert.notEqual(missing.code, EXIT_OK, `a missing baseline must not pass:\n${missing.output}`);
  assert.ok(/REFUSING/.test(missing.output), `the refusal must say so:\n${missing.output}`);
  assert.equal(fs.existsSync(absent), false, 'a failing run must never seed its own baseline');
  checks += 3;
}

{
  // Seeding is the deliberate, separate act -- and the only thing that may write where
  // no record exists.
  const seeded = path.join(workspace, 'seeded.json');
  const result = runGate(['--baseline', seeded, '--seed-baseline']);
  assert.equal(result.code, EXIT_OK, `--seed-baseline must establish a record:\n${result.output}`);
  const written = JSON.parse(fs.readFileSync(seeded, 'utf8'));
  assert.ok(written.names, 'a seeded baseline records names');
  assert.equal(written.counts, undefined, 'the retired count format must not be written back');
  assert.ok(
    Array.isArray(written.names['interface-name-renamed']) && written.names['interface-name-renamed'].length > 0,
    'the identity list must be populated from the real tree'
  );
  checks += 4;

  // A freshly seeded record must rule its own tree clean.
  const rerun = runGate(['--baseline', seeded]);
  assert.equal(rerun.code, EXIT_OK, `a just-seeded baseline must pass:\n${rerun.output}`);
  checks += 1;

  // Seeding must never REPLACE a readable record; that is what --update-baseline is for,
  // and it is the difference between establishing a standard and overwriting one.
  const overwrite = runGate(['--baseline', seeded, '--seed-baseline']);
  assert.notEqual(overwrite.code, EXIT_OK, `--seed-baseline must refuse a readable record:\n${overwrite.output}`);
  checks += 1;

  // Now doctor that record into a rename: drop a real domain, insert one the tree does
  // not contain. The set arithmetic is identical to renaming the domain in source.
  const real = written.names['interface-name-renamed'][0];
  const invented = 'coordinator.invented.for.this.test.v1';
  const doctored = path.join(workspace, 'doctored.json');
  fs.writeFileSync(doctored, `${JSON.stringify({
    ...written,
    names: {
      ...written.names,
      'interface-name-renamed': [
        invented,
        ...written.names['interface-name-renamed'].filter((name) => name !== real)
      ]
    }
  }, null, 2)}\n`);

  const renamed = runGate(['--baseline', doctored]);
  assert.equal(renamed.code, EXIT_RATCHET, `a rename must fail through the real tool:\n${renamed.output}`);
  assert.ok(renamed.output.includes(invented), `the identifier that left must be named:\n${renamed.output}`);
  assert.ok(renamed.output.includes(real), `the identifier that arrived must be named:\n${renamed.output}`);
  assert.ok(/RENAME/.test(renamed.output), `the real tool must call the shape a rename:\n${renamed.output}`);
  checks += 4;

  // And the regression must not be launderable by re-pinning.
  const before = fs.readFileSync(doctored, 'utf8');
  const relaunder = runGate(['--baseline', doctored, '--update-baseline']);
  assert.notEqual(relaunder.code, EXIT_OK, `--update-baseline must refuse over a regression:\n${relaunder.output}`);
  assert.equal(fs.readFileSync(doctored, 'utf8'), before, 'a refused re-pin must not have written anything');
  checks += 2;
}

{
  // The retired format is recognised and named, not silently accepted as an empty record.
  const legacy = fixture('legacy.json', { comment: 'old', recordedAt: '2026-08-09', counts: { 'interface-name-renamed': 99 } });
  const result = runGate(['--baseline', legacy]);
  assert.equal(result.code, EXIT_UNTRUSTED, `a count-pinned baseline must refuse to rule:\n${result.output}`);
  assert.ok(/count-pinned/.test(result.output), `the message must name the format:\n${result.output}`);
  checks += 2;
}

{
  // An unreadable record is not a missing one: restore it from git, never re-seed over it.
  const broken = fixture('broken.json', '{ this is not json');
  const result = runGate(['--baseline', broken]);
  assert.equal(result.code, EXIT_UNTRUSTED, `an unparseable baseline must exit 2:\n${result.output}`);
  const reseed = runGate(['--baseline', broken, '--seed-baseline']);
  assert.notEqual(reseed.code, EXIT_OK, `--seed-baseline must refuse to overwrite a corrupted record:\n${reseed.output}`);
  assert.equal(fs.readFileSync(broken, 'utf8'), '{ this is not json', 'the corrupted record must be left for a human to restore');
  checks += 3;
}

{
  // A malformed entry is a refusal, not a wildcard: a reader must never see N protected
  // identities in the file and a gate that protects N-1.
  const sloppy = fixture('sloppy.json', {
    names: { 'source-basename-not-kebab': [], 'test-dir-singular': [], 'interface-name-renamed': ['coordinator.feed', ''] }
  });
  const result = runGate(['--baseline', sloppy]);
  assert.equal(result.code, EXIT_UNTRUSTED, `a baseline with an unusable entry must exit 2:\n${result.output}`);
  checks += 1;
}

{
  // "Check nothing regressed, then record" and "there is nothing to check against" must
  // not be asked at once, or a regression gets recorded as though it were reviewed.
  const result = runGate(['--update-baseline', '--seed-baseline']);
  assert.equal(result.code, EXIT_UNTRUSTED, `mutually exclusive flags must refuse:\n${result.output}`);
  checks += 1;
}

fs.rmSync(workspace, { recursive: true, force: true });

process.stdout.write(`naming-ratchet: ${checks} gate behaviours verified `
  + '(rename fails naming both halves, deletion fails, tree as it stands passes, '
  + 'unrecorded rule/stale id/legacy/corrupt/sloppy baselines all refuse, no self-seeding)\n');
