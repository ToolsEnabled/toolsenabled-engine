'use strict';

// THE r_ledger TOOLS: REGISTERED, CLASSIFIED, AND GATED BY THE PERSON'S SETTING.
// What must hold: both tools exist with a local-write effect and the bound
// actor field; Guided (read-only) refuses them by effect and Standard admits
// them; with the switch off the handler refuses by name and no file
// appears; in the internal propose-only mode file refuses PROPOSE_ONLY while
// propose files a row that waits for the person; with the switch on the entry
// lands attributed to the actor; a tree or thread scope without its key is
// refused; a non-durable audit intent refuses before the gate is even
// consulted; nothing is ever rewritten by an agent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// A scratch state root BEFORE the first src/lib require, per the standing
// trap: state modules decide their root at first require.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-tools-'));
process.env.TOOLSENABLED_STATE_ROOT = path.join(SCRATCH, 'state');
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true });

const registry = require('../src/lib/tool-registry');
const policy = require('../src/lib/permission-tier-policy');
const surface = require('../src/lib/confined-tool-surface');
const { assertValid } = require('../src/lib/schema-validator');
const ledger = require('../src/lib/r-ledger');
const { RLedgerAgentControl, MODES } = require('../src/lib/r-ledger-agent-gate');
const summary = require('../src/lib/agent-tool-summary');
const { bindAgentActor } = require('../src/mcp-server');

const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const GUIDED = Object.freeze({ origin: 'local', tier: 'confined', profile: 'read-only' });
const TOOLS = ['r_ledger.file', 'r_ledger.propose'];

