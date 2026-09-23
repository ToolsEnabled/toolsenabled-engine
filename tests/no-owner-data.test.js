// EXECUTABLE CHANGE
// Assertion-can-fail audit report (2026-08-26): strengthened refusal checks so
// exit 2 is accompanied by subject-owned diagnostic evidence. Mutation results
// and the final restored-source run are recorded beside the affected checks.
//
// MUTATIONS (each was made temporarily in tools/check-no-owner-data.mjs):
// - Missing explicit profile: changed "no identity profile at" to "identity
//   profile unavailable at". RED: "❌ OWNER-DATA GUARD: 1 failure(s) of 101
//   check(s)" / "an absent explicit profile must diagnose that the identity
//   profile is missing."
// - Empty identity: changed "declares no identity patterns" to "is invalid".
//   RED: "a profile with empty identity must explain that specific defect".
// - Template: changed "still holds a REPLACE-ME placeholder" to "is invalid".
//   RED: "a profile with unedited template must explain that specific defect".
// - Unknown kind: replaced its specific kind diagnosis with "has an invalid
//   kind". RED: "a profile with unknown kind must explain that specific defect".
// - Wrong schema: changed "schemaVersion must be 1" to "schema is invalid".
//   RED: "a profile with wrong schema must explain that specific defect".
// - Short pattern: changed "is shorter than 3 characters" to "is invalid".
//   RED: "a profile with one-character pattern must explain that specific defect".
// - Empty publishable set: changed "no tracked file ... is classified open" to
//   "publishable selection failed". RED: "an empty publishable set must be
//   diagnosed as an empty-set refusal."
// Every mutation retained exit 2; before these checks, its assertion stayed
// green. The source was restored byte-for-byte (SHA-256 before/after both
// 6c6bc0851105f36c45d4184886af727ca910c0b16eeec8d6d4e0bc0bc1218d10).
// Restored run: "🎉 Owner-data guard tests passed successfully! (101 checks)".
//
// CENSUS: (1) NOT-FOUND -- assertion loops use non-empty local literals, and
// rows(run) is reached only after per-kind checks require rows; (2) FOUND -- the
// seven exit-only refusal checks above are strengthened; (3) NOT-FOUND -- the
// cleanup catch only ignores cleanup errors and no optional chain exists;
// (4) NOT-FOUND -- no mocks; (5) NOT-FOUND -- no skips or platform guards;
// (6) NOT-FOUND -- expected values are independent literals, not product output.
// Preconditions not met: none.
'use strict';

// THE OWNER-DATA GUARD, PINNED.
//
// tools/check-no-owner-data.mjs answers "does the set of files this repository
// would actually publish carry the builder's identity". It exists because the
// 2026-08-13 publication-leak audit found that the guard everyone believed was
// doing that job was not tracked by git at all, had no identity profile on this
// machine, and scanned a BUILD DIRECTORY rather than a git file list -- so it
// could not have caught any of the nine leak classes the audit found even if it
// had been wired up.
//
// Two of those three failures are silent by nature, so they are what this file
// is mostly about:
//
//   - A GUARD WITH NO PROFILE MUST REFUSE, NOT PASS. Absence-as-emptiness is the
//     defect that made the original useless: no profile, so no patterns, so no
//     matches, so a clean report. testMissingProfileRefuses() and its variants
//     pin exit 2 -- deliberately a different code from a finding, so "not set
//     up" can never be read as "tree is clean".
//
//   - A LEAK REPORT MUST NOT QUOTE THE LEAK. testNoValueIsEverPrinted() runs the
//     guard over a tree seeded with known values and asserts that not one of
//     them appears anywhere in stdout or stderr. This report is written to be
//     pasted into terminals, issues and handoffs; if it carried the values, the
//     guard would be a distribution channel for the thing it exists to contain.
//
// ---------------------------------------------------------------------------
// WHY EVERY PLANTED VALUE IN THIS FILE IS ASSEMBLED FROM FRAGMENTS.
//
// A test for a leak detector has to contain the shapes the detector detects. If
// it contained them as plain literals, this file would itself be a finding the
// moment it were classified `open` -- and the honest fix would then be to weaken
// the guard, which is backwards. So every detectable string is built at runtime
// from pieces that match nothing on their own, and selfTestFragmentsHold()
// asserts that this file's own source contains none of the assembled values. If
// somebody later inlines one for readability, that assertion fails and says why.
//
// The identity itself is invented. No value below is the owner's, or anyone's.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'check-no-owner-data.mjs');

