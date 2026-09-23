#!/usr/bin/env node
// GREPSAVER reindex tests — isolated via TOOLSENABLED_GREPSAVER_CONTEXT (a temp
// context dir + temp fake target systems) and TOOLSENABLED_GREPSAVER_NOW (a
// pinned clock), mirroring tests/grepsaver/grepsaver.js's disposable-paths
// pattern. Standalone: `node tests/grepsaver/reindex.js`.
//
// Covers the owner directive (R1118/R1117) this file exists to prove: the
// system LIST in context/systems.json + context/SYSTEMS.md is a mechanical,
// deterministic function of the cards in context/ — not something an agent
// hand-writes — and:
//   1. regeneration over unchanged input is byte-identical (no diff);
//   2. a stale index (never generated, or drifted from the cards) is
//      DETECTED mechanically, not by eye;
//   3. hand-written card content (judgment zones, review trust state) is
//      never touched by regeneration.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('../../tools/grepsaver-lib.js');

const REINDEX = path.join(__dirname, '..', '..', 'tools', 'grepsaver-reindex.js');
const CHECKER = path.join(__dirname, '..', '..', 'tools', 'grepsaver-check.js');
const PINNED_NOW = '2026-08-04';

let failures = 0;
const assert = (cond, name) => {
  if (cond) process.stdout.write(`ok   ${name}\n`);
  else { failures++; process.stdout.write(`FAIL ${name}\n`); }
};

