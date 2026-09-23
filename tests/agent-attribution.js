// EXECUTABLE CHANGE
// testcanfail-tests-agent-attribution-js
//
// Strengthened assertion: the real-ledger end-to-end case now requires the
// protected audit head to be persisted at least once. Mutation applied:
// src/lib/audit.js writeAnchor() had `writer(encoded, anchor.sequence)` replaced
// temporarily with a no-op. Before this change the complete test stayed GREEN.
// After this change it went RED with:
//   AssertionError [ERR_ASSERTION]: the signed ledger persists its protected head
//   actual: false, expected: true
// The source mutation was restored byte-for-byte (SHA-256 before and after:
// 0d54120a8f091610c6c769cf6d5a268e31bdf2bb68e965e34c932393611d1c4f), and the
// restored run was GREEN with: `Agent attribution tests passed.`
//
// Shape census: (1) NOT-FOUND -- collection loops are fixture-nonempty or have
// explicit cardinality assertions; (2) NOT-FOUND -- no exit-status/truthy-process
// assertions; (3) NOT-FOUND -- the sole try/finally only closes the store and
// does not catch failures; (4) NOT-FOUND -- mock audit coverage tests projection,
// while ledger behavior is covered separately using the real audit module;
// (5) NOT-FOUND -- no skip or platform precondition guard; (6) NOT-FOUND -- no
// expected value is computed by the same product code being checked.
// Precondition: the default Node.js v20.20.2 lacks node:sqlite, so real-ledger
// mutation and green runs used the installed Node.js v22.22.2.

'use strict';

// Q27: observed agent type + declared-vs-observed reconciliation.
//
// Every test runs against fixture session trees in a temp directory -- never
// this machine's real ~/.claude or ~/.codex corpora -- so the suite is
// deterministic, offline, and reads no owner transcript. The final block
// exercises the spawn helper against the REAL signed audit ledger, isolated
// per the project rule via createAuditStore({file: ':memory:'}).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const observer = require('../src/lib/agent-session-observer');
const attribution = require('../src/lib/agent-attribution-projection');
const consentModule = require('../src/lib/ide-session-consent');
const launchRecord = require('../src/lib/controller-launch-record');

// Consent is now an explicit precondition for a session to be PROJECTED at all
// (src/lib/ide-session-consent.js): discovered sessions are listed, never
// auto-adopted. Fixtures here stand for sessions the user HAS imported.
//
// The key set is derived from the fixtures rather than hardcoded. A hardcoded list
// under-imports silently the moment a fixture gains a provider, and the suite then
// fails on a session count instead of on the behaviour it is actually testing.
function importAll(sessions) {
  const split = consentModule.partitionObservedSessions(sessions || [], { ok: true, source: 'file', importedSurfaces: [] });
  return Object.freeze({
    ok: true,
    source: 'file',
    importedSurfaces: Object.freeze(split.offeredSurfaces.map(entry => entry.surface))
  });
}

const launchOutcome = require('../src/lib/launch-outcome');
const agentOrg = require('../src/lib/agent-org');
const realAudit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');
const spawnRecord = require('../tools/spawn-record');

const hash = seed => crypto.createHash('sha256').update(String(seed)).digest('hex');
const code = (fn, expected, label) => assert.throws(fn, error => error && error.code === expected, `${label || ''}: expected ${expected}`);

const NOW = Date.now();
const at = offsetMs => new Date(NOW + offsetMs).toISOString();
const FIXTURE_WORKSPACE = path.join(os.tmpdir(), 'fixture-workspaces', 'ToolsEnabled');

// --- fixtures ----------------------------------------------------------------
//
// The transcripts below deliberately carry realistic message CONTENT, including
// secret-shaped strings and prose, so the no-leak assertion is testing
// something real rather than an empty payload.

const CANARY = Object.freeze([
  'CANARY_PROMPT_TEXT_the_owner_private_question_about_his_medical_records',
  'sk-canaryAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'ghp_canaryBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'C:\\Users\\owner\\Desktop\\SecretProject\\passwords.txt'
]);

