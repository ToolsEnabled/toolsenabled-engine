'use strict';

// THE ACTOR ON A LEDGER ENTRY IS THE TRANSPORT'S PRINCIPAL, NOT A NAME THE
// AGENT TYPED. bindAgentActor in src/mcp-server.js is the one place the
// session's TOOLSENABLED_AGENT_ACTOR meets the tool's `actor` argument; the
// r_ledger tools must go through it exactly as research.* does, or the
// "filed by codex" on a head line would be whatever the caller said it was.
//
// t_ledger.file/complete/remove and a_ledger.file (LEDGER-KINDS-INTERFACE-
// 20260907.md) are bound the SAME way (src/mcp-server.js
// R_LEDGER_ACTOR_BOUND_TOOLS), so this list is EVERY name in that set, not
// just the original two -- a tool added to the set with no name added here
// would pass this file green while never having been exercised at all,
// which is exactly the gap a smaller list here would hide.

require('./lib/isolated-environment').activate('mcp-actor-binding');

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { bindAgentActor } = require('../src/mcp-server');

const LEDGER_TOOLS = ['r_ledger.file', 'r_ledger.propose', 't_ledger.file', 't_ledger.complete', 't_ledger.progress', 't_ledger.remove',
  'a_ledger.file', 'a_ledger.answer', 'a_ledger.decline', 'p_ledger.decide'];

test('an r_ledger call whose actor differs from the transport-bound principal is refused with -32602', () => {
  for (const name of LEDGER_TOOLS) {
    assert.throws(() => bindAgentActor(name, { actor: 'claude', scope: 'global', words: 'w' }, 'codex'),
      error => error.code === -32602 && /[Ll]edger actor must match this transport-bound principal \('codex'\)/.test(error.message));
  }
});

test('an r_ledger call with no bound principal at all is refused, naming the family', () => {
  for (const name of LEDGER_TOOLS) {
    assert.throws(() => bindAgentActor(name, { actor: 'codex', scope: 'global', words: 'w' }, undefined),
      error => error.code === -32602 && /ledger mutation requires a transport-bound TOOLSENABLED_AGENT_ACTOR/.test(error.message));
    assert.throws(() => bindAgentActor(name, { actor: 'human', scope: 'global', words: 'w' }, 'human'),
      error => error.code === -32602, 'human is not an agent principal a transport can be started as');
  }
});

test('a matching actor passes through unchanged; tools outside the bound sets are untouched', () => {
  for (const name of LEDGER_TOOLS) {
    const args = { actor: 'codex', scope: 'thread', key: 'node-1', words: 'w' };
    assert.equal(bindAgentActor(name, args, 'codex'), args);
    const gemini = { ...args, actor: 'gemini' };
    assert.equal(bindAgentActor(name, gemini, ' GEMINI '), gemini, 'the env value is trimmed and lower-cased before comparison');
  }
  const unrelated = { actor: 'whatever' };
  assert.equal(bindAgentActor('memory.set', unrelated, undefined), unrelated);
});

test('Local Ledger actor binding rejects impersonation', () => {
  for (const name of LEDGER_TOOLS) {
    const args = { actor: 'local' };
    assert.equal(bindAgentActor(name, args, 'local'), args);
    for (const actor of ['codex', 'claude', 'gemini', 'grok', 'human', 'coordinator', 'unknown']) {
      assert.throws(() => bindAgentActor(name, { actor }, 'local'), error => error.code === -32602);
      assert.throws(() => bindAgentActor(name, args, actor), error => error.code === -32602);
    }
  }

});