function run(tool, contextDir, extra = [], extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [tool, ...extra], {
      encoding: 'utf8',
      env: { ...process.env, TOOLSENABLED_GREPSAVER_CONTEXT: contextDir, TOOLSENABLED_GREPSAVER_NOW: PINNED_NOW, ...extraEnv },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const runReindex = (contextDir, extra, env) => run(REINDEX, contextDir, extra, env);
const runChecker = (contextDir, extra, env) => run(CHECKER, contextDir, extra, env);

function cardText({ id, target, name = id, extraFrontmatter = '', manifest = ['a.txt', 'b.txt'] }) {
  return [
    '---',
    `system: ${id}`,
    `source_path: ${target}`,
    'fingerprint: manifest-hash:sha256:placeholder',
    'fingerprint_type: manifest',
    'manifest:',
    ...manifest.map((m) => `  - ${m}`),
    'generated: 2026-07-23',
    'reviewed_on: PENDING',
    'generator: test',
    extraFrontmatter,
    '---',
    `# ${name}`,
    '',
    '<!-- judgment -->',
    '## Identity',
    `Test fixture for ${id}. This exact sentence must survive every regeneration byte-for-byte.`,
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
}

function makeTarget(base, id, files = { 'a.txt': 'alpha', 'b.txt': 'beta' }) {
  const target = path.join(base, `target-${id}`);
  fs.mkdirSync(target, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(target, name), content);
  return target;
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'grepsaver-reindex-test-'));
  const contextDir = path.join(base, 'context');
  fs.mkdirSync(contextDir);
  return { base, contextDir };
}

const readState = (d) => JSON.parse(fs.readFileSync(path.join(d, 'systems.json'), 'utf8'));
const readMd = (d) => fs.readFileSync(path.join(d, 'SYSTEMS.md'), 'utf8');
const readCard = (d, id) => fs.readFileSync(path.join(d, `${id}.md`), 'utf8');
const writeCard = (d, id, opts) => fs.writeFileSync(path.join(d, `${id}.md`), cardText({ id, ...opts }));

// -----------------------------------------------------------------------
// 1. Determinism: a fresh generation, then a second run with nothing
//    changed, produces byte-identical files (with the clock pinned, per the
//    one documented exception in grepsaver-reindex.js's header comment).
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });

  const r1 = runReindex(contextDir);
  assert(r1.code === 0, 'first reindex run succeeds');
  const sysBytes1 = fs.readFileSync(path.join(contextDir, 'systems.json'));
  const mdBytes1 = fs.readFileSync(path.join(contextDir, 'SYSTEMS.md'));
  const mtimeAfterFirst = fs.statSync(path.join(contextDir, 'systems.json')).mtimeMs;

  const r2 = runReindex(contextDir);
  assert(r2.code === 0, 'second reindex run succeeds');
  const sysBytes2 = fs.readFileSync(path.join(contextDir, 'systems.json'));
  const mdBytes2 = fs.readFileSync(path.join(contextDir, 'SYSTEMS.md'));

  assert(Buffer.compare(sysBytes1, sysBytes2) === 0, 'systems.json is byte-identical across two runs over unchanged cards');
  assert(Buffer.compare(mdBytes1, mdBytes2) === 0, 'SYSTEMS.md is byte-identical across two runs over unchanged cards');
  assert(/systems\.json unchanged; SYSTEMS\.md unchanged/.test(r2.out), 'a no-op rerun reports both files unchanged (not merely equal)');
  assert(fs.statSync(path.join(contextDir, 'systems.json')).mtimeMs === mtimeAfterFirst, 'a no-op rerun does not even touch mtime — a true no-op, not a same-bytes rewrite');

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 2. A stale index is DETECTED mechanically: never generated, membership
//    drift (card added/removed), and content-only drift (display name
//    changed) are each distinguished and reported, never silently accepted.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });

  const beforeAny = runReindex(contextDir, ['--check']);
  assert(beforeAny.code === 1 && /never generated/.test(beforeAny.out), '--check on a never-generated index reports STALE, not a false CURRENT');

  runReindex(contextDir);
  const current = runReindex(contextDir, ['--check']);
  assert(current.code === 0 && /^CURRENT/.test(current.out), '--check reports CURRENT immediately after a real generation');

  // Membership drift: a new card appears.
  const t2 = makeTarget(base, 'sys2');
  writeCard(contextDir, 'sys2', { target: t2 });
  const addedDrift = runReindex(contextDir, ['--check']);
  assert(addedDrift.code === 1 && /membership drift/.test(addedDrift.out) && /\+ sys2/.test(addedDrift.out), 'a new card is detected as membership drift, naming the added id');
  runReindex(contextDir); // absorb it before the next sub-case

  // Membership drift: a card disappears.
  fs.rmSync(path.join(contextDir, 'sys2.md'));
  const removedDrift = runReindex(contextDir, ['--check']);
  assert(removedDrift.code === 1 && /membership drift/.test(removedDrift.out) && /- sys2/.test(removedDrift.out), 'a removed card is detected as membership drift, naming the dropped id');
  runReindex(contextDir);

  // Content-only drift: the card's own display name (H1) changes, but its
  // identity (id/path/fingerprint recipe) does not, so generated_from is
  // unchanged — this must still be caught by the full-content comparison,
  // proving --check is not merely a generated_from check in disguise.
  const before = readState(contextDir).generated_from;
  fs.writeFileSync(path.join(contextDir, 'sys1.md'), cardText({ id: 'sys1', target: t1, name: 'Sys One Renamed' }));
  const renameDrift = runReindex(contextDir, ['--check']);
  assert(renameDrift.code === 1 && /content differs/.test(renameDrift.out), 'a display-name-only edit is detected as content drift');
  assert(readState(contextDir).generated_from === before, 'sanity: the rename alone does not change generated_from (proves the content check is a real second signal, not a duplicate of the hash check)');

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 3. Hand-written content survives regeneration: the card file itself is
//    byte-identical before and after every reindex run (reindex never opens
//    a card for writing), and per-card REVIEW TRUST earned via
//    grepsaver-check.js --approve survives a reindex that adds an unrelated
//    system.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });
  runReindex(contextDir);
  const approve = runChecker(contextDir, ['--approve', 'sys1']);
  assert(approve.code === 0, 'sys1 approved (fixture setup)');

  const cardBefore = readCard(contextDir, 'sys1');
  const stateBeforeSys1 = readState(contextDir).systems.find((s) => s.id === 'sys1');
  assert(stateBeforeSys1.status === 'fresh' && !!stateBeforeSys1.reviewed_fingerprint, 'fixture setup: sys1 is FRESH with recorded review trust');

  // Add an unrelated second system and reindex.
  const t2 = makeTarget(base, 'sys2');
  writeCard(contextDir, 'sys2', { target: t2 });
  const r = runReindex(contextDir);
  assert(r.code === 0, 'reindex succeeds after adding an unrelated card');

  const cardAfter = readCard(contextDir, 'sys1');
  assert(cardBefore === cardAfter, "sys1's card file (identity prose, judgment zones) is byte-identical after an unrelated reindex — reindex never writes card files");

  const stateAfterSys1 = readState(contextDir).systems.find((s) => s.id === 'sys1');
  assert(stateAfterSys1.status === 'fresh', "sys1's FRESH status survives a reindex triggered by a different system's card appearing");
  assert(stateAfterSys1.reviewed_fingerprint === stateBeforeSys1.reviewed_fingerprint, 'reviewed_fingerprint is carried forward unchanged, not recomputed by reindex');
  assert(stateAfterSys1.reviewed_card_hash === stateBeforeSys1.reviewed_card_hash, 'reviewed_card_hash is carried forward unchanged by reindex');

  // A subsequent checker run must still see sys1 as FRESH (reindex did not
  // silently invalidate the review by touching anything judgment-hashed).
  const checkAfter = runChecker(contextDir);
  const stAfterCheck = readState(contextDir).systems.find((s) => s.id === 'sys1');
  assert(/^sys1: fresh$/m.test(checkAfter.out), 'the post-reindex checker actually examines sys1 and reports its FRESH result');
  assert(stAfterCheck.status === 'fresh', 'sys1 is still FRESH after the checker re-verifies post-reindex (reindex introduced no spurious drift)');

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 4. Ports are mechanically cross-referenced from ServerControl/servers.json
//    — never hand-typed into a card or systems.json.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });
  const scRoot = path.join(base, 'ServerControl');
  fs.mkdirSync(scRoot, { recursive: true });
  fs.writeFileSync(path.join(scRoot, 'servers.json'), JSON.stringify([
    { Name: 'Sys1 Server', Port: 4321, Url: 'http://localhost:4321', WorkDir: t1 },
  ]));

  const r = runReindex(contextDir, [], { TOOLSENABLED_SERVER_CONTROL_ROOT: scRoot });
  assert(r.code === 0, 'reindex succeeds with a fixture servers.json present');
  const st = readState(contextDir).systems.find((s) => s.id === 'sys1');
  assert(Array.isArray(st.ports) && st.ports.includes(4321), 'port is mechanically pulled from servers.json into systems.json, not hand-entered');
  assert(/\|\s*4321\s*\|/.test(readMd(contextDir)), 'the port appears in the generated SYSTEMS.md row');

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 5. Refusals: an uncertain/ambiguous input is a hard error (exit 2),
//    never a silently shrunk or wrong index.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });
  const before = fs.existsSync(path.join(contextDir, 'systems.json'));
  assert(!before, 'fixture setup: no systems.json exists yet');

  // Filename/id mismatch.
  fs.writeFileSync(path.join(contextDir, 'wrong-name.md'), cardText({ id: 'sys1', target: t1 }));
  let r = runReindex(contextDir);
  assert(r.code === 2 && /must match filename/.test(r.out), 'filename/frontmatter id mismatch refuses to write (exit 2)');
  assert(!fs.existsSync(path.join(contextDir, 'systems.json')), 'a refused run writes nothing');
  fs.rmSync(path.join(contextDir, 'wrong-name.md'));

  // Duplicate id across two files.
  fs.writeFileSync(path.join(contextDir, 'sys1-dup.md'), cardText({ id: 'sys1', target: t1 }).replace('system: sys1', 'system: sys1'));
  // The above file is named sys1-dup.md but claims system: sys1 — both the
  // filename-mismatch AND duplicate-id paths would fire; rename fixture to
  // exercise duplicate-id specifically via two *correctly named* files is
  // impossible (two files cannot both be named sys1.md), so duplicate ids
  // are exercised through the id-vs-filename mismatch path above and through
  // buildEntries() directly instead:
  fs.rmSync(path.join(contextDir, 'sys1-dup.md'));
  const dup = require('../../tools/grepsaver-reindex.js').buildEntries([
    { file: 'a.md', id: 'sys1', text: '# A', frontmatter: { source_path: t1, fingerprint_type: 'manifest', manifest: ['a.txt'] } },
    { file: 'b.md', id: 'sys1', text: '# B', frontmatter: { source_path: t1, fingerprint_type: 'manifest', manifest: ['a.txt'] } },
  ]);
  assert(dup.errors.length === 1 && /duplicate system id/.test(dup.errors[0]), 'two cards claiming the same system id is refused as ambiguous routing');

  // Invalid frontmatter (missing required key).
  fs.writeFileSync(path.join(contextDir, 'broken.md'), [
    '---',
    'system: broken',
    'fingerprint_type: manifest',
    '---',
    '# Broken',
  ].join('\n'));
  r = runReindex(contextDir);
  assert(r.code === 2 && /invalid frontmatter/.test(r.out), 'a card missing required frontmatter keys is refused (exit 2), not silently dropped');
  fs.rmSync(path.join(contextDir, 'broken.md'));

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 6. Regression: ORIENTATION.md (hand-authored, not a card) must never be
//    treated as a system by reindex, and must never be flagged as an orphan
//    by grepsaver-check.js. Before this file's lib.js change, NON_CARD_FILES
//    was a local copy in grepsaver-check.js that omitted ORIENTATION.md, so
//    any real checker run over a real context/ directory containing it
//    raised a false "orphan card ... divergence" error.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });
  fs.writeFileSync(path.join(contextDir, 'ORIENTATION.md'), '# Orientation\n\nHand-authored onboarding doc. Not a system card.\n');

  const r = runReindex(contextDir);
  assert(r.code === 0, 'reindex succeeds with ORIENTATION.md present alongside real cards');
  assert(readState(contextDir).systems.length === 1 && readState(contextDir).systems[0].id === 'sys1', 'ORIENTATION.md is excluded from discovered systems');

  const check = runChecker(contextDir);
  assert(/^sys1: /m.test(check.out), 'grepsaver-check.js actually loads the fixture and reports sys1 while checking for orphan cards');
  assert(!/orphan card/.test(check.out), 'grepsaver-check.js does not flag ORIENTATION.md as an orphan card (regression: it used to)');

  fs.rmSync(base, { recursive: true, force: true });
}