test('ledger.read returns real task progress and ask answers through a confined read-only tool without writing', async () => {
  const store = require('../src/lib/owner-request-store');
  const entry = registry.getTool('ledger.read');
  assert.ok(entry);
  assert.equal(entry.effect, 'local-read');
  assert.equal(surface.classify(entry.name), 'contained');
  policy.assertToolAllowed(entry, GUIDED);
  policy.assertToolAllowed(entry, STANDARD);
  assert.throws(() => assertValid(entry.inputSchema, { key: '../escape' }, { path: '$' }));
  assert.throws(() => assertValid(entry.inputSchema, { limit: 101 }, { path: '$' }));
  const read = args => registry.executeTool('ledger.read', args, { permissionSession: GUIDED });
  const absent = await read({});
  assert.equal(absent.exists, false);
  assert.deepEqual(absent.records, []);
  assert.equal(fs.existsSync(store.ledgerFileFor()), false, 'a read must not create the ledger');

  const task = store.fileTask({ scope: 'tree', key: 'manager', words: 'Finish the requested fix', filedBy: 'codex' });
  const ask = store.fileAsk({ scope: 'tree', key: 'manager', words: 'Which format?', filedBy: 'codex' });
  store.fileTask({ scope: 'thread', key: 'sibling', words: 'Unrelated work', filedBy: 'claude' });
  const first = await read({ scope: 'tree', key: 'manager', limit: 1 });
  assert.deepEqual(first.records.map(row => row.id), [task.id]);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.total, 2);
  const second = await read({ scope: 'tree', key: 'manager', limit: 1, offset: first.nextOffset });
  assert.deepEqual(second.records.map(row => row.id), [ask.id]);
  assert.equal(second.nextOffset, null);
  assert.equal(second.revision, first.revision);

  store.completeTask({ id: task.id, actor: 'codex' });
  store.answerAsk({ id: ask.id, actor: 'owner', answer: 'Use plain text.' });
  const before = [store.ledgerFileFor(), store.historyFileFor()].map(file => fs.readFileSync(file, 'utf8'));
  const completed = await read({ id: task.id });
  assert.equal(completed.records[0].status, 'done');
  assert.equal(completed.chain.ok, true);
  assert.equal(completed.grantsAuthority, false);
  assert.equal((await read({ id: ask.id })).records[0].answer.words, 'Use plain text.');
  assert.ok(completed.revision > first.revision);
  assert.deepEqual([store.ledgerFileFor(), store.historyFileFor()].map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal('path' in completed, false);

  store.removeTask({ id: task.id, actor: 'codex' });
  assert.deepEqual((await read({ id: task.id })).records, []);
  assert.equal((await read({ id: task.id, removed: true })).records[0].status, 'removed');
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-ledger-control-'));
  const rootPath = (...parts) => path.join(dir, ...parts);
  return { dir, opts: { rootPath } };
}

// A row that waits for the person, in the one ledger: what r_ledger.propose
// files, and what r_ledger.file files under the person's "approve first" row.
function waiting(scope, key, opts) {
  return ledger.readLedger(scope, key, { ...opts, includeProposed: true }).entries.filter(entry => entry.status === 'proposed');
}

function build(mode, { durable = true, needsApproval = false } = {}) {
  const { dir, opts } = sandbox();
  const audits = [];
  const control = new RLedgerAgentControl({
    gate: () => ({ mode, state: mode === 'off' ? 'withheld' : 'enabled', why: mode === 'off' ? '"rules.capture_spoken" is off.' : null, needsApproval }),
    auditRequire: (action, target, details) => { audits.push({ action, target, details }); return { durable }; },
    ledgerOptions: opts
  });
  return { dir, opts, control, audits };
}

test('both tools are registered as local writes with the bound actor, and the confined table classifies them', () => {
  for (const name of TOOLS) {
    const entry = registry.getTool(name);
    assert.ok(entry, `${name} is registered`);
    assert.equal(entry.effect, 'local-write');
    assert.equal(entry.annotations.destructiveHint, false);
    assert.deepEqual(entry.baseInputSchema.required, ['actor', 'scope', 'words']);
    assert.deepEqual(entry.baseInputSchema.properties.actor.enum, ['human', 'codex', 'claude', 'gemini', 'grok', 'local']);
    assert.deepEqual(entry.baseInputSchema.properties.scope.enum, ['global', 'session', 'tree', 'thread']);
    assert.equal(entry.baseInputSchema.properties.key.pattern, ledger.SAFE_KEY.source);
    assert.equal(surface.classify(name), 'contained', `${name} has a recorded confinement decision`);
    // Guided's read-only profile refuses by effect with no new code; Standard admits.
    assert.throws(() => policy.assertToolAllowed(entry, GUIDED), { code: 'PERMISSION_CONFINED_EFFECT_REFUSED' });
    policy.assertToolAllowed(entry, STANDARD);
    // The schema itself holds the key to the ledger's id shape and the words to the ledger's ceiling.
    assert.throws(() => assertValid(entry.inputSchema, { actor: 'codex', scope: 'thread', key: '../escape', words: 'w' }, { path: '$' }));
    assert.throws(() => assertValid(entry.inputSchema, { actor: 'codex', scope: 'global', words: '' }, { path: '$' }));
    assertValid(entry.inputSchema, { actor: 'codex', scope: 'global', words: 'w', why: 'because' }, { path: '$' });
    assertValid(entry.inputSchema, { actor: 'grok', scope: 'global', words: 'w', why: 'because' }, { path: '$' });
    assertValid(entry.inputSchema, { actor: 'local', scope: 'global', words: 'w', why: 'because' }, { path: '$' });
  }
  for (const name of ['research.run_submit', 'overnight_advisory.submit']) {
    assert.equal(registry.getTool(name).baseInputSchema.properties.actor.enum.includes('local'), true,
      'Local API actor identity is shared with Research and advisory schemas');
    for (const actor of ['human', 'unknown']) {
      assert.throws(() => bindAgentActor(name, { actor }, actor), error => error.code === -32602,
        `${name} remains transport-agent-only and rejects ${actor}`);
    }
    assert.doesNotThrow(() => bindAgentActor(name, { actor: 'local' }, 'local'),
      `${name} accepts the current local transport principal`);
  }
  const guidedNames = new Set(policy.allowedToolNames(registry.registeredTools(), GUIDED));
  const standardNames = new Set(policy.allowedToolNames(registry.registeredTools(), STANDARD));
  for (const name of TOOLS) {
    assert.equal(guidedNames.has(name), false, `${name} is withheld at Guided`);
    assert.equal(standardNames.has(name), true, `${name} is offered at Standard`);
  }
});

test('the tool note names the r_ledger family at Standard and not at Guided', () => {
  const total = registry.registeredTools().map(tool => tool.name);
  const standard = summary.briefToolSummary({ tier: 'standard', allowedNames: [...policy.allowedToolNames(registry.registeredTools(), STANDARD)], totalNames: total, enabled: true });
  assert.match(standard.text.slice(0, standard.text.indexOf('Not at this level')), /\br_ledger\b/);
  const guided = summary.briefToolSummary({ tier: 'guided', allowedNames: [...policy.allowedToolNames(registry.registeredTools(), GUIDED)], totalNames: total, enabled: true });
  assert.doesNotMatch(guided.text.slice(0, guided.text.indexOf('Not at this level')), /\br_ledger\b/);
});

test('off: both refuse by name, the refusal names the setting, and no file appears', () => {
  const { dir, control, audits } = build(MODES.OFF);
  const args = { actor: 'codex', scope: 'global', words: 'always ask before spending money' };
  // The refusal names the setting and tells the agent not to ask (owner,
  // 2026-09-15: "agents shouldnt ask if its disabled either").
  assert.throws(() => control.file(args), { code: 'R_LEDGER_AGENT_FILING_OFF', message: /"Who adds standing rules" in Settings/ });
  assert.throws(() => control.propose(args), { code: 'R_LEDGER_AGENT_FILING_OFF', message: /Do not ask the person whether to file it/ });
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false);
  assert.equal(fs.existsSync(path.join(dir, 'state')), false);
  assert.equal(audits.length, 2, 'the refused attempt is still audited');
  for (const row of audits) {
    assert.equal(row.details.actor, 'codex');
    assert.equal(Object.keys(row.details).includes('words'), false, 'the words never reach the audit row');
  }
});

