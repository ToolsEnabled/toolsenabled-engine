// EXECUTABLE CHANGE
// testcanfail-tests-r-ledger-agent-gate-test-js
//
// Strengthened assertions and mutation evidence:
// - The privacy-error check at line 168 used a bare try/catch, so returning
//   normally skipped its assertion. Mutation: on the third `always push`
//   check, `_checkWords` returned success instead of throwing. RED:
//   "error: 'Missing expected exception.'" (ERR_ASSERTION, line 168).
// - The audit-detail assertions iterated `audits` without first proving it
//   nonempty. Mutation: `_audit` returned a durable result without invoking
//   `auditRequire`, leaving `audits` empty. RED:
//   "every attempted filing and proposal records an audit intent\n\n0 !== 11"
//   (ERR_ASSERTION, line 172).
// - NOT-FOUND (1), beyond the fixed audit loop: every other assertion loop
//   uses a nonempty array literal. NOT-FOUND (2): no process or exit-status
//   assertions. NOT-FOUND (3), beyond the fixed privacy try/catch: the other
//   try/finally only guarantees cleanup and swallows no failure. NOT-FOUND
//   (4): no assertion substitutes a mock for the behavior under test; the
//   injected audit callback observes the control's call boundary. NOT-FOUND
//   (5): no skips or platform precondition guards. NOT-FOUND (6): comparisons
//   that reuse a returned value are also independently pinned to literals.
// - Both source mutations were temporary. `src/lib/r-ledger-agent-gate.js`
//   was restored byte-for-byte (`cmp -s` passed) after each mutation.
//   Restored GREEN: "# pass 11", "# fail 0" from
//   `node --test tests/r-ledger-agent-gate.test.js`.
// - Preconditions: all met; no platform, dependency, or fixture limitation.

'use strict';

require('./helpers/isolated-state-root'); // FINDING 1, REPORT-ledger-kinds-tools-20260907.md: redirect TOOLSENABLED_STATE_ROOT off the live root before anything below can resolve it.

// THE SWITCH THAT DECIDES WHETHER AN AGENT MAY FILE A STANDING RULE. What must
// hold: silence is off; a value outside the options is off; a value nobody
// chose (registry default, not user/installer provenance) is off; the row in
// the catalogue and the module agree on the option words; the paragraph an
// agent is handed names the tool only when the tool is actually reachable,
// and the off text is the host's pre-O7 sentence byte-for-byte.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = require('../src/lib/r-ledger-agent-gate');
const { loadRegistry } = require('../src/lib/settings-registry');
const { loadSettings } = require('../src/lib/settings');
const ledger = require('../src/lib/r-ledger');
const spool = require('../src/lib/owner-capture-spool');
const proposals = require('../src/lib/r-ledger-proposals');

const ID = gate.AGENT_FILING_SETTING_ID;
const ASK = gate.ASK_WHEN_UNSURE_SETTING_ID;

function resolved(value, source = 'user') {
  return {
    values: value === undefined ? {} : { [ID]: value },
    provenance: value === undefined ? {} : { [ID]: { source, atMs: 1, directive: null } }
  };
}

test('absent row, absent value, legacy words and a non-choice all read as off', () => {
  assert.equal(gate.agentFilingMode({ settings: resolved(undefined) }).mode, 'off');
  assert.equal(gate.agentFilingMode({ settings: resolved(undefined) }).state, 'unclassified');
  assert.equal(gate.agentFilingMode({}).mode, 'off');
  assert.equal(gate.agentFilingMode({ settings: resolved('Capture and show me') }).mode, 'off', 'the legacy option cannot become consent');
  assert.equal(gate.agentFilingMode({ settings: resolved('File it and show me') }).mode, 'off', 'the retired three-way option cannot become consent');
  assert.equal(gate.agentFilingMode({ settings: resolved('true') }).mode, 'off', 'the string "true" is not the boolean the toggle writes');
  assert.equal(gate.agentFilingMode({ settings: resolved(1) }).mode, 'off');
  assert.equal(gate.agentFilingMode({ settings: resolved('auto') }).mode, 'off', 'the internal mode word is not an option');
  assert.equal(gate.agentFilingMode({ settings: resolved(gate.OPTIONS.OFF) }).mode, 'off');
});

test('only user or installer provenance can turn it on', () => {
  assert.equal(gate.agentFilingMode({ settings: resolved(gate.OPTIONS.AUTO, 'default') }).mode, 'off', 'a registry default is not a choice');
  assert.equal(gate.agentFilingMode({ settings: resolved(gate.OPTIONS.AUTO, 'agent') }).mode, 'off');
  assert.equal(gate.agentFilingMode({ settings: resolved(gate.OPTIONS.AUTO, 'user') }).mode, 'auto');
  assert.equal(gate.modeOfValue(true), 'auto');
  assert.equal(gate.modeOfValue(false), 'off');
  assert.equal(gate.modeOfValue('propose'), null, 'no value a person can set selects the internal propose mode');
  assert.equal(gate.agentFilingMode({ settings: resolved(gate.OPTIONS.AUTO, 'installer') }).mode, 'auto');
  const why = gate.agentFilingMode({ settings: resolved(gate.OPTIONS.AUTO, 'default') }).why;
  assert.match(why, /provenance is "default"/);
});