test('real Local MCP Ledger calls preserve consent, verbatim, tier and durable attribution', async () => {
  const server = require('../src/mcp-server');
  const settings = require('../src/lib/settings');
  const gate = require('../src/lib/r-ledger-agent-gate');
  const spool = require('../src/lib/owner-capture-spool');
  const proposals = require('../src/lib/r-ledger-proposals');
  const store = require('../src/lib/owner-request-store');
  const options = { agentActor: 'local', agentApiMode: 'Only', allowedToolNames: LEDGER_TOOLS,
    agentSessionId: 'local-ledger-protocol', permissionSession: { origin: 'local', tier: 'full' } };
  async function request(method, params, context = options) {
    let answer;
    await server.processLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), packet => { answer = packet; }, context);
    return answer;
  }
  const list = await request('tools/list', {});
  assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), [...LEDGER_TOOLS].sort());
  for (const tool of list.result.tools) assert.ok(tool.inputSchema.properties.actor.enum.includes('local'), tool.name);
  const words = 'Keep fixture reports concise.';
  const args = { actor: 'local', scope: 'session', key: 'local-ledger-protocol', sessionId: 'local-ledger-protocol', words };
  const call = (name, arguments_, context) => request('tools/call', { name, arguments: arguments_ }, context);
  const refused = await call('r_ledger.file', args);
  assert.equal(refused.result?.isError, true);
  assert.equal(refused.result.structuredContent.error.code, 'R_LEDGER_AGENT_FILING_OFF');
  const valuesPath = settings.resolveValuesPath({});
  fs.mkdirSync(path.dirname(valuesPath), { recursive: true });
  const values = { [gate.AGENT_FILING_SETTING_ID]: true, [gate.NEEDS_APPROVAL_SETTING_ID]: true, 'agent.close_asks': false };
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: 1, directive: null }])) }));
  spool.writeAhead(proposals.anchorFile(), { mode: 'ingress', id: null, text: words, actor: 'local', source: 'product/sendTurn',
    status: 'unclassified', scope: 'session', threadId: 'local-ledger-protocol', provenanceClass: 'owner-ingress' });
  const filed = await call('r_ledger.file', args);
  assert.equal(filed.result?.isError, undefined, JSON.stringify(filed));
  const rule = filed.result.structuredContent;
  assert.equal(rule.filed, true);
  assert.equal(rule.status, 'proposed', 'owner approval remains necessary');
  assert.equal(store.findRecord(rule.id).filedBy, 'local');
  assert.equal(store.findRecord(rule.id).history[0].actor, 'local');
  const proposal = await call('r_ledger.propose', { ...args, scope: 'global', key: undefined });
  assert.equal(proposal.result?.isError, undefined, JSON.stringify(proposal));
  assert.equal(proposal.result.structuredContent.status, 'proposed');
  assert.equal(store.findRecord(proposal.result.structuredContent.id).filedBy, 'local');
  const wrongWords = await call('r_ledger.file', { ...args, words: 'Invented fixture instruction.' });
  assert.equal(wrongWords.result.structuredContent.error.code, 'R_LEDGER_WORDS_NOT_VERBATIM');
  const task = await call('t_ledger.file', { actor: 'local', scope: 'session', key: 'local-ledger-protocol', words: 'Check fixture output.' });
  assert.equal(task.result?.isError, undefined, JSON.stringify(task));
  assert.equal(store.findRecord(task.result.structuredContent.id).filedBy, 'local');
  const taskId = task.result.structuredContent.id;
  for (const [name, fields, status] of [
    ['t_ledger.progress', { status: 'in-progress', reason: 'Observed fixture output.' }, 'in-progress'],
    ['t_ledger.complete', {}, 'done'], ['t_ledger.remove', {}, 'removed']
  ]) {
    const result = await call(name, { actor: 'local', id: taskId, ...fields });
    assert.equal(result.result?.isError, undefined, JSON.stringify(result));
    const record = store.findRecord(taskId);
    assert.equal(record.status, status);
    assert.equal(record.history.at(-1).actor, 'local');
  }
  const ask = await call('a_ledger.file', { actor: 'local', scope: 'global', words: 'Which fixture should be checked?' });
  assert.equal(ask.result?.isError, undefined, JSON.stringify(ask));
  const askId = ask.result.structuredContent.id;
  for (const [name, fields] of [['a_ledger.answer', { words: 'The isolated fixture.' }], ['a_ledger.decline', { reason: 'No longer needed.' }]]) {
    const blocked = await call(name, { actor: 'local', id: askId, ...fields });
    assert.equal(blocked.result.structuredContent.error.code, 'AGENT_ASK_DECISION_DISABLED');
    assert.equal(store.findRecord(askId).status, 'open');
  }
  values['agent.close_asks'] = true;
  fs.writeFileSync(valuesPath, JSON.stringify({ revision: 2, values,
    provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user', atMs: 2, directive: null }])) }));
  const answer = await call('a_ledger.answer', { actor: 'local', id: askId, words: 'The isolated fixture.' });
  assert.equal(answer.result?.isError, undefined, JSON.stringify(answer));
  assert.equal(store.findRecord(askId).status, 'answered');
  assert.equal(store.findRecord(askId).history.at(-1).actor, 'local');
  const otherAsk = store.fileAsk({ scope: 'global', words: 'Is another fixture needed?', filedBy: 'local' });
  const declined = await call('a_ledger.decline', { actor: 'local', id: otherAsk.id, reason: 'Current evidence is sufficient.' });
  assert.equal(declined.result?.isError, undefined, JSON.stringify(declined));
  assert.equal(store.findRecord(otherAsk.id).status, 'declined');
  assert.equal(store.findRecord(otherAsk.id).history.at(-1).actor, 'local');
  const mirror = store.filePurchase({ scope: 'global', words: 'Synthetic purchase record only.', filedBy: 'owner',
    purchase: { requestId: 'no-real-purchase', lines: [] } });
  const decision = await call('p_ledger.decide', { actor: 'local', id: mirror.id, decision: 'approve', reason: 'Fixture mirror check.' });
  assert.equal(decision.result?.isError, undefined, JSON.stringify(decision));
  assert.match(decision.result.structuredContent.note, /ledger mirror only/);
  assert.match(decision.result.structuredContent.note, /never spends/);
  assert.equal(store.findRecord(mirror.id).purchase.decision.actor, 'local');
  const beforeDenied = store.readAll({ includeRemoved: true, includeProposed: true }).revision;
  const denied = await call('t_ledger.file', { actor: 'local', scope: 'global', words: 'Should remain unwritten.' },
    { ...options, permissionSession: { origin: 'local', tier: 'confined', profile: 'read-only' } });
  assert.equal(denied.result?.isError, true, JSON.stringify(denied));
  assert.equal(denied.result.structuredContent.error.code, 'PERMISSION_CONFINED_EFFECT_REFUSED');
  const spoofed = await call('t_ledger.file', { actor: 'codex', scope: 'global', words: 'Should remain unwritten.' });
  assert.equal(spoofed.error?.code, -32602);
  assert.equal(store.readAll({ includeRemoved: true, includeProposed: true }).revision, beforeDenied, 'refused tier/actor calls write nothing');
});

const LOCAL_CONTROL_TOOLS = ['research.run_submit', 'research.finding_save', 'research.session_assign', 'research.lifecycle',
  'overnight_advisory.submit', 'overnight_advisory.lifecycle'];

test('Local Research and overnight binding preserves exact principals without human or coordinator authority', () => {
  for (const name of LOCAL_CONTROL_TOOLS) {
    const args = { actor: 'local' };
    assert.equal(bindAgentActor(name, args, ' LOCAL '), args, name);
    for (const actor of ['codex', 'claude', 'gemini', 'grok', 'human', 'coordinator', 'unknown', 'LOCAL', ' local ']) {
      assert.throws(() => bindAgentActor(name, { actor }, 'local'), error => error.code === -32602, name);
      assert.throws(() => bindAgentActor(name, args, actor === 'LOCAL' || actor === ' local ' ? '' : actor),
        error => error.code === -32602, name);
    }
    assert.throws(() => bindAgentActor(name, {}, 'local'), error => error.code === -32602, name);
  }
});

test('allowed Local Research and overnight schemas advertise the same exact bound actor set', async () => {
  const { dispatch } = require('../src/mcp-server');
  const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {
    agentActor: 'local', allowedToolNames: LOCAL_CONTROL_TOOLS, agentApiMode: 'Only',
    permissionSession: { origin: 'local', tier: 'full' }, agentRole: { functions: LOCAL_CONTROL_TOOLS }
  });
  assert.deepEqual(response.tools.map(tool => tool.name).sort(), [...LOCAL_CONTROL_TOOLS].sort());
  for (const tool of response.tools) assert.deepEqual(tool.inputSchema.properties.actor.enum,
    ['human', 'codex', 'claude', 'gemini', 'grok', 'local'], tool.name);
});