let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (condition) return;
  failures.push(message);
}

// ---------------------------------------------------------------------------
// THE INVENTED IDENTITY, IN PIECES.
// ---------------------------------------------------------------------------

const ACCOUNT = 'acme' + 'builder';
const ALIAS = 'acme' + '-primary-alias';
const SURNAME = 'Quenne' + 'ville';
const MACHINE = 'ACME' + 'BOX01';
const PROJECT_ID = 'acme' + '-live-project-4711';
const LAN_PREFIX = '198.' + '51.100.';
// The local part is split on the SAME boundary as SURNAME above, and it has to
// be: written with the surname whole in its lower-case form, this file carried
// the surname literally, which the guard matches case-insensitively.
// testGuardAndTestAreCleanUnderTheirOwnRules() caught it;
// selfTestFragmentsHold(), then case-sensitive, did not. Twice, in fact -- the
// second time in the comment that had just been written to explain the first.
const OWNER_MAIL = 'q.' + 'quenne' + 'ville' + '@acme-internal.example';

// Shape-rule fixtures. These match with no profile at all, which is the half of
// the problem a profile structurally cannot cover: the next contributor's
// address is in nobody's profile.
const CONSUMER_MAIL = 'release-bot@' + 'gm' + 'ail' + '.com';
const HOME_PATH = 'C:' + '\\Users\\' + ACCOUNT + '\\Desktop\\tree';
const MACHINE_SHAPE = 'DESK' + 'TOP-A1B2C3D';
const PROJECT_SHAPE = 'proj' + 'ect-4f2ab19c';
const SERVICE_ACCOUNT = 'runner-bot@' + 'acme-widgets-42' + '.iam.gservice' + 'account.com';

// Attribution the product is REQUIRED to carry. The second form deliberately
// wraps a shape match inside an attribution string, which is how
// testShapeRulesAreNeverExcused() proves the excusal cannot launder one.
const ATTRIBUTION = SURNAME + ' Publishing Trust';
const ATTRIBUTION_HIDING_A_PATH = SURNAME + ' of ' + HOME_PATH;

const PLANTED_VALUES = [
  ACCOUNT, ALIAS, SURNAME, MACHINE, PROJECT_ID, LAN_PREFIX, OWNER_MAIL,
  CONSUMER_MAIL, HOME_PATH, MACHINE_SHAPE, PROJECT_SHAPE, SERVICE_ACCOUNT
];

const PROFILE = {
  schemaVersion: 1,
  identity: [
    { kind: 'windows-account-name', value: ACCOUNT },
    { kind: 'owner-account-alias', value: ALIAS },
    { kind: 'owner-personal-name', value: SURNAME },
    { kind: 'machine-name', value: MACHINE },
    { kind: 'cloud-project-id', value: PROJECT_ID },
    { kind: 'private-network-prefix', value: LAN_PREFIX },
    { kind: 'owner-email-address', value: OWNER_MAIL }
  ],
  publishedAttribution: [ATTRIBUTION, ATTRIBUTION_HIDING_A_PATH]
};

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const temporaries = [];

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `te-owner-data-${label}-`));
  temporaries.push(directory);
  return directory;
}

function cleanUp() {
  for (const directory of temporaries) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* a leftover temp directory is not a test failure */
    }
  }
}