test('the catalogue row and the module agree: one toggle, default off, enforcer named', () => {
  const row = loadRegistry().byId.get(ID);
  assert.ok(row, `${ID} must exist in config/settings-registry.json`);
  assert.equal(row.control, 'toggle', 'the owner ruled "just on or off"; a select here would be a third position nobody asked for');
  assert.equal(row.options, undefined);
  assert.equal(row.default, gate.OPTIONS.OFF);
  assert.equal(row.default, false);
  assert.equal(row.enforcedBy, 'src/lib/r-ledger-agent-gate.js');
  assert.match(row.consequence, /memory|durable notes/i, 'the consequence says what this switch does NOT govern');
});

test('through the real settings loader: a stored legacy value fails validation and reads back as off', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const write = value => fs.writeFileSync(file, JSON.stringify({
    revision: 1, values: { [ID]: value }, provenance: { [ID]: { source: 'user', atMs: 1, directive: null } }
  }));
  write('Capture and show me');
  const legacy = loadSettings({ valuesPath: file });
  assert.ok(legacy.rejected.some(entry => entry.id === ID), 'the legacy value is rejected by name');
  assert.equal(gate.agentFilingMode({ settings: legacy }).mode, 'off');
  assert.equal(gate.loadAgentFilingMode({ valuesPath: file }).mode, 'off');
  write(gate.OPTIONS.AUTO);
  assert.equal(gate.loadAgentFilingMode({ valuesPath: file }).mode, 'auto');
  write(gate.OPTIONS.OFF);
  assert.equal(gate.loadAgentFilingMode({ valuesPath: file }).mode, 'off');
  // An unreadable settings layer answers off, never throws.
  assert.equal(gate.loadAgentFilingMode({ valuesPath: dir }).mode, 'off');
});

test('the contract paragraph: off is the pre-O7 text plus the no-asking sentence; on names the tool only when reachable', () => {
  const off = gate.requestContractParagraph('off', { canFile: true });
  // The owner, 2026-09-15: "agents shouldnt ask if its disabled either". Off
  // keeps the pre-O7 sentence about the typed commands and adds the one thing
  // that sentence never said: no filing, no proposing and no question about it.
  assert.equal(off, 'If the person types /Request, /RequestSession, /RequestTree, or /RequestThread here, ToolsEnabled itself files their words as a standing rule — you need no tool for that and should not act on the command yourself; the chat shows the person the confirmation, and the rules above are read again at each session start. '
    + 'Agents do not file, propose or ask about standing rules on this computer: when something the person says sounds like a rule, do not offer to record it and do not end your reply with a question about it — carry on with the work and leave the ledger to them.');
  assert.equal(gate.requestContractParagraph(undefined), off);
  assert.equal(gate.requestContractParagraph('nonsense', { canFile: true }), off);
  // "Ledger page only": the commands are off, so the paragraph must not name them.
  const pageOnly = gate.requestContractParagraph('off', { canFile: true, chatFiling: false });
  assert.doesNotMatch(pageOnly, /\/Request/);
  assert.match(pageOnly, /Ledger page/);
  assert.match(pageOnly, /do not end your reply with a question/);
  assert.equal(gate.requestContractParagraph('off', { canFile: true, chatFiling: true }), off);
  const withheldPageOnly = gate.requestContractParagraph('auto', { canFile: false, chatFiling: false });
  assert.doesNotMatch(withheldPageOnly, /\/Request/);
  assert.match(withheldPageOnly, /Ledger page/);
  const propose = gate.requestContractParagraph('propose', { canFile: true });
  assert.match(propose, /r_ledger\.propose/);
  assert.doesNotMatch(propose, /r_ledger\.file/);
  assert.match(propose, /nothing is filed until they do/);
  const auto = gate.requestContractParagraph('auto', { canFile: true });
  assert.match(auto, /r_ledger\.file/);
  assert.match(auto, /r_ledger\.propose instead/);
  assert.match(auto, /secret/);
  for (const mode of ['propose', 'auto']) {
    const withheld = gate.requestContractParagraph(mode, { canFile: false });
    assert.match(withheld, /withholds the filing tool/);
    assert.doesNotMatch(withheld, /r_ledger\./, 'a withheld session is not told to call a tool it does not have');
  }
});

// ---------------------------------------------------------------------------
// THE O7 IMPROVEMENTS (owner, 2026-08-22). Three doors on the filing path --
// verbatim or nothing, duplicates nest, ask me when unsure -- proved here
// against a scratch ledger and a scratch spool, with the gate and the audit
// intent injected so only the words are on trial.
// ---------------------------------------------------------------------------

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-gate-words-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

/* Rows an agent filed that still wait for the person, across every layer of
   the one ledger -- what r_ledger.propose writes now that the proposal spool
   is retired. */
function waitingRows(opts) {
  return ledger.readAll({ includeRemoved: false, includeProposed: true }, opts).records.filter(record => record.status === 'proposed');
}

function control(opts, extra = {}) {
  const audits = [];
  const made = new gate.RLedgerAgentControl({
    gate: () => ({ mode: 'auto', state: 'enabled', why: null, askWhenUnsure: false }),
    auditEnabled: () => true,
    auditRequire: (action, target, details) => { audits.push({ action, target, details }); return { durable: true }; },
    ledgerOptions: opts,
    ...extra
  });
  return { control: made, audits };
}

/* A person turn as the product spools it. `source` names the harness the
   turn arrived through (the engine hook's shape: "claude-code/UserPromptSubmit",
   "codex/..."); `actor` is what the product writes when it names the agent
   directly. Either is how a turn belongs to an actor. */