// -----------------------------------------------------------------------
// 7. Path display is computed from the OS home directory at run time, never
//    a hand-picked per-machine base-path legend (the exact fault that made
//    the historical SYSTEMS.md's "T=D\ToolsEnabled" line wrong on the
//    machine it was checked out on).
// -----------------------------------------------------------------------
{
  const under = path.join(os.homedir(), 'Desktop', 'SomeProject');
  const outside = process.platform === 'win32' ? 'C:\\ProgramData\\SomeService' : '/opt/some-service';
  assert(lib.homeRelative(under).startsWith('~/'), 'a path under the home directory renders relative to it, with no hardcoded base letter');
  assert(!lib.homeRelative(outside).startsWith('~'), 'a path outside the home directory renders as a plain absolute path, not a fabricated alias');

  process.stdout.write(`ok   (info) homeRelative(<home>/Desktop/SomeProject) = ${lib.homeRelative(under)}\n`);
}

// -----------------------------------------------------------------------
// 8. Regression: an orphaned SYSTEMS.md row (left over with no backing
//    systems.json entry — a real scenario, since systems.json is gitignored
//    on this repo and SYSTEMS.md is not always deleted alongside it) must
//    NEVER be carried forward as if it were earned status. A status cell is
//    only reused when a real prior systems.json entry backs it; otherwise
//    the row is a brand-new NOT-YET-CHECKED entry. This is exactly the
//    "stale index that looks current" failure the whole mechanism exists to
//    prevent — found and fixed while dogfooding this tool against the real
//    repo, where a leftover FRESH-looking SYSTEMS.md row from days earlier
//    (with no systems.json to back it) would otherwise have been carried
//    into a brand-new, never-reviewed system's row.
// -----------------------------------------------------------------------
{
  const { base, contextDir } = setup();
  const t1 = makeTarget(base, 'sys1');
  writeCard(contextDir, 'sys1', { target: t1 });
  // An orphan: a SYSTEMS.md claiming sys1 is FRESH, but NO systems.json at
  // all — e.g. systems.json was deleted/never synced while SYSTEMS.md
  // (a different gitignore rule, or a stray copy) survived.
  fs.writeFileSync(path.join(contextDir, 'SYSTEMS.md'), [
    '# System index', '', '| system | path | ports | status |', '|---|---|---|---|',
    `| sys1 | ${t1} | - | FRESH 2020-01-01 |`, '',
  ].join('\n'));
  assert(!fs.existsSync(path.join(contextDir, 'systems.json')), 'fixture setup: no systems.json backs the orphaned SYSTEMS.md row');

  const r = runReindex(contextDir);
  assert(r.code === 0, 'reindex succeeds despite the orphaned SYSTEMS.md row');
  const row = readMd(contextDir).split('\n').find((l) => l.startsWith('| sys1'));
  assert(/NOT-YET-CHECKED/.test(row), 'the orphaned FRESH-looking status text is discarded, not carried forward, once a real systems.json entry is created');
  assert(!/FRESH 2020-01-01/.test(readMd(contextDir)), 'the stale 2020-01-01 FRESH claim never reaches the new index');

  fs.rmSync(base, { recursive: true, force: true });
}