function runGit(repository, arguments_) {
  // core.hooksPath is set repository-wide in this checkout; a fresh init must not
  // inherit anything that would run somebody's hook against a fixture.
  const result = spawnSync('git', ['-C', repository, '-c', 'core.hooksPath=', ...arguments_], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Builds a git repository whose index carries `files`, plus a boundary manifest
// classifying `open` exactly as asked. The manifest is written OUTSIDE the open
// list so the fixture measures the planted files and nothing else.
function makeRepository(files, openPaths) {
  const repository = temporaryDirectory('repo');
  runGit(repository, ['init', '--quiet']);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(repository, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const manifest = path.join(repository, 'payload-boundary.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({ schemaVersion: 1, status: 'proposed', open: { paths: openPaths } }, null, 2)
  );
  runGit(repository, ['add', '--all']);
  return { repository, manifest };
}

function writeProfile(profile) {
  // OUTSIDE every repository, which is the arrangement the guard enforces.
  const directory = temporaryDirectory('profile');
  const file = path.join(directory, 'owner-data-profile.json');
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return file;
}

function runGuard({ repository, manifest, profile, environment = {} }) {
  // The per-user fallback location is redirected into a temp directory that does
  // not exist, so a machine where the operator happens to HAVE a real profile
  // cannot make a "missing profile" case pass by accident.
  const nowhere = path.join(os.tmpdir(), 'te-owner-data-no-such-config');
  const environmentBase = { ...process.env, LOCALAPPDATA: nowhere, APPDATA: nowhere, XDG_CONFIG_HOME: nowhere };
  delete environmentBase.TE_OWNER_DATA_PROFILE;

  const arguments_ = [TOOL, '--repo', repository, '--manifest', manifest];
  if (profile) arguments_.push('--profile', profile);

  const result = spawnSync(process.execPath, arguments_, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...environmentBase, ...environment }
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`
  };
}

function rows(run) {
  const found = [];
  for (const line of run.output.split('\n')) {
    const match = /^ {2}(\S+?)(?::(\d+))? {2}-- {2}([a-z-]+)(?: x(\d+))?\s*$/.exec(line);
    if (match) found.push({ file: match[1], line: match[2] ? Number(match[2]) : null, kind: match[3] });
  }
  return found;
}

function hasRow(run, file, kind, line) {
  return rows(run).some(
    (row) => row.file === file && row.kind === kind && (line === undefined || row.line === line)
  );
}

// ---------------------------------------------------------------------------
// THE DIRTY TREE. One kind per file, so a missed kind names itself.
// ---------------------------------------------------------------------------

const DIRTY_FILES = {
  // Profile kinds.
  'src/a-account.js': `// line one\nconst home = ${JSON.stringify(`C:\\projects\\${ACCOUNT}\\build`)};\n`,
  'src/b-alias.js': `const account = ${JSON.stringify(ALIAS)};\n`,
  'src/c-name.js': `// written by ${SURNAME}\n`,
  'src/d-machine.js': `const host = ${JSON.stringify(MACHINE)};\n`,
  'src/e-project.js': `const project = ${JSON.stringify(PROJECT_ID)};\n`,
  'src/f-subnet.js': `const peer = ${JSON.stringify(`${LAN_PREFIX}14`)};\n`,
  'src/g-mail.js': `const contact = ${JSON.stringify(OWNER_MAIL)};\n`,
  // Shape kinds. None of these is in the profile.
  'src/h-consumer-mail.js': `const notify = ${JSON.stringify(CONSUMER_MAIL)};\n`,
  // BOTH SPELLINGS OF A WINDOWS PATH, and the escaped one is the load-bearing
  // fixture. JSON.stringify gives `C:\\Users\\...`, which is what a Windows path
  // looks like in every .js and .json file in the tree; the .ps1 below gives the
  // raw single-backslash form. A separator rule that handles only the raw form
  // passes a plausible-looking test and misses most of the real finding.
  'src/i-home-path.js': `const checkout = ${JSON.stringify(HOME_PATH)};\n`,
  'src/m-home-path-raw.ps1': `$checkout = '${HOME_PATH}'\n`,
  'src/j-machine-shape.ps1': `# host was ${MACHINE_SHAPE}\n`,
  'src/k-project-shape.json': `{\n  "project": ${JSON.stringify(PROJECT_SHAPE)}\n}\n`,
  'src/l-service-account.js': `const identity = ${JSON.stringify(SERVICE_ACCOUNT)};\n`,
  // Excusal: attribution the product must carry, alone on the line.
  'NOTICE': `Copyright ${ATTRIBUTION}\n`,
  // Excusal must not launder a shape match wrapped inside an attribution string.
  'src/n-laundered.js': `// ${ATTRIBUTION_HIDING_A_PATH}\n`,
  // Withheld: carries owner data and is NOT classified open. Must not be read.
  'private/withheld.js': `const owner = ${JSON.stringify(OWNER_MAIL)}; // ${HOME_PATH}\n`
};

const DIRTY_OPEN = Object.keys(DIRTY_FILES).filter((file) => !file.startsWith('private/'));

const CLEAN_FILES = {
  // The audit's own prescribed remediations. A guard that flags the fix it asks
  // for gets argued with and then overridden, so these must pass.
  'README.md': [
    'Install under C:\\Users\\<you>\\Desktop\\checkout.',
    'Test fixtures use C:\\Users\\testuser\\AppData and C:\\Users\\...\\Local.',
    'Write to primary@example.com or secondary@example.invalid.',
    'The sample project is example-product.test.',
    ''
  ].join('\n'),
  'src/clean.js': 'const account = "<your-google-account>";\nconst project = "<your-gcp-project>";\n',
  'NOTICE': `Copyright ${ATTRIBUTION}\n`
};

// ---------------------------------------------------------------------------
// CASES
// ---------------------------------------------------------------------------

function selfTestFragmentsHold() {
  // CASE-INSENSITIVE, because the guard is. This check was case-sensitive first
  // and passed while the surname sat in this file in lower case inside an email
  // fragment -- a self-test weaker than the thing it is testing proves nothing.
  const ownSource = fs.readFileSync(__filename, 'utf8').toLowerCase();
  for (const value of PLANTED_VALUES.map((planted) => planted.toLowerCase())) {
    check(
      !ownSource.includes(value),
      `this test file contains the literal value ${JSON.stringify(value.slice(0, 6))}... assembled. ` +
        'Every detectable value here must be built from fragments, or this file becomes a finding in the ' +
        'set it is testing -- and the tempting fix for that is to weaken the guard.'
    );
  }
}

function testCleanTreePasses() {
  const { repository, manifest } = makeRepository(CLEAN_FILES, Object.keys(CLEAN_FILES));
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 0, `a clean tree must exit 0, got ${run.status}. Output:\n${run.output}`);
  check(/OWNER-DATA GUARD: clean/.test(run.stdout), 'a clean tree must say so in as many words');
  check(
    rows(run).length === 0,
    `a clean tree must produce no findings; got ${rows(run).length}:\n${run.output}`
  );
}

function testEveryKindIsDetected() {
  const { repository, manifest } = makeRepository(DIRTY_FILES, DIRTY_OPEN);
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });

  check(run.status === 1, `a tree carrying owner data must exit 1, got ${run.status}. Output:\n${run.output}`);

  const expected = [
    ['src/a-account.js', 'windows-account-name'],
    ['src/b-alias.js', 'owner-account-alias'],
    ['src/c-name.js', 'owner-personal-name'],
    ['src/d-machine.js', 'machine-name'],
    ['src/e-project.js', 'cloud-project-id'],
    ['src/f-subnet.js', 'private-network-prefix'],
    ['src/g-mail.js', 'owner-email-address'],
    ['src/h-consumer-mail.js', 'personal-email-shape'],
    ['src/i-home-path.js', 'home-directory-path'],
    ['src/m-home-path-raw.ps1', 'home-directory-path'],
    ['src/j-machine-shape.ps1', 'machine-name-shape'],
    ['src/k-project-shape.json', 'cloud-project-id-shape'],
    ['src/l-service-account.js', 'cloud-service-account']
  ];
  for (const [file, kind] of expected) {
    check(hasRow(run, file, kind), `${kind} was not reported for ${file}. Output:\n${run.output}`);
  }

  // The line number has to be the line the value is on, not the file.
  check(hasRow(run, 'src/a-account.js', 'windows-account-name', 2), 'line numbers must be the matched line');
  check(hasRow(run, 'src/k-project-shape.json', 'cloud-project-id-shape', 2), 'line numbers must survive JSON');

  // Every kind reported must be one the guard defines, with a description. A
  // free-text label is how a matched value would reach the report.
  for (const row of rows(run)) {
    check(
      /^[a-z][a-z-]+$/.test(row.kind),
      `kind ${JSON.stringify(row.kind)} is not a plain enumerated key; a report can only speak in fixed kinds`
    );
  }
}