test('propose-only (internal mode, no setting selects it): file refuses PROPOSE_ONLY, propose files a row that waits for the person and counts for nobody', () => {
  const { control, opts } = build(MODES.PROPOSE);
  const args = { actor: 'claude', scope: 'thread', key: 'node-3', words: 'keep it short', why: 'said from now on' };
  assert.throws(() => control.file(args), { code: 'R_LEDGER_AGENT_FILING_PROPOSE_ONLY', message: /r_ledger\.propose/ });
  const made = control.propose(args);
  assert.equal(made.filed, false);
  assert.equal(made.proposedBy, 'claude');
  assert.equal(made.proposalId, made.id);
  assert.equal(made.id, 'R1');
  assert.equal(made.awaitingApproval, true);
  assert.match(made.note, /Ledger page/);
  assert.deepEqual(waiting('thread', 'node-3', opts).map(entry => [entry.words, entry.filedBy]), [['keep it short', 'claude']]);
  assert.deepEqual(ledger.collectStack({ threadId: 'node-3' }, opts).find(layer => layer.scope === 'thread').entries, [], 'a waiting row is never handed to an agent at boot');
  assert.equal(fs.existsSync(opts.rootPath('state', 'r-ledger')), false, 'no proposal spool is written any more');
});

test('on: the entry lands at the bound scope attributed to the actor; propose files a waiting row', () => {
  const { control, opts } = build(MODES.AUTO);
  const filed = control.file({ actor: 'codex', scope: 'session', key: 'sess-9', words: 'answer in one sentence', why: 'said from now on' });
  assert.equal(filed.filed, true);
  assert.equal(filed.id, 'R1');
  assert.equal(filed.filedBy, 'codex');
  assert.equal(filed.status, 'open');
  assert.equal(filed.awaitingApproval, false);
  assert.match(filed.note, /R1/);
  const read = ledger.readLedger('session', 'sess-9', opts);
  assert.equal(read.entries[0].filedBy, 'codex');
  assert.equal(read.entries[0].words, 'answer in one sentence');
  assert.deepEqual(ledger.readLedger('global', null, opts).entries, [], 'a session rule never lands in the global layer');
  const again = control.file({ actor: 'codex', scope: 'session', key: 'sess-9', words: 'second' });
  assert.equal(again.id, 'R2');
  assert.deepEqual(ledger.readLedger('session', 'sess-9', opts).entries.map(entry => [entry.id, entry.words, entry.filedBy]),
    [['R1', 'answer in one sentence', 'codex'], ['R2', 'second', 'codex']], 'the first entry is untouched by the second filing');
  const suggested = control.propose({ actor: 'codex', scope: 'global', words: 'w' });
  assert.equal(suggested.filed, false);
  assert.equal(suggested.id, 'R3');
  assert.deepEqual(waiting('global', null, opts).map(entry => entry.id), ['R3']);
});

