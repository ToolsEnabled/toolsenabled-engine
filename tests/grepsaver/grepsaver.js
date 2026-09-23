#!/usr/bin/env node
// EXECUTABLE CHANGE
// Strengthened: "exit 1 while not all FRESH". Mutation: suppressed the checker's
// per-system status output in tools/grepsaver-check.js; before this change the
// exit-code-only assertion remained green despite losing the subject's evidence.
// With the assertion below strengthened, the mutation produced:
//   FAIL exit 1 while not all FRESH
//   1 FAILURE(S)
// The product file was then restored byte-for-byte. The restored run produced:
//   ok   exit 1 while not all FRESH
//   all grepsaver tests passed
// Census: empty loop/forEach assertions NOT-FOUND; swallowed try/catch or
// optional-chain failures NOT-FOUND; subject-under-test mocks NOT-FOUND;
// whole-file skip/platform guards NOT-FOUND; expected values computed by the
// same subject code NOT-FOUND. No preconditions were unmet.
// GREPSAVER checker tests — isolated via TOOLSENABLED_GREPSAVER_CONTEXT (a temp
// context dir + temp fake target systems). Standalone: `node tests/grepsaver.js`.
// npm-test-chain wiring is deferred (package.json under concurrent edit when
// this shipped); the file follows the disposable-paths house pattern.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const LIB = require('../../tools/grepsaver-lib.js');
const { gitIdentity } = require('../../tools/grepsaver-extract.js');

const CHECKER = path.join(__dirname, '..', '..', 'tools', 'grepsaver-check.js');
let failures = 0;
const assert = (cond, name) => {
  if (cond) process.stdout.write(`ok   ${name}\n`);
  else { failures++; process.stdout.write(`FAIL ${name}\n`); }
};

function runChecker(contextDir, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [CHECKER, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, TOOLSENABLED_GREPSAVER_CONTEXT: contextDir },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function makeCard(dir, id, target, extraFm = '', body = 'Body.') {
  const raw = [
    '---',
    `system: ${id}`,
    `source_path: ${target}`,
    'fingerprint: manifest-hash:sha256:placeholder',
    'fingerprint_type: manifest',
    'manifest:',
    '  - a.txt',
    '  - b.txt',
    'generated: 2026-07-23',
    'reviewed_on: PENDING',
    'generator: test',
    extraFm,
    '---',
    `# ${id}`,
    '',
    '<!-- judgment -->',
    '## Identity',
    `Test fixture. ${body}`,
    '<!-- /judgment -->',
    '',
    '<!-- mechanical -->',
    '## Entry points',
    'fixture entry.',
    '## Run / build / test',
    'npm test <!-- provenance: hand-verified -->',
    '## Ports / URLs / services',
    'none.',
    '## Key file map',
    'a.txt - fixture.',
    '## Deeper docs',
    'README.md.',
    '<!-- /mechanical -->',
    '',
    '<!-- judgment -->',
    '## Invariants and gotchas',
    'fixture only.',
    '<!-- /judgment -->',
    '',
    '<!-- judgment -->',
    '## Do not touch',
    'None.',
    '<!-- /judgment -->',
    '',
    '<!-- judgment -->',
    '## Confidence',
    'High - fixture.',
    '<!-- /judgment -->',
    '',
    '',
  ].join('\n');
  const facts = {
    schemaVersion: 1,
    extractor: 'tools/grepsaver-extract.js',
    source_path: target,
    git: { isGit: false, head: null, dirty: false },
    servers: [], docs: [], package_scripts: [], readme_commands: [],
    top_level: [{ name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' }],
  };
  fs.writeFileSync(path.join(dir, `${id}.md`), LIB.replaceDerivedBlock(raw, facts));
}

function setup(ids = ['sys1']) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-test-'));
  const contextDir = path.join(base, 'context');
  fs.mkdirSync(contextDir);
  const targets = {};
  const systems = [];
  const rows = [];
  for (const id of ids) {
    const target = path.join(base, `target-${id}`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(target, 'b.txt'), 'beta');
    targets[id] = target;
    makeCard(contextDir, id, target);
    systems.push({ id, name: id, path: target.replace(/\\/g, '/'), card: `context/${id}.md`, ports: [], fingerprint: { type: 'manifest', value: null }, status: 'pending-review' });
    rows.push(`| ${id} | ${target} | — | PENDING-REVIEW 2026-07-23 |`);
  }
  fs.writeFileSync(path.join(contextDir, 'SYSTEMS.md'), ['# System index', '', '| system | path | ports | status |', '|---|---|---|---|', ...rows, ''].join('\n'));
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify({ generated: '2026-07-23', systems }, null, 2));
  return { base, contextDir, targets };
}

const readState = (d) => JSON.parse(fs.readFileSync(path.join(d, 'systems.json'), 'utf8'));
const card = (d, id = 'sys1') => fs.readFileSync(path.join(d, `${id}.md`), 'utf8');
const index = (d) => fs.readFileSync(path.join(d, 'SYSTEMS.md'), 'utf8');

// A checkout, drive root, or administrator-owned directory above a system is
// not that system's repository.  Use deliberately invalid parent metadata so
// this proves the extractor does not invoke Git against the parent: the old
// implementation threw here before it could return its `isGit: false` answer.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-parent-git-'));
  const target = path.join(base, 'ordinary-system');
  fs.mkdirSync(path.join(base, '.git'));
  fs.mkdirSync(target);
  try {
    const identity = gitIdentity(target);
    assert(identity.isGit === false, 'an unrelated parent repository does not make the target a repository');
    assert(identity.note === `inside a parent git repo at ${base}`, 'parent-repository note names the discovered parent without invoking Git');
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  }
}

