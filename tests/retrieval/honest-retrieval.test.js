// EXECUTABLE CHANGE
// Test-can-fail report (testcanfail-tests-retrieval-honest-retrieval-test-js):
// - EMPTY-LOOP: mutating the withheld recall packet to return `sources: []`
//   stayed GREEN (`R1246 retrieval: all 34 behavioural checks passed.`). The
//   withheld-source assertion now first requires the independently expected
//   ledger/board/docs census. Under that mutation it was RED:
//   `FAIL no settings file at all withholds the surface and touches nothing`
//   `withheld recall omitted or invented source evidence`.
// - EXIT-ONLY: mutating tools/recall.js to exit 2 without emitting its own
//   usage diagnostic stayed GREEN before the strengthening. The usage check
//   now requires that diagnostic; under the mutation it was RED:
//   `FAIL tools/recall.js exits 5 when the surface is withheld, 2 with no topic`
//   `exit 2 without the recall CLI usage diagnostic is only a failed process, not evidence of usage refusal`.
// - EMPTY-LOOP: mutating the shipped source registry to `SOURCES = []` is now
//   caught by an independent expected source-id census before its assertions.
//   Under that mutation it was RED:
//   `FAIL every registered source names a control that exists in the shipped settings registry`
//   `the shipped source registry was empty or its expected retrieval sources disappeared`.
// - NOT-FOUND: no assertion-bearing optional chain or swallowed try/catch; no
//   mock of recall, its gate/index/backends, or either spawned CLI; no skip or
//   platform precondition guard; no expected value computed by the same
//   retrieval operation it checks. Literal non-empty loops and the unreadable
//   branch (guarded by `unreadable.length !== 0`) cannot execute zero times.
// - Preconditions met with Node v22.22.2. All mutated product files were
//   restored byte-for-byte. The restored run was GREEN:
//   `R1246 retrieval: all 34 behavioural checks passed.`

'use strict';

// R1246 -- unified honest retrieval. Behavioural tests only.
//
// EVERY ASSERTION HERE IS ABOUT WHAT THE SOFTWARE DOES, not about what its
// source text says. Two planted defects passed a fully green suite in this
// codebase on 2026-08-11 because the assertions were source-text greps, and
// dead code greps identically to live code. So this suite builds real ledger
// files, a real SQLite durable-memory store and a real docs corpus on disk,
// runs the real query path over them, and reads the real process exit codes by
// spawning the real CLI -- never through a pipe, because `node x.js | tail`
// reports TAIL's status.
//
// THE DEFECTS EACH TEST EXISTS TO CATCH ARE NAMED IN ITS FAILURE MESSAGE, so a
// red here says what broke rather than that something did.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

// Literal relative requires, not require(path.join(...)). tools/invocation-guard.js
// resolves reachability by reading these specifiers as TEXT, so a computed path
// is an edge the graph cannot see -- and a module reached only through one is
// reported as reached by nothing at all, which is how a live module gets
// mistaken for dead code and deleted.
const { recall, decideOutcome, RECALL_EXIT } = require('../../tools/retrieval');
const { gate, decideToggle, GATE_STATE } = require('../../tools/retrieval/settings-gate');
const backends = require('../../tools/retrieval/backends');
const fts = require('../../tools/retrieval/fts-index');
const sources = require('../../tools/retrieval/sources');
const { loadSettings } = require('../../src/lib/settings');
const { buildIndex, INDEX_EXIT } = require('../../tools/recall-index');
const recallCli = require('../../tools/recall');