test('under the person\'s "approve first" row, file lands a waiting row and says so', () => {
  const { control, opts } = build(MODES.AUTO, { needsApproval: true });
  const filed = control.file({ actor: 'codex', scope: 'global', words: 'always ask before spending money' });
  assert.equal(filed.filed, true);
  assert.equal(filed.status, 'proposed');
  assert.equal(filed.awaitingApproval, true);
  assert.match(filed.note, /waits for the person's approval on the Ledger page/);
  assert.deepEqual(waiting('global', null, opts).map(entry => entry.id), ['R1']);
  assert.deepEqual(ledger.collectStack({}, opts)[0].entries, []);
  const again = control.file({ actor: 'claude', scope: 'global', words: 'always ask before spending money' });
  assert.equal(again.alreadyStanding, true, 'the same words while the first waits do not file a second waiting row');
  assert.equal(again.id, 'R1');
  assert.equal(again.status, 'proposed');
  assert.equal(again.awaitingApproval, true, 'the answer says the match is only proposed');
  assert.match(again.note, /waiting for the person's approval/);
  assert.doesNotMatch(again.note, /on file/i);
});

test('tree or thread without its id is refused; empty words are refused; nothing is written', () => {
  const { control, dir } = build(MODES.AUTO);
  assert.throws(() => control.file({ actor: 'codex', scope: 'tree', words: 'w' }), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => control.file({ actor: 'codex', scope: 'thread', words: 'w' }), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => control.propose({ actor: 'codex', scope: 'tree', words: 'w' }), { code: 'R_LEDGER_KEY_INVALID' });
  assert.throws(() => control.file({ actor: 'codex', scope: 'global', words: '   ' }), { code: 'R_LEDGER_WORDS_EMPTY' });
  assert.equal(fs.existsSync(path.join(dir, 'state')), false);
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false);
});

test('a non-durable audit intent refuses before the gate is consulted', () => {
  const { dir, opts } = sandbox();
  let gateAsked = 0;
  const control = new RLedgerAgentControl({
    gate: () => { gateAsked += 1; return { mode: 'auto' }; },
    auditRequire: () => ({ durable: false }),
    ledgerOptions: opts
  });
  assert.throws(() => control.file({ actor: 'codex', scope: 'global', words: 'w' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.throws(() => control.propose({ actor: 'codex', scope: 'global', words: 'w' }), { code: 'R_LEDGER_AUDIT_REQUIRED' });
  assert.equal(gateAsked, 0);
  assert.equal(fs.existsSync(path.join(dir, 'reports')), false);
});

/* THE O7 IMPROVEMENTS (owner, 2026-08-22) THROUGH THE TOOL SEAM. Both schemas
   carry the optional sessionId the product supplies; the results say how the
   verbatim check went; a duplicate answers alreadyStanding with the standing
   id; a refinement lands as a child; a bare "ok" is refused; and with a
   session the tool checks against the person's turns (injected here) --
   src/lib/r-ledger-agent-gate.js is where each rule lives and is proved. */
test('both schemas carry the optional sessionId; the result shapes say how the verbatim check went and where a duplicate landed', () => {
  for (const name of TOOLS) {
    const entry = registry.getTool(name);
    const property = entry.baseInputSchema.properties.sessionId;
    assert.ok(property && property.type === 'string', `${name} carries sessionId`);
    assert.equal(entry.baseInputSchema.required.includes('sessionId'), false, 'the product supplies it; a CLI caller may not');
    assertValid(entry.inputSchema, { actor: 'codex', scope: 'global', words: 'w', sessionId: 'sess-1' }, { path: '$' });
    assert.throws(() => assertValid(entry.inputSchema, { actor: 'codex', scope: 'global', words: 'w', sessionId: '' }, { path: '$' }));
    assert.throws(() => assertValid(entry.inputSchema, { actor: 'codex', scope: 'global', words: 'w', sessionId: 7 }, { path: '$' }));
  }
  assert.match(registry.getTool('r_ledger.file').description, /exact slice of what the person typed/);
  const { control, opts } = build(MODES.AUTO);
  const filed = control.file({ actor: 'codex', scope: 'global', words: 'keep it short' });
  assert.equal(filed.filed, true);
  assert.equal(filed.id, 'R1');
  assert.equal(filed.parentId, null);
  assert.equal(filed.verbatim, 'skipped: no spool', 'a scratch root with no spool at all is the one case the check is skipped');
  assert.match(filed.note, /Verbatim check skipped: this computer keeps no spool/);
  const same = control.file({ actor: 'claude', scope: 'global', words: 'keep  it short' });
  assert.deepEqual(Object.keys(same).sort(), ['alreadyStanding', 'appliesTo', 'awaitingApproval', 'filed', 'id', 'key', 'note', 'scope', 'status', 'verbatim']);
  assert.equal(same.filed, false);
  assert.equal(same.alreadyStanding, true);
  assert.equal(same.id, 'R1');
  assert.equal(same.status, 'open');
  assert.equal(same.awaitingApproval, false);
  assert.match(same.note, /already standing as R1/i);
  assert.equal(ledger.readLedger('global', null, opts).entries.length, 1, 'nothing new was written');
  const child = control.file({ actor: 'codex', scope: 'global', words: 'keep it short, always' });
  assert.deepEqual(Object.keys(child).sort(), ['appliesTo', 'awaitingApproval', 'filed', 'filedBy', 'id', 'key', 'note', 'parentId', 'scope', 'stamp', 'status', 'verbatim']);
  assert.equal(child.id, 'R1.1');
  assert.equal(child.parentId, 'R1');
  assert.match(child.note, /refinement as R1\.1 under R1/);
  const proposed = control.propose({ actor: 'codex', scope: 'global', words: 'keep it short' });
  assert.equal(proposed.filed, false);
  assert.equal(proposed.verbatim, 'skipped: no spool');
  assert.equal(proposed.alreadyStanding, true, 'a suggestion of words already standing files nothing');
  assert.equal(proposed.id, 'R1');
  const fresh = control.propose({ actor: 'codex', scope: 'global', words: 'never push on a Friday' });
  assert.equal(fresh.filed, false);
  assert.equal(fresh.id, 'R2');
  assert.deepEqual(waiting('global', null, opts).map(entry => entry.id), ['R2']);
  assert.throws(() => control.file({ actor: 'codex', scope: 'global', words: 'ok' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  assert.throws(() => control.propose({ actor: 'codex', scope: 'global', words: 'password: hunter2' }), { code: 'R_LEDGER_WORDS_REFUSED' });
  // With a spool the tool checks -- this session's turns when the call names one, else every turn typed to this
  // actor; the turn reader is injected to prove the seam (null = no spool at all, an array otherwise).
  const turnsOf = { codex: { 'sess-1': ['please keep it short from now on'], 'sess-3': ['and no emoji ever'] }, claude: { 'sess-9': ['always push'] } };
  const checked = new RLedgerAgentControl({
    gate: () => ({ mode: 'auto' }),
    auditRequire: () => ({ durable: true }),
    ledgerOptions: opts,
    turns: ({ sessionId, actor }) => {
      const mine = turnsOf[actor] || {};
      return sessionId ? (mine[sessionId] || []) : Object.values(mine).flat();
    }
  });
  const verbatim = checked.file({ actor: 'codex', scope: 'session', key: 'sess-1', sessionId: 'sess-1', words: 'keep it short from now on' });
  assert.equal(verbatim.verbatim, 'checked: this session');
  assert.equal(verbatim.id, 'R3', 'one counter across every scope');
  assert.throws(() => checked.file({ actor: 'codex', scope: 'session', key: 'sess-1', sessionId: 'sess-1', words: 'keep it brief' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.throws(() => checked.file({ actor: 'codex', scope: 'session', key: 'sess-1', sessionId: 'sess-2', words: 'keep it short from now on' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' },
    'a session id the spool has nothing for is an empty measure, not a skip');
  const actorWide = checked.file({ actor: 'codex', scope: 'session', key: 'sess-1', words: 'no emoji ever' });
  assert.equal(actorWide.verbatim, 'checked: every session of yours', 'without a session id, every session of this actor is the measure');
  assert.throws(() => checked.file({ actor: 'codex', scope: 'session', key: 'sess-1', words: 'always push' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' }, 'another actor\'s turns never count');
  assert.equal(checked.file({ actor: 'claude', scope: 'session', key: 'sess-1', words: 'always push' }).verbatim, 'checked: every session of yours');
  // The person's hand is not a tool: edit and remove are not registered and not on the control.
  assert.equal(registry.getTool('r_ledger.edit'), null);
  assert.equal(registry.getTool('r_ledger.remove'), null);
  assert.equal(typeof control.edit, 'undefined');
  assert.equal(typeof control.remove, 'undefined');
  assert.equal(typeof ledger.editRequest, 'function');
  assert.equal(typeof ledger.removeRequest, 'function');
});