// The stopped-distro guard must query only the running list.  Patch the child
// process module before loading the library in a disposable Node process, so a
// fake down state fails if fingerprintWsl ever attempts `wsl -d`.
{
  const libPath = path.join(__dirname, '..', '..', 'tools', 'grepsaver-lib.js');
  const script = `
    const cp = require('node:child_process');
    const calls = [];
    cp.execFileSync = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === '--list') return 'OtherDistro\\n';
      throw new Error('unexpected WSL invocation');
    };
    const lib = require(${JSON.stringify(libPath)});
    let error;
    try { lib.fingerprintWsl('OpenClawGateway', ['/safe/manifest'], '/safe'); }
    catch (e) { error = e; }
    process.stdout.write(JSON.stringify({ code: error && error.code, calls }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
  assert(result.code === 'WSL_NOT_RUNNING', 'stopped WSL distro produces WSL_NOT_RUNNING');
  assert(result.calls.length === 1 && result.calls[0][1] === '--list' && !result.calls.flat().includes('-d'), 'stopped WSL guard never invokes wsl -d');
}

// === lifecycle basics ======================================================
{
  const { base, contextDir, targets } = setup();

  let r = runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'pending-review', 'plain check never promotes unreviewed content');
  assert(readState(contextDir).systems[0].fingerprint.value.startsWith('manifest-hash:sha256:'), 'manifest fingerprint computed');
  assert(card(contextDir).includes('> STATUS: PENDING-REVIEW'), 'pending-review banner injected');
  assert(index(contextDir).includes('PENDING-REVIEW'), 'index status rewritten');
  assert(r.code === 1 && /^sys1: pending-review$/m.test(r.out), 'exit 1 while not all FRESH');

  const fp1 = readState(contextDir).systems[0].fingerprint.value;
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].fingerprint.value === fp1, 'fingerprint deterministic');
  assert(!card(contextDir).includes('> STATUS: PENDING-REVIEW\n\n> STATUS:'), 'banner does not accumulate across runs');

  // capture exact stat state before approval for the revert test later
  const aPath = path.join(targets.sys1, 'a.txt');
  const preStat = fs.statSync(aPath);

  r = runChecker(contextDir, ['--approve', 'sys1']);
  let st = readState(contextDir);
  assert(st.systems[0].status === 'fresh' && st.systems[0].reviewed_fingerprint === st.systems[0].fingerprint.value, '--approve promotes and records fingerprint');
  assert(typeof st.systems[0].reviewed_card_hash === 'string' && st.systems[0].reviewed_card_hash.length === 64, '--approve records card-body hash');
  assert(typeof st.systems[0].reviewed_mechanical_hash === 'string' && st.systems[0].reviewed_mechanical_hash.length === 64, '--approve records mechanical hash');
  assert(typeof st.systems[0].reviewed_judgment_hash === 'string' && st.systems[0].reviewed_judgment_hash.length === 64, '--approve records judgment hash');
  assert(st.systems[0].mechanical_snapshot && st.systems[0].mechanical_snapshot.provenance === 'extracted, unexecuted', '--approve records a value-safe mechanical snapshot');
  assert(!card(contextDir).includes('> STATUS:'), 'banner removed on FRESH');
  assert(r.code === 0, 'exit 0 when all FRESH');

  // trust model: editing the card body after approval demotes to PENDING-REVIEW
  fs.appendFileSync(path.join(contextDir, 'sys1.md'), 'Sneaky new claim.\n');
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'pending-review', 'card body edited after review => pending-review');
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), card(contextDir).replace(/> STATUS:[^\n]*\n\n/, '').replace('Sneaky new claim.\n', ''));
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'fresh', 'restoring exact card bytes restores FRESH');

  // drift: source change flips STALE with a stable stale_since date
  fs.writeFileSync(aPath, 'alpha-changed');
  r = runChecker(contextDir);
  st = readState(contextDir);
  assert(st.systems[0].status === 'stale' && st.systems[0].stale_since, 'source drift => stale with stale_since');
  assert(card(contextDir).includes(`> STATUS: STALE since ${st.systems[0].stale_since}`), 'stale banner carries since-date');
  assert(index(contextDir).includes(`STALE since ${st.systems[0].stale_since}`), 'index carries STALE since <date>');

  // §5 revert-restore: exact content + exact mtime restored => FRESH, asserted unconditionally
  fs.writeFileSync(aPath, 'alpha');
  fs.utimesSync(aPath, preStat.atime, preStat.mtime);
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'fresh', 'revert-restore: exact reviewed state => FRESH (no re-review needed)');

  // negative: same content, different mtime second => stale (mtime is part of the recipe)
  fs.utimesSync(aPath, preStat.atime, new Date(preStat.mtime.getTime() + 5000));
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'stale', 'same content different mtime => stale by design');

  fs.rmSync(base, { recursive: true, force: true });
}

// === Q23 mechanical refresh and closed semantic triggers ===================
{
  const { base, contextDir, targets } = setup();
  runChecker(contextDir, ['--approve', 'sys1']);
  const before = readState(contextDir).systems[0].reviewed_fingerprint;

  // A manifest-only mtime/content drift with unchanged extracted commands,
  // ports, and top-level directories is safe for the mechanical writer.
  fs.writeFileSync(path.join(targets.sys1, 'a.txt'), 'alpha-mechanical-change');
  let r = runChecker(contextDir, ['--auto-refresh']);
  let st = readState(contextDir);
  const log = fs.readFileSync(path.join(contextDir, 'check-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(st.systems[0].status === 'fresh' && st.systems[0].reviewed_fingerprint !== before, 'mechanical-only drift auto-refreshes and stays fresh');
  assert(log[log.length - 1].systems.sys1.autoRefresh && log[log.length - 1].systems.sys1.autoRefresh.applied, 'auto-refresh records a bounded diff in check-log');
  assert(r.code === 0, 'mechanical auto-refresh exits clean');

  // Cards that would exceed the hard byte cap may keep the compact snapshot in
  // systems.json instead of a fenced card block; the same no-agent refresh
  // path must still work and update the snapshot.
  const snapshotOnly = readState(contextDir).systems[0].mechanical_snapshot;
  const withoutDerived = card(contextDir).replace(/<!-- grepsaver:derived -->[\s\S]*?<!-- \/grepsaver:derived -->\n?/g, '');
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), withoutDerived);
  const snapshotState = readState(contextDir);
  const snapshotHashes = LIB.cardZoneHashes(withoutDerived);
  snapshotState.systems[0].reviewed_card_hash = LIB.cardTrustHash(withoutDerived);
  snapshotState.systems[0].reviewed_mechanical_hash = snapshotHashes.mechanicalHash;
  snapshotState.systems[0].reviewed_judgment_hash = snapshotHashes.judgmentHash;
  snapshotState.systems[0].mechanical_snapshot = snapshotOnly;
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(snapshotState, null, 2));
  fs.writeFileSync(path.join(targets.sys1, 'a.txt'), 'alpha-mechanical-change-2');
  r = runChecker(contextDir, ['--auto-refresh']);
  st = readState(contextDir);
  assert(st.systems[0].status === 'fresh' && !card(contextDir).includes('grepsaver:derived'), 'snapshot-only card refreshes without exceeding its cap');

  // A new top-level directory is a closed semantic trigger, even though it is
  // not present in the declared manifest fingerprint.
  fs.mkdirSync(path.join(targets.sys1, 'new-dir'));
  r = runChecker(contextDir, ['--auto-refresh']);
  st = readState(contextDir);
  assert(st.systems[0].status === 'pending-review' && /top-level directories changed/.test(r.out), 'top-level directory trigger demotes to pending-review');
  fs.rmSync(path.join(targets.sys1, 'new-dir'), { recursive: true, force: true });

  // Once the closed trigger is reversed, the same source drift is again a
  // mechanical-only refresh. The writer must not touch the judgment prose.
  r = runChecker(contextDir, ['--auto-refresh']);
  assert(readState(contextDir).systems[0].status === 'fresh', 'reversing a semantic trigger restores mechanical refresh eligibility');
  const stableCard = card(contextDir);
  const falseStale = readState(contextDir);
  falseStale.systems[0].reviewed_fingerprint = 'manifest-hash:sha256:' + '0'.repeat(64);
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(falseStale, null, 2));
  r = runChecker(contextDir, ['--auto-refresh']);
  st = readState(contextDir);
  const falseStaleLog = fs.readFileSync(path.join(contextDir, 'check-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert(st.systems[0].status === 'fresh' && card(contextDir) === stableCard, 'false stale with unchanged source is byte-identical');
  assert(falseStaleLog.systems.sys1.autoRefresh && falseStaleLog.systems.sys1.autoRefresh.diff.changed.length === 0, 'false stale records no spurious derived diff');

  // A judgment edit is never eligible for unattended promotion, even when a
  // manifest file also drifts and would otherwise qualify for auto-refresh.
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), card(contextDir).replace('fixture only.', 'fixture only. judgment edit.'));
  fs.writeFileSync(path.join(targets.sys1, 'a.txt'), 'alpha-judgment-edit');
  r = runChecker(contextDir, ['--auto-refresh']);
  st = readState(contextDir);
  assert(st.systems[0].status === 'pending-review' && card(contextDir).includes('judgment edit.'), 'judgment-zone edit demotes and is never auto-written');

  // The unattended snapshot contains only digests, so secret-shaped command
  // text from an untrusted extractor result cannot reach a card.
  const secretCard = LIB.replaceDerivedBlock(card(contextDir), {
    package_scripts: [{ file: 'package.json', scripts: { start: 'node -e "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' } }],
    servers: [], readme_commands: [], top_level: [],
  });
  assert(!secretCard.includes('ghp_'), 'secret-shaped extractor content is never written to derived block');

  // The closed semantic list is centralized in semanticDiff; exercise each
  // category directly so a future refactor cannot silently broaden/narrow it.
  assert(LIB.semanticDiff({ semantic: { ports: [{ name: 'x', port: 1 }] } }, { semantic: { ports: [{ name: 'x', port: 2 }] } }).includes('ports/services changed'), 'port changes are semantic triggers');
  assert(LIB.semanticDiff({ semantic: { commandDigest: 'a' } }, { semantic: { commandDigest: 'b' } }).includes('run/build/test commands changed'), 'lifecycle command changes are semantic triggers');
  assert(LIB.semanticDiff({ semantic: { topLevelDirDigest: 'a' } }, { semantic: { topLevelDirDigest: 'b' } }).includes('top-level directories changed'), 'top-level directory changes are semantic triggers');

  // A missing marker pair is refused rather than guessed at.
  const marked = card(contextDir);
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), marked.replace(/<!-- mechanical -->\n|<!-- \/mechanical -->\n/g, ''));
  r = runChecker(contextDir);
  st = readState(contextDir);
  assert(r.code === 2 && st.systems[0].status === 'unknown' && /zone provenance invalid/.test(r.out), 'card without markers is refused');

  fs.rmSync(base, { recursive: true, force: true });
}

// === approve guards ========================================================
{
  const { base, contextDir, targets } = setup();

  let r = runChecker(contextDir, ['--approve', 'no-such-id']);
  assert(r.code === 2 && /no such system/.test(r.out), '--approve unknown id is a hard error');

  // approve refused while a manifest entry is missing
  fs.rmSync(path.join(targets.sys1, 'b.txt'));
  r = runChecker(contextDir, ['--approve', 'sys1']);
  assert(r.code === 2 && /manifest entries do not resolve: b.txt/.test(r.out) && /REFUSED --approve/.test(r.out), 'missing manifest entry blocks approval');
  assert(readState(contextDir).systems[0].status !== 'fresh', 'no promotion under manifest errors');
  fs.writeFileSync(path.join(targets.sys1, 'b.txt'), 'beta');

  // approve refused on over-cap card
  fs.appendFileSync(path.join(contextDir, 'sys1.md'), 'x'.repeat(7000));
  r = runChecker(contextDir, ['--approve', 'sys1']);
  assert(r.code === 2 && /REFUSED --approve/.test(r.out) && readState(contextDir).systems[0].status !== 'fresh', 'over-cap card blocks approval');
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), card(contextDir).replace(/x{7000}/, ''));

  // approve refused when source is MISSING
  fs.rmSync(targets.sys1, { recursive: true, force: true });
  r = runChecker(contextDir, ['--approve', 'sys1']);
  assert(r.code === 2 && /cannot promote/.test(r.out) && readState(contextDir).systems[0].status === 'missing', 'MISSING source blocks approval');

  fs.rmSync(base, { recursive: true, force: true });
}

// === robustness: CRLF, parse failure, secrets, git ========================
{
  const { base, contextDir, targets } = setup();
  runChecker(contextDir, ['--approve', 'sys1']);

  // CRLF re-save still parses and stays FRESH (hash normalizes line endings)
  const lf = card(contextDir);
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), lf.replace(/\n/g, '\r\n'));
  let r = runChecker(contextDir);
  assert(!/no frontmatter/.test(r.out), 'CRLF card still parses');
  assert(readState(contextDir).systems[0].status === 'fresh', 'CRLF re-save does not break trust (normalized hash)');

  // parse failure demotes visibly instead of leaving FRESH behind
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), 'no frontmatter here at all\n');
  r = runChecker(contextDir);
  assert(r.code === 2 && readState(contextDir).systems[0].status === 'unknown', 'unparsable card demotes to unknown');
  assert(index(contextDir).includes('UNKNOWN'), 'index reflects unknown after parse failure');

  // secret-like content in a card is flagged
  makeCard(contextDir, 'sys1', targets.sys1, '', 'token: ghp_abcdefghijklmnopqrstuvwx1234567890');
  r = runChecker(contextDir);
  assert(r.code === 2 && /secret-like content/.test(r.out), 'secret-like card content is a hard error');

  fs.rmSync(base, { recursive: true, force: true });
}

// === git fingerprint path ==================================================
{
  const { base, contextDir, targets } = setup();
  const target = targets.sys1;
  const git = (...a) => execFileSync('git', ['-C', target, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  // switch card to git fingerprinting
  const c = card(contextDir).replace('fingerprint_type: manifest', 'fingerprint_type: git').replace(/manifest:\n(  - [^\n]*\n)+/, '');
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), c);

  runChecker(contextDir, ['--approve', 'sys1']);
  let st = readState(contextDir);
  assert(st.systems[0].fingerprint.value.startsWith('git:') && st.systems[0].status === 'fresh', 'git fingerprint computed and approved');
  assert(st.systems[0].fingerprint.dirty === false, 'clean tree => dirty=false');

  fs.writeFileSync(path.join(target, 'a.txt'), 'workingtree-edit');
  let r = runChecker(contextDir);
  st = readState(contextDir);
  assert(st.systems[0].status === 'fresh' && st.systems[0].fingerprint.dirty === true, 'dirty tree stays FRESH (HEAD unchanged) with dirty flag');
  assert(index(contextDir).includes('FRESH*'), 'index shows FRESH* for dirty tree');

  git('add', '-A'); git('commit', '-q', '-m', 'drift');
  runChecker(contextDir);
  assert(readState(contextDir).systems[0].status === 'stale', 'new commit => stale');

  fs.rmSync(base, { recursive: true, force: true });
}

// === divergence + orphans + refresh + dispute + lock =======================
{
  const { base, contextDir, targets } = setup(['sys1', 'sys2']);

  // orphan card
  fs.writeFileSync(path.join(contextDir, 'ghost.md'), '---\nsystem: ghost\n---\n# ghost\n');
  let r = runChecker(contextDir);
  assert(r.code === 2 && /orphan card context\/ghost.md/.test(r.out), 'orphan card flagged as divergence');
  fs.rmSync(path.join(contextDir, 'ghost.md'));

  // missing index row
  const idx = index(contextDir).split('\n').filter((l) => !l.includes('| sys2 |')).join('\n');
  fs.writeFileSync(path.join(contextDir, 'SYSTEMS.md'), idx);
  r = runChecker(contextDir);
  assert(r.code === 2 && /'sys2' has no SYSTEMS.md row/.test(r.out), 'missing index row flagged as divergence');
  fs.writeFileSync(path.join(contextDir, 'SYSTEMS.md'), idx + `| sys2 | ${targets.sys2} | — | PENDING-REVIEW 2026-07-23 |\n`);

  // Duplicate ids would otherwise share one SYSTEMS.md row and make targeted
  // card routing / approvals ambiguous.
  const duplicateState = readState(contextDir);
  duplicateState.systems.push({ ...duplicateState.systems[0] });
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(duplicateState, null, 2));
  r = runChecker(contextDir);
  assert(r.code === 2 && /duplicate systems\.json id 'sys1'/.test(r.out), 'duplicate system id is rejected as ambiguous routing');
  duplicateState.systems.pop();
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(duplicateState, null, 2));

  // path disagreement between card and systems.json
  const st0 = readState(contextDir);
  st0.systems[1].path = st0.systems[1].path + '-elsewhere';
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(st0, null, 2));
  r = runChecker(contextDir);
  assert(r.code === 2 && /source_path disagrees/.test(r.out), 'card/state path disagreement flagged');
  const st1 = readState(contextDir);
  st1.systems[1].path = st1.systems[1].path.replace('-elsewhere', '');
  fs.writeFileSync(path.join(contextDir, 'systems.json'), JSON.stringify(st1, null, 2));

  // refresh demotes an approved card
  runChecker(contextDir, ['--approve', 'sys1']);
  r = runChecker(contextDir, ['--refresh', 'sys1']);
  const st2 = readState(contextDir);
  assert(st2.systems[0].status === 'pending-review' && !st2.systems[0].reviewed_fingerprint, '--refresh demotes and clears reviewed state');
  assert(/extractor output/.test(r.out), '--refresh reruns the extractor');

  // dispute appends a disposition entry
  runChecker(contextDir, ['--dispute', 'sys1', '--note', 'mtime churn from backup tool']);
  const log = fs.readFileSync(path.join(contextDir, 'check-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const disp = log[log.length - 1];
  assert(disp.disposition && disp.disposition.verdict === 'false-stale' && disp.note, '--dispute records a false-STALE disposition with note');

  // lock: a live lock file makes a second run fail fast
  fs.writeFileSync(path.join(contextDir, '.check.lock'), '99999');
  r = runChecker(contextDir);
  assert(r.code === 2 && /another checker run/.test(r.out), 'live lock blocks a concurrent run');
  fs.rmSync(path.join(contextDir, '.check.lock'));

  fs.rmSync(base, { recursive: true, force: true });
}

process.stdout.write(failures ? `\n${failures} FAILURE(S)\n` : '\nall grepsaver tests passed\n');
process.exit(failures ? 1 : 0);