let checks = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    checks += 1;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}\n       ${error && error.message}`);
  }
}

const temporaries = [];
function scratch(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `r1246-${prefix}-`));
  temporaries.push(directory);
  return directory;
}
process.on('exit', () => {
  for (const directory of temporaries) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --------------------------------------------------------------------------
// Fixtures -- real files, real SQLite, no mocks of the subject
// --------------------------------------------------------------------------

const ALL_SETTING_IDS = [
  'retrieval.unified_search',
  'retrieval.search_documents',
  'retrieval.search_request_ledger',
  'retrieval.search_coordination_board',
  'retrieval.meaning_search',
];

function settingsFile(directory, values, provenanceSource = 'user') {
  const file = path.join(directory, 'settings.json');
  const provenance = {};
  for (const id of Object.keys(values)) {
    provenance[id] = { source: provenanceSource, atMs: 1786000000000, directive: 'R1246' };
  }
  fs.writeFileSync(file, `${JSON.stringify({ revision: 1, values, provenance }, null, 2)}\n`, 'utf8');
  return loadSettings({ valuesPath: file });
}

function allOn(directory, overrides = {}) {
  const values = {
    'retrieval.unified_search': true,
    'retrieval.search_documents': true,
    'retrieval.search_request_ledger': true,
    'retrieval.search_coordination_board': true,
    ...overrides,
  };
  return settingsFile(directory, values);
}

const LEDGER_FIXTURE = {
  schemaVersion: 3,
  revision: 1,
  requests: [
    {
      id: 'R9001',
      verbatim: 'the daily spend cap has to be a number I chose, not one an agent invented for me',
      request: '(interpretation) The spend cap must trace to an owner setting.',
      status: 'open', scope: 'global', gates: [], provenance: { class: 'owner-stated', recordedAt: '2026-08-01T00:00:00.000Z' },
    },
    {
      id: 'R9002',
      verbatim: 'put the quokka telemetry behind a switch',
      request: '(interpretation) Gate the quokka telemetry.',
      status: 'done', scope: 'global', gates: [], provenance: { class: 'owner-stated', recordedAt: '2026-08-02T00:00:00.000Z' },
    },
    {
      id: 'R9003',
      verbatim: [
        'rotate the deploy credential',
        'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789',
        'and never print it again',
      ].join('\n'),
      request: '(interpretation) Rotate the deploy credential.',
      status: 'open', scope: 'global', gates: [], provenance: { class: 'owner-stated', recordedAt: '2026-08-03T00:00:00.000Z' },
    },
  ],
};

function writeLedger(directory, document = LEDGER_FIXTURE) {
  const file = path.join(directory, 'OWNER-REQUEST-LEDGER.json');
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return file;
}

function writeBoard(directory, entries) {
  const file = path.join(directory, 'board.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE memory_entries (namespace TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL, '
    + 'value_hash TEXT NOT NULL, note TEXT, tags_json TEXT NOT NULL, revision INTEGER NOT NULL, '
    + 'created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (namespace, entry_key));');
  const insert = db.prepare('INSERT INTO memory_entries VALUES(?,?,?,?,?,?,?,?,?)');
  let at = 1786000000000;
  for (const entry of entries) {
    at += 1000;
    insert.run(entry.namespace, entry.key, JSON.stringify(entry.value), 'x', entry.note || null,
      JSON.stringify(entry.tags || []), 1, at, at);
  }
  db.close();
  return file;
}

function writeDocs(directory, files) {
  for (const scope of ['docs', 'reports', 'context']) fs.mkdirSync(path.join(directory, scope), { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return directory;
}

function world(prefix, options = {}) {
  const directory = scratch(prefix);
  const ledgerPath = writeLedger(directory, options.ledger);
  const statePath = options.noBoard ? path.join(directory, 'missing.sqlite3') : writeBoard(directory, options.board || [
    { namespace: 'agent-coord', key: 'wave-nine-territory', note: 'lane nine claims the quokka telemetry switch', tags: ['territory-claim'], value: { owner: 'lane-nine' } },
    { namespace: 'agent-coord', key: 'spend-cap-answer', note: 'the daily spend cap default traces to a baseline commit, not to the owner', tags: ['answer'], value: { finding: 'agent default' } },
  ]);
  const docsRoot = writeDocs(directory, options.docs || {
    'docs/SPEND-CAP-PROVENANCE.md': '# Spend cap provenance\n\nThe daily spend cap default came from an AI-authored baseline commit.\n',
    'docs/UNRELATED-NOTE.md': '# Unrelated note\n\nNothing to see.\n',
    'reports/LANE-REPORT.md': '# Lane report\n\nA lane reported on the quokka telemetry switch.\n',
    'context/SYSTEMS.md': '# Systems\n\nA map of systems.\n',
  });
  return {
    directory,
    options: {
      ledgerPath,
      statePath,
      docsRoot,
      noWrite: true,
      dbPath: path.join(directory, 'index.sqlite'),
    },
  };
}

// --------------------------------------------------------------------------
// 1. ABSENCE IS WITHHELD, NEVER CONSENT
// --------------------------------------------------------------------------

console.log('R1246 retrieval: the absence case, before the presence case');

check('no settings file at all withholds the surface and touches nothing', () => {
  const w = world('absent');
  const settings = loadSettings({ valuesPath: path.join(w.directory, 'does-not-exist.json') });
  const packet = recall('spend cap', { ...w.options, settings });
  assert.strictEqual(packet.outcome, 'withheld',
    'a MISSING settings file must withhold the surface; absence read as consent is the recurring defect class here');
  assert.strictEqual(packet.reason, 'SURFACE_DISABLED_BY_SETTINGS',
    'the surface being off and every source being off are different sentences to say to a user, and the early '
    + 'refusal that keeps them apart must actually be the branch that ran');
  assert.strictEqual(packet.exitCode, RECALL_EXIT.WITHHELD);
  assert.strictEqual(packet.results.length, 0);
  assert.strictEqual(fs.existsSync(w.options.dbPath), false,
    'a withheld surface must not build an index -- a disabled system that half-runs is worse than either state');
  assert.deepStrictEqual(packet.sources.map(source => source.id), ['ledger', 'board', 'docs'],
    'withheld recall omitted or invented source evidence');
  for (const source of packet.sources) {
    assert.strictEqual(source.documentsConsulted, 0, `${source.id} was read despite the surface being withheld`);
  }
});

check('a non-boolean in the settings FILE is refused by name, and the surface stays withheld', () => {
  const w = world('nontrue-file');
  for (const value of [null, '', 0, 'true', 1, 'yes', [], {}]) {
    const settings = settingsFile(scratch('nt'), {
      'retrieval.unified_search': value,
      'retrieval.search_request_ledger': true,
    });
    assert.ok(settings.rejected.some(entry => entry.id === 'retrieval.unified_search'),
      `loadSettings accepted ${JSON.stringify(value)} for a toggle instead of rejecting it`);
    const packet = recall('spend cap', { ...w.options, settings });
    assert.strictEqual(packet.outcome, 'withheld',
      `value ${JSON.stringify(value)} for the master toggle enabled the surface; only boolean true may`);
    assert.ok(packet.settingsGate.rejected.some(entry => entry.id === 'retrieval.unified_search'),
      'a refused retrieval setting was swallowed instead of being carried into the answer -- the user configured '
      + 'something and needs to know it did not take effect');
  }
  // And the key simply not being in the user's file at all.
  const settings = settingsFile(scratch('nt-absent'), { 'retrieval.search_request_ledger': true });
  assert.strictEqual(recall('spend cap', { ...w.options, settings }).outcome, 'withheld',
    'a master toggle absent from the settings file enabled the surface');
});

check('the GATE itself withholds anything that is not exactly true, without trusting the loader', () => {
  // The check above passes for a reason that is NOT this gate: loadSettings
  // validates control types, so those values never reach here. That makes it a
  // positive control for the loader, and no test at all for the gate. Anything
  // that builds a settings object another way -- a settings surface writing
  // values directly, a control whose type changes, a caller passing its own
  // object -- goes straight past the loader. So the gate is tested on its own
  // terms: `value === true`, never a truthiness check, never a falsy default.
  const w = world('nontrue-gate');
  for (const value of [undefined, null, false, '', 0, 'true', 1, 'yes', [], {}, 'enabled']) {
    const raw = {
      values: { 'retrieval.unified_search': value, 'retrieval.search_request_ledger': true },
      provenance: {
        'retrieval.unified_search': { source: 'user', atMs: 1, directive: 'R1246' },
        'retrieval.search_request_ledger': { source: 'user', atMs: 1, directive: 'R1246' },
      },
      rejected: [],
      revision: 1,
      valuesPath: null,
    };
    assert.strictEqual(decideToggle(raw, 'retrieval.unified_search').state, GATE_STATE.WITHHELD,
      `the gate accepted ${JSON.stringify(value)} as consent; only boolean true may enable a system`);
    assert.strictEqual(recall('spend cap', { ...w.options, settings: raw }).outcome, 'withheld',
      `a query ran with the master toggle set to ${JSON.stringify(value)}`);
  }
  // ...and the positive control, so a gate that refuses EVERYTHING cannot pass
  // this check by being uniformly broken.
  const affirmative = {
    values: { 'retrieval.unified_search': true, 'retrieval.search_request_ledger': true },
    provenance: {
      'retrieval.unified_search': { source: 'user', atMs: 1, directive: 'R1246' },
      'retrieval.search_request_ledger': { source: 'user', atMs: 1, directive: 'R1246' },
    },
    rejected: [], revision: 1, valuesPath: null,
  };
  assert.strictEqual(decideToggle(affirmative, 'retrieval.unified_search').state, GATE_STATE.ENABLED,
    'the gate refuses an explicit user-chosen true, so the check above proves nothing');
});

check('a registry DEFAULT of true cannot enable the surface -- only a user or installer choice can', () => {
  // R1248 / owner-directive-control-that-does-not-enforce: "A control faithfully
  // enforcing an agent-invented value is still a software failure." So a value
  // that reads true but whose provenance is `default` must NOT enable anything.
  const w = world('provenance');
  const asDefault = settingsFile(scratch('prov'), {
    'retrieval.unified_search': true,
    'retrieval.search_request_ledger': true,
  }, 'default');
  const packet = recall('spend cap', { ...w.options, settings: asDefault });
  assert.strictEqual(packet.outcome, 'withheld',
    'a setting that is ON only by a built-in default enabled a system the user never chose');
  assert.match(packet.settingsGate.surface.why, /provenance/i);

  const asInstaller = settingsFile(scratch('prov-i'), {
    'retrieval.unified_search': true,
    'retrieval.search_request_ledger': true,
  }, 'installer');
  assert.notStrictEqual(recall('spend cap', { ...w.options, settings: asInstaller }).outcome, 'withheld',
    'an installer-set value is a real deployment decision and must be honoured');
});

check('a source with no settings-registry entry is UNCLASSIFIED and withheld, master toggle notwithstanding', () => {
  // The "a module added tomorrow is withheld until classified" property.
  const w = world('unclassified');
  const rogue = [
    ...sources.SOURCES,
    { id: 'rogue', kind: 'indexed', settingId: 'retrieval.not_in_the_registry', label: 'rogue',
      fingerprint: () => 'x', documents: () => [{ docId: 'r', identity: 'spend cap', title: 'spend cap', body: 'spend cap', locator: 'r' }] },
  ];
  const settings = allOn(scratch('rogue'));
  const packet = recall('spend cap', { ...w.options, settings, sources: rogue });
  const decided = packet.sources.find(entry => entry.id === 'rogue');
  assert.strictEqual(decided.state, 'unclassified',
    'a source whose control does not exist in the settings registry was searched anyway');
  assert.ok(!packet.results.some(result => result.source === 'rogue'),
    'an unclassified source contributed results');
});

check('settings-gate blindness census fails closed for every reproduced shape', () => {
  const enabled = {
    values: {
      'retrieval.unified_search': true,
      'retrieval.meaning_search': false,
      'retrieval.search_documents': true,
    },
    provenance: {
      'retrieval.unified_search': { source: 'user', atMs: 1 },
      'retrieval.meaning_search': { source: 'user', atMs: 1 },
      'retrieval.search_documents': { source: 'user', atMs: 1 },
    },
    rejected: [],
  };

  // Shape 1 NOT-REPRODUCED. Input tried: this module required normally and
  // through a differently named symlink. It has no main-module/entry guard;
  // both paths export the same callable gate, so there is no guarded check to
  // skip. (The symlink reproduction itself is platform-specific and belongs
  // in the recorded census, not in this portable behavioural suite.)
  assert.strictEqual(typeof gate, 'function');

  // Shape 2 REPRODUCED before this fix. Input tried: an explicit empty source
  // enumeration. It used to leave surface.state ENABLED and report no enabled
  // sources, making "nothing was checked" indistinguishable from a pass.
  const empty = gate({ settings: enabled, sources: [] });
  assert.strictEqual(empty.surface.state, GATE_STATE.UNMEASURABLE);
  assert.strictEqual(empty.surfaceWithheld, true);

  // Shape 3 NOT-REPRODUCED. Input tried: gate() with settings missing. The
  // master control was already UNCLASSIFIED and withheld, never satisfied.
  const missing = gate();
  assert.strictEqual(missing.surface.state, GATE_STATE.UNCLASSIFIED);
  assert.strictEqual(missing.surfaceWithheld, true);

  // Shape 4 REPRODUCED before this fix. Input tried: a user-enabled retrieval
  // key absent from the declared source list. It was silently omitted while
  // the surface passed. It must now be named and withhold the surface.
  const extraId = 'retrieval.future_undeclared_source';
  const extra = gate({ settings: {
    ...enabled,
    values: { ...enabled.values, [extraId]: true },
    provenance: { ...enabled.provenance, [extraId]: { source: 'user', atMs: 1 } },
  } });
  assert.strictEqual(extra.surface.state, GATE_STATE.UNCLASSIFIED);
  assert.strictEqual(extra.surfaceWithheld, true);
  assert.deepStrictEqual([...extra.undeclaredSettingIds], [extraId]);

  // Shape 5 REPRODUCED before this fix. Input tried: a wildcard read error in
  // rejected plus default-false values. It collapsed to the definite verdict
  // WITHHELD. A could-not-read input is now explicitly unmeasurable.
  const unreadable = gate({ settings: {
    values: { 'retrieval.unified_search': false },
    provenance: {},
    rejected: [{ id: '*', reason: 'EACCES: could not read settings' }],
  } });
  assert.strictEqual(unreadable.surface.state, GATE_STATE.UNMEASURABLE);
  assert.strictEqual(unreadable.surfaceWithheld, true);
  assert.deepStrictEqual([...unreadable.rejected], [{ id: '*', reason: 'EACCES: could not read settings' }]);
});

// --------------------------------------------------------------------------
// 2. THE OUTCOME ALGEBRA -- and the rule that an empty answer is never exit 0
// --------------------------------------------------------------------------

console.log('R1246 retrieval: hit / miss / unknown / withheld, and their exit codes');

check('a real hit cites the exact ledger request that carries the wording', () => {
  const w = world('hit');
  const packet = recall('spend cap', { ...w.options, settings: allOn(scratch('hit-s')) });
  assert.strictEqual(packet.outcome, 'hit', packet.why);
  assert.strictEqual(packet.exitCode, RECALL_EXIT.FOUND);
  const ledgerHits = packet.results.filter(result => result.source === 'ledger');
  assert.ok(ledgerHits.length >= 1, 'the ledger holds the phrase and returned nothing');
  assert.ok(ledgerHits.some(result => result.locator.endsWith('#R9001')),
    `the ledger must be citable per R-NUMBER, not as one 1.3MB file; got ${ledgerHits.map(r => r.locator).join(', ')}`);
});

check('a genuine gap is MISS with exit 3, and says every source was read in full', () => {
  const w = world('miss');
  const packet = recall('xylophone marmalade zeppelin', { ...w.options, settings: allOn(scratch('miss-s')) });
  assert.strictEqual(packet.outcome, 'miss', packet.why);
  assert.strictEqual(packet.exitCode, RECALL_EXIT.MISS,
    'a MISS must not exit 0 -- grepsaver-orient exiting 0 on "no carded system matched" is why research was redone');
  assert.strictEqual(packet.sources.filter(entry => entry.state === 'read').length, 3,
    'MISS is only honest when EVERY registered source was read');
  assert.match(packet.why, /genuine gap/i);
});

check('a source switched OFF turns an empty answer into UNKNOWN, never MISS', () => {
  const w = world('partial');
  const settings = settingsFile(scratch('partial-s'), {
    'retrieval.unified_search': true,
    'retrieval.search_request_ledger': true,
    'retrieval.search_documents': false,
    'retrieval.search_coordination_board': false,
  });
  const packet = recall('xylophone marmalade zeppelin', { ...w.options, settings });
  assert.strictEqual(packet.outcome, 'unknown',
    '"you turned off two sources and I found nothing in the third" was reported as a genuine gap');
  assert.strictEqual(packet.reason, 'SOURCE_WITHHELD_BY_SETTINGS');
  assert.strictEqual(packet.exitCode, RECALL_EXIT.UNKNOWN);
  assert.match(packet.why, /not a finding that the topic is unexplored/i);
});

check('a source that cannot be READ turns an empty answer into UNKNOWN, and names the code', () => {
  const w = world('noboard', { noBoard: true });
  const packet = recall('xylophone marmalade zeppelin', { ...w.options, settings: allOn(scratch('noboard-s')) });
  assert.strictEqual(packet.outcome, 'unknown', packet.why);
  assert.strictEqual(packet.reason, 'SOURCE_UNAVAILABLE');
  assert.strictEqual(packet.exitCode, RECALL_EXIT.UNKNOWN);
  const board = packet.sources.find(entry => entry.id === 'board');
  assert.strictEqual(board.state, 'unavailable');
  assert.strictEqual(board.code, 'BOARD_STORE_ABSENT',
    'a missing durable-memory file must be UNKNOWN, not an empty board -- the board may live on another host');
});

check('a hit still declares what was NOT searched', () => {
  const w = world('partialhit', { noBoard: true });
  const packet = recall('spend cap', { ...w.options, settings: allOn(scratch('ph-s')) });
  assert.strictEqual(packet.outcome, 'hit');
  assert.match(packet.why, /NOT searched/,
    'three results read as a complete answer; a hit that skipped a source must say so');
});

check('no outcome other than hit can ever produce exit 0', () => {
  for (const outcome of ['miss', 'unknown', 'withheld']) {
    const decision = { miss: { surfaceWithheld: false, sourceStates: [{ id: 'a', state: 'read' }], resultCount: 0 },
      unknown: { surfaceWithheld: false, sourceStates: [{ id: 'a', state: 'read' }, { id: 'b', state: 'unavailable' }], resultCount: 0 },
      withheld: { surfaceWithheld: true, sourceStates: [], resultCount: 0 } }[outcome];
    const result = decideOutcome(decision);
    assert.strictEqual(result.outcome, outcome);
  }
  // And the mapping itself: only FOUND is 0.
  const zeros = Object.entries(RECALL_EXIT).filter(([, code]) => code === 0).map(([name]) => name);
  assert.deepStrictEqual(zeros, ['FOUND'], `exit 0 is reachable from ${zeros.join(', ')}; it must mean FOUND and nothing else`);
});

// --------------------------------------------------------------------------
// 3. THE CLI'S REAL PROCESS STATUS -- read bare, never through a pipe
// --------------------------------------------------------------------------

console.log('R1246 retrieval: real process exit codes from the real CLI');

function runCli(script, args, env, root = ROOT) {
  const result = spawnSync(process.execPath, [path.join(root, 'tools', script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
    timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  assert.ifError(result.error);
  assert.strictEqual(result.signal, null, `${script} was terminated before reporting a retrieval outcome`);
  return result;
}

check('tools/recall.js exits 5 when the surface is withheld, 2 with no topic', () => {
  const directory = scratch('cli-off');
  fs.writeFileSync(path.join(directory, 'settings.json'),
    `${JSON.stringify({ revision: 1, values: {}, provenance: {} })}\n`, 'utf8');
  const withheld = runCli('recall.js', ['spend cap'], { TOOLSENABLED_SETTINGS_PATH: path.join(directory, 'settings.json') });
  assert.strictEqual(withheld.status, RECALL_EXIT.WITHHELD,
    `a withheld surface exited ${withheld.status}; every non-hit status must differ from 0`);
  assert.match(withheld.stdout, /WITHHELD/);
  const usage = runCli('recall.js', [], {});
  assert.strictEqual(usage.status, RECALL_EXIT.USAGE);
  assert.match(usage.stderr, /usage:.*recall\.js/i,
    'exit 2 without the recall CLI usage diagnostic is only a failed process, not evidence of usage refusal');

  // An invalid result bound used to become NaN, which recall() silently
  // replaced with its default of eight. That produced a definite retrieval
  // answer even though the CLI could not establish the limit the caller asked
  // it to enforce. Refuse the run instead of searching under a different bound.
  for (const invalidLimit of ['nope', '0', '26', '1.5']) {
    const invalid = runCli('recall.js', ['--limit', invalidLimit, 'spend cap'], {});
    assert.strictEqual(invalid.status, RECALL_EXIT.USAGE,
      `--limit ${invalidLimit} exited ${invalid.status}; an invalid bound must refuse the run`);
    assert.match(invalid.stderr, /--limit must be an integer from 1 through 25/);
    assert.strictEqual(invalid.stdout, '', 'an invalid bound must not emit a retrieval answer');
  }
  const missingLimit = runCli('recall.js', ['--limit'], {});
  assert.strictEqual(missingLimit.status, RECALL_EXIT.USAGE,
    `--limit without a value exited ${missingLimit.status}; a missing bound must refuse the run`);
  assert.match(missingLimit.stderr, /--limit must be an integer from 1 through 25/);
  assert.strictEqual(missingLimit.stdout, '', 'a missing bound must not emit a retrieval answer');
});

check('tools/recall.js proves HIT, MISS and UNKNOWN using a disposable real CLI corpus', () => {
  const w = world('cli-on');
  // The CLI resolves its docs and fallback ledger against its own program
  // root. Copy the production program byte-for-byte, then supply only the
  // literal corpus above. Do not borrow the checkout's owner ledger, docs,
  // state, vault or caches, and do not mock the CLI's path resolution.
  for (const relative of ['src', 'tools', 'config', 'package.json']) {
    fs.cpSync(path.join(ROOT, relative), path.join(w.directory, relative), {
      recursive: true, force: false, errorOnExist: true,
      filter(source) {
        const entry = fs.lstatSync(source);
        assert.ok(entry.isDirectory() || entry.isFile(),
          `the CLI fixture refuses linked or special program input: ${path.relative(ROOT, source)}`);
        return true;
      },
    });
  }
  const programLedger = path.join(w.directory, 'reports', 'OWNER-REQUEST-LEDGER.json');
  fs.renameSync(w.options.ledgerPath, programLedger);
  const stateRoot = path.join(w.directory, 'local-app-data', 'ToolsEnabled Retrieval Test', 'capability');
  fs.mkdirSync(path.join(stateRoot, 'reports'), { recursive: true });
  const settingsPath = path.join(w.directory, 'settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify({
    revision: 1,
    values: Object.fromEntries(ALL_SETTING_IDS.slice(0, 4).map(id => [id, true])),
    provenance: Object.fromEntries(ALL_SETTING_IDS.slice(0, 4).map(id => [id, { source: 'user', atMs: 1, directive: 'R1246' }])),
  })}\n`, 'utf8');
  const env = {
    LOCALAPPDATA: path.join(w.directory, 'local-app-data'),
    TOOLSENABLED_STATE_ROOT: stateRoot,
    TOOLSENABLED_SERVER_CONTROL_ROOT: path.join(w.directory, 'services'),
    TOOLSENABLED_SETTINGS_PATH: settingsPath,
    TOOLSENABLED_RETRIEVAL_DB: w.options.dbPath,
    TOOLSENABLED_STATE_PATH: w.options.statePath,
  };
  function query(topic, expectedStatus, expectedOutcome) {
    const result = runCli('recall.js', ['--json', topic], env, w.directory);
    assert.strictEqual(result.status, expectedStatus,
      `the real CLI must report ${expectedOutcome}; got ${result.status}: ${result.stdout}\n${result.stderr}`);
    const packet = JSON.parse(result.stdout);
    assert.strictEqual(packet.outcome, expectedOutcome);
    assert.strictEqual(packet.exitCode, expectedStatus, 'the packet and bare process status disagree');
    assert.deepStrictEqual(packet.sources.map(source => source.id).sort(), ['board', 'docs', 'ledger'],
      'the CLI omitted or invented a required source');
    return packet;
  }
  function assertComplete(packet) {
    for (const source of packet.sources) {
      assert.strictEqual(source.state, 'read', `${source.id} was not actually read: ${source.why}`);
      assert.ok(source.documentsConsulted > 0, `${source.id} did not consult its nonempty fixture`);
    }
  }
  const hit = query('quokka telemetry', 0, 'hit');
  assertComplete(hit);
  for (const [source, locator] of [
    ['ledger', 'reports/OWNER-REQUEST-LEDGER.json#R9002'],
    ['board', 'memory:agent-coord/wave-nine-territory'],
  ]) {
    assert.ok(hit.results.some(result => result.source === source && result.locator === locator),
      `a successful CLI search omitted the known ${source} result ${locator}`);
  }
  const docsHit = query('systems', 0, 'hit');
  assertComplete(docsHit);
  assert.ok(docsHit.results.some(result => result.source === 'docs' && result.locator === 'context/SYSTEMS.md'),
    'the real CLI did not find the known delegated docs result');
  const absentTopic = 'xylophone marmalade zeppelin quokkatronic';
  const miss = query(absentTopic, 3, 'miss');
  assertComplete(miss);
  assert.deepStrictEqual(miss.results, [], 'a genuine gap must have no results');
  assert.strictEqual(miss.reason, 'EVERY_ENABLED_SOURCE_READ_AND_EMPTY');

  // The other production resolution must also work: an installed shell
  // redirects mutable reports into its configured state root. Move the only
  // ledger there, then remove it after priming the persistent retrieval cache.
  const stateLedger = path.join(stateRoot, 'reports', 'OWNER-REQUEST-LEDGER.json');
  fs.renameSync(programLedger, stateLedger);
  const relocated = query('quokka telemetry', 0, 'hit');
  assertComplete(relocated);
  assert.ok(relocated.results.some(result => result.source === 'ledger'
    && result.locator === 'local-app-data/ToolsEnabled Retrieval Test/capability/reports/OWNER-REQUEST-LEDGER.json#R9002'),
  'the CLI did not resolve the ledger from its configured state root');
  assert.ok(fs.statSync(w.options.dbPath).isFile(), 'the real CLI never created its disposable retrieval cache');
  assert.ok(fs.statSync(path.join(w.directory, 'context', '.prior-work-cache.json')).isFile(),
    'the delegated docs cache did not remain in the disposable program root');
  fs.unlinkSync(stateLedger);
  const unknown = query(absentTopic, 4, 'unknown');
  assert.deepStrictEqual(unknown.results, [], 'missing source data must not invent results');
  assert.strictEqual(unknown.reason, 'SOURCE_UNAVAILABLE');
  const unavailable = unknown.sources.filter(source => source.state !== 'read');
  assert.deepStrictEqual(unavailable.map(source => [source.id, source.state, source.code]),
    [['ledger', 'unavailable', 'LEDGER_FILE_ABSENT']], 'UNKNOWN must name exactly the fixture source that was removed');
  assert.ok(unavailable[0].why.length > 0, 'the unavailable ledger must have an actionable reason');
  const afterRemoval = query('quokka telemetry', 0, 'hit');
  assert.ok(afterRemoval.results.length > 0, 'the still-readable fixture sources disappeared');
  assert.ok(afterRemoval.results.every(result => result.source !== 'ledger'),
    'a removed ledger was still served from a stale retrieval cache');
});