test('real Local MCP control calls retain durable attribution and all existing admission gates', async t => {
  const { createStateStore } = require('../src/lib/state-store');
  const researchPath = require.resolve('../src/lib/providers/research');
  const overnightPath = require.resolve('../src/lib/providers/overnight-advisory');
  const research = require(researchPath);
  const overnight = require(overnightPath);
  const policy = require('../src/lib/policy');
  const settingsGate = require('../src/lib/research/settings-gate');
  const { OvernightAdvisoryWorkerRuntime } = require('../src/lib/providers/overnight-advisory-runtime');
  const root = fs.mkdtempSync(path.join(process.env.TOOLSENABLED_TEST_ROOT, 'local-control-'));
  const state = createStateStore({ file: path.join(root, 'state.sqlite3') });
  t.after(() => { state.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const audit = [];
  const auditRequire = (action, target, details) => { audit.push({ action, target, details }); return { durable: true }; };
  let pipeline = true, runner = true, advisory = true;
  const gate = () => settingsGate.gate({ settings: {
    values: { 'research.pipeline': pipeline, 'research.runner_process': runner },
    provenance: { 'research.pipeline': { source: 'user', atMs: 1 }, 'research.runner_process': { source: 'user', atMs: 1 } }
  } });
  let launches = 0;
  const runtimeDir = path.join(root, 'no-native-runtime');
  const runtime = new OvernightAdvisoryWorkerRuntime({ platform: 'linux', runtimeDir,
    launch() { launches++; throw new Error('No native worker is allowed in this test.'); } });
  // Keep the real registry handlers, control classes, policy decisions, content
  // fences and SQLite transactions. Inject only owned test state, the existing
  // audit seam, and explicit lifecycle availability; never touch a vault/model.
  require.cache[researchPath].exports = { ...research, ResearchControl: class extends research.ResearchControl {
    constructor() { super({ state, gate, auditRequire }); }
  } };
  require.cache[overnightPath].exports = { ...overnight, OvernightAdvisoryControl: class extends overnight.OvernightAdvisoryControl {
    constructor() { super({ state, runtime, auditRequire,
      assertEnabled: () => policy.assertOvernightAdvisoryAllowed({ overnightAdvisory: { enabled: advisory } }) }); }
  } };
  t.after(() => { require.cache[researchPath].exports = research; require.cache[overnightPath].exports = overnight; });
  const setup = new research.ResearchControl({ state, gate, auditRequire });
  const { project } = setup.projectSave({ actor: 'human', name: 'Local control fixture', enabled: true });
  const { experiment } = setup.experimentSave({ actor: 'human', projectId: project.projectId, name: 'Existing process fixture',
    runnerKind: 'process', runnerConfig: { command: 'node', args: ['-e', 'process.exit(0)'], stdin: 'none' },
    resultSchema: { fields: { n: 'number' }, required: ['n'] }, collector: { kind: 'stdout-json' } });
  const { processLine } = require('../src/mcp-server');
  const options = { agentActor: 'local', agentApiMode: 'Only', allowedToolNames: LOCAL_CONTROL_TOOLS,
    agentRole: { functions: LOCAL_CONTROL_TOOLS }, permissionSession: { origin: 'local', tier: 'full' } };
  let sequence = 0;
  async function call(name, args, context = options) {
    let response;
    await processLine(JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call',
      params: { name, arguments: args } }), packet => { response = packet; }, context);
    return response;
  }
  function success(response) {
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    return response.result.structuredContent;
  }
  function refused(response, code) {
    assert.equal(response.result?.isError, true, JSON.stringify(response));
    assert.equal(response.result.structuredContent.error.code, code, JSON.stringify(response));
  }
  const runInput = { actor: 'local', experimentId: experiment.experimentId, params: { replicate: 1 },
    sessionRefKind: 'observed', sessionRef: 'local-control-session' };
  const advisoryInput = { actor: 'local', idempotencyKey: 'local-control-advisory-one', title: 'Review bounded arithmetic',
    prompt: 'Explain a small arithmetic identity.', acceptanceChecklist: ['State the identity.'], maxOutputTokens: 64, allowStrong: false };
  const count = () => state.transaction(db => db.prepare('SELECT count(*) AS n FROM tasks').get().n);

  await t.test('Research submission uses existing process runner, attribution, replay and enable fences', async () => {
    const result = success(await call('research.run_submit', runInput));
    assert.equal(result.disposition, 'submitted');
    assert.equal(result.run.sessionRef, 'local-control-session');
    assert.equal(state.getResearchExperiment({ experimentId: experiment.experimentId }).runnerKind, 'process');
    const task = state.getTask({ taskId: result.run.taskId, includePayload: true });
    assert.equal(task.queue, 'research-runs'); assert.equal(task.status, 'queued');
    assert.equal(success(await call('research.run_submit', runInput)).run.runId, result.run.runId);
    assert.equal(audit.findLast(row => row.action === 'research.run_submit').details.actor, 'local');
    const before = count();
    pipeline = false;
    refused(await call('research.run_submit', { ...runInput, params: { replicate: 2 } }), 'RESEARCH_PIPELINE_DISABLED');
    pipeline = true; runner = false;
    refused(await call('research.run_submit', { ...runInput, params: { replicate: 2 } }), 'RESEARCH_RUNNER_DISABLED');
    runner = true; state.updateResearchProject({ projectId: project.projectId, enabled: false });
    refused(await call('research.run_submit', { ...runInput, params: { replicate: 2 } }), 'RESEARCH_PROJECT_DISABLED');
    state.updateResearchProject({ projectId: project.projectId, enabled: true });
    refused(await call('research.run_submit', { ...runInput, params: { api_key: 'sk_live_' + 'x'.repeat(24) } }), 'RESEARCH_SENSITIVE_CONTENT');
    assert.equal(count(), before);
  });
  await t.test('Research assignments and findings keep Local audit identity and untrusted content', async () => {
    const assigned = success(await call('research.session_assign', { actor: 'local', projectId: project.projectId,
      assign: [{ kind: 'observed', ref: 'local-control-session' }] }));
    assert.equal(assigned.assigned.length, 1);
    assert.equal(state.listResearchSessionAssignments({ projectId: project.projectId }).length, 1);
    const finding = success(await call('research.finding_save', { actor: 'local', projectId: project.projectId,
      claim: 'The isolated call persisted a queued run.', status: 'open' }));
    assert.equal(finding.grantsAuthority, false);
    assert.equal(state.listResearchFindings({ projectId: project.projectId })[0].findingId, finding.findingId);
    for (const action of ['research.session_assign', 'research.finding_save'])
      assert.equal(audit.findLast(row => row.action === action).details.actor, 'local');
  });
  await t.test('overnight submission retains bounded queue, replay, content, policy and fixed-model rules', async () => {
    const result = success(await call('overnight_advisory.submit', advisoryInput));
    const task = state.getTask({ taskId: result.taskId, includePayload: true });
    assert.equal(task.queue, overnight.QUEUE); assert.equal(task.type, overnight.TYPE); assert.equal(task.maxAttempts, 6);
    assert.deepEqual(overnight.metadata(task.payload).acceptanceChecklist, advisoryInput.acceptanceChecklist);
    assert.equal(success(await call('overnight_advisory.submit', advisoryInput)).taskId, result.taskId);
    assert.equal(audit.findLast(row => row.action === 'overnight_advisory.submit').details.actor, 'local');
    const before = count(); advisory = false;
    refused(await call('overnight_advisory.submit', { ...advisoryInput, idempotencyKey: 'local-control-disabled' }), 'OVERNIGHT_ADVISORY_DISABLED');
    advisory = true;
    refused(await call('overnight_advisory.submit', { ...advisoryInput, prompt: 'Contact owner@example.com' }), 'OVERNIGHT_ADVISORY_SENSITIVE_CONTENT');
    const arbitraryModel = await call('overnight_advisory.submit', { ...advisoryInput, model: 'unbounded-caller-model' });
    assert.equal(arbitraryModel.error?.code, -32602, JSON.stringify(arbitraryModel));
    assert.deepEqual(arbitraryModel.error.data, [{ path: 'model', keyword: 'additionalProperties', message: 'additional property is not allowed' }]);
    assert.equal(count(), before);
    for (let index = 1; index < overnight.MAX_QUEUE_DEPTH; index++)
      success(await call('overnight_advisory.submit', { ...advisoryInput, idempotencyKey: `local-control-queue-${index}` }));
    refused(await call('overnight_advisory.submit', { ...advisoryInput, idempotencyKey: 'local-control-overflow' }), 'OVERNIGHT_ADVISORY_QUEUE_FULL');
  });
  await t.test('spoof, missing permission, read-only, role, direct-user and disabled API cannot write', async () => {
    const before = count();
    for (const actor of ['codex', 'human', 'coordinator']) {
      assert.equal((await call('research.run_submit', { ...runInput, actor })).error?.code, -32602);
      assert.equal((await call('overnight_advisory.submit', { ...advisoryInput, actor })).error?.code, -32602);
    }
    for (const [name, input] of [['research.run_submit', runInput], ['overnight_advisory.submit', advisoryInput]]) {
      refused(await call(name, input, { ...options, permissionSession: undefined }), 'PERMISSION_SESSION_REQUIRED');
      refused(await call(name, input, { ...options, permissionSession: { origin: 'local', tier: 'confined', profile: 'read-only' } }), 'PERMISSION_CONFINED_EFFECT_REFUSED');
      assert.equal((await call(name, input, { ...options, agentRole: { functions: [] } })).error?.code, -32602);
      refused(await call(name, input, { ...options, agentPrincipal: { sessionId: 'local-control-session' }, agentRole: undefined }), 'ROLE_POLICY_REQUIRED');
      refused(await call(name, input, { ...options, agentPrincipal: { sessionId: 'local-control-session' },
        agentRole: { functions: LOCAL_CONTROL_TOOLS, requiresDirectUserAuthorization: true } }), 'ROLE_DIRECT_USER_REQUEST_REQUIRED');
      refused(await call(name, input, { ...options, agentApiMode: 'Disabled' }), 'TOOL_API_DISABLED');
    }
    assert.equal(count(), before);
  });
  await t.test('Local lifecycle reaches explicit availability refusal without inventing Linux workers', async () => {
    refused(await call('research.lifecycle', { actor: 'local', action: 'start', idempotencyKey: 'local-control-research-start' }), 'RESEARCH_RUNTIME_UNAVAILABLE');
    refused(await call('overnight_advisory.lifecycle', { actor: 'local', action: 'start', idempotencyKey: 'local-control-advisory-start' }), 'OVERNIGHT_ADVISORY_WORKER_PLATFORM_UNSUPPORTED');
    assert.equal(launches, 0); assert.equal(fs.existsSync(runtimeDir), false);
    assert.equal(audit.findLast(row => row.action === 'overnight_advisory.lifecycle.start').details.actor, 'local');
  });
});
