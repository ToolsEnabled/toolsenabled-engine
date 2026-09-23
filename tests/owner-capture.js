'use strict';

// Tests for tools/owner-capture.js. Every test that touches a ledger file
// operates on a TEMP COPY written under os.tmpdir() -- never on
// reports/OWNER-REQUEST-LEDGER.json, the production record. Each helper
// below that writes a fixture creates a brand-new temp directory, so tests
// cannot interfere with each other's on-disk state.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'tools', 'owner-capture.js');

const {
  parseArgs, validateLedgerShape, applyNewEntry, applyAppend, finalizeLedger,
  toGateObject, atomicWriteLedgerWithBackup, acquireLedgerLock, todayString,
  printUsage, OwnerCaptureError, ID_PATTERN, ALLOWED_CAPTURE_STATUSES,
  hasRuntimeGateWord, assertRuntimeGateEvidence, assertCaptureActor, THREAD_ID_PATTERN, CAPTURE_SCOPES, normalizeCaptureScope
} = require('../tools/owner-capture');

const { assertGatesMet, readGates } = require('../src/lib/egress-preflight');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };

// --- fixture helpers ---------------------------------------------------------

function fixtureLedgerData() {
  return {
    $comment: ['TEST FIXTURE -- not the real ledger.'],
    schemaVersion: 1,
    revision: 3,
    sessionLabel: 'owner-capture test fixture',
    updatedAt: '2020-01-01',
    maintainedBy: 'test-harness',
    statusVocabulary: {
      done: 'Delivered and independently verified.',
      partial: 'Substantially delivered with a stated shortfall.',
      'in-progress': 'Actively being worked.',
      open: 'Accepted, not started.',
      'blocked-external': 'Cannot proceed without owner action.',
      'not-possible-as-asked': 'The literal request cannot be satisfied.'
    },
    requests: [
      { id: 'R01', request: 'A plain existing request with no verbatim field.', status: 'done', evidence: 'x' },
      {
        id: 'R44',
        verbatim: "[1] 'also there is a document somewhere, my most recent mcnari draft'",
        request: '(interpretation) find and finish the mcnair draft',
        status: 'done',
        gates: [{ instruction: 'verify against the previously submitted version', met: false, evidence: '' }]
      }
    ],
    controllerNotes: ['fixture note']
  };
}

// Writes a fresh copy of the fixture to its own temp directory and returns
// the file path. Every test gets an isolated file so mutations in one test
// can never leak into another.
function freshLedgerFile(overrideData) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-capture-test-'));
  const file = path.join(directory, 'OWNER-REQUEST-LEDGER.json');
  fs.writeFileSync(file, JSON.stringify(overrideData || fixtureLedgerData(), null, 2), 'utf8');
  return file;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, windowsHide: true, env: process.env, ...options
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// =============================================================================
// Pure function unit tests -- no subprocess, no disk.
// =============================================================================

check('parseArgs accumulates ordered hedged and unhedged gates and leaves others singular', () => {
  const parsed = parseArgs(['--new-id', 'R90', '--gate', 'a', '--hedged-gate', 'b', '--actor', 'controller']);
  assert.deepEqual(parsed.gate, [{ instruction: 'a', hedged: false }, { instruction: 'b', hedged: true }]);
  assert.equal(parsed['new-id'], 'R90');
  assert.equal(parsed.actor, 'controller');
});

check('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus', 'x']), error => error.code === 'OWNER_CAPTURE_USAGE');
});

check('parseArgs rejects a flag with a missing value', () => {
  assert.throws(() => parseArgs(['--actor']), error => error.code === 'OWNER_CAPTURE_USAGE');
  assert.throws(() => parseArgs(['--actor', '--new-id', 'R90']), error => error.code === 'OWNER_CAPTURE_USAGE');
});

check('parseArgs rejects a duplicate non-repeatable flag', () => {
  assert.throws(() => parseArgs(['--actor', 'a', '--actor', 'b']), error => error.code === 'OWNER_CAPTURE_USAGE');
});

check('parseArgs recognizes --help', () => {
  assert.equal(parseArgs(['--help']).help, true);
});

check('ID_PATTERN accepts the ledger convention, dotted refinements included, and rejects malformed ids', () => {
  for (const good of ['R01', 'R44', 'R9', 'R9999', 'R3.1', 'R3.1.2', 'R44.12']) assert.ok(ID_PATTERN.test(good), good);
  for (const bad of ['44', 'r44', 'R', 'R4a', ' R44', 'R44 ', 'R3.0', 'R3.01', 'R3.', 'R00000', 'RS3', 'RT2.1']) assert.ok(!ID_PATTERN.test(bad), bad);
});