process.stdout.write(failures ? `\n${failures} FAILURE(S)\n` : '\nall grepsaver-reindex tests passed\n');
process.exit(failures ? 1 : 0);

// EXECUTABLE CHANGE
// testcanfail-tests-grepsaver-reindex-js
//
// Mutation: tools/grepsaver-check.js was temporarily changed to exit 0 before
// every no-argument check.  Before the assertions above were added, this whole
// file stayed green ("all grepsaver-reindex tests passed"), proving that the
// checker could fail to load/inspect anything without the two regression cases
// noticing.  With the assertions strengthened, the same mutation went red:
//   FAIL the post-reindex checker actually examines sys1 and reports its FRESH result
//   FAIL grepsaver-check.js actually loads the fixture and reports sys1 while checking for orphan cards
//   2 FAILURE(S)
// The mutation was restored byte-for-byte (SHA-256 before and after:
// 778327fbb7c931edc43f40da37475c2bbd275c9eb7f1ca5c9e62f454a4155531),
// and the restored run ended: "all grepsaver-reindex tests passed".
//
// Shape census: (1) empty loop/forEach assertions — NOT-FOUND; (2) bare exit
// status/truthy return without subject output — fixed for the two checker
// regressions above; other status assertions are coupled to output/state or
// establish fixture success; (3) swallowing try/catch/optional-chain —
// NOT-FOUND (run() captures process evidence, and assertions consume it);
// (4) mock of the subject — NOT-FOUND; (5) skip/platform guard — NOT-FOUND;
// (6) expected value computed by the implementation under test — NOT-FOUND.
// Preconditions not met: none.