function testUnreadableIsAFinding() {
  const { repository, manifest } = makeRepository(
    { 'src/gone.js': 'const clean = 1;\n', 'src/kept.js': 'const clean = 2;\n' },
    ['src/gone.js', 'src/kept.js']
  );
  // Tracked in the index, absent from the working tree: exactly what the
  // publisher would try to copy and what no reviewer has read.
  fs.rmSync(path.join(repository, 'src', 'gone.js'));

  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 1, `an unreadable publishable file must exit 1, got ${run.status}. Output:\n${run.output}`);
  check(hasRow(run, 'src/gone.js', 'unreadable'), `unreadable must be a finding, not a skip. Output:\n${run.output}`);
  check(!hasRow(run, 'src/kept.js', 'unreadable'), 'a readable file must not be reported unreadable');
}

function testWithheldFilesAreNotScanned() {
  // The whole point of scanning the publishable set rather than the tree: owner
  // data in a withheld file is not a publication leak, and reporting it would
  // train the reader to ignore this guard.
  const { repository, manifest } = makeRepository(
    { 'private/withheld.js': `const owner = ${JSON.stringify(OWNER_MAIL)};\n`, 'src/clean.js': 'const x = 1;\n' },
    ['src/clean.js']
  );
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 0, `owner data in a withheld file must not fail the guard, got ${run.status}. Output:\n${run.output}`);
  check(!/withheld\.js/.test(run.output), 'a withheld file must not even be named');
}