check('ALLOWED_CAPTURE_STATUSES excludes done/partial/not-possible-as-asked', () => {
  assert.ok(ALLOWED_CAPTURE_STATUSES.has('open'));
  assert.ok(ALLOWED_CAPTURE_STATUSES.has('in-progress'));
  assert.ok(ALLOWED_CAPTURE_STATUSES.has('blocked-external'));
  assert.ok(!ALLOWED_CAPTURE_STATUSES.has('done'));
  assert.ok(!ALLOWED_CAPTURE_STATUSES.has('partial'));
  assert.ok(!ALLOWED_CAPTURE_STATUSES.has('not-possible-as-asked'));
});

check('capture authority accepts ledger-custody roles and refuses unverified relay actors', () => {
  for (const actor of ['controller', 'codex-controller-machine-b', 'coordinator', 'claude-planning-operations']) {
    assert.equal(assertCaptureActor(actor), actor);
  }
  for (const actor of ['codex', 'claude', 'gemini-builder', 'codex-worker-machine-a', 'shadow-manager', 'owner-telegram']) {
    assert.throws(() => assertCaptureActor(actor), error => error.code === 'OWNER_CAPTURE_AGENT_TEXT_REFUSED');
  }
  assert.equal(assertCaptureActor('owner-telegram', 'historical owner-chat sequence 412'), 'owner-telegram',
    'a legacy label is an ordinary cited relay, never a privileged owner identity');
});

check('toGateObject records an explicit hedge marker while retaining string-call compatibility', () => {
  assert.deepEqual(toGateObject('do the thing'), { instruction: 'do the thing', hedged: false, met: false, evidence: '' });
  assert.deepEqual(toGateObject({ instruction: 'maybe do the thing', hedged: true }), { instruction: 'maybe do the thing', hedged: true, met: false, evidence: '' });
});

check('capture scope grammar keeps global unbound and requires a stable key for every other tier', () => {
  // MEASURED 2026-09-03: the canonical ledger (src/lib/owner-request-store.js
  // SCOPES) has carried four tiers -- global, session, tree, thread -- since
  // the owner's 2026-09-02 ruling, and every other writer already speaks all
  // four. This tool answered OWNER_CAPTURE_SCOPE_INVALID for 'session' and
  // 'tree' until now, so a spooled turn shell/agent-host.cjs spoolPersonTurn
  // had tagged scope:'session' could never be promoted back at that same tier.
  assert.deepEqual([...CAPTURE_SCOPES].sort(), ['global', 'session', 'thread', 'tree']);
  for (const valid of ['thread-1', 'owner.thread:alpha']) assert.ok(THREAD_ID_PATTERN.test(valid), valid);
  for (const invalid of ['', 'thread id', 'thread/id', '.thread']) assert.ok(!THREAD_ID_PATTERN.test(invalid), invalid);
  assert.deepEqual(normalizeCaptureScope(), { scope: 'global', threadId: null });
  for (const scope of ['session', 'tree', 'thread']) {
    assert.deepEqual(normalizeCaptureScope(scope, 'key-1'), { scope, threadId: 'key-1' });
    assert.throws(() => normalizeCaptureScope(scope, null), error => error.code === 'OWNER_CAPTURE_SCOPE_INVALID');
  }
  assert.throws(() => normalizeCaptureScope('global', 'thread-1'), error => error.code === 'OWNER_CAPTURE_SCOPE_INVALID');
  assert.throws(() => normalizeCaptureScope('tree-anchor'), error => error.code === 'OWNER_CAPTURE_SCOPE_INVALID');
});