check('the CLI renders a withheld answer as WITHHELD and never as an empty result list', () => {
  // Rendering is where an honest packet most easily becomes a dishonest screen:
  // "0 results" printed for a withheld surface reads exactly like a gap.
  const w = world('render');
  const settings = settingsFile(scratch('rn-s'), { 'retrieval.unified_search': false });
  const withheld = recallCli.renderMarkdown(recall('spend cap', { ...w.options, settings }));
  assert.match(withheld, /WITHHELD/);
  assert.ok(!/## Results/.test(withheld), 'a withheld answer rendered a results section');
  assert.match(withheld, /retrieval\.unified_search/, 'the render must name the control the user has to flip');

  const missPacket = recall('xylophone marmalade zeppelin', { ...w.options, settings: allOn(scratch('rn-m')) });
  const miss = recallCli.renderMarkdown(missPacket);
  assert.match(miss, /genuine gap/i, 'a real MISS must be rendered as a gap, not as an absence of output');
  assert.match(miss, /## Sources/, 'every rendered answer must account for the sources it read');

  assert.deepStrictEqual(recallCli.parseArgv(['node', 'recall.js', '--json', '--limit', '3', 'a', 'b']),
    { help: false, words: ['a', 'b'], asJson: true, limit: 3 });
});

check('tools/recall-index.js refuses to index a withheld source and exits 5', () => {
  const w = world('index-off');
  const settings = settingsFile(scratch('io-s'), { 'retrieval.unified_search': false });
  const result = buildIndex({ ...w.options, settings });
  assert.strictEqual(result.state, 'withheld');
  assert.strictEqual(result.exitCode, INDEX_EXIT.WITHHELD);
  assert.strictEqual(fs.existsSync(w.options.dbPath), false,
    'the indexer built a store for a surface the user switched off');
});

check('tools/recall-index.js reports 4, not 0, when an enabled source cannot be indexed', () => {
  const w = world('index-broken', { noBoard: true });
  const result = buildIndex({ ...w.options, settings: allOn(scratch('ib-s')) });
  assert.strictEqual(result.exitCode, INDEX_EXIT.UNKNOWN,
    'an index run that could not read an enabled source reported success');
  assert.ok(result.sources.some(entry => entry.state === 'unavailable' && entry.code === 'BOARD_STORE_ABSENT'));
});

check('tools/recall-index.js refuses a refresh report that omits an enabled source', () => {
  const w = world('index-missing-status');
  /* INJECT THROUGH THE SEAM, never by assigning onto the module. fts-index.js
   * exports Object.freeze({...}), so `fts.ensureFresh = ...` is silently
   * refused in non-strict mode: the real function then runs, every source
   * reports fresh, and this assertion cannot hold no matter how the gate
   * behaves. That is precisely how this check shipped permanently red. */
  try {
    const result = buildIndex({
      ...w.options,
      settings: allOn(scratch('ims-s')),
      ensureFresh: () => [],
    });
    assert.strictEqual(result.exitCode, INDEX_EXIT.UNKNOWN,
      'an index run with no status for enabled sources reported success');
    assert.ok(result.sources.some(entry => entry.state === 'unavailable'
      && entry.code === 'SOURCE_INDEX_STATUS_MISSING'));
  } finally {
    /* Nothing to restore: the injection rides in options and touches no module
     * state, which is the point -- the previous version restored a property it
     * had never actually managed to set. */
  }
});

// --------------------------------------------------------------------------
// 4. THE INDEX -- granularity, self-healing, redaction, write-failure
// --------------------------------------------------------------------------

console.log('R1246 retrieval: the index itself');

check('the ledger is indexed one document PER REQUEST, not as one file', () => {
  const w = world('granular');
  const store = fts.openStore({ dbPath: w.options.dbPath });
  fts.ensureFresh(store.db, [sources.SOURCE_BY_ID.get('ledger')], w.options);
  const rows = store.db.prepare("SELECT docId FROM docs WHERE source = 'ledger' ORDER BY docId").all();
  store.db.close();
  assert.deepStrictEqual(rows.map(row => row.docId), ['R9001', 'R9002', 'R9003'],
    'the 1.3MB ledger must decompose into per-R-number documents; one blob is the defect this replaces');
});

check('a secret-shaped line in a verbatim never reaches the index', () => {
  const w = world('secret');
  const store = fts.openStore({ dbPath: w.options.dbPath });
  fts.ensureFresh(store.db, [sources.SOURCE_BY_ID.get('ledger')], w.options);
  const bodies = store.db.prepare("SELECT body FROM docs WHERE source = 'ledger'").all().map(row => row.body).join('\n');
  const matched = store.db.prepare('SELECT docId FROM docs WHERE docs MATCH ?').all('"sk"').length;
  store.db.close();
  assert.ok(!bodies.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'),
    'a bearer-token-shaped line was copied into a second store');
  assert.ok(bodies.includes('rotate the deploy credential'),
    'redaction removed the whole record instead of the one secret-shaped line');
  assert.strictEqual(matched, 0, 'the redacted token is reachable through the index');
});

check('the index self-heals: a request added after the first query is found by the second', () => {
  const w = world('selfheal');
  const settings = allOn(scratch('sh-s'));
  const before = recall('brachiosaurus', { ...w.options, settings });
  assert.strictEqual(before.results.length, 0);

  const document = JSON.parse(fs.readFileSync(w.options.ledgerPath, 'utf8'));
  document.requests.push({
    id: 'R9004', verbatim: 'the brachiosaurus report needs a chart', request: '(interpretation) add a chart',
    status: 'open', scope: 'global', gates: [], provenance: { class: 'owner-stated', recordedAt: '2026-08-04T00:00:00.000Z' },
  });
  fs.writeFileSync(w.options.ledgerPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  // Deliberately NO rebuild command. An index that is only correct after
  // somebody remembers a command is an index that is usually wrong.
  const after = recall('brachiosaurus', { ...w.options, settings });
  assert.strictEqual(after.outcome, 'hit',
    'a request added one second ago was not in the answer one second later; the freshness check is not running');
  assert.ok(after.results.some(result => result.locator.endsWith('#R9004')));
});

check('an unwritable index falls back to memory and still answers correctly', () => {
  const w = world('unwritable');
  // A directory where the DB file should be: opening it as a database fails the
  // same way a locked or read-only path does.
  fs.mkdirSync(w.options.dbPath, { recursive: true });
  const packet = recall('spend cap', { ...w.options, settings: allOn(scratch('uw-s')) });
  assert.strictEqual(packet.index.storage, 'memory',
    'a failed index open must fall back, not fail');
  assert.strictEqual(packet.outcome, 'hit',
    'a cache write failure was turned into "this topic does not exist"');
  assert.match(packet.index.why, /could not be opened/);
});

check('the query tokenizer splits the way FTS5 unicode61 splits, so a term can never be unfindable', () => {
  assert.deepStrictEqual(fts.tokenize('agent_coord board'), ['agent', 'coord', 'board'],
    'underscore is a separator in unicode61; a query term the index cannot contain produces a false MISS');
  assert.deepStrictEqual(fts.tokenize('R1246'), ['r1246']);
  assert.deepStrictEqual(fts.tokenize('the a of is'), []);
});

// --------------------------------------------------------------------------
// 5. DELEGATION, NOT DUPLICATION (R1237 C7 keeps ownership of docs/)
// --------------------------------------------------------------------------

console.log('R1246 retrieval: docs stays owned by tools/prior-work-index.js');

check('docs results come from the prior-work index and are NOT copied into the FTS store', () => {
  const w = world('delegate');
  const packet = recall('spend cap provenance', { ...w.options, settings: allOn(scratch('dl-s')) });
  const docsSource = packet.sources.find(entry => entry.id === 'docs');
  assert.strictEqual(docsSource.delegatedTo, 'tools/prior-work-index.js',
    'the docs source must delegate; a second docs index would disagree with the first, silently');
  const docsResults = packet.results.filter(result => result.source === 'docs');
  assert.ok(docsResults.length >= 1, 'the delegated source returned nothing for a topic its corpus covers');
  assert.ok(docsResults.every(result => result.scoreScale === 'prior-work-weight-idf'),
    'a delegated result was relabelled onto the FTS scale, inventing a common ordering that does not exist');

  const store = new DatabaseSync(w.options.dbPath, { readOnly: true });
  const copied = store.prepare("SELECT COUNT(*) AS c FROM docs WHERE source = 'docs'").get().c;
  store.close();
  assert.strictEqual(copied, 0, 'docs/ was copied into this surface\'s own index -- that is the duplication R1237 C7 forbids');
});

check('an UNKNOWN from the delegated index propagates as UNKNOWN, not as an empty docs corpus', () => {
  const w = world('delegate-unknown');
  // A docs root with no scopes at all: prior-work-index reports CORPUS_INCOMPLETE.
  const emptyRoot = scratch('emptyroot');
  const packet = recall('xylophone marmalade zeppelin',
    { ...w.options, docsRoot: emptyRoot, settings: allOn(scratch('du-s')) });
  const docsSource = packet.sources.find(entry => entry.id === 'docs');
  assert.strictEqual(docsSource.state, 'unavailable',
    'the delegated index said "I could not look" and this surface reported "nothing exists"');
  assert.strictEqual(docsSource.code, 'DOCS_CORPUS_INCOMPLETE');
  assert.strictEqual(packet.outcome, 'unknown');
});

// --------------------------------------------------------------------------
// 6. THE EMBEDDING SEAM -- three states, never two
// --------------------------------------------------------------------------

console.log('R1246 retrieval: the post-launch embedding seam');

check('meaning search OFF says so, and keyword ranking is what ran', () => {
  const w = world('seam-off');
  const packet = recall('spend cap', { ...w.options, settings: allOn(scratch('so-s')) });
  assert.strictEqual(packet.ranking.state, 'disabled-by-setting');
  assert.strictEqual(packet.ranking.ranker, 'fts5-bm25');
});

check('meaning search ON with no backend installed reports UNAVAILABLE in the answer, and still answers', () => {
  const w = world('seam-missing');
  const settings = allOn(scratch('sm-s'), { 'retrieval.meaning_search': true });
  const packet = recall('spend cap', { ...w.options, settings });
  assert.strictEqual(packet.ranking.state, 'unavailable',
    'the user asked for meaning-based ranking, none was installed, and the product said nothing -- absence read as consent');
  assert.match(packet.ranking.why, /not the ranking you asked for/);
  assert.ok(packet.results.length > 0, 'a missing re-ranker must not withhold the answer itself');
});

check('a registered, available backend actually re-ranks and is named', () => {
  const w = world('seam-active');
  backends.registerBackend({
    name: 'test-reverser', kind: 'semantic', settingId: 'retrieval.meaning_search',
    available: () => true, rerank: candidates => candidates.slice().reverse(),
  });
  try {
    const settings = allOn(scratch('sa-s'), { 'retrieval.meaning_search': true });
    const baseline = recall('spend cap quokka', { ...w.options, settings: allOn(scratch('sa-b')) });
    const reranked = recall('spend cap quokka', { ...w.options, settings });
    assert.strictEqual(reranked.ranking.state, 'active');
    assert.strictEqual(reranked.ranking.backend, 'test-reverser');
    assert.deepStrictEqual(
      reranked.results.map(result => result.locator),
      baseline.results.map(result => result.locator).reverse(),
      'the registered backend did not actually affect the order, so the seam is decorative'
    );
  } finally {
    backends.unregisterBackend('test-reverser');
  }
});

check('a backend that invents a result is refused and the baseline order is kept', () => {
  const w = world('seam-cheat');
  backends.registerBackend({
    name: 'test-inventor', kind: 'semantic', settingId: 'retrieval.meaning_search',
    available: () => true,
    rerank: candidates => candidates.map(() => ({ source: 'ledger', docId: 'FABRICATED', locator: 'nowhere' })),
  });
  try {
    const settings = allOn(scratch('sc-s'), { 'retrieval.meaning_search': true });
    const packet = recall('spend cap', { ...w.options, settings });
    assert.ok(packet.ranking.contractViolation, 'a backend fabricated a result and it was accepted');
    assert.ok(!packet.results.some(result => result.docId === 'FABRICATED'));
  } finally {
    backends.unregisterBackend('test-inventor');
  }
});

check('a backend that duplicates one result and drops another is refused', () => {
  const w = world('seam-duplicate');
  backends.registerBackend({
    name: 'test-duplicator', kind: 'semantic', settingId: 'retrieval.meaning_search',
    available: () => true,
    rerank: candidates => candidates.map(() => candidates[0]),
  });
  try {
    const settings = allOn(scratch('sd-s'), { 'retrieval.meaning_search': true });
    const packet = recall('spend cap quokka', { ...w.options, settings });
    assert.ok(packet.results.length > 1, 'the caller did not produce enough candidates to exercise replacement');
    assert.ok(packet.ranking.contractViolation,
      'a backend replaced one candidate with a duplicate and the incomplete membership check accepted it');
    assert.notStrictEqual(packet.results[0].docId, packet.results[1].docId,
      'the duplicate re-rank was returned instead of the baseline order');
  } finally {
    backends.unregisterBackend('test-duplicator');
  }
});

check('registerBackend refuses a backend that is not gated by a retrieval.* control', () => {
  assert.throws(() => backends.registerBackend({
    name: 'ungated', kind: 'semantic', settingId: 'something.else', available: () => true, rerank: c => c,
  }), /settingId must name a retrieval/);
});

// --------------------------------------------------------------------------
// 7. THE GATE, DIRECTLY
// --------------------------------------------------------------------------

console.log('R1246 retrieval: the gate as a unit');

check('surface-off and every-source-off are reported as DIFFERENT reasons', () => {
  const w = world('two-offs');
  const surfaceOff = settingsFile(scratch('so'), {
    'retrieval.unified_search': false,
    'retrieval.search_request_ledger': true,
    'retrieval.search_documents': true,
    'retrieval.search_coordination_board': true,
  });
  const sourcesOff = settingsFile(scratch('vo'), {
    'retrieval.unified_search': true,
    'retrieval.search_request_ledger': false,
    'retrieval.search_documents': false,
    'retrieval.search_coordination_board': false,
  });
  const a = recall('spend cap', { ...w.options, settings: surfaceOff });
  const b = recall('spend cap', { ...w.options, settings: sourcesOff });
  assert.strictEqual(a.outcome, 'withheld');
  assert.strictEqual(b.outcome, 'withheld');
  assert.strictEqual(a.reason, 'SURFACE_DISABLED_BY_SETTINGS');
  assert.strictEqual(b.reason, 'EVERY_SOURCE_DISABLED_BY_SETTINGS',
    'turning off the whole surface and turning off every source produced the same message; a user cannot tell '
    + 'which switch to flip from it');
  assert.notStrictEqual(a.why, b.why);
});

check('the master toggle is a fence: an ON source under an OFF surface is still withheld', () => {
  const settings = settingsFile(scratch('fence'), {
    'retrieval.unified_search': false,
    'retrieval.search_request_ledger': true,
  });
  const decisions = gate({ settings });
  assert.strictEqual(decisions.surfaceWithheld, true);
  const ledger = decisions.sources.find(entry => entry.id === 'ledger');
  assert.strictEqual(ledger.state, GATE_STATE.WITHHELD,
    'a source stayed enabled under a disabled surface, so the master switch is advisory');
  assert.deepStrictEqual([...decisions.enabledSourceIds], []);
});

check('decideToggle distinguishes unclassified from withheld', () => {
  const settings = settingsFile(scratch('dt'), { 'retrieval.unified_search': true });
  assert.strictEqual(decideToggle(settings, 'retrieval.does_not_exist').state, GATE_STATE.UNCLASSIFIED);
  assert.strictEqual(decideToggle(settings, 'retrieval.search_documents').state, GATE_STATE.WITHHELD);
  assert.strictEqual(decideToggle(settings, 'retrieval.unified_search').state, GATE_STATE.ENABLED);
});

check('every registered source names a control that exists in the shipped settings registry', () => {
  // The other half of the unclassified rule: it must be impossible to ship a
  // source with no user control, not merely refused at runtime.
  const settings = loadSettings({ valuesPath: path.join(scratch('shipped'), 'none.json') });
  assert.deepStrictEqual(sources.SOURCES.map(source => source.id), ['ledger', 'board', 'docs'],
    'the shipped source registry was empty or its expected retrieval sources disappeared');
  for (const source of sources.SOURCES) {
    assert.ok(Object.prototype.hasOwnProperty.call(settings.values, source.settingId),
      `source "${source.id}" is gated by "${source.settingId}", which is not in config/settings-registry.json`);
    assert.strictEqual(settings.values[source.settingId], false,
      `"${source.settingId}" ships defaulted to ${JSON.stringify(settings.values[source.settingId])}; `
      + 'every retrieval control must ship OFF so absence is never consent');
  }
});

// --------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.log(`R1246 retrieval: ${checks} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.log(`  - ${failure.label}: ${failure.error && failure.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`R1246 retrieval: all ${checks} behavioural checks passed.`);
}