function testAttributionIsExcusedAndCounted() {
  const { repository, manifest } = makeRepository(
    { NOTICE: `Copyright ${ATTRIBUTION}\n` },
    ['NOTICE']
  );
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(
    run.status === 0,
    `the published attribution must not fail the guard -- MIT requires it in NOTICE. Got ${run.status}:\n${run.output}`
  );
  check(
    /Excused as published attribution: 1\b/.test(run.stdout),
    `excusals must be counted and printed, not silently dropped. Output:\n${run.stdout}`
  );
}

function testShapeRulesAreNeverExcused() {
  // The attribution string here CONTAINS a home-directory path. If shape rules
  // were excusable, a leak could be laundered by putting the author's name in
  // front of it.
  const { repository, manifest } = makeRepository(
    { 'src/n-laundered.js': `// ${ATTRIBUTION_HIDING_A_PATH}\n` },
    ['src/n-laundered.js']
  );
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 1, `a shape match inside an attribution string must still fail, got ${run.status}`);
  check(
    hasRow(run, 'src/n-laundered.js', 'home-directory-path'),
    `home-directory-path must survive an attribution excusal. Output:\n${run.output}`
  );
  check(
    !hasRow(run, 'src/n-laundered.js', 'owner-personal-name'),
    'a profile kind wholly inside the attribution string is excused, which is the whole point of the excusal'
  );
}

function testNoValueIsEverPrinted() {
  const { repository, manifest } = makeRepository(DIRTY_FILES, DIRTY_OPEN);
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  const haystack = run.output.toLowerCase();
  for (const value of PLANTED_VALUES) {
    check(
      !haystack.includes(value.toLowerCase()),
      `the guard printed a matched value (${JSON.stringify(value.slice(0, 4))}...). This report is pasted ` +
        'into terminals and issues; a leak report that quotes the leak is a second copy of the leak.'
    );
  }
  // Nor may it print the file paths of the profile's own values, or an excerpt
  // of any matched line: both are the same disclosure by another route.
  check(!/excerpt/i.test(run.output), 'the guard must not print excerpts');
  check(!/offset=/.test(run.output), 'the guard must not print byte offsets into a matched line');
}