check('todayString returns YYYY-MM-DD', () => {
  assert.match(todayString(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(todayString(new Date('2026-07-28T16:50:43Z')), '2026-07-28');
});

check('validateLedgerShape accepts the fixture', () => {
  validateLedgerShape(fixtureLedgerData(), 'fixture');
});

check('validateLedgerShape rejects a non-object, a missing requests array, and duplicate ids', () => {
  assert.throws(() => validateLedgerShape(null, 'x'), error => error.code === 'OWNER_CAPTURE_LEDGER_SHAPE');
  assert.throws(() => validateLedgerShape([], 'x'), error => error.code === 'OWNER_CAPTURE_LEDGER_SHAPE');
  assert.throws(() => validateLedgerShape({}, 'x'), error => error.code === 'OWNER_CAPTURE_LEDGER_SHAPE');
  assert.throws(
    () => validateLedgerShape({ requests: [{ id: 'R01' }, { id: 'R01' }] }, 'x'),
    error => error.code === 'OWNER_CAPTURE_LEDGER_SHAPE'
  );
  assert.throws(
    () => validateLedgerShape({ requests: [{ id: '' }] }, 'x'),
    error => error.code === 'OWNER_CAPTURE_LEDGER_SHAPE'
  );
});

check('applyNewEntry builds an entry labeled "(interpretation)" per STANDING-ORDERS 1a, defaulting status to open', () => {
  const data = fixtureLedgerData();
  const next = applyNewEntry(data, {
    id: 'R90', text: 'the owner said this exact thing', interpretation: 'do the thing',
    status: 'open', gates: ['gate one', 'gate two'], actor: 'controller', timestamp: '2026-07-28T00:00:00.000Z'
  });
  const entry = next.requests.find(r => r.id === 'R90');
  assert.equal(entry.verbatim, 'the owner said this exact thing');
  assert.equal(entry.request, '(interpretation) do the thing');
  assert.equal(entry.status, 'open');
  assert.deepEqual(entry.gates, [
    { instruction: 'gate one', hedged: false, met: false, evidence: '' },
    { instruction: 'gate two', hedged: false, met: false, evidence: '' }
  ]);
  assert.equal(entry.scope, 'global');
  assert.equal(entry.scopeKey, null);
  assert.equal(entry.threadId, null);
  assert.deepEqual(entry.captureLog, [{ at: '2026-07-28T00:00:00.000Z', actor: 'controller', mode: 'new', gatesAdded: 2 }]);
  // the original object is not mutated
  assert.equal(data.requests.length, 2);
});

check('applyNewEntry keys session and tree scope on scopeKey with no threadId, and mirrors thread scope into both', () => {
  // The canonical store (src/lib/owner-request-store.js normalizeRecord)
  // reads scopeKey for every non-global scope, and treats threadId as an
  // alias populated only when scope is literally 'thread'. This tool's entry
  // must match that shape for a session- or tree-scoped capture to be
  // readable at its own tier rather than silently landing nowhere any reader
  // looks.
  for (const scope of ['session', 'tree']) {
    const data = fixtureLedgerData();
    const next = applyNewEntry(data, {
      id: 'R90', text: 'the owner said this exact thing', interpretation: 'do the thing', status: 'open',
      scope, threadId: 'key-1', gates: [], actor: 'controller', timestamp: '2026-07-28T00:00:00.000Z'
    });
    const entry = next.requests.find(r => r.id === 'R90');
    assert.equal(entry.scope, scope);
    assert.equal(entry.scopeKey, 'key-1', `${scope}: scopeKey must carry the key`);
    assert.equal(entry.threadId, null, `${scope}: threadId must stay null, not be overloaded with a ${scope} key`);
  }
  const threadData = fixtureLedgerData();
  const threadNext = applyNewEntry(threadData, {
    id: 'R90', text: 'x', interpretation: 'y', status: 'open',
    scope: 'thread', threadId: 'key-1', gates: [], actor: 'controller', timestamp: '2026-07-28T00:00:00.000Z'
  });
  const threadEntry = threadNext.requests.find(r => r.id === 'R90');
  assert.equal(threadEntry.scopeKey, 'key-1');
  assert.equal(threadEntry.threadId, 'key-1', 'thread scope alone still mirrors the key into threadId, unchanged');
});

check('applyNewEntry refuses a duplicate id with a typed OwnerCaptureError', () => {
  const data = fixtureLedgerData();
  assert.throws(
    () => applyNewEntry(data, { id: 'R44', text: 'x', interpretation: 'y', status: 'open', gates: [], actor: 'controller', timestamp: 't' }),
    error => error instanceof OwnerCaptureError && error.code === 'OWNER_CAPTURE_ID_EXISTS'
  );
});

check('applyAppend strictly extends existing verbatim text and never rewrites it', () => {
  const data = fixtureLedgerData();
  const before = data.requests.find(r => r.id === 'R44').verbatim;
  const next = applyAppend(data, {
    id: 'R44', text: "go to rweb and pull the previous week submission and check, that i had submitted like last monday",
    gates: [], actor: 'controller', timestamp: '2026-07-28T01:00:00.000Z'
  });
  const entry = next.requests.find(r => r.id === 'R44');
  assert.ok(entry.verbatim.startsWith(before), 'the original verbatim text must survive unmodified as a prefix');
  assert.ok(entry.verbatim.length > before.length);
  // the exact clause that was paraphrased away in the real R44 incident must
  // survive byte-for-byte in the appended text.
  assert.ok(entry.verbatim.includes('that i had submitted like last monday'));
  // the original fixture object is untouched
  assert.equal(data.requests.find(r => r.id === 'R44').verbatim, before);
});

check('applyAppend on an entry with no prior verbatim field starts clean, not "undefined..."', () => {
  const data = fixtureLedgerData(); // R01 has no verbatim field at all
  const next = applyAppend(data, { id: 'R01', text: 'first captured words for R01', gates: [], actor: 'controller', timestamp: 't' });
  assert.equal(next.requests.find(r => r.id === 'R01').verbatim, 'first captured words for R01');
});

check('applyAppend appends new gates onto existing gates without disturbing them', () => {
  const data = fixtureLedgerData();
  const next = applyAppend(data, { id: 'R44', text: 'more words', gates: ['a new sub-instruction'], actor: 'controller', timestamp: 't' });
  const entry = next.requests.find(r => r.id === 'R44');
  assert.equal(entry.gates.length, 2);
  assert.equal(entry.gates[0].instruction, 'verify against the previously submitted version');
  assert.equal(entry.gates[1].instruction, 'a new sub-instruction');
  assert.equal(entry.gates[1].hedged, false);
});

check('applyNewEntry preserves an explicit thread classification and hedged gate', () => {
  const entry = applyNewEntry(fixtureLedgerData(), {
    id: 'R90', text: 'maybe do this for this thread', interpretation: 'explore it', status: 'open',
    scope: 'thread', threadId: 'thread-123', gates: [{ instruction: 'maybe use this approach', hedged: true }],
    actor: 'controller', timestamp: '2026-07-28T00:00:00.000Z'
  }).requests.find(request => request.id === 'R90');
  assert.equal(entry.scope, 'thread');
  assert.equal(entry.threadId, 'thread-123');
  assert.deepEqual(entry.gates, [{ instruction: 'maybe use this approach', hedged: true, met: false, evidence: '' }]);
});

check('applyAppend refuses an id that does not exist', () => {
  const data = fixtureLedgerData();
  assert.throws(
    () => applyAppend(data, { id: 'R999', text: 'x', gates: [], actor: 'controller', timestamp: 't' }),
    error => error.code === 'OWNER_CAPTURE_REQUEST_NOT_FOUND'
  );
});

check('applyAppend leaves every other field of the entry untouched', () => {
  const data = fixtureLedgerData();
  const next = applyAppend(data, { id: 'R44', text: 'x', gates: [], actor: 'controller', timestamp: 't' });
  const entry = next.requests.find(r => r.id === 'R44');
  assert.equal(entry.request, '(interpretation) find and finish the mcnair draft');
  assert.equal(entry.status, 'done');
});

check('finalizeLedger increments an integer revision and defaults a missing one to 1', () => {
  const withRevision = finalizeLedger({ revision: 7, requests: [] }, []);
  assert.equal(withRevision.revision, 8);
  const withoutRevision = finalizeLedger({ requests: [] }, []);
  assert.equal(withoutRevision.revision, 1);
  assert.match(withRevision.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
});

check('printUsage writes to the given stream without throwing', () => {
  const chunks = [];
  printUsage({ write: (text) => chunks.push(text) });
  assert.ok(chunks.join('').includes('--new-id'));
});

check('acquireLedgerLock serializes against itself and reports the holder pid', () => {
  const file = freshLedgerFile();
  const lock = acquireLedgerLock(file);
  try {
    assert.throws(() => acquireLedgerLock(file), (error) => {
      assert.equal(error.code, 'OWNER_CAPTURE_LEDGER_LOCKED');
      assert.equal(error.holderPid, process.pid);
      return true;
    });
  } finally {
    lock.release();
  }
  // released: a fresh acquire now succeeds
  const second = acquireLedgerLock(file);
  second.release();
});

check('atomicWriteLedgerWithBackup writes a valid file and a byte-identical .bak of the previous content', () => {
  const file = freshLedgerFile();
  const previousRaw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(previousRaw);
  const next = applyAppend(data, { id: 'R44', text: 'atomic write test', gates: [], actor: 'controller', timestamp: 't' });
  atomicWriteLedgerWithBackup(file, previousRaw, next);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), previousRaw);
  const written = readJson(file);
  assert.ok(written.requests.find(r => r.id === 'R44').verbatim.includes('atomic write test'));
  // no leftover temp files
  const directory = path.dirname(file);
  const leftovers = fs.readdirSync(directory).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// =============================================================================
// End-to-end CLI tests -- real subprocess, real temp-copy ledger file.
// Every invocation below passes --ledger pointing at a freshLedgerFile()
// temp copy; the real reports/OWNER-REQUEST-LEDGER.json is never touched.
// =============================================================================

check('CLI: --new-id creates an entry from --text, exits 0, prints a JSON summary', () => {
  const file = freshLedgerFile();
  const result = runCli([
    '--ledger', file, '--new-id', 'R90', '--interpretation', 'do the new thing',
    '--actor', 'controller', '--gate', 'first sub-instruction', '--text', "the owner's exact words"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.mode, 'new');
  assert.equal(summary.id, 'R90');
  assert.equal(summary.gatesAdded, 1);

  const written = readJson(file);
  const entry = written.requests.find(r => r.id === 'R90');
  assert.equal(entry.verbatim, "the owner's exact words");
  assert.equal(entry.status, 'open');
  assert.equal(entry.request, '(interpretation) do the new thing');
  assert.equal(entry.scope, 'global');
  assert.equal(entry.threadId, null);
  assert.equal(written.revision, 4); // fixture started at revision 3
});

check('CLI: every keyed scope requires a stable --thread-id and rejects thread-id for global/append', () => {
  const file = freshLedgerFile();
  for (const scope of ['session', 'tree', 'thread']) {
    const missing = runCli(['--ledger', file, '--new-id', 'R91', '--interpretation', 'x', '--actor', 'controller', '--text', 'x', '--scope', scope]);
    assert.equal(missing.status, 1, scope);
    assert.match(missing.stderr, /OWNER_CAPTURE_USAGE/, scope);
  }
  const globalWithThread = runCli(['--ledger', file, '--new-id', 'R91', '--interpretation', 'x', '--actor', 'controller', '--text', 'x', '--thread-id', 'thread-1']);
  assert.equal(globalWithThread.status, 1);
  assert.match(globalWithThread.stderr, /OWNER_CAPTURE_USAGE/);
  const append = runCli(['--ledger', file, '--request-id', 'R44', '--actor', 'controller', '--text', 'x', '--scope', 'thread', '--thread-id', 'thread-1']);
  assert.equal(append.status, 1);
  assert.match(append.stderr, /OWNER_CAPTURE_USAGE/);
});

check('CLI: captures an explicit thread scope and hedged gate after persistence', () => {
  const file = freshLedgerFile();
  const result = runCli([
    '--ledger', file, '--new-id', 'R91', '--interpretation', 'explore the option', '--actor', 'controller', '--text', 'maybe do this',
    '--scope', 'thread', '--thread-id', 'thread-1', '--hedged-gate', 'maybe use this design'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const entry = readJson(file).requests.find(r => r.id === 'R91');
  assert.equal(entry.scope, 'thread');
  assert.equal(entry.threadId, 'thread-1');
  assert.deepEqual(entry.gates.at(-1), { instruction: 'maybe use this design', hedged: true, met: false, evidence: '' });
});

check('CLI: captures session and tree scope end to end -- the promotion path owner-spool-review.js drives for a turn an agent filed nothing for', () => {
  // Before this fix: `--scope session` (or `tree`) answered exit 1,
  // OWNER_CAPTURE_SCOPE_INVALID: scope must be global or thread -- so
  // tools/owner-spool-review.js --promote could never recover a spooled turn
  // (shell/agent-host.cjs spoolPersonTurn tags every one scope:'session') at
  // its own tier; only global or thread were reachable.
  for (const scope of ['session', 'tree']) {
    const file = freshLedgerFile();
    const result = runCli([
      '--ledger', file, '--new-id', 'R91', '--interpretation', 'explore the option', '--actor', 'controller', '--text', 'maybe do this',
      '--scope', scope, '--thread-id', 'key-1'
    ]);
    assert.equal(result.status, 0, `${scope}: ${result.stderr}`);
    const entry = readJson(file).requests.find(r => r.id === 'R91');
    assert.equal(entry.scope, scope);
    assert.equal(entry.scopeKey, 'key-1', `${scope}: the store's normalizeRecord reads scopeKey, not threadId, for this tier`);
    assert.equal(entry.threadId, null, `${scope}: threadId must not carry a ${scope} key`);
  }
});

check('CLI: reads the verbatim text from piped stdin when --text is omitted', () => {
  const file = freshLedgerFile();
  const result = runCli(
    ['--ledger', file, '--new-id', 'R91', '--interpretation', 'captured via stdin', '--actor', 'controller'],
    { input: "the owner's words piped on stdin\n" }
  );
  assert.equal(result.status, 0, result.stderr);
  const entry = readJson(file).requests.find(r => r.id === 'R91');
  assert.equal(entry.verbatim, "the owner's words piped on stdin");
});

check('CLI: --request-id appends to an existing entry and never shortens or rewrites its verbatim text', () => {
  const file = freshLedgerFile();
  const before = readJson(file).requests.find(r => r.id === 'R44').verbatim;
  const result = runCli([
    '--ledger', file, '--request-id', 'R44', '--actor', 'controller',
    '--text', "go pull the previous week submission and check, that i had submitted like last monday"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const after = readJson(file).requests.find(r => r.id === 'R44').verbatim;
  assert.ok(after.startsWith(before));
  assert.ok(after.includes('that i had submitted like last monday'));
});

check('CLI: refuses two captures that race the same ledger file (lock holds for the process lifetime of the first)', () => {
  // Not a true concurrency test (spawnSync is sequential), but proves the
  // lock file the CLI writes is visible and stale-reclaimable: acquire it
  // out-of-band, confirm the CLI is refused, release, confirm it then works.
  const file = freshLedgerFile();
  const lock = acquireLedgerLock(file);
  try {
    const result = runCli(['--ledger', file, '--new-id', 'R92', '--interpretation', 'x', '--actor', 'controller', '--text', 'x']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OWNER_CAPTURE_LEDGER_LOCKED/);
    assert.ok(!readJson(file).requests.some(r => r.id === 'R92'));
  } finally {
    lock.release();
  }
  const after = runCli(['--ledger', file, '--new-id', 'R92', '--interpretation', 'x', '--actor', 'controller', '--text', 'x']);
  assert.equal(after.status, 0, after.stderr);
});

check('CLI: a duplicate --new-id is refused and the ledger file is left byte-identical', () => {
  const file = freshLedgerFile();
  const before = fs.readFileSync(file, 'utf8');
  const result = runCli(['--ledger', file, '--new-id', 'R44', '--interpretation', 'x', '--actor', 'controller', '--text', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_ID_EXISTS/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!fs.existsSync(`${file}.bak`));
});

check('CLI: an unknown --request-id is refused', () => {
  const file = freshLedgerFile();
  const result = runCli(['--ledger', file, '--request-id', 'R999', '--actor', 'controller', '--text', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_REQUEST_NOT_FOUND/);
});

check('CLI: --actor is required', () => {
  const file = freshLedgerFile();
  const result = runCli(['--ledger', file, '--new-id', 'R93', '--interpretation', 'x', '--text', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_ACTOR_REQUIRED/);
});

check('CLI: an agent-authored Codex lane brief is REFUSED and the ledger stays byte-identical', () => {
  const file = freshLedgerFile();
  const before = fs.readFileSync(file, 'utf8');
  const result = runCli([
    '--ledger', file, '--new-id', 'R93', '--interpretation', 'agent lane brief',
    '--actor', 'codex', '--text', 'You are a Codex build lane. Implement this task and report back.'
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_AGENT_TEXT_REFUSED/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!fs.existsSync(`${file}.bak`));
});

check('CLI: requires exactly one of --new-id or --request-id (both and neither are rejected)', () => {
  const file = freshLedgerFile();
  const both = runCli(['--ledger', file, '--new-id', 'R94', '--request-id', 'R44', '--actor', 'controller', '--text', 'x', '--interpretation', 'y']);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /OWNER_CAPTURE_USAGE/);

  const neither = runCli(['--ledger', file, '--actor', 'controller', '--text', 'x']);
  assert.equal(neither.status, 1);
  assert.match(neither.stderr, /OWNER_CAPTURE_USAGE/);
});

check('CLI: --status can never be set to done/partial/not-possible-as-asked at capture time', () => {
  const file = freshLedgerFile();
  const result = runCli(['--ledger', file, '--new-id', 'R95', '--interpretation', 'x', '--actor', 'controller', '--text', 'x', '--status', 'done']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_USAGE/);
  assert.ok(!readJson(file).requests.some(r => r.id === 'R95'));
});

check('CLI: --interpretation and --status are rejected in append mode', () => {
  const file = freshLedgerFile();
  const withInterpretation = runCli(['--ledger', file, '--request-id', 'R44', '--actor', 'controller', '--text', 'x', '--interpretation', 'y']);
  assert.equal(withInterpretation.status, 1);
  assert.match(withInterpretation.stderr, /OWNER_CAPTURE_USAGE/);

  const withStatus = runCli(['--ledger', file, '--request-id', 'R44', '--actor', 'controller', '--text', 'x', '--status', 'open']);
  assert.equal(withStatus.status, 1);
  assert.match(withStatus.stderr, /OWNER_CAPTURE_USAGE/);
});

check('CLI: refuses to operate on a nonexistent ledger file rather than creating one', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-capture-test-')), 'does-not-exist.json');
  const result = runCli(['--ledger', missing, '--new-id', 'R96', '--interpretation', 'x', '--actor', 'controller', '--text', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_LEDGER_NOT_FOUND/);
  assert.ok(!fs.existsSync(missing));
});

check('CLI: refuses malformed JSON in the ledger file without touching it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-capture-test-'));
  const file = path.join(directory, 'broken.json');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  const result = runCli(['--ledger', file, '--new-id', 'R97', '--interpretation', 'x', '--actor', 'controller', '--text', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OWNER_CAPTURE_LEDGER_INVALID_JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not valid json');
});

check('CLI: --help exits 0 and prints usage without requiring any other flag', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--new-id/);
  assert.match(result.stdout, /--hedged-gate/);
});

// =============================================================================
// Cross-module wiring: a gate captured by owner-capture.js is consumable by
// the existing enforcement primitive in src/lib/egress-preflight.js on the
// same ledger file. This is the concrete replay of incident 2 (the dropped
// "go pull the previous submission and check" instruction): captured as a
// gate here, it must show up as an unmet, blocking precondition there.
// =============================================================================

check('a gate captured via owner-capture.js is read and enforced by egress-preflight.assertGatesMet on the same file', () => {
  const file = freshLedgerFile();
  const result = runCli([
    '--ledger', file, '--new-id', 'R98', '--interpretation', 'redo a submission properly',
    '--actor', 'controller', '--text', 'redo it and verify first this time',
    '--gate', 'go pull the previous week submission and check before rebuilding anything'
  ]);
  assert.equal(result.status, 0, result.stderr);

  const gates = readGates('R98', file);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].met, false);

  assert.throws(() => assertGatesMet('R98', file), (error) => {
    assert.equal(error.code, 'EGRESS_GATES_UNMET');
    assert.match(error.message, /go pull the previous week submission and check/);
    return true;
  });
});

// --- RECORD 2: an agent may never certify its own precondition --------------
//
// STANDING-ORDERS.md class RECORD, order 2: "Never mark a request done without
// independent verification. Never soften a status."
//
// The shape this refuses is not hypothetical: fleet lane s10 shipped a
// `set-gate` command that would have let an agent self-certify its own egress
// gate (GEMINI-LANE-DOCTRINE failure mode 5). It was caught by review. These
// pins make the next one fail at the writer instead of depending on a reviewer
// noticing -- the same explicit-checked-invariant style this file's own
// append-only verbatim rule already uses.
const { assertGatesAppendOnly } = require('../tools/owner-capture');

check('the gate writer refuses to CREATE a gate that is already met', () => {
  assert.throws(
    () => assertGatesAppendOnly('R99', [], [{ instruction: 'do the thing', met: true, evidence: 'trust me' }]),
    (error) => {
      assert.equal(error.code, 'OWNER_CAPTURE_GATES_NOT_APPEND_ONLY');
      assert.match(error.message, /already marked met/);
      assert.match(error.message, /an agent may never certify its own precondition/);
      assert.match(error.message, /Never soften a status/);
      return true;
    }
  );
});

check('the gate writer refuses to FLIP an existing gate to met', () => {
  const existing = [{ instruction: 'verify against the destination', met: false, evidence: '' }];
  assert.throws(
    () => assertGatesAppendOnly('R99', existing, [{ instruction: 'verify against the destination', met: true, evidence: 'done' }]),
    (error) => {
      assert.equal(error.code, 'OWNER_CAPTURE_GATES_NOT_APPEND_ONLY');
      assert.match(error.message, /change the met status of existing gate 0 \(false -> true\)/);
      return true;
    }
  );
});

check('the gate writer refuses to rewrite evidence, rewrite an instruction, or drop a gate', () => {
  const existing = [{ instruction: 'A', met: true, evidence: 'real evidence' }];
  assert.throws(
    () => assertGatesAppendOnly('R99', existing, [{ instruction: 'A', met: true, evidence: 'softened' }]),
    (error) => /change the evidence of existing gate 0/.test(error.message)
  );
  assert.throws(
    () => assertGatesAppendOnly('R99', existing, [{ instruction: 'A (reworded)', met: true, evidence: 'real evidence' }]),
    (error) => /rewrite the instruction of existing gate 0/.test(error.message)
  );
  assert.throws(
    () => assertGatesAppendOnly('R99', existing, []),
    (error) => /drop 1 existing gate/.test(error.message)
  );
});

check('the gate writer refuses to change or retrofit an existing hedge marker', () => {
  assert.throws(
    () => assertGatesAppendOnly('R99', [{ instruction: 'maybe do it', hedged: true, met: false, evidence: '' }], [{ instruction: 'maybe do it', hedged: false, met: false, evidence: '' }]),
    error => /hedge marker/.test(error.message)
  );
  assert.throws(
    () => assertGatesAppendOnly('R99', [{ instruction: 'legacy gate', met: false, evidence: '' }], [{ instruction: 'legacy gate', hedged: false, met: false, evidence: '' }]),
    error => /hedge marker/.test(error.message)
  );
});

check('the gate writer ALLOWS an honest append that preserves every existing gate', () => {
  const existing = [{ instruction: 'A', met: true, evidence: 'real evidence' }];
  const next = [...existing, { instruction: 'B', met: false, evidence: '' }];
  assert.deepEqual(assertGatesAppendOnly('R99', existing, next), next);
  assert.deepEqual(assertGatesAppendOnly('R99', [], []), []);
});

// --- Q34: runtime claims need destination evidence --------------------------
//
// This is deliberately a writer-level check only. The source ledger remains
// directly writable, and owner-capture keeps refusing all gate satisfaction;
// the test pins a narrow refusal rather than pretending it closes class 1.
check('runtime-word detection is narrow and case-insensitive', () => {
  assert.equal(hasRuntimeGateWord('the service is running continuously'), true);
  assert.equal(hasRuntimeGateWord('the message was SENT to the recipient'), true);
  assert.equal(hasRuntimeGateWord('write the deployment guide'), false);
  assert.equal(hasRuntimeGateWord('verify destination behavior'), false);
});

check('runtime evidence accepts only post-change destination-query output', () => {
  const instruction = 'keep the worker running continuously';
  const accepted = [
    'Captured post-change destination query:\nPS> Get-ScheduledTask -TaskName ToolsEnabledWorker\nTaskName State\nToolsEnabledWorker Running',
    'After the change, process table query:\nPS> Get-Process -Id 1234\nProcessName Id CPU\nnode 1234 12.5',
    'Post-change audit ledger query:\naudit.verify\nvalid: true\nsequence: 9123',
    'Post-change recipient inbox search:\nrecipient inbox\nFrom: service@example.test\nSubject: delivered'
  ];
  for (const evidence of accepted) {
    assert.doesNotThrow(() => assertRuntimeGateEvidence(instruction, evidence));
  }
});

check('runtime evidence refuses edit-only claims and an attempted runtime gate mutation routes through the refusal', () => {
  const instruction = 'the service is live after deployment';
  for (const evidence of [
    '',
    'Post-change: I edited the service file and it should be running.',
    'Get-ScheduledTask -TaskName ToolsEnabledWorker\nTaskName State\nToolsEnabledWorker Running',
    'Post-change destination query: audit.verify\nall looks good'
  ]) {
    assert.throws(
      () => assertRuntimeGateEvidence(instruction, evidence, { required: true }),
      error => error.code === 'OWNER_CAPTURE_RUNTIME_EVIDENCE_REQUIRED'
    );
  }
  const existing = [{ instruction, met: false, evidence: '' }];
  assert.throws(
    () => assertGatesAppendOnly('R99', existing, [{ instruction, met: true, evidence: 'post-change: edited it' }]),
    error => {
      assert.equal(error.code, 'OWNER_CAPTURE_RUNTIME_EVIDENCE_REQUIRED');
      assert.match(error.message, /voluntary writer, not a chokepoint/);
      return true;
    }
  );
});

check('the real capture path runs the guard: a new entry cannot be born with a met gate', () => {
  // Pins that the invariant is wired into applyNewEntry/applyAppend, not merely
  // exported -- a checked invariant nobody calls is the failure this whole
  // enforcement sweep exists to close.
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'owner-capture.js'), 'utf8');
  assert.match(source, /gates:\s*assertGatesAppendOnly\(/, 'applyNewEntry must route its gates through the guard');
  assert.match(source, /const nextGates = assertGatesAppendOnly\(/, 'applyAppend must route its gates through the guard');
  assert.match(source, /assertRuntimeGateEvidence\(next\.instruction, next\.evidence/, 'gate mutation must route runtime evidence through the Q34 guard');
});

console.log(`Owner-capture tests passed (${checks} checks; every ledger file touched was a temp copy under ${os.tmpdir()}, and the gate writer cannot self-certify, flip, soften, or drop a gate).`);