function spoolTurn(opts, threadId, text, when, { source = 'codex/UserPromptSubmit', actor = 'owner-ingress-hook' } = {}) {
  return spool.writeAhead(proposals.anchorFile(opts), {
    mode: 'ingress', id: null, text, interpretation: null, actor, source,
    gates: [], status: null, scope: 'session', threadId, provenanceClass: null, proposal: null, now: new Date(when)
  });
}

test('Local owner turns remain attributable across sessions and cannot become another provider\'s words', () => {
  const { dir, opts } = sandbox();
  try {
    spoolTurn(opts, 'local-one', 'Keep fixture reports concise.', '2026-09-13T12:00:00Z', { actor: 'local', source: 'product/sendTurn' });
    spoolTurn(opts, 'codex-one', 'Use fixture output only.', '2026-09-13T12:00:01Z', { actor: 'codex', source: 'product/sendTurn' });
    assert.deepEqual(gate.spooledTurns({ actor: 'local' }, opts), ['Keep fixture reports concise.']);
    for (const actor of ['codex', 'claude', 'gemini', 'grok']) {
      assert.deepEqual(gate.spooledTurns({ actor, sessionId: 'local-one' }, opts), []);
    }
    assert.deepEqual(gate.spooledTurns({ actor: 'local', sessionId: 'codex-one' }, opts), []);
    const { control: c } = control(opts);
    const filed = c.file({ actor: 'local', scope: 'global', words: 'Keep fixture reports concise.' });
    assert.equal(filed.filedBy, 'local');
    assert.equal(filed.verbatim, 'checked: every session of yours');
    assert.throws(() => c.file({ actor: 'codex', sessionId: 'local-one', scope: 'global', words: 'Keep fixture reports concise.' }),
      { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
    assert.throws(() => c.file({ actor: 'local', sessionId: 'codex-one', scope: 'global', words: 'Use fixture output only.' }),
      { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verbatim or nothing: an exact slice of a spooled turn files byte-identical; a paraphrase, a case change or a splice is refused', () => {
  const { opts } = sandbox();
  const first = spoolTurn(opts, 'sess-V', 'From now on keep every reply to one sentence.\nThanks.', '2026-08-22T10:00:00Z');
  spool.markReconciled(first, { now: new Date('2026-08-22T10:00:01Z') });
  spoolTurn(opts, 'sess-V', 'also never use emoji', '2026-08-22T10:00:02Z');
  spoolTurn(opts, 'sess-OTHER', 'a different session said: always push', '2026-08-22T10:00:03Z', { source: 'claude-code/UserPromptSubmit' });
  assert.deepEqual([...gate.spooledTurns({ sessionId: 'sess-V', actor: 'codex' }, opts)].sort(), ['From now on keep every reply to one sentence.\nThanks.', 'also never use emoji'].sort(),
    'pending and reconciled records for the session, and only that session');
  assert.deepEqual(gate.spooledTurns({ sessionId: 'sess-NONE', actor: 'codex' }, opts), [], 'a spool with nothing for that session is an empty measure, not a skip');
  assert.deepEqual(gate.spooledTurns({ sessionId: 'sess-OTHER', actor: 'codex' }, opts), [], 'another actor\'s session does not count for this actor, even by id');
  const { control: c, audits } = control(opts);
  const filed = c.file({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-V', words: 'keep every reply   to one sentence' });
  assert.equal(filed.filed, true);
  assert.equal(filed.verbatim, 'checked: this session');
  assert.doesNotMatch(filed.note, /skipped/);
  assert.equal(ledger.readLedger('session', 'sess-V', opts).entries[0].words, 'keep every reply   to one sentence', 'filed as given, not as normalised');
  const across = c.file({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-V', words: 'one sentence.\nThanks' });
  assert.equal(across.filed, true, 'a slice across the turn\'s own line break is still one contiguous slice');
  for (const words of ['keep replies to one sentence', 'Keep every reply to one sentence', 'one sentence. also never use emoji', 'always push']) {
    assert.throws(() => c.file({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-V', words }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM', message: /not an exact slice/ });
    assert.throws(() => c.propose({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-V', words }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  }
  assert.equal(ledger.readLedger('session', 'sess-V', opts).entries.length, 2, 'nothing refused was written');
  assert.equal(waitingRows(opts).length, 0, 'nothing refused was proposed');
  // The refusal sentences carry no path, key or stack; the audit row carries neither the words nor the session id.
  assert.throws(() => c.file({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-V', words: 'always push' }), error => {
    assert.doesNotMatch(error.message, /sess-V|[\\/]|\bat\b .*:\d+/);
    return error.code === 'R_LEDGER_WORDS_NOT_VERBATIM';
  });
  assert.equal(audits.length, 11, 'every attempted filing and proposal records an audit intent');
  for (const row of audits) {
    assert.deepEqual(Object.keys(row.details).sort(), ['actor', 'keyed', 'scope']);
  }
  // A session id the spool never saw is an empty measure: refused, not skipped (an agent cannot name its way past the check).
  assert.throws(() => c.file({ actor: 'codex', scope: 'session', key: 'sess-V', sessionId: 'sess-NONE', words: 'also never use emoji' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  // The pure helper.
  assert.equal(gate.isVerbatimSlice('b c', ['a b\nc d']), true);
  assert.equal(gate.isVerbatimSlice('B c', ['a b c']), false, 'no case folding');
  assert.equal(gate.isVerbatimSlice('', ['anything']), false);
  assert.equal(gate.isVerbatimSlice('x', []), false);
  assert.equal(gate.normaliseForMatch('  a \n\t b  '), 'a b');
});

test('without a session id the measure is every turn the person typed to THIS actor, in any session; never another actor\'s; skipped only with no spool at all', () => {
  const { opts } = sandbox();
  // codex's sessions: two of them; claude's: one; a product-shaped record naming gemini directly; one naming nobody.
  spoolTurn(opts, 'codex-1', 'From now on keep every reply to one sentence.', '2026-08-22T11:00:00Z');
  const reconciled = spoolTurn(opts, 'codex-2', 'and never use emoji in replies', '2026-08-22T11:00:01Z');
  spool.markReconciled(reconciled, { now: new Date('2026-08-22T11:00:02Z') });
  spoolTurn(opts, 'claude-1', 'always push after every commit', '2026-08-22T11:00:03Z', { source: 'claude-code/UserPromptSubmit' });
  spoolTurn(opts, 'gemini-1', 'answer in French', '2026-08-22T11:00:04Z', { source: 'test', actor: 'gemini' });
  spoolTurn(opts, 'nobody-1', 'a turn that names no actor', '2026-08-22T11:00:05Z', { source: 'test', actor: 'owner-ingress-hook' });
  assert.deepEqual([...gate.spooledTurns({ actor: 'codex' }, opts)].sort(), ['From now on keep every reply to one sentence.', 'and never use emoji in replies'].sort(),
    'both of codex\'s sessions, pending and reconciled; nobody else\'s');
  assert.deepEqual(gate.spooledTurns({ actor: 'claude' }, opts), ['always push after every commit']);
  assert.deepEqual(gate.spooledTurns({ actor: 'gemini' }, opts), ['answer in French'], 'a record naming the actor directly counts for it');
  assert.deepEqual(gate.spooledTurns({ actor: 'nobody' }, opts), [], 'a turn that names no actor counts for no actor');
  assert.deepEqual(gate.spooledTurns({}, opts), [], 'no session and no actor measures nothing');
  assert.deepEqual(gate.spooledTurns({ sessionId: 'nobody-1', actor: 'codex' }, opts), ['a turn that names no actor'], 'by session id, a turn naming no actor still counts');
  const { control: codex } = control(opts);
  const fromFirst = codex.file({ actor: 'codex', scope: 'global', words: 'keep every reply to one sentence' });
  assert.equal(fromFirst.filed, true);
  assert.equal(fromFirst.verbatim, 'checked: every session of yours');
  assert.doesNotMatch(fromFirst.note, /skipped/);
  const fromSecond = codex.file({ actor: 'codex', scope: 'global', words: 'never use   emoji in replies' });
  assert.equal(fromSecond.filed, true, 'a slice from the other session of the same actor passes');
  assert.equal(fromSecond.verbatim, 'checked: every session of yours');
  assert.throws(() => codex.file({ actor: 'codex', scope: 'global', words: 'keep replies to one sentence' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM', message: /typed to you/ });
  assert.throws(() => codex.file({ actor: 'codex', scope: 'global', words: 'always push after every commit' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.throws(() => codex.propose({ actor: 'codex', scope: 'global', words: 'always push after every commit' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.throws(() => codex.file({ actor: 'codex', scope: 'global', words: 'answer in French' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.throws(() => codex.file({ actor: 'codex', scope: 'global', words: 'a turn that names no actor' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.throws(() => codex.file({ actor: 'codex', scope: 'global', words: 'a turn that names no actor', sessionId: 'claude-1' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' }, 'naming another actor\'s session does not borrow its turns');
  const claudeSays = codex.file({ actor: 'claude', scope: 'global', words: 'always push after every commit' });
  assert.equal(claudeSays.filed, true, 'the same words pass for the actor they were typed to');
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 3);
  assert.equal(waitingRows(opts).length, 0);
  // No spool at all: the only skip, and the result says which.
  const { opts: bare } = sandbox();
  assert.equal(gate.spooledTurns({ actor: 'codex' }, bare), null);
  assert.equal(gate.spooledTurns({ sessionId: 'x', actor: 'codex' }, bare), null);
  const { control: unspooled } = control(bare);
  const skipped = unspooled.file({ actor: 'codex', scope: 'global', words: 'nothing to check this against' });
  assert.equal(skipped.filed, true);
  assert.equal(skipped.verbatim, 'skipped: no spool');
  assert.match(skipped.note, /Verbatim check skipped: this computer keeps no spool/);
  assert.equal(unspooled.propose({ actor: 'codex', scope: 'global', words: 'suggested with no spool' }).verbatim, 'skipped: no spool');
  // An empty spool directory (the product created it, nobody has typed yet) is a measure of nothing, not a skip.
  fs.mkdirSync(spool.spoolDirectory(proposals.anchorFile(bare)), { recursive: true });
  assert.deepEqual(gate.spooledTurns({ actor: 'codex' }, bare), []);
  assert.throws(() => unspooled.file({ actor: 'codex', scope: 'global', words: 'still nothing to check against' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
});

test('an unreadable spool is unknown, never an empty or absent measurement', () => {
  const { opts } = sandbox();
  const root = spool.spoolDirectory(proposals.anchorFile(opts));
  fs.mkdirSync(root, { recursive: true });

  const denied = Object.create(fs);
  denied.readdirSync = target => {
    if (path.dirname(target) === root) {
      const error = new Error('access denied');
      error.code = 'EACCES';
      throw error;
    }
    return fs.readdirSync(target);
  };
  assert.throws(
    () => gate.spooledTurns({ actor: 'codex' }, { ...opts, fsImpl: denied }),
    { code: 'R_LEDGER_SPOOL_UNREADABLE', message: /presence is unknown/ },
    'a failed directory read must not become an empty list of turns'
  );

  const pending = spool.pendingDirectory(proposals.anchorFile(opts));
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'broken.json'), '{not json');
  assert.throws(
    () => gate.spooledTurns({ actor: 'codex' }, opts),
    { code: 'R_LEDGER_SPOOL_UNREADABLE' },
    'a record that could not be inspected must not be silently omitted'
  );
});

test('a bare assent and a secret shape are refused outright, whether or not the verbatim check runs', () => {
  const { opts } = sandbox();
  spoolTurn(opts, 'sess-A', 'ok', '2026-08-22T10:00:00Z');
  spoolTurn(opts, 'sess-A', 'my password: hunter2 from now on', '2026-08-22T10:00:01Z');
  const { control: c } = control(opts);
  for (const words of ['ok', 'Yes', 'sure, go ahead', 'no.', 'yes please', 'OK!', 'do it', 'nope']) {
    assert.equal(gate.isAssent(words), true, words);
    assert.throws(() => c.file({ actor: 'codex', scope: 'session', key: 'sess-A', sessionId: 'sess-A', words }), { code: 'R_LEDGER_WORDS_REFUSED', message: /not a standing rule/ });
    assert.throws(() => c.file({ actor: 'codex', scope: 'global', words }), { code: 'R_LEDGER_WORDS_REFUSED' });
    assert.throws(() => c.propose({ actor: 'codex', scope: 'global', words }), { code: 'R_LEDGER_WORDS_REFUSED' });
    /* A refusal that only says no leaves the agent with nothing to do and the
       person with nothing filed and nothing said -- the shape that settled 228
       of the owner's turns as "agent read it and filed nothing". */
    assert.throws(
      () => c.file({ actor: 'codex', scope: 'global', words }),
      { message: /tell them what you would have filed/i },
      'the assent refusal must name the next move, not merely refuse'
    );
  }
  for (const words of ['no emoji', 'ok but keep it short', 'yes to every deploy only after I say go', 'go ahead and always ask first']) {
    assert.equal(gate.isAssent(words), false, words);
  }
  const secrets = [
    'my password: hunter2 from now on',
    'use token=abc123def456 for the api',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    /* A bare 'secret:' prefix (the gate's own BARE_SECRET_PREFIX). A provider-
       shaped key was here before; GitHub's push protection reads it as a real
       one and refuses the push, so the fixture is a shape no scanner mistakes
       for a live credential and the gate still refuses. */
    'secret: 0123456789abcdefghijklmnopqrstuvwxyz',
    `the key is ${'a1'.repeat(24)}`,
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  ];
  for (const words of secrets) {
    assert.equal(gate.looksSecretShaped(words), true, words);
    assert.throws(() => c.file({ actor: 'codex', scope: 'session', key: 'sess-A', sessionId: 'sess-A', words }), { code: 'R_LEDGER_WORDS_REFUSED', message: /password, key or token/ });
    assert.throws(() => c.propose({ actor: 'codex', scope: 'global', words }), { code: 'R_LEDGER_WORDS_REFUSED' });
  }
  for (const words of ['always ask before spending money', 'the api key question comes up a lot', 'never paste a token into chat', 'rotate the password monthly']) {
    assert.equal(gate.looksSecretShaped(words), false, words);
  }
  // The judgement is the audit module's scrubber, reused, not a second definition: an injected scrubber decides.
  assert.equal(gate.looksSecretShaped('harmless', { scrub: () => 'changed' }), true);
  assert.equal(gate.looksSecretShaped('harmless', { scrub: value => value }), false);
  assert.equal(gate.looksSecretShaped('password: x', { scrub: value => value }), true, 'the bare-prefix shape holds even under a lenient scrubber');
  assert.equal(fs.existsSync(ledger.ledgerPath('global', null, opts)), false, 'nothing refused was written');
  assert.equal(fs.existsSync(ledger.ledgerPath('session', 'sess-A', opts)), false);
  assert.equal(waitingRows(opts).length, 0);
});

test('duplicates nest: the same words answer alreadyStanding; a refinement files as a child of the closest standing entry', () => {
  const { opts } = sandbox();
  const { control: c } = control(opts);
  const first = c.file({ actor: 'codex', scope: 'global', words: 'keep it short' });
  assert.equal(first.id, 'R1');
  assert.equal(first.parentId, null);
  const again = c.file({ actor: 'claude', scope: 'global', words: '  keep   it\nshort ' });
  assert.deepEqual({ filed: again.filed, alreadyStanding: again.alreadyStanding, id: again.id }, { filed: false, alreadyStanding: true, id: 'R1' });
  assert.match(again.note, /already standing as R1/i);
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 1, 'an exact duplicate writes nothing');
  const wider = c.file({ actor: 'codex', scope: 'global', words: 'keep it short and skip the preamble' });
  assert.equal(wider.filed, true);
  assert.equal(wider.id, 'R1.1');
  assert.equal(wider.parentId, 'R1');
  assert.match(wider.note, /filed your refinement as R1\.1 under R1/i);
  const narrower = c.file({ actor: 'codex', scope: 'global', words: 'it short' });
  assert.equal(narrower.id, 'R1.2', 'contained-by is a refinement too, under the closest parent');
  const unrelated = c.file({ actor: 'codex', scope: 'global', words: 'always ask before spending money' });
  assert.equal(unrelated.id, 'R2');
  assert.equal(unrelated.parentId, null);
  const ofChild = c.file({ actor: 'codex', scope: 'global', words: 'keep it short and skip the preamble, always' });
  assert.equal(ofChild.id, 'R1.1.1', 'a refinement of a refinement nests under the refinement, not the root');
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries.map(entry => `${entry.id}@${entry.depth}`),
    ['R1@0', 'R1.1@1', 'R1.1.1@2', 'R1.2@1', 'R2@0']);
  const read = ledger.readLedger('global', null, opts);
  assert.equal(read.entries.find(entry => entry.id === 'R1.1').filedBy, 'codex', 'a child is attributed like any agent-filed entry');
  assert.equal(read.entries.find(entry => entry.id === 'R1.1').words, 'keep it short and skip the preamble');
  // The same words in another layer are new there: scope and key are part of "standing"; the counter is one.
  const elsewhere = c.file({ actor: 'codex', scope: 'session', key: 'S', words: 'keep it short' });
  assert.equal(elsewhere.id, 'R3');
  assert.equal(elsewhere.alreadyStanding, undefined);
  // The helper, pure.
  assert.equal(gate.findStanding([], 'x'), null);
  assert.equal(gate.findStanding(undefined, 'x'), null);
  assert.equal(gate.findStanding([{ id: 'R1', words: 'alpha beta' }], 'gamma'), null);
  assert.equal(gate.findStanding([{ id: 'R1', words: 'alpha  beta' }], 'alpha beta').kind, 'equal');
  assert.equal(gate.findStanding([{ id: 'R1', words: 'alpha beta' }, { id: 'R2', words: 'alpha beta gamma' }], 'alpha beta gamma').entry.id, 'R2', 'an exact match wins over a refinement');
  assert.equal(gate.findStanding([{ id: 'R1', words: 'alpha' }, { id: 'R1.1', words: 'alpha beta' }], 'alpha beta gamma').entry.id, 'R1.1', 'the closest fit is the parent');
  assert.equal(gate.findStanding([{ id: 'R1', words: 'alpha' }, { id: 'R1.1', words: 'alpha beta gamma' }], 'alpha beta').entry.id, 'R1',
    'contained by one and containing another, the nearer in length (5 apart, not 6) is the parent');
  assert.equal(gate.findStanding([{ id: 'R1', words: 'Alpha' }], 'alpha'), null, 'no case folding here either');
});

test('"ask me when unsure": the nested row, how it is read, and the paragraph it switches', () => {
  assert.equal(ASK, 'rules.ask_when_unsure');
  const { entries, byId } = loadRegistry();
  const row = byId.get(ASK);
  assert.ok(row, `${ASK} must exist in config/settings-registry.json`);
  assert.equal(row.control, 'toggle');
  assert.equal(row.default, false, 'the owner: "default no"');
  assert.equal(row.section, byId.get(ID).section);
  assert.equal(row.depth, byId.get(ID).depth + 1, 'the owner: "nest it below in settings"');
  assert.equal(entries.findIndex(entry => entry.id === ASK), entries.findIndex(entry => entry.id === ID) + 1, 'directly after its parent row');
  assert.equal(row.enforcedBy, 'src/lib/r-ledger-agent-gate.js');
  assert.equal(row.derivedFrom, 'built-in product policy');
  assert.match(row.consequence, /one short question/);
  assert.match(row.consequence, /narrowest reading/);
  // Reading: absent, false, a non-boolean, or a value nobody chose all read as off; the person's true reads as on.
  const both = (on, ask, askSource = 'user') => ({
    values: { [ID]: on, [ASK]: ask },
    provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [ASK]: { source: askSource, atMs: 1, directive: null } }
  });
  assert.equal(gate.agentFilingMode({ settings: resolved(true) }).askWhenUnsure, false, 'absent is off');
  assert.equal(gate.agentFilingMode({}).askWhenUnsure, false);
  assert.equal(gate.agentFilingMode({ settings: both(true, true) }).askWhenUnsure, true);
  assert.equal(gate.agentFilingMode({ settings: both(true, true, 'installer') }).askWhenUnsure, true);
  assert.equal(gate.agentFilingMode({ settings: both(true, true, 'default') }).askWhenUnsure, false, 'a registry default is not a choice');
  assert.equal(gate.agentFilingMode({ settings: both(true, true, 'agent') }).askWhenUnsure, false);
  assert.equal(gate.agentFilingMode({ settings: both(true, 'true') }).askWhenUnsure, false);
  assert.equal(gate.agentFilingMode({ settings: both(true, 1) }).askWhenUnsure, false);
  assert.equal(gate.agentFilingMode({ settings: both(true, false) }).askWhenUnsure, false);
  const parentOff = gate.agentFilingMode({ settings: both(false, true) });
  assert.equal(parentOff.mode, 'off');
  assert.equal(parentOff.askWhenUnsure, true, 'read on its own; with the switch off the paragraph is the off text regardless');
  // Through the real loader, and failing closed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-gate-ask-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      revision: 1, values: { [ID]: true, [ASK]: true },
      provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [ASK]: { source: 'user', atMs: 1, directive: null } }
    }));
    const live = gate.loadAgentFilingMode({ valuesPath: file });
    assert.equal(live.mode, 'auto');
    assert.equal(live.askWhenUnsure, true);
    fs.writeFileSync(file, JSON.stringify({ revision: 1, values: { [ID]: true, [ASK]: 'yes' }, provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [ASK]: { source: 'user', atMs: 1, directive: null } } }));
    assert.equal(gate.loadAgentFilingMode({ valuesPath: file }).askWhenUnsure, false, 'a value the toggle cannot hold is rejected and reads as off');
    assert.equal(gate.loadAgentFilingMode({ valuesPath: dir }).askWhenUnsure, false, 'unreadable settings answer off, never throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The paragraph: only the doubt clause changes, and only in the auto mode with the tools reachable.
  const plain = gate.requestContractParagraph('auto', { canFile: true });
  const ask = gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true });
  assert.equal(gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: false }), plain);
  assert.match(plain, /unclear → the narrowest, and say so\. Never propose/);
  assert.match(plain, /If unsure, call r_ledger\.propose instead\.$/);
  assert.match(ask, /unclear or unsure → file nothing; end your reply with ONE short question; when the person answers yes, file their ORIGINAL sentence\. Never propose/);
  assert.doesNotMatch(ask, /propose instead/);
  assert.doesNotMatch(ask, /narrowest/);
  assert.equal(ask.slice(0, ask.indexOf('unclear')), plain.slice(0, plain.indexOf('unclear')), 'everything before the doubt clause is the same text');
  assert.match(ask, /r_ledger\.file/);
  assert.equal(gate.requestContractParagraph('off', { canFile: true, askWhenUnsure: true }), gate.requestContractParagraph('off'), 'the off text is byte-identical whatever the sub-setting');
  assert.equal(gate.requestContractParagraph('propose', { canFile: true, askWhenUnsure: true }), gate.requestContractParagraph('propose', { canFile: true }));
  assert.equal(gate.requestContractParagraph('auto', { canFile: false, askWhenUnsure: true }), gate.requestContractParagraph('auto', { canFile: false }));
});

/* APPROVE BEFORE IT COUNTS (owner, 2026-09-02: one ledger, managed on the
   Ledger page). The row rules.agent_filed_needs_approval sits under the one
   switch beside "ask me when unsure", read by the same three rules and off by
   default; with it on, r_ledger.file lands a row that waits for the person
   and the paragraph says so; r_ledger.propose always waits; a waiting row is
   never handed to an agent at boot; the spool is no longer written. */
test('"approve before it counts": the nested row, how it is read, what file and propose write, and the paragraph it switches', () => {
  const NEEDS = gate.NEEDS_APPROVAL_SETTING_ID;
  assert.equal(NEEDS, 'rules.agent_filed_needs_approval');
  const { entries, byId } = loadRegistry();
  const row = byId.get(NEEDS);
  assert.ok(row, `${NEEDS} must exist in config/settings-registry.json`);
  assert.equal(row.control, 'toggle');
  assert.equal(row.default, false, 'off by default: an agent-filed rule counts at once unless the person asks otherwise');
  assert.equal(row.section, byId.get(ID).section);
  assert.equal(row.depth, byId.get(ID).depth + 1, 'nested under the one switch');
  assert.equal(entries.findIndex(entry => entry.id === NEEDS), entries.findIndex(entry => entry.id === ASK) + 1, 'directly after "ask me when unsure"');
  /* BOTH ENDS OF THE CHAIN, NAMED. This pinned the store alone, and the store
     is not what reads the row -- it asks the gate, so the string
     `rules.agent_filed_needs_approval` appears nowhere in
     owner-request-store.js. tests/settings-rows-inert.test.js opens every file
     an `enforcedBy` names and requires at least one of them to carry the id, so
     the declaration now names the gate as well. Asserted as the two files
     rather than as one exact sentence: the sentence is prose and the files are
     the claim. */
  assert.match(row.enforcedBy, /src\/lib\/r-ledger-agent-gate\.js/,
    'the declaration no longer names the gate that actually reads this row');
  assert.match(row.enforcedBy, /src\/lib\/owner-request-store\.js/,
    'the declaration no longer names the store that acts on the answer');
  assert.equal(row.derivedFrom, 'built-in product policy');
  assert.match(row.consequence, /waits on the Ledger page until you approve/);
  // Reading: absent, false, a non-boolean, or a value nobody chose all read as off; the person's true reads as on.
  const withNeeds = (value, source = 'user') => ({
    values: { [ID]: true, [NEEDS]: value },
    provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [NEEDS]: { source, atMs: 1, directive: null } }
  });
  assert.equal(gate.agentFiledNeedsApprovalOf(resolved(true)), false, 'absent is off');
  assert.equal(gate.agentFiledNeedsApprovalOf(undefined), false);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(true)), true);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(true, 'installer')), true);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(true, 'default')), false, 'a registry default is not a choice');
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(true, 'agent')), false);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds('true')), false);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(1)), false);
  assert.equal(gate.agentFiledNeedsApprovalOf(withNeeds(false)), false);
  assert.equal(gate.agentFilingMode({ settings: withNeeds(true) }).needsApproval, true, 'surfaced on the decision');
  assert.equal(gate.agentFilingMode({ settings: resolved(true) }).needsApproval, false);
  assert.equal(gate.agentFilingMode({}).needsApproval, false);
  // Through the real loader, and failing closed to off.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-gate-needs-'));
  try {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      revision: 1, values: { [ID]: true, [NEEDS]: true },
      provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [NEEDS]: { source: 'user', atMs: 1, directive: null } }
    }));
    const live = gate.loadAgentFilingMode({ valuesPath: file });
    assert.equal(live.mode, 'auto');
    assert.equal(live.needsApproval, true);
    fs.writeFileSync(file, JSON.stringify({ revision: 1, values: { [ID]: true, [NEEDS]: 'yes' }, provenance: { [ID]: { source: 'user', atMs: 1, directive: null }, [NEEDS]: { source: 'user', atMs: 1, directive: null } } }));
    assert.equal(gate.loadAgentFilingMode({ valuesPath: file }).needsApproval, false, 'a value the toggle cannot hold is rejected and reads as off');
    assert.equal(gate.loadAgentFilingMode({ valuesPath: dir }).needsApproval, false, 'unreadable settings answer off, never throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Through the control: file waits under the row, propose always waits, and neither touches a spool.
  const { dir: root, opts } = sandbox();
  const gated = new gate.RLedgerAgentControl({
    gate: () => ({ mode: 'auto', state: 'enabled', why: null, askWhenUnsure: false, needsApproval: true }),
    auditEnabled: () => true,
    auditRequire: () => ({ durable: true }),
    ledgerOptions: opts
  });
  const filed = gated.file({ actor: 'codex', scope: 'global', words: 'always ask before spending money' });
  assert.equal(filed.filed, true);
  assert.equal(filed.id, 'R1');
  assert.equal(filed.status, 'proposed');
  assert.equal(filed.awaitingApproval, true);
  assert.match(filed.note, /waits for the person's approval on the Ledger page/);
  assert.deepEqual(ledger.readLedger('global', null, { ...opts, includeProposed: true }).entries.map(entry => `${entry.id}:${entry.status}`), ['R1:proposed'], 'the layer read sees it when asked, for the duplicate check');
  assert.deepEqual(ledger.readLedger('global', null, opts).entries, [], 'a plain layer read never hands an agent a waiting row');
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries, [], 'the boot stack never carries it');
  const same = gated.file({ actor: 'claude', scope: 'global', words: 'always ask before spending money' });
  assert.equal(same.alreadyStanding, true, 'the same words while it waits file nothing new');
  assert.equal(same.status, 'proposed', 'the duplicate answer says the match is only proposed');
  assert.equal(same.awaitingApproval, true);
  assert.match(same.note, /waiting for the person's approval/);
  assert.doesNotMatch(same.note, /on file|already standing/i, 'a waiting row is never described as standing');
  const sameProposal = gated.propose({ actor: 'claude', scope: 'global', words: 'always ask before spending money' });
  assert.equal(sameProposal.alreadyStanding, true);
  assert.equal(sameProposal.status, 'proposed');
  assert.equal(sameProposal.awaitingApproval, true);
  assert.match(sameProposal.note, /waiting for the person's approval/);
  assert.doesNotMatch(sameProposal.note, /on file/i);
  const proposed = gated.propose({ actor: 'codex', scope: 'thread', key: 'node-3', words: 'one sentence replies', why: 'the person said from now on' });
  assert.equal(proposed.filed, false);
  assert.equal(proposed.proposalId, 'R2');
  assert.equal(proposed.id, 'R2');
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.awaitingApproval, true);
  assert.equal(proposed.proposedBy, 'codex');
  assert.match(proposed.note, /Ledger page/);
  assert.deepEqual(waitingRows(opts).map(record => [record.id, record.scope, record.scopeKey, record.filedBy]), [['R1', 'global', null, 'codex'], ['R2', 'thread', 'node-3', 'codex']]);
  assert.equal(waitingRows(opts)[1].provenance.note, 'the person said from now on', 'the agent\'s one line rides on the record');
  assert.equal(fs.existsSync(path.join(root, 'state', 'r-ledger')), false, 'no proposal spool is written');
  const { control: free } = control(opts);
  assert.equal(free.file({ actor: 'codex', scope: 'global', words: 'and never on a Friday' }).status, 'open', 'with the row off, an agent-filed rule counts at once');
  assert.equal(free.propose({ actor: 'codex', scope: 'global', words: 'maybe on Mondays' }).status, 'proposed', 'a suggestion always waits');
  // After the person approves, the row rides at boot like any other.
  assert.equal(ledger.decide({ id: 'R1', decision: 'approve' }, opts).status, 'open');
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries.map(entry => entry.id), ['R1', 'R3']);
  // The paragraph: one sentence more, only in the auto mode with the tools reachable.
  const plain = gate.requestContractParagraph('auto', { canFile: true });
  const withApproval = gate.requestContractParagraph('auto', { canFile: true, needsApproval: true });
  assert.equal(gate.requestContractParagraph('auto', { canFile: true, needsApproval: false }), plain);
  assert.equal(withApproval, `${plain} A rule you file waits for the person's approval on the Ledger page before it counts.`);
  const askApproval = gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true, needsApproval: true });
  assert.equal(askApproval, `${gate.requestContractParagraph('auto', { canFile: true, askWhenUnsure: true })} A rule you file waits for the person's approval on the Ledger page before it counts.`);
  assert.match(plain, /If unsure, call r_ledger\.propose instead\.$/, 'the existing pin still holds with the row off');
  assert.equal(gate.requestContractParagraph('off', { canFile: true, needsApproval: true }), gate.requestContractParagraph('off'), 'the off text is byte-identical whatever the sub-setting');
  assert.equal(gate.requestContractParagraph('propose', { canFile: true, needsApproval: true }), gate.requestContractParagraph('propose', { canFile: true }));
  assert.equal(gate.requestContractParagraph('auto', { canFile: false, needsApproval: true }), gate.requestContractParagraph('auto', { canFile: false }));
});