function testMissingProfileRefuses() {
  const { repository, manifest } = makeRepository(DIRTY_FILES, DIRTY_OPEN);

  // The load-bearing case: a DIRTY tree with no profile. It must not exit 0, and
  // it must not exit 1 either -- "not set up" and "tree is dirty" are different
  // problems with different fixes.
  const noProfile = runGuard({ repository, manifest, profile: null });
  check(
    noProfile.status === 2,
    `a missing profile must REFUSE with exit 2, got ${noProfile.status}. Output:\n${noProfile.output}`
  );
  check(!/GUARD: clean/.test(noProfile.output), 'a refusal must never read as a clean verdict');
  check(
    /--profile/.test(noProfile.output) && /TE_OWNER_DATA_PROFILE/.test(noProfile.output),
    'the refusal must name every way to supply a profile, or it gets routed around'
  );

  const pointedAtNothing = runGuard({
    repository,
    manifest,
    profile: path.join(os.tmpdir(), 'te-owner-data-absent', 'profile.json')
  });
  check(pointedAtNothing.status === 2, 'an explicitly named but absent profile must refuse');
  check(
    /no identity profile at/.test(pointedAtNothing.stderr),
    `an absent explicit profile must diagnose that the identity profile is missing. Output:\n${pointedAtNothing.output}`
  );

  for (const [label, profile, diagnostic] of [
    ['empty identity', { schemaVersion: 1, identity: [] }, /declares no identity patterns/],
    ['unedited template', { schemaVersion: 1, identity: [{ kind: 'windows-account-name', value: 'REPLACE-ME-windows-account' }] }, /REPLACE-ME placeholder/],
    ['unknown kind', { schemaVersion: 1, identity: [{ kind: 'favourite-colour', value: 'ultramarine' }] }, /kind "favourite-colour", which is not one of/],
    ['wrong schema', { schemaVersion: 99, identity: [{ kind: 'machine-name', value: MACHINE }] }, /schemaVersion must be 1/],
    ['one-character pattern', { schemaVersion: 1, identity: [{ kind: 'machine-name', value: 'a' }] }, /shorter than 3 characters/]
  ]) {
    const run = runGuard({ repository, manifest, profile: writeProfile(profile) });
    check(run.status === 2, `a profile with ${label} must refuse with exit 2, got ${run.status}:\n${run.output}`);
    check(
      diagnostic.test(run.stderr),
      `a profile with ${label} must explain that specific defect, rather than merely exit non-zero. Output:\n${run.output}`
    );
    check(!/GUARD: clean/.test(run.output), `a profile with ${label} must not report clean`);
  }

  // A profile INSIDE the work tree is refused rather than warned about: every
  // value in it is a string the guard exists to keep out of a published tree.
  const inside = path.join(repository, 'owner-data-profile.json');
  fs.writeFileSync(inside, JSON.stringify(PROFILE, null, 2));
  const insideRun = runGuard({ repository, manifest, profile: inside });
  check(
    insideRun.status === 2,
    `a profile inside the repository must refuse, got ${insideRun.status}:\n${insideRun.output}`
  );
  check(/INSIDE the repository/.test(insideRun.output), 'the refusal must say why a repository path is refused');
}

function testEnvironmentVariableIsAccepted() {
  const { repository, manifest } = makeRepository(CLEAN_FILES, Object.keys(CLEAN_FILES));
  const run = runGuard({
    repository,
    manifest,
    profile: null,
    environment: { TE_OWNER_DATA_PROFILE: writeProfile(PROFILE) }
  });
  check(run.status === 0, `TE_OWNER_DATA_PROFILE must be honoured, got ${run.status}:\n${run.output}`);
  check(/via TE_OWNER_DATA_PROFILE/.test(run.stdout), 'the guard must report which source supplied the profile');
}