function claudeAssistant({ sessionId, model, effort, entrypoint, isSidechain, timestamp }) {
  return JSON.stringify({
    parentUuid: 'f9efc5dd-69d0-4797-912f-78a18f949568',
    isSidechain,
    requestId: `req_${crypto.randomUUID()}`,
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp,
    effort,
    userType: 'external',
    entrypoint,
    cwd: FIXTURE_WORKSPACE,
    sessionId,
    version: '2.1.220',
    gitBranch: 'main',
    message: {
      model,
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: `${CANARY[0]} ${CANARY[1]}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 34, service_tier: 'standard', speed: 'standard' }
    }
  });
}

function claudeUser(sessionId, timestamp) {
  return JSON.stringify({
    type: 'user', sessionId, timestamp, uuid: crypto.randomUUID(), isSidechain: false,
    message: { role: 'user', content: `${CANARY[2]} ${CANARY[3]}` }
  });
}

function codexSessionMeta({ id, parentThreadId, threadSource, agentPath, timestamp }) {
  const payload = {
    session_id: id, id, timestamp, cwd: FIXTURE_WORKSPACE,
    originator: 'codex_vscode', cli_version: '0.146.0-alpha.3.1', thread_source: threadSource,
    model_provider: 'openai',
    base_instructions: { text: `${CANARY[0]} ${CANARY[1]}` },
    git: { commit_hash: 'e57047f3dad43804cfaed1e238447f87906c79e7', branch: 'main' }
  };
  if (parentThreadId) payload.parent_thread_id = parentThreadId;
  if (agentPath) payload.agent_path = agentPath;
  return JSON.stringify({ timestamp, type: 'session_meta', payload });
}

function codexTurnContext({ model, effort, timestamp }) {
  return JSON.stringify({
    timestamp, type: 'turn_context',
    payload: {
      turn_id: crypto.randomUUID(), cwd: FIXTURE_WORKSPACE,
      approval_policy: 'never', model, effort, summary: 'auto', personality: 'pragmatic',
      collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort, developer_instructions: CANARY[3] } }
    }
  });
}

function codexAgentMessage(timestamp) {
  return JSON.stringify({
    timestamp, type: 'response_item',
    payload: { type: 'agent_message', message: `${CANARY[0]} ${CANARY[2]}` }
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q27-observe-'));
const claudeRoot = path.join(root, 'claude-projects');
const codexRoot = path.join(root, 'codex-sessions');

const CLAUDE_MAIN_SESSION = '11111111-2222-4333-8444-555555555555';
const CLAUDE_SDK_SESSION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CODEX_USER_SESSION = '019f9c80-8703-7373-9ffb-3ff319b56337';
const CODEX_SUB_SESSION = '019fab0f-f0b3-7281-95a5-762ff9682986';
const CODEX_TWIN_A = '019fab0f-1111-7281-95a5-762ff9682111';
const CODEX_TWIN_B = '019fab0f-2222-7281-95a5-762ff9682222';

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

// Claude: one interactive IDE session that switched model AND effort mid-run.
write(path.join(claudeRoot, 'c--proj', `${CLAUDE_MAIN_SESSION}.jsonl`), [
  claudeUser(CLAUDE_MAIN_SESSION, at(-600_000)),
  claudeAssistant({ sessionId: CLAUDE_MAIN_SESSION, model: 'claude-sonnet-5', effort: 'high', entrypoint: 'claude-vscode', isSidechain: false, timestamp: at(-600_000) }),
  claudeAssistant({ sessionId: CLAUDE_MAIN_SESSION, model: 'claude-opus-5', effort: 'xhigh', entrypoint: 'claude-vscode', isSidechain: false, timestamp: at(-300_000) })
]);

// Claude: a spawned subagent, with the harness's own declared agent type.
const subagentId = 'a0344bd95d42a51e8';
const subagentFile = path.join(claudeRoot, 'c--proj', CLAUDE_MAIN_SESSION, 'subagents', `agent-${subagentId}.jsonl`);
write(subagentFile, [
  claudeAssistant({ sessionId: CLAUDE_MAIN_SESSION, model: 'claude-fable-5', effort: 'high', entrypoint: 'claude-vscode', isSidechain: true, timestamp: at(-240_000) })
]);
fs.writeFileSync(subagentFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
  agentType: 'general-purpose',
  description: `${CANARY[0]} -- free-form prose that must never be read`,
  name: 'spawn-tracker',
  toolUseId: 'toolu_01GLKC666uqZQz8m1iXJQKbQ',
  spawnDepth: 1,
  model: 'sonnet',
  parentAgentId: 'ab874ea1fbbd27480'
}), 'utf8');

// Claude: a headless sdk-cli run.
write(path.join(claudeRoot, 'c--proj', `${CLAUDE_SDK_SESSION}.jsonl`), [
  claudeAssistant({ sessionId: CLAUDE_SDK_SESSION, model: 'claude-haiku-4-5-20251001', effort: undefined, entrypoint: 'sdk-cli', isSidechain: false, timestamp: at(-120_000) })
]);

// Files under the Claude project tree that are NOT session transcripts must be
// ignored by construction, not by hoping their records fail a type filter.
write(path.join(claudeRoot, 'c--proj', CLAUDE_MAIN_SESSION, 'tool-results', 'decoy.jsonl'), [
  JSON.stringify({ type: 'assistant', timestamp: at(-60_000), sessionId: CLAUDE_MAIN_SESSION, message: { model: 'decoy-model-must-not-appear', content: CANARY[0] } })
]);

// Codex: an owner-driven session on the premium tier.
write(path.join(codexRoot, '2026', '07', '28', `rollout-x-${CODEX_USER_SESSION}.jsonl`), [
  codexSessionMeta({ id: CODEX_USER_SESSION, threadSource: 'user', timestamp: at(-500_000) }),
  codexAgentMessage(at(-499_000)),
  codexTurnContext({ model: 'gpt-5.6-sol', effort: 'ultra', timestamp: at(-480_000) })
]);

// Codex: a spawned subagent thread on the mid tier.
write(path.join(codexRoot, '2026', '07', '28', `rollout-y-${CODEX_SUB_SESSION}.jsonl`), [
  codexSessionMeta({ id: CODEX_SUB_SESSION, parentThreadId: CODEX_USER_SESSION, threadSource: 'subagent', agentPath: '/root/terra_q17_baseline_review', timestamp: at(-200_000) }),
  codexTurnContext({ model: 'gpt-5.6-terra', effort: 'xhigh', timestamp: at(-199_000) })
]);

// Codex: a model with no entry in the product tier map.
write(path.join(codexRoot, '2026', '07', '28', 'rollout-z-019fab0f-3333-7281-95a5-762ff9682333.jsonl'), [
  codexSessionMeta({ id: '019fab0f-3333-7281-95a5-762ff9682333', threadSource: 'subagent', timestamp: at(-100_000) }),
  codexTurnContext({ model: 'codex-auto-review', effort: 'low', timestamp: at(-99_000) })
]);

const observation = observer.observeAgentSessions({ claudeRoot, codexRoot, nowMs: NOW });
const byRef = new Map(observation.sessions.map(session => [session.sourceRef, session]));
const find = predicate => observation.sessions.find(predicate);

// --- 1. observed type is read, not guessed, for both providers ---------------

(() => {
  assert.equal(observation.coverage, 'complete', 'the fixture corpus is small enough to scan completely');
  assert.equal(observation.sessions.length, 6, 'three Claude transcripts and three Codex rollouts, and nothing else under the trees');

  const main = find(session => session.sessionId === CLAUDE_MAIN_SESSION && session.kind === 'interactive');
  assert.equal(main.provider, 'claude');
  assert.equal(main.model, 'claude-opus-5', 'the LATEST observed model is reported, not the first');
  assert.equal(main.effort, 'xhigh');
  assert.equal(main.modelSource, 'assistant.message.model');
  assert.equal(main.effortSource, 'assistant.effort');
  assert.equal(main.serviceTier, 'standard');
  assert.equal(main.surface, 'claude-vscode');
  assert.equal(main.typeLabel, 'claude-opus-5 (xhigh)');
  assert.equal(main.typeChangedDuringSession, true, 'a session that changed model/effort says so instead of collapsing to one value');
  assert.equal(main.modelMix.length, 2);
  assert.equal(main.workspace, 'ToolsEnabled', 'only the workspace folder name, never the full path');

  const sub = find(session => session.agentId !== null);
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.kindReason, 'subagents/agent-*.jsonl transcript');
  assert.equal(sub.agentType, 'general-purpose', 'the harness records the agent TYPE and it is carried through');
  assert.equal(sub.agentName, 'spawn-tracker');
  assert.equal(sub.spawnDepth, 1);
  assert.equal(sub.parentAgentId, 'ab874ea1fbbd27480');
  assert.equal(sub.declaredModelAlias, 'sonnet', 'the harness-requested alias');
  assert.equal(sub.model, 'claude-fable-5', 'and, separately, the concrete model actually served');
  assert.equal(sub.agentMetaSource, 'claude-subagent-meta');

  const sdk = find(session => session.sessionId === CLAUDE_SDK_SESSION);
  assert.equal(sdk.kind, 'subagent', 'an sdk-cli entrypoint is a headless run, not an owner IDE session');
  assert.equal(sdk.model, 'claude-haiku-4-5-20251001');
  assert.equal(sdk.effort, null, 'this record carried no effort label');
  assert.match(sdk.effortUnknownReason, /no effort label/, 'and it says why rather than defaulting one');

  const codexUser = find(session => session.sessionId === CODEX_USER_SESSION);
  assert.equal(codexUser.provider, 'codex');
  assert.equal(codexUser.model, 'gpt-5.6-sol');
  assert.equal(codexUser.effort, 'ultra');
  assert.equal(codexUser.kind, 'interactive');
  assert.equal(codexUser.kindReason, 'session_meta.thread_source user');
  assert.equal(codexUser.modelSource, 'turn_context.payload.model');

  const codexSub = find(session => session.sessionId === CODEX_SUB_SESSION);
  assert.equal(codexSub.kind, 'subagent');
  assert.equal(codexSub.parentSessionId, CODEX_USER_SESSION);
  assert.equal(codexSub.declaredAgentPath, '/root/terra_q17_baseline_review');
  assert.equal(codexSub.model, 'gpt-5.6-terra');

  assert.equal(find(session => session.model === 'decoy-model-must-not-appear'), undefined,
    'a .jsonl outside the session/subagent layout is never scanned');
  console.log('OK: observed model/effort/agent-type read from both providers, latest-wins, with sources named');
})();

// --- 2. unknown tier stays unknown, with a reason, and is never defaulted ----

(() => {
  const claudeSessions = observation.sessions.filter(session => session.provider === 'claude');
  assert.ok(claudeSessions.length >= 3);
  for (const session of claudeSessions) {
    assert.equal(session.costTier, 'unknown', 'no Anthropic product tier mapping is declared, so no Claude cost tier may be asserted');
    assert.equal(session.costTierSource, null);
    assert.match(session.costTierReason, /no product tier mapping for Anthropic model classes is declared/);
    // The type itself is still fully reported -- only the COST bucket is unknown.
    assert.notEqual(session.model, null);
  }

  const sol = find(session => session.model === 'gpt-5.6-sol');
  assert.equal(sol.costTier, 'premium');
  assert.equal(sol.costTierSource, observer.RATE_CARD_SOURCE, 'a mapped tier names the record it came from');
  assert.equal(sol.costTierReason, null);
  assert.equal(find(session => session.model === 'gpt-5.6-terra').costTier, 'standard');

  const autoReview = find(session => session.model === 'codex-auto-review');
  assert.equal(autoReview.costTier, 'unknown', 'a Codex model absent from the tier map is unknown, not silently bucketed as cheap');
  assert.match(autoReview.costTierReason, /no entry in the Codex tier map/);

  // Direct unit coverage of the resolver, including the no-model case.
  assert.equal(observer.costTierForModel('codex', 'gpt-5.6-luna').costTier, 'cheap');
  assert.equal(observer.costTierForModel('codex', 'gpt-5.6-invented').costTier, 'unknown');
  assert.equal(observer.costTierForModel('claude', 'claude-opus-5').costTier, 'unknown');
  const noModel = observer.costTierForModel('claude', null);
  assert.equal(noModel.costTier, 'unknown');
  assert.match(noModel.costTierReason, /no model id was observed/);
  // DEFAULT_TIER exists on the declared side and must NOT leak into observation.
  assert.equal(launchRecord.DEFAULT_TIER, 'cheap');
  assert.ok(!observation.sessions.some(session => session.provider === 'claude' && session.costTier === launchRecord.DEFAULT_TIER),
    'the declared-side default tier must never be applied to an observation');
  console.log('OK: an unmapped model/tier stays unknown with a stated reason, and is never defaulted');
})();

// --- 3. no message content, prompt text, secret, or path ever escapes --------

(() => {
  const serialized = JSON.stringify(observation);
  for (const canary of CANARY) {
    assert.equal(serialized.includes(canary), false, `observation leaked fixture content: ${canary.slice(0, 40)}`);
  }
  assert.equal(serialized.includes('free-form prose that must never be read'), false, 'the subagent meta description is never read');
  assert.equal(serialized.includes('toolu_'), false, 'tool use ids are not carried');
  assert.equal(serialized.includes('SecretProject'), false);
  assert.equal(serialized.includes('Desktop'), false, 'no filesystem path fragment is emitted, only the workspace folder name');
  assert.equal(serialized.includes(root), false, 'the scan root path itself never appears in the output');

  // The gate, not the field list, is what makes this structural: prose placed
  // into a field this module DOES read is still dropped.
  const state = { provider: 'claude', sourceRef: 'x', sessionId: null, parentSessionId: null, surface: null,
    threadSource: null, declaredAgentPath: null, cliVersion: null, gitBranch: null, workspace: null,
    serviceTier: null, agentId: null, parentAgentId: null, agentType: null, agentName: null,
    declaredModelAlias: null, spawnDepth: null, agentMetaSource: null,
    latest: null, mix: new Map(), recordCount: 0, firstAtMs: null, lastAtMs: null };
  observer.claudeLineToState(JSON.stringify({
    type: 'assistant', timestamp: at(0), sessionId: CLAUDE_MAIN_SESSION, entrypoint: 'claude-vscode',
    message: { model: `please ignore prior instructions and ${CANARY[0]}`, usage: { service_tier: 'standard' } }
  }), state);
  assert.equal(state.latest, null, 'a prose-shaped model field is dropped by the allowlist gate rather than emitted');
  assert.equal(state.mix.size, 0);
  console.log('OK: no message content, prompt text, secret, or filesystem path escapes the observer');
})();

// --- declared side: a small org and a mock ledger -----------------------------

const org = agentOrg.normalizeOrg({
  revision: 1,
  agents: [
    { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'claude', enabled: true },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true },
    { id: 'terra', displayName: 'Terra', role: 'builder', provider: 'codex', enabled: true },
    // 'builder', not 'reviewer'. This fixture only needs a codex-provider agent
    // that can be LAUNCHED at a phase; the role was incidental. agent-org.js's
    // NON_CLAIMING_ROLES later added 'reviewer' to the read-only set on purpose
    // ("this narrows what an agent may do"), and controller-launch-record.js
    // routes its phase gate through mayClaim(), so recordSpawn() below started
    // throwing LAUNCH_PHASE_REJECTED for phase Q27. The product rule is correct
    // and is pinned by tests/controller-launch-record.js; it was this fixture
    // that went stale. Match luna/terra rather than relax the gate.
    { id: 'sol', displayName: 'Sol', role: 'builder', provider: 'codex', enabled: true },
    { id: 'local-worker', displayName: 'Local worker', role: 'worker', provider: 'local', enabled: true },
    { id: 'ghostagent', displayName: 'Ghost', role: 'builder', provider: 'codex', enabled: false }
  ],
  relationships: [
    { from: 'claude', to: 'luna', type: 'manages' },
    { from: 'claude', to: 'terra', type: 'manages' },
    { from: 'claude', to: 'sol', type: 'manages' },
    { from: 'claude', to: 'local-worker', type: 'manages' },
    { from: 'claude', to: 'ghostagent', type: 'manages' }
  ]
});

function makeMockAudit(clock) {
  const events = [];
  let seq = 0;
  return {
    events,
    requireRecord(action, target, details) {
      seq += 1;
      const record = { sequence: seq, eventId: `evt-${seq}`, eventHash: hash(`${action}:${target}:${seq}`),
        event: { action, target, details, timestamp: new Date(clock()).toISOString() } };
      events.push(record);
      return { durable: true, anchored: true, sequence: record.sequence, eventHash: record.eventHash };
    },
    findEvents({ action, target, limit = 100 }) {
      return events.filter(entry => entry.event.action === action && entry.event.target === target).slice(0, limit);
    },
    tail(limit = 20) {
      return events.slice(-limit).map(entry => ({ ...entry.event, sequence: entry.sequence, eventId: entry.eventId, eventHash: entry.eventHash }));
    }
  };
}

// --- 4. reconciliation, both directions --------------------------------------

(() => {
  let now = NOW - 500_000 - 30_000; // just before the codex sol session starts
  const clock = () => now;
  const auditApi = makeMockAudit(clock);

  // (a) A declared launch that DID produce an observed session.
  const matched = spawnRecord.recordSpawn(
    { requestingActor: 'claude', targetAgentId: 'sol', objectiveRef: 'Q27', model: 'gpt-5.6-sol', tier: 'premium', turns: 30 },
    { org, audit: auditApi, clock });

  // (b) A declared launch for an observable provider with NO session anywhere
  //     near it in time -> unobserved drift.
  now = NOW - 5_000;
  const unobserved = spawnRecord.recordSpawn(
    { requestingActor: 'claude', targetAgentId: 'luna', objectiveRef: 'Q27-idle', model: 'gpt-5.6-luna', turns: 10, capMs: 60_000 },
    { org, audit: auditApi, clock });

  // (c) A declared launch on a provider this repo cannot observe at all. This
  //     must NOT be counted as drift.
  const unobservable = spawnRecord.recordSpawn(
    { requestingActor: 'claude', targetAgentId: 'local-worker', objectiveRef: 'Q27-local', model: 'local-sidecar', turns: 10 },
    { org, audit: auditApi, clock });

  const projection = attribution.buildAgentAttributionProjection(
    { nowMs: NOW, windowMs: 24 * 60 * 60 * 1000, observation, sessionConsent: importAll(observation.sessions) },
    { org, audit: auditApi });

  assert.equal(projection.counts.declaredLaunches, 3);
  assert.equal(projection.counts.observedSessions, 6);

  // direction 1: declared -> observed
  const matchedLaunch = projection.launches.find(entry => entry.launchId === matched.launchId);
  assert.equal(matchedLaunch.origin, 'declared');
  assert.equal(matchedLaunch.corroboration, 'observed', 'a declared launch with a matching session reads as observed');
  assert.equal(matchedLaunch.matchStrength, 'model-exact');
  assert.equal(matchedLaunch.observable, true);
  assert.equal(byRef.get(matchedLaunch.observationRef).model, 'gpt-5.6-sol');

  const unobservedLaunch = projection.launches.find(entry => entry.launchId === unobserved.launchId);
  assert.equal(unobservedLaunch.corroboration, 'unobserved', 'a declared launch with no session reads as unobserved, never as running');
  assert.equal(unobservedLaunch.observable, true);
  assert.match(unobservedLaunch.corroborationReason, /never started, or it started outside/);

  const unobservableLaunch = projection.launches.find(entry => entry.launchId === unobservable.launchId);
  assert.equal(unobservableLaunch.observable, false, 'a provider with no session-file observer is unobservable, not drift');
  assert.match(unobservableLaunch.corroborationReason, /no session-file observer exists for provider "local"/);
  assert.equal(projection.counts.unobservableLaunches, 1);
  assert.equal(projection.counts.unobservedLaunches, 1, 'the unobservable launch is excluded from the unobserved count');
  assert.equal(projection.counts.corroboratedLaunches, 1);

  // direction 2: observed -> declared
  const attributedSessions = projection.sessions.filter(entry => entry.attribution === 'attributed');
  assert.equal(attributedSessions.length, 1);
  assert.equal(attributedSessions[0].model, 'gpt-5.6-sol');
  assert.equal(attributedSessions[0].launchId, matched.launchId);

  assert.equal(projection.counts.unattributedSessions, 5, 'every observed session with no launch record is counted as unattributed, never omitted');
  assert.equal(projection.unattributed.observed.count, 5);
  assert.deepEqual(projection.unattributed.observed.byProvider, { claude: 3, codex: 2 });
  assert.equal(projection.unattributed.observed.confidence, 'medium');
  assert.ok(projection.unattributed.observed.limitations.some(line => /not a join/.test(line)),
    'the correlational nature of a match is disclosed, not hidden behind a clean number');
  assert.notEqual(projection.unattributed.observed.confidence, 'high');
  assert.notEqual(projection.reconciliation.confidence, 'high');

  // The ledger-based estimate is preserved verbatim alongside, not replaced.
  assert.ok(projection.unattributed.ledger, 'the original ledger estimate is still published');
  assert.equal(projection.unattributed.ledger.method, 'bounded-tail-window-count-diff');
  assert.ok(['low', 'very-low'].includes(projection.unattributed.ledger.confidence));

  // Dashboard-facing mix, so tiers can be compared on real launches going forward.
  assert.equal(projection.mix.byCostTier.premium, 1);
  assert.equal(projection.mix.byCostTier.standard, 1);
  assert.equal(projection.mix.byCostTier.unknown, 4);
  assert.ok(projection.mix.byAgentType.some(row => row.key === 'general-purpose'));
  console.log('OK: reconciliation resolves both directions, and an unobservable provider is not miscounted as drift');
})();

// --- 5. an ambiguous correlation refuses rather than guessing ----------------

(() => {
  const twinAt = NOW - 400_000;
  const twins = [CODEX_TWIN_A, CODEX_TWIN_B].map(id => Object.freeze({
    schemaVersion: 1, origin: 'observed', provider: 'codex', observationRef: `ref-${id}`, sourceRef: `ref-${id}`,
    sessionId: id, parentSessionId: null, agentId: null, parentAgentId: null, agentType: null, agentName: null,
    spawnDepth: null, declaredModelAlias: null, agentMetaSource: null, agentTypeUnknownReason: null,
    surface: 'codex_vscode', threadSource: 'user', kind: 'interactive', kindReason: 'x', declaredAgentPath: null,
    cliVersion: null, gitBranch: null, workspace: null, serviceTier: null,
    model: 'gpt-5.6-luna', modelSource: 'turn_context.payload.model', modelUnknownReason: null,
    effort: 'medium', effortSource: 'turn_context.payload.effort', effortUnknownReason: null,
    costTier: 'cheap', costTierSource: observer.RATE_CARD_SOURCE, costTierReason: null,
    typeLabel: 'gpt-5.6-luna (medium)', modelMix: [], typeChangedDuringSession: false,
    firstObservedAt: new Date(twinAt).toISOString(), firstObservedAtMs: twinAt,
    observedAt: new Date(twinAt).toISOString(), observedAtMs: twinAt,
    recordCount: 1, method: observer.OBSERVATION_METHOD
  }));

  let now = twinAt - 10_000;
  const clock = () => now;
  const auditApi = makeMockAudit(clock);
  const ambiguous = spawnRecord.recordSpawn(
    { requestingActor: 'claude', targetAgentId: 'luna', objectiveRef: 'Q27-twins', model: 'gpt-5.6-luna', turns: 10 },
    { org, audit: auditApi, clock });

  const projection = attribution.buildAgentAttributionProjection(
    { nowMs: NOW, observation: { method: observer.OBSERVATION_METHOD, coverage: 'complete', coverageNotes: [], scans: [], sessions: twins }, sessionConsent: importAll(twins) },
    { org, audit: auditApi });

  const entry = projection.launches.find(row => row.launchId === ambiguous.launchId);
  assert.equal(entry.corroboration, 'ambiguous');
  assert.equal(entry.observationRef, null, 'an ambiguous launch is attributed to NO session rather than to a plausible one');
  assert.match(entry.corroborationReason, /refusing to attribute rather than guessing/);
  assert.equal(projection.counts.ambiguousLaunches, 1);
  assert.equal(projection.counts.unattributedSessions, 2, 'refusing to guess deliberately inflates the unattributed count instead of hiding it');
  assert.ok(projection.unattributed.observed.limitations.some(line => /tied against two or more sessions/.test(line)));
  console.log('OK: an ambiguous correlation refuses to attribute and says so in the limitations');
})();

// --- 6. the spawn helper still enforces every launch-record refusal ----------

(() => {
  let now = NOW;
  const clock = () => now;
  const auditApi = makeMockAudit(clock);
  const base = { requestingActor: 'claude', targetAgentId: 'luna', objectiveRef: 'Q27', model: 'gpt-5.6-luna' };

  code(() => spawnRecord.recordSpawn({ ...base, targetAgentId: 'ghostagent' }, { org, audit: auditApi, clock }), 'LAUNCH_DISABLED_AGENT', 'disabled agent');
  code(() => spawnRecord.recordSpawn({ ...base, targetAgentId: 'nosuchagent' }, { org, audit: auditApi, clock }), 'LAUNCH_UNKNOWN_AGENT', 'unknown agent');

  const fanoutRoot = spawnRecord.recordSpawn({ ...base, objectiveRef: 'fanout-root' }, { org, audit: auditApi, clock });
  for (let index = 0; index < launchRecord.MAX_FAN_OUT; index += 1) {
    const child = spawnRecord.recordSpawn({ ...base, objectiveRef: 'fanout-child', parentLaunchId: fanoutRoot.launchId }, { org, audit: auditApi, clock });
    assert.equal(child.record.depth, 1);
  }
  code(() => spawnRecord.recordSpawn({ ...base, objectiveRef: 'fanout-child', parentLaunchId: fanoutRoot.launchId }, { org, audit: auditApi, clock }),
    'LAUNCH_FANOUT_EXCEEDED', `child ${launchRecord.MAX_FAN_OUT + 1}`);

  let chain = spawnRecord.recordSpawn({ ...base, objectiveRef: 'depth-root' }, { org, audit: auditApi, clock });
  for (let depth = 1; depth <= launchRecord.MAX_DEPTH; depth += 1) {
    chain = spawnRecord.recordSpawn({ ...base, objectiveRef: 'depth-child', parentLaunchId: chain.launchId }, { org, audit: auditApi, clock });
    assert.equal(chain.record.depth, depth);
  }
  code(() => spawnRecord.recordSpawn({ ...base, objectiveRef: 'depth-child', parentLaunchId: chain.launchId }, { org, audit: auditApi, clock }),
    'LAUNCH_DEPTH_EXCEEDED', `depth ${launchRecord.MAX_DEPTH + 1}`);

  // The helper adds exactly one refusal of its own: it will not invent a type.
  assert.throws(() => spawnRecord.recordSpawn({ ...base, model: undefined }, { org, audit: auditApi, clock }),
    /model is required/, 'the spawn helper refuses to default a model rather than recording an invented type');
  const explicitUnknown = spawnRecord.recordSpawn({ ...base, objectiveRef: 'Q27-unknown-type', model: 'unknown' }, { org, audit: auditApi, clock });
  assert.equal(explicitUnknown.record.model, 'unknown', 'an unknown type may be recorded, but only explicitly by the caller');
  console.log('OK: the spawn helper enforces every launch-record refusal and refuses to default a model');
})();

// --- 7. end-to-end through the spawn helper against the REAL signed ledger ----

function memoryAnchor(onSet) {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      onSet();
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      if (value !== null && sequence < JSON.parse(value).sequence) throw new Error('anchor cannot move backward');
      value = next;
    }
  };
}

(() => {
  const isolatedStore = createAuditStore({ file: ':memory:' });
  const projectionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q27-attrib-e2e-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  let nextId = 0;
  let anchorWrites = 0;
  const deps = {
    store: isolatedStore,
    signer: {
      keyId: 'q27-attrib-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(projectionDirectory, value),
    env: {},
    eventIdFactory: () => `q27-attrib-${String(++nextId).padStart(6, '0')}`,
    clock: () => NOW - 500_000 - 30_000 + nextId,
    reportError: () => {},
    anchorStore: memoryAnchor(() => { anchorWrites += 1; })
  };
  const isolatedAudit = {
    requireRecord: (action, target, details) => realAudit.requireRecord(action, target, details, deps),
    findEvents: query => realAudit.findEvents(query, deps),
    tail: limit => realAudit.tail(limit, deps)
  };

  try {
    const result = spawnRecord.recordSpawn(
      { requestingActor: 'claude', targetAgentId: 'sol', objectiveRef: 'Q27', model: 'gpt-5.6-sol', tier: 'premium', turns: 30 },
      { org, audit: isolatedAudit, clock: () => NOW - 500_000 - 30_000 });

    // One signed controller.agent.launch event, targeted at the launch id.
    const events = isolatedAudit.findEvents({ action: launchRecord.LAUNCH_ACTION, target: result.launchId, limit: 5 });
    assert.equal(events.length, 1, 'the spawn helper writes exactly one signed launch event');
    assert.ok(anchorWrites > 0, 'the signed ledger persists its protected head');
    assert.equal(launchRecord.launchFromAuditEvent(events[0]).recordHash, result.recordHash);
    assert.match(result.auditEventHash, /^[a-f0-9]{64}$/);

    // And it is the event the projection reconciles against.
    const projection = attribution.buildAgentAttributionProjection(
      { nowMs: NOW, observation, sessionConsent: importAll(observation.sessions) }, { org, audit: isolatedAudit });
    const row = projection.launches.find(entry => entry.launchId === result.launchId);
    assert.equal(row.corroboration, 'observed');
    assert.equal(row.matchStrength, 'model-exact');
    assert.equal(row.tier, 'premium');
    assert.equal(row.tierProposed, true, 'a costlier-than-default tier stays flagged through the helper');

    const receipt = launchOutcome.normalizeReceipt({
      schemaVersion: launchOutcome.SCHEMA_VERSION,
      launchId: result.launchId,
      launchRecordHash: result.recordHash,
      terminalState: 'completed',
      terminalAt: at(-1_000)
    });
    isolatedAudit.requireRecord(launchOutcome.TERMINAL_ACTION, result.launchId, launchOutcome.terminalPayload(receipt));
    const terminalProjection = attribution.buildAgentAttributionProjection(
      { nowMs: NOW, observation, sessionConsent: importAll(observation.sessions) }, { org, audit: isolatedAudit });
    const terminalRow = terminalProjection.launches.find(entry => entry.launchId === result.launchId);
    assert.equal(terminalRow.terminalState, 'completed', 'the projection joins the hash-bound terminal receipt');
    assert.equal(terminalRow.storedTerminalState, 'completed');
    assert.equal(terminalRow.stale, false);
    console.log('OK: end-to-end -- the spawn helper writes one signed launch event that the projection reconciles');
  } finally {
    isolatedStore.close();
  }
})();


// --- 8. the consent gate, in the projection itself --------------------------
//
// BOTH halves are asserted here, because satisfying either one alone produces a
// broken product. If sessions appear without a choice, the feature is invasive.
// If the offer list is empty when sessions exist, the feature is invisible and
// nobody can ever import anything. The owner asked for listed-but-not-adopted,
// which is precisely the conjunction.

(() => {
  const observation = {
    method: observer.OBSERVATION_METHOD,
    coverage: 'complete',
    coverageNotes: [],
    scans: [],
    sessions: [
      { observationRef: 'r1', observedAtMs: NOW - 1000, provider: 'codex', surface: 'codex_vscode', kind: 'interactive', typeLabel: 'x', costTier: 'unknown' },
      { observationRef: 'r2', observedAtMs: NOW - 2000, provider: 'claude', surface: null, kind: 'interactive', typeLabel: 'y', costTier: 'unknown' }
    ]
  };
  // Half one: no choice made -> nothing is projected.
  const none = attribution.buildAgentAttributionProjection(
    { nowMs: NOW, observation, sessionConsent: { ok: true, source: 'absent', importedSurfaces: [] } },
    { org, audit: realAudit });
  assert.equal(none.sessions.length, 0, 'a session must never be projected without an explicit import');
  assert.equal(none.sessionConsent.importedCount, 0);

  // Half two: the machine is NOT reported as empty, and the surfaces are offered.
  assert.equal(none.sessionConsent.discoveredTotal, 2,
    'discovery must survive the gate, or an unimported machine renders as an idle one');
  assert.equal(none.sessionConsent.offeredSurfaces.length, 2,
    'both surfaces must be offered as choices, including the one with no identifiable surface');
  assert.ok(none.sessionConsent.offeredSurfaces.some(entry => entry.surface === 'codex_vscode'));
  assert.ok(none.sessionConsent.offeredSurfaces.some(entry => entry.synthetic === true),
    'a surfaceless session must still be importable under a synthetic key, or it is lost forever');

  // Choosing one imports exactly that one.
  const one = attribution.buildAgentAttributionProjection(
    { nowMs: NOW, observation, sessionConsent: { ok: true, source: 'file', importedSurfaces: ['codex_vscode'] } },
    { org, audit: realAudit });
  assert.equal(one.sessions.length, 1);
  assert.equal(one.sessions[0].observationRef, 'r1');
  assert.equal(one.sessionConsent.availableCount, 1, 'the unchosen session stays offered, not discarded');

  console.log('OK: IDE sessions are listed and offered, and never projected without an explicit import');
})();

fs.rmSync(root, { recursive: true, force: true });
console.log('Agent attribution tests passed.');