function testEmptyPublishableSetRefuses() {
  // A verdict over an empty set is not a verdict. This is the same
  // absence-as-emptiness failure as the missing profile, one level up.
  const { repository, manifest } = makeRepository({ 'src/clean.js': 'const x = 1;\n' }, ['does/not/exist.js']);
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 2, `an empty publishable set must refuse, got ${run.status}:\n${run.output}`);
  check(
    /no tracked file .* is classified "open"/.test(run.stderr) && /empty set is not a clean verdict/.test(run.stderr),
    `an empty publishable set must be diagnosed as an empty-set refusal. Output:\n${run.output}`
  );
}

function testMalformedOpenRulesRefuse() {
  // A string used to fall through Object.keys(), turning "src/clean.js" into
  // numeric character indexes. A tracked file named "0" then matched that
  // accidental namespace and received a confident clean verdict even though
  // the manifest had not supplied a usable path list.
  const { repository, manifest } = makeRepository({ '0': 'const x = 1;\n' }, ['placeholder']);
  fs.writeFileSync(
    manifest,
    JSON.stringify({ schemaVersion: 1, open: { paths: 'src/clean.js' } }, null, 2)
  );
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(run.status === 2, `malformed open.paths must refuse, got ${run.status}:\n${run.output}`);
  check(!/GUARD: clean/.test(run.output), 'malformed open rules must never produce a clean verdict');
}

function testGuardAndTestAreCleanUnderTheirOwnRules() {
  // BOTH OF THESE FILES ARE PUBLISHABLE SOURCE, and both are full of the shapes
  // the guard detects -- one in its comments, the other in its fixtures. If
  // either failed its own rules the guard would be unsatisfiable, and an
  // unsatisfiable rule does not get fixed, it gets overridden. This is the pin
  // that keeps a later edit from writing an illustrative real-looking path into
  // a comment.
  const files = {
    'tools/check-no-owner-data.mjs': fs.readFileSync(TOOL, 'utf8'),
    'tests/no-owner-data.test.js': fs.readFileSync(__filename, 'utf8')
  };
  const { repository, manifest } = makeRepository(files, Object.keys(files));
  const run = runGuard({ repository, manifest, profile: writeProfile(PROFILE) });
  check(
    run.status === 0,
    `the guard and its own test must be clean under the guard's own rules, got ${run.status}:\n${run.output}`
  );
}

function testDeterministic() {
  const { repository, manifest } = makeRepository(DIRTY_FILES, DIRTY_OPEN);
  const profile = writeProfile(PROFILE);
  const first = runGuard({ repository, manifest, profile });
  const second = runGuard({ repository, manifest, profile });
  check(first.status === second.status, 'two runs over the same tree must agree on the exit code');
  check(
    first.output === second.output,
    'two runs over the same tree must produce byte-identical output, or the guard cannot be diffed between commits'
  );
}

// ---------------------------------------------------------------------------

console.log('Owner-data guard tests');

try {
  selfTestFragmentsHold();
  testCleanTreePasses();
  testEveryKindIsDetected();
  testUnreadableIsAFinding();
  testWithheldFilesAreNotScanned();
  testAttributionIsExcusedAndCounted();
  testShapeRulesAreNeverExcused();
  testNoValueIsEverPrinted();
  testMissingProfileRefuses();
  testEnvironmentVariableIsAccepted();
  testEmptyPublishableSetRefuses();
  testMalformedOpenRulesRefuse();
  testGuardAndTestAreCleanUnderTheirOwnRules();
  testDeterministic();
} finally {
  cleanUp();
}

if (failures.length) {
  console.error(`\n❌ OWNER-DATA GUARD: ${failures.length} failure(s) of ${checks} check(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nThis gate fails rather than warns. The two failures it is mostly about are silent by\n' +
      'nature: a guard with no profile that reports clean, and a leak report that quotes the leak.\n'
  );
  process.exit(1);
}

assert.ok(checks > 0, 'the suite must actually assert something');
console.log(`🎉 Owner-data guard tests passed successfully! (${checks} checks)`);
