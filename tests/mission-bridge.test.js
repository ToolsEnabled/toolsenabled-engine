'use strict';

require('./lib/agent-api-mode-fixture').selectAgentApiMode('Enabled');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const {
  authorizedMissionAgent, claudeArgs, codexArgs, createMissionActions, detectClaudeCliPresence, LANE_MCP_CONFIG_FILE, localArgs, TIERS
} = require('../src/lib/mission-bridge/actions');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');
const laneDispatch = require('../src/lib/mission-bridge/agent-lane-dispatch');
const {
  createMissionBridgeServer, DEFAULT_PORTS, MAX_BODY_BYTES, removeRuntimeDiscovery, writeRuntimeDiscovery
} = require('../src/lib/mission-bridge/server');
const queueWriter = require('../src/lib/build-queue-writer');
const queueCorpus = require('../src/lib/build-queue-corpus');
const bridgeCli = require('../tools/mission-bridge');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

// This suite proves the audited operation path: launch, terminal, queue and
// host receipts. Auditing is an explicit choice under the Basic runtime policy,
// so every adapter here is built with that choice saved by a person. It is
// injected, never written to a settings file: this file can be run directly.
const auditChosen = () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] });
const createAuditedMissionActions = options => createMissionActions({ loadSettings: auditChosen, ...options });

const org = declaredOrg();
const controllerActor = enabledControllerId(org);
const firstDeclaredClaudeSeat = TIERS['claude-sonnet'].seats.find(id =>
  org.agents.some(agent => agent.id === id && agent.enabled === true && agent.provider === 'claude')
);

let assertions = 0;
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
async function rejects(fn, code) {
  assertions += 1;
  await assert.rejects(fn, error => error && error.code === code, `expected ${code}`);
}

function fixtureQueue(status = 'OPEN') {
  return [
    '# Build queue',
    '',
    '## Completed — do not rebuild',
    '',
    `- **Q1 — Old:** closed 2026-08-01 by ${controllerActor} — fixture`,
    '',
    '## Q2 — Fixture bridge phase',
    '',
    `**Status:** ${status}`,
    '',
    '**Authority:** R1135 (directiveId: R1135)',
    '',
    '**Instructions (verbatim):**',
    '<!-- build-queue-writer:v1 bytes=12 -->',
    'fixture work',
    ''
  ].join('\n');
}

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const sequence = events.length + 1;
    const event = { action, target, details, sequence, ...extra };
    event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    events.push(event);
    return event;
  };
  return {
    events,
    requireRecord(action, target, details) {
      const event = append(action, target, details);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    tail() { return []; },
    findEvents({ action, target, limit = 100 } = {}) {
      return events.filter(event => (!action || event.action === action) && (!target || event.target === target)).slice(-limit);
    },
    conditionalRecord({ action, target, eventId, decide }) {
      const outcome = decide({ findEvents: this.findEvents.bind(this), nowMs: Date.now() });
      if (outcome.kind === 'refused') return { recorded: false, refusal: outcome.refusal };
      const event = append(action, target, outcome.details, { eventId });
      return { recorded: true, durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash, value: outcome.value };
    }
  };
}

function completedLane(options, status = 'finished') {
  const runId = crypto.randomUUID();
  return {
    runId,
    taskId: `task-${options.agentId}`,
    terminal: {
      agentId: options.agentId,
      runId,
      currentTask: `task-${options.agentId}`,
      status,
      exitCode: status === 'finished' ? 0 : 1,
      lastVerdict: status === 'finished' ? 'VERDICT: fixture complete' : 'VERDICT: fixture failed'
    }
  };
}

function heartbeatPresence(history) {
  return {
    heartbeat(agentId, runId, patch) {
      const record = { agentId, runId, currentTask: patch.currentTask, status: 'running', ...patch };
      history.push(record);
      return record;
    }
  };
}

function toolsFixture(auditApi) {
  const calls = [];
  const execute = async (name, input, context) => {
    calls.push({ name, input, context });
    if (name === 'host.read_file') {
      const stat = fs.statSync(input.path);
      auditApi.requireRecord('host.read_file.intent', input.path, { bytes: stat.size });
      return { path: input.path, content: fs.readFileSync(input.path, 'utf8'), bytes: stat.size };
    }
    if (name === 'memory.set') {
      auditApi.requireRecord('memory.set', `${input.namespace}/${input.key}`, { revision: 1 });
      return { namespace: input.namespace, key: input.key, revision: 1 };
    }
    throw Object.assign(new Error('offline'), { code: 'DEPENDENCY_OFFLINE' });
  };
  return { calls, execute };
}

async function httpJson(baseUrl, pathname, { method = 'GET', token = null, body = null, origin = 'http://127.0.0.2:4600' } = {}) {
  const headers = { origin };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== null) headers['content-type'] = 'application/json';
  const requestUrl = `${baseUrl}${pathname}`;
  let response;
  try {
    response = await fetch(requestUrl, { method, headers, ...(body === null ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    error.message = `${error.message} (${method} ${requestUrl}, origin ${origin})`;
    throw error;
  }
  return { status: response.status, body: await response.json() };
}

function partialJson(baseUrl, pathname, token) {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, baseUrl);
    let received = false;
    const request = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { origin: 'http://127.0.0.2:4600', authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    }, response => {
      received = true;
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', error => { if (!received) reject(error); });
    request.write('{');
  });
}

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => response.end());
    const onError = error => {
      server.off('listening', onListening);
      if (error?.code === 'EADDRINUSE') resolve({ port, server: null, preexisting: true });
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve({ port, server, preexisting: false });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function closeListener(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function firstAvailablePort(ports) {
  for (const port of ports) {
    const probe = await occupyPort(port);
    if (probe.preexisting) continue;
    await closeListener(probe.server);
    return port;
  }
  return null;
}

async function main() {
  // A missing executable and an executable whose presence could not be
  // established are different answers: false versus null.
  {
    const environment = { PATH: ['first', 'second'].join(path.delimiter) };
    equal(detectClaudeCliPresence(environment, {
      statSync() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
    }), false, 'Claude presence reports a definite negative when every candidate is absent');
    equal(detectClaudeCliPresence(environment, {
      statSync(candidate) {
        const code = candidate.includes('first') ? 'EACCES' : 'ENOENT';
        throw Object.assign(new Error(code), { code });
      }
    }), null, 'Claude presence keeps "this did not happen" distinct from "this could not be established"');
  }
  ok(controllerActor, 'organization fixture declares an enabled controller');
  ok(firstDeclaredClaudeSeat, 'organization fixture declares an enabled Claude pool seat');
  const scratchParent = process.env.TOOLSENABLED_TEST_ROOT || isolatedTemporaryRoot();
  const root = fs.mkdtempSync(path.join(scratchParent, 'mission-bridge-test-'));
  const queueFile = path.join(root, 'BUILD-QUEUE.md');
  const reportFile = path.join(root, 'P5-REPORT.md');
  const runtimeFile = path.join(root, 'mission-bridge-runtime.json');
  fs.writeFileSync(queueFile, fixtureQueue(), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(reportFile, '# Fixture report\n\nAll bounded.\n', { encoding: 'utf8', mode: 0o600 });
  const auditApi = auditFixture();
  const toolset = toolsFixture(auditApi);
  const laneCalls = [];
  const policyCalls = [];
  const actions = createAuditedMissionActions({
    roots: { primary: root },
    actor: controllerActor,
    audit: auditApi,
    policy: { assertActive(action, options) { policyCalls.push({ action, options }); } },
    // Pinned, not inherited: without this the builder reads THIS machine's
    // recorded install tier, and the unattended-flag assertion below passes
    // only on a machine recorded unrestricted (red since b43c584 on standard
    // installs). Same pattern as mission-bridge-claude-mcp-config.test.js and
    // tests/helpers/owner-dispatch.js.
    permissionSession: { origin: 'local', tier: 'full' },
    env: { PATH: process.env.PATH, TEST_API_KEY: 'fixture-value' },
    executeTool: toolset.execute,
    resolveCommand: () => ({ command: 'codex-fixture.exe', prefixArgs: [] }),
    // Pinned, not inherited, same rule as permissionSession above: the Claude
    // dispatch below must not depend on whether the machine running this suite
    // has Claude Code installed. The refusal itself has its own case below.
    claudeCliPresent: () => true,
    // A Claude lane is handed --strict-mcp-config, so the real dispatch now
    // resolves that file BEFORE spawning and refuses if this installation has
    // no machine record to generate it from. This fixture has no such record
    // and is not testing that path, so it injects the guard -- exactly what
    // resolveCommand and runLane already do for the executable and the spawn.
    // The refusal itself is covered by tests/mission-bridge-claude-mcp-config.test.js.
    ensureMcpConfig: () => ({ file: null, generated: false }),
    async runLane(options) {
      laneCalls.push(options);
      return completedLane(options);
    }
  });

  try {
    const report = await actions.readReport({ rootId: 'primary', relativePath: 'P5-REPORT.md' });
    equal(report.receipt.content.includes('All bounded.'), true, 'report content comes from audited reader');
    equal(toolset.calls[0].name, 'host.read_file', 'report uses host.read_file');

    const reply = await actions.reply({ idempotencyKey: 'reply-1', threadId: 'owner-thread', message: 'Fixture reply.' });
    equal(reply.receipt.action, 'thread-reply', 'thread reply returns durable receipt');

    /* THE PERSON'S DECISION LANDS IN THE ONE LEDGER (owner, 2026-09-02). An
     * agent principal -- this fixture's controller included -- is refused
     * before any write; the owner-ui principal flips a row an agent filed from
     * waiting to open, and the receipt says what the ledger now holds. */
    const ownerStore = require('../src/lib/owner-request-store');
    const storeOptions = { rootPath: (...parts) => path.join(root, 'ledger-root', ...parts), needsApproval: false };
    const waiting = ownerStore.fileRequest({ scope: 'global', words: 'Fixture rule an agent filed.', filedBy: 'codex', proposed: true }, storeOptions);
    equal(waiting.status, 'proposed', 'the planted row waits for the person');
    const ledgerBytesBefore = fs.readFileSync(waiting.path, 'utf8');
    await assert.rejects(() => actions.decide({ idempotencyKey: 'decision-1', target: waiting.id, decision: 'approve', reason: 'Fixture evidence is sufficient.' }),
      error => error?.code === 'BRIDGE_PERSON_REQUIRED' && error?.status === 403, 'an agent principal may not approve a request');
    assertions += 1;
    equal(fs.readFileSync(waiting.path, 'utf8'), ledgerBytesBefore, 'the refused decision wrote nothing');
    const ownerActions = createAuditedMissionActions({
      roots: { primary: root }, principal: { kind: 'owner-ui' }, audit: auditApi,
      policy: { assertActive(action, options) { policyCalls.push({ action, options }); } },
      permissionSession: { origin: 'local', tier: 'full' }, executeTool: toolset.execute,
      ownerRequestStoreOptions: storeOptions
    });
    const decision = await ownerActions.decide({ idempotencyKey: 'decision-1', target: waiting.id, decision: 'approve', reason: 'Fixture evidence is sufficient.' });
    equal(decision.receipt.action, 'decision', 'decision returns a typed receipt');
    equal(decision.receipt.actor, 'owner', 'decision receipt names the person');
    equal(decision.receipt.requestId, waiting.id, 'the receipt names the request');
    equal(decision.receipt.decision, 'approve');
    equal(decision.receipt.status, 'open', 'approval turns the waiting row open');
    equal(typeof decision.receipt.revision, 'number');
    ok(Number.isFinite(Date.parse(decision.receipt.recordedAt)), 'the receipt is stamped');
    assert.deepEqual(Object.keys(decision.receipt).sort(), ['action', 'actor', 'decision', 'recordedAt', 'requestId', 'revision', 'status']);
    assertions += 1;
    equal(ownerStore.readAll(storeOptions).records.find(record => record.id === waiting.id).status, 'open', 'the ledger holds the decision');
    const declined = await ownerActions.decide({ idempotencyKey: 'decision-2', target: waiting.id, decision: 'decline', reason: 'Changed my mind.' });
    equal(declined.receipt.status, 'declined');
    await rejects(() => ownerActions.decide({ idempotencyKey: 'decision-3', target: 'R9999', decision: 'approve', reason: 'nothing there' }), 'BRIDGE_TARGET_UNKNOWN');
    await rejects(() => ownerActions.decide({ idempotencyKey: 'decision-4', target: waiting.id, decision: 'approve', reason: 'already declined' }), 'BRIDGE_LEDGER_DECISION_REFUSED');
    await rejects(() => ownerActions.decide({ idempotencyKey: 'decision-5', target: 'not-an-id', decision: 'approve', reason: 'malformed' }), 'BRIDGE_TARGET_MALFORMED');
    await rejects(() => ownerActions.decide({ idempotencyKey: 'decision-6', target: waiting.id, decision: 'maybe', reason: 'malformed' }), 'BRIDGE_TARGET_MALFORMED');
    ownerStore.resetKind({ ...ownerStore.previewResetKind({ kind: 'R', actor: 'owner' }, storeOptions), actor: 'owner' }, storeOptions);
    await assert.rejects(() => ownerActions.decide({ idempotencyKey: 'decision-reset', target: waiting.id, decision: 'approve', reason: 'stale approval' }),
      error => error.code === 'BRIDGE_LEDGER_TARGET_RESET' && error.status === 409);
    assertions += 1;
    equal(toolset.calls.filter(call => call.name === 'memory.set').length, 1, 'only the thread reply routes through memory.set; a decision is a ledger write');

    const firstHash = queueWriter.sha256(fs.readFileSync(queueFile, 'utf8'));
    const goalBrief = 'Record this goal in the durable queue only. Do not dispatch a worker from this action.';
    const opened = await actions.queue({
      rootId: 'primary', expectedHash: firstHash, operation: 'open',
      title: 'Fixture goal phase', authority: 'R1135 (directiveId: R1135)', brief: goalBrief
    });
    equal(opened.receipt.action, 'queue-open', 'goal queue open returns a typed receipt');
    equal(opened.receipt.phaseId, 'Q3', 'the writer, not the caller, allocates the next queue id');
    ok(fs.readFileSync(queueFile, 'utf8').includes(goalBrief), 'the bounded goal brief is durably queued verbatim');
    equal(laneCalls.length, 0, 'opening a goal records work only; it never dispatches a lane');
    equal(JSON.stringify(opened.receipt).includes(goalBrief), false, 'the queue-open receipt does not echo the brief');

    const claimed = await actions.queue({ rootId: 'primary', expectedHash: opened.receipt.nextHash, phaseId: 'Q2', operation: 'claim' });
    equal(claimed.receipt.action, 'queue-claim', 'claim receipt is typed');
    ok(fs.readFileSync(queueFile, 'utf8').includes('**Status:** IN-PROGRESS'), 'claim uses strict writer transition');
    const closed = await actions.queue({ rootId: 'primary', expectedHash: claimed.receipt.nextHash, phaseId: 'Q2', operation: 'close', reason: 'Fixture passed all checks.' });
    equal(closed.receipt.action, 'queue-close', 'close receipt is typed');
    const closedText = fs.readFileSync(queueFile, 'utf8');
    equal(closedText.includes('## Q2'), false, 'close removes the live phase');
    ok(closedText.includes('- **Q2 — Fixture bridge phase:**'), 'close reserves the id in Completed');
    fs.mkdirSync(path.join(root, 'queue'));
    fs.writeFileSync(queueFile, `${closedText.trimEnd()}\n\n${queueCorpus.renderQueueIndex(['fixture'])}`, 'utf8');
    fs.writeFileSync(path.join(root, 'queue', 'fixture.md'), queueWriter.renderPhase({
      phaseId: 'Q4', title: 'Sliced fixture phase', authority: 'R1135 (directiveId: R1135)', instructions: 'sliced fixture'
    }), 'utf8');
    const slicedInspection = queueWriter.inspectQueueCorpus({ queueFile });
    equal(slicedInspection.indexed, true, 'queue inspection recognizes indexed corpus');
    equal(slicedInspection.sha256 === queueWriter.sha256(fs.readFileSync(queueFile, 'utf8')), false, 'indexed compare-and-swap hash covers more than the root file');
    const slicedClaim = await actions.queue({ rootId: 'primary', expectedHash: slicedInspection.sha256, phaseId: 'Q4', operation: 'claim' });
    equal(slicedClaim.receipt.queuePath, 'queue/fixture.md', 'status-compatible corpus hash claims a sliced phase');
    await rejects(() => Promise.resolve().then(() => queueWriter.parseStrictQueue(fixtureQueue().replace('**Status:** OPEN', '**Status:** OPEN\n**Status:** DONE'))), 'QUEUE_PHASE_AMBIGUOUS');

    const dispatched = await actions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'phase5-fixture', brief: 'Read the fixture and return a bounded report.',
      cap: { kind: 'turns', value: 3, capMs: 60_000 }
    });
    equal(dispatched.receipt.action, 'dispatch', 'dispatch receipt is typed');
    equal(laneCalls.length, 1, 'dispatch invokes the canonical agent-lane dependency once');
    equal(laneCalls[0].role, 'builder', 'runtime role comes from the normalized tier declaration');
    equal(laneCalls[0].reportsTo, controllerActor, 'runtime reporting line comes from the normalized declaration');
    equal(laneCalls[0].childArgs.at(-1), '-', 'durable brief travels to the Codex lane on stdin');
    equal(laneCalls[0].childArgs.includes('--model'), true, 'tier model is explicit');
    equal(fs.readFileSync(laneCalls[0].brief, 'utf8').includes('Read the fixture'), true, 'bounded brief is durable before runLane is called');
    equal(path.relative(root, laneCalls[0].brief).startsWith('state'), true, 'durable brief path derives from the declared project root');
    equal(laneCalls[0].checkpoint, laneDispatch.checkpointPath(root, dispatched.receipt.launchId), 'launch spec input carries the exact root-derived checkpoint path');
    equal(path.relative(root, laneCalls[0].checkpoint), path.join('state', 'mission-bridge-checkpoints', `${dispatched.receipt.launchId}.md`), 'checkpoint path is bounded and relative to the selected root');
    const checkpointSeed = fs.readFileSync(laneCalls[0].checkpoint, 'utf8');
    ok(checkpointSeed.includes('no child-authored progress has been recorded'), 'first-run checkpoint seed truthfully records no prior progress');
    equal(/Checkpoint state:\s*(?:complete|finished)/i.test(checkpointSeed), false, 'first-run checkpoint seed does not claim completed work');
    ok(fs.readFileSync(laneCalls[0].brief, 'utf8').includes(laneDispatch.checkpointRelativePath(dispatched.receipt.launchId)), 'durable brief tells the child the bounded relative checkpoint path');
    equal(dispatched.receipt.agentId, 'luna', 'dispatch receipt carries the declared target identity');
    equal(dispatched.receipt.kind, 'codex', 'Codex dispatch receipt identifies its lane kind');
    await new Promise(resolve => setImmediate(resolve));
    equal(policyCalls.find(call => call.action === 'mission.bridge.dispatch').options.outward, true, 'dispatch honors the outward kill-switch guard');

    const claudeDispatch = await actions.dispatch({
      rootId: 'primary', tier: 'claude-sonnet', objectiveRef: 'phase2c-claude-fixture', brief: 'Read the fixture and return a bounded Claude report.',
      cap: { kind: 'turns', value: 3, capMs: 60_000 }
    });
    const claudeLane = laneCalls.at(-1);
    equal(claudeDispatch.receipt.kind, 'claude', 'Claude dispatch receipt identifies its lane kind');
    equal(claudeDispatch.receipt.agentId, firstDeclaredClaudeSeat, 'Claude tiers route to the first available declared Claude pool seat');
    equal(claudeLane.kind, 'claude', 'canonical lane options retain Claude kind');
    equal(claudeLane.tier, 'claude/sonnet', 'presence tier records Claude family and tier truthfully');
    equal(claudeLane.childArgs.includes('stream-json'), true, 'Claude output is machine-readable stream JSON');
    equal(claudeLane.childArgs.includes('--dangerously-skip-permissions'), true, 'Claude unattended permission mode is explicit');
    equal(claudeLane.childArgs.includes('--mcp-config'), true, 'Claude launch pins the project MCP config');
    /* THESE TWO LINES USED TO PIN THE DEFECT.
     *
     * They asserted `--tools` was present and that its value was
     * `Read,Edit,Write,Glob,Grep`, and called that "bounded per lane". It was
     * bounded per NOTHING: the same five names were emitted for a `guided` lane and
     * for the unrestricted one, so the argument expressed no level. What it did
     * express was the absence of the Skill tool, and therefore of every skill the
     * product ships -- `/loop` and the rest registered in the child and unable to run.
     *
     * A/B measured 2026-08-13, claude 2.1.186, same prompt and cwd, one flag apart:
     * without `--tools` the init event listed 31 tools including Skill and the child
     * named all 27 skills; with `--tools Read,Edit,Write,Glob,Grep` it listed those
     * five, no Skill, and the child reported that no skills existed. `slash_commands`
     * was identical (42 entries) in both runs, which is why the symptom read as a
     * command that does nothing rather than a command that is missing.
     *
     * So the assertion was inverted: the lane must NOT carry a built-in tool
     * allowlist at all, because any such list is a list somebody has to remember to
     * put Skill back into.
     *
     * AND THAT PROXY HAS NOW BEEN REPLACED BY THE REAL PROPERTY, because the owner
     * asked for the census flag back under a name and a switch -- the AGENT API
     * (B9, 2026-08-24), src/lib/agent-api-policy.js. A blanket ban on `--tools`
     * was never the invariant; it was a way of guaranteeing the invariant when
     * nobody owned the list. Somebody owns it now: the keep-list is a reviewed
     * table with a reason per entry, Skill is on it, and tests/agent-api-policy.test.js
     * fails the moment it is not.
     *
     * What is asserted here instead is the property that actually matters and that
     * survives either decision -- `stripsSkill`, twenty lines down, which walks
     * every tool-shaped argument in the argv whatever its spelling. That check was
     * already written for exactly this case: "asserted directly so a future
     * allowlist cannot reintroduce the defect while still satisfying them". This is
     * that future allowlist, and the check does its job.
     *
     * The five-name set that caused the original defect is still banned below, so
     * the specific regression cannot return under any flag. */
    const toolsAt = claudeLane.childArgs.indexOf('--tools');
    if (toolsAt >= 0) {
      const kept = String(claudeLane.childArgs[toolsAt + 1] ?? '').split(',').map(name => name.trim());
      equal(kept.includes('Skill'), true,
        'if the lane states a built-in census at all it must keep Skill, or every project skill vanishes from the lane again');
      equal(kept.includes('Bash') || kept.includes('PowerShell'), false,
        'the Agent API exists so a shell call goes through host.exec and lands in the audit log; a census that keeps a built-in shell is not the Agent API');
    }
    equal(claudeLane.childArgs.includes('--allowedTools'), false,
      'the same restriction under its other spelling must be gone too');
    equal(claudeLane.childArgs.includes('Read,Edit,Write,Glob,Grep'), false,
      'the five-name set that removed the Skill tool must not survive under any flag');
    /* The property the two lines above only imply, asserted directly so a future
     * allowlist cannot reintroduce the defect while still satisfying them: whatever
     * tool arguments the argv carries, none of them may remove Skill. */
    const stripsSkill = claudeLane.childArgs.some((argument, index) => {
      const value = String(claudeLane.childArgs[index + 1] ?? '').split(',').map(name => name.trim());
      if (argument === '--tools' || argument === '--allowedTools') return !value.includes('Skill');
      if (argument === '--disallowedTools') return value.includes('Skill');
      return false;
    });
    equal(stripsSkill, false, 'no argument in the Claude lane argv may strip the Skill tool');
    equal(claudeLane.childArgs.includes('--disallowedTools'), false,
      'the unrestricted lane carries no tool bound; --disallowedTools belongs to the confined tiers only');
    // The lane's MCP document is the lane's own file. Asserting the exact path is
    // what stops it drifting back onto a checkout's hand-maintained `.mcp.json`,
    // which --strict-mcp-config would then make the lane's ONLY tool source.
    const mcpConfigAt = claudeLane.childArgs.indexOf('--mcp-config');
    equal(claudeLane.childArgs[mcpConfigAt + 1], path.join(root, LANE_MCP_CONFIG_FILE),
      'the Claude lane is pinned to the dispatcher-owned MCP document under the declared root');
    equal(path.basename(claudeLane.childArgs[mcpConfigAt + 1]) === '.mcp.json', false,
      'a dispatch root that is also a checkout must not have its tracked .mcp.json claimed by a lane');
    // Skill discovery is cwd-based, and this fixture's root is a temp directory with
    // no .claude/ in it -- the packaged shape, where the dispatch root is not the
    // checkout. The lane has to be told where the product's skills actually live.
    const addDirAt = claudeLane.childArgs.indexOf('--add-dir');
    ok(addDirAt >= 0, 'a dispatch root that is not the checkout must still reach the checkout\'s skills');
    equal(claudeLane.childArgs[addDirAt + 1], path.resolve(__dirname, '..'),
      '--add-dir names the checkout this product is installed from');
    equal(claudeLane.childArgs.at(-1) === '-', false, 'Claude reads stdin without the Codex dash sentinel');
    await rejects(() => actions.dispatch({
      rootId: 'primary', tier: 'claude-invalid', objectiveRef: 'phase2c-invalid-claude-tier', brief: 'typed refusal probe',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_TIER_REFUSED');

    /* A MACHINE WITHOUT CLAUDE CODE REFUSES BEFORE ANYTHING IS RECORDED.
     * Measured on the sealed 2026-08-19 build in a foreign environment:
     * resolveCommand('claude') legitimately answers a bare `claude.cmd`, the
     * spawn "succeeds", cmd.exe exits 9009 into a log nobody watches -- after
     * a launch record already said a lane started. The refusal must be typed,
     * must carry the install door, and must leave no launch record behind. */
    {
      const launchEventsBefore = auditApi.events.filter(event => event.action === 'controller.agent.launch').length;
      const claudelessActions = createAuditedMissionActions({
        roots: { primary: root }, actor: controllerActor, audit: auditApi,
        policy: { assertActive() {} },
        permissionSession: { origin: 'local', tier: 'full' },
        env: { PATH: process.env.PATH },
        executeTool: toolset.execute,
        resolveCommand: () => ({ command: 'claude.cmd', prefixArgs: [] }),
        ensureMcpConfig: () => ({ file: null, generated: false }),
        claudeCliPresent: () => false,
        async runLane() { throw new Error('a claude lane must not be run on a machine without Claude Code'); }
      });
      await rejects(() => claudelessActions.dispatch({
        rootId: 'primary', tier: 'claude-sonnet', objectiveRef: 'phase2c-claudeless-machine', brief: 'refusal probe',
        cap: { kind: 'turns', value: 1, capMs: 60_000 }
      }), 'BRIDGE_CLAUDE_CLI_NOT_INSTALLED');
      equal(auditApi.events.filter(event => event.action === 'controller.agent.launch').length, launchEventsBefore,
        'a claude dispatch refused for a missing CLI writes no launch record');
    }

    /* THE LOCAL LANE'S RUNNER IS RESOLVED WITH THE SAME RULE AS ITS RUNTIME.
     * The shipped capability payload does not carry
     * tools/local-node-lane-runner.js, so on a customer machine with a working
     * model runtime the dispatch passed every gate and spawned a child that
     * died on MODULE_NOT_FOUND. The refusal must fire before the launch record. */
    {
      const launchEventsBefore = auditApi.events.filter(event => event.action === 'controller.agent.launch').length;
      const runnerlessActions = createAuditedMissionActions({
        roots: { primary: root }, actor: controllerActor, audit: auditApi,
        policy: { assertActive() {} },
        permissionSession: { origin: 'local', tier: 'full' },
        env: { PATH: process.env.PATH },
        executeTool: toolset.execute,
        resolveLocalNode: async () => ({ runtime: 'ollama', model: 'qwen2.5:7b-instruct', host: '127.0.0.1', port: 11434 }),
        laneDependencies: { fsImpl: { ...fs, existsSync: () => false } },
        async runLane() { throw new Error('a local lane must not be run when this copy has no runner program'); }
      });
      await rejects(() => runnerlessActions.dispatch({
        rootId: 'primary', tier: 'local', objectiveRef: 'local-runnerless-copy', brief: 'refusal probe',
        cap: { kind: 'turns', value: 1, capMs: 60_000 }
      }), 'BRIDGE_LOCAL_RUNNER_MISSING');
      equal(auditApi.events.filter(event => event.action === 'controller.agent.launch').length, launchEventsBefore,
        'a local dispatch refused for a missing runner writes no launch record');
    }

    await rejects(() => actions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'phase5-fixture', brief: 'password=hunter2',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_CREDENTIAL_MATERIAL_REFUSED');

    assertions += 1;
    assert.throws(() => laneDispatch.persistCheckpoint({
      projectRoot: root,
      launchId: 'launch_checkpointcredential1',
      content: 'api_key=abcdefghijklmnopqrstuvwxyz123456'
    }), error => error?.code === 'BRIDGE_AGENT_CHECKPOINT_CREDENTIAL_REFUSED', 'checkpoint publication refuses credential-shaped content');
    assertions += 1;
    assert.throws(() => laneDispatch.persistCheckpoint({
      projectRoot: root,
      launchId: 'launch_checkpointoversize01',
      content: 'x'.repeat(laneDispatch.MAX_CHECKPOINT_BYTES + 1)
    }), error => error?.code === 'BRIDGE_AGENT_CHECKPOINT_INVALID', 'checkpoint publication refuses oversized content');
    const escapeRoot = path.join(root, 'checkpoint-escape-root');
    const escapedDirectory = path.join(root, 'checkpoint-outside');
    const stateJunction = path.join(escapeRoot, 'state');
    fs.mkdirSync(escapeRoot);
    fs.mkdirSync(escapedDirectory);
    fs.symlinkSync(escapedDirectory, stateJunction, 'junction');
    try {
      assertions += 1;
      assert.throws(() => laneDispatch.persistCheckpoint({
        projectRoot: escapeRoot,
        launchId: 'launch_checkpointescape0001'
      }), error => error?.code === 'BRIDGE_AGENT_PATH_REFUSED', 'checkpoint publication refuses an ancestor junction escape');
    } finally {
      fs.unlinkSync(stateJunction);
    }

    let observedTimeout = null;
    const timedPresence = [];
    const timedActions = createAuditedMissionActions({
      roots: { primary: root }, actor: controllerActor, audit: auditApi, policy: { assertActive() {} },
      env: { PATH: process.env.PATH },
      executeTool: toolset.execute, resolveCommand: () => ({ command: 'codex-fixture.exe', prefixArgs: [] }),
      laneDependencies: {
        presence: heartbeatPresence(timedPresence),
        setTimeoutImpl(_callback, milliseconds) {
          observedTimeout = milliseconds;
          return { unref() {} };
        },
        clearTimeoutImpl() {}
      },
      spawn() {
        const child = new EventEmitter();
        child.kill = () => true;
        return child;
      },
      async runLane(options, dependencies) {
        const child = dependencies.spawnImpl(options.command, options.childArgs, {
          cwd: options.worktree,
          env: { TOOLSENABLED_AGENT_ID: options.agentId },
          windowsHide: true,
          shell: false
        });
        dependencies.presence.heartbeat(options.agentId, crypto.randomUUID(), {
          pid: 4242,
          currentTask: `task-${options.agentId}`,
          mailboxOffset: 0,
          at: Date.now()
        });
        child.emit('close', 1);
        return completedLane(options, 'failed');
      }
    });
    const timed = await timedActions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'phase5-timeout-fixture', brief: 'Bounded timeout fixture.',
      cap: { kind: 'turns', value: 2, capMs: 61_000 }
    });
    equal(observedTimeout, 61_000, 'declared launch capMs arms the canonical lane child deadline');
    equal(timedPresence.length, 1, 'dispatch waits for the canonical running presence transition');
    ok(auditApi.events.some(event => event.action === 'controller.agent.launch.terminal' && event.target === timed.receipt.launchId && event.details.receipt.terminalState === 'failed'), 'timeout produces a canonical failed terminal receipt');
    const timedStatus = await timedActions.launchStatus({ launchId: timed.receipt.launchId });
    equal(timedStatus.receipt.state, 'failed', 'failed lane remains failed in launch-status');
    equal(timedStatus.receipt.terminal.failureReason, 'VERDICT: fixture failed', 'launch-status carries the lane\'s bounded actionable failure reason');

    const refusedSpawnActions = createAuditedMissionActions({
      roots: { primary: root }, actor: controllerActor, audit: auditApi, policy: { assertActive() {} },
      env: { PATH: process.env.PATH },
      executeTool: toolset.execute, resolveCommand: () => ({ command: 'codex-fixture.exe', prefixArgs: [] }),
      runLane: async () => { throw Object.assign(new Error('fixture spawn refused'), { code: 'ENOENT' }); }
    });
    await rejects(() => refusedSpawnActions.dispatch({
      rootId: 'primary', tier: 'luna', objectiveRef: 'phase5-spawn-fixture', brief: 'Spawn refusal fixture.',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_CODEX_SPAWN_REFUSED');

    await rejects(() => actions.dispatch({
      rootId: 'primary', tier: 'invalid', objectiveRef: 'phase5-fixture', brief: 'refusal probe',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    }), 'BRIDGE_TIER_REFUSED');
    // The scope-activation gate is pinned against the probe's OWN org fixture
    // (the rotatedOrg pattern below), not against this checkout's
    // config/agent-org.json. Since 755dc91 the tracked org is the neutral
    // example, in which sol is enabled with no scopeActivation, so dispatching
    // sol against the declared org legitimately resolves -- asserting a
    // rejection there pinned one installation's private org, not the gate.
    // The scopeActivation tuple shape is the one proven in
    // tests/controller-launch-record.js.
    const scopedOrg = {
      schemaVersion: 1,
      revision: 1,
      agents: [
        { id: 'scoped-controller', displayName: 'Scoped Controller', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
        {
          id: 'sol', displayName: 'Scoped Sol', role: 'builder', provider: 'codex', enabled: false, assignedPhase: null, phasePriority: [],
          scopeActivation: { ruleKey: 'game.agent.model', sourceRequestId: 'R240', model: 'gpt-5.6-sol', tier: 'premium' }
        }
      ],
      relationships: [{ from: 'scoped-controller', to: 'sol', type: 'manages' }]
    };
    const scopedActions = createAuditedMissionActions({
      roots: { primary: root }, actor: 'scoped-controller', agentOrg: scopedOrg, audit: auditApi, policy: { assertActive() {} },
      // Pinned for the same reason as the main instance above: reaching the
      // launch gate must not depend on this machine's recorded install tier.
      permissionSession: { origin: 'local', tier: 'full' },
      executeTool: toolset.execute,
      runLane: async options => completedLane(options)
    });
    await rejects(() => scopedActions.dispatch({ rootId: 'primary', tier: 'sol', objectiveRef: 'phase5-fixture', brief: 'refusal probe', cap: { kind: 'turns', value: 1, capMs: 60_000 } }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED');
    await rejects(() => actions.readReport({ rootId: 'primary', relativePath: '../secret.txt' }), 'BRIDGE_REPORT_PATH_REFUSED');
    assertions += 1;
    assert.throws(() => createAuditedMissionActions({ roots: { primary: root } }), error => error?.code === 'BRIDGE_ACTOR_REFUSED', 'an omitted actor cannot acquire an implicit controller identity');
    const rotatedOrg = {
      schemaVersion: 1,
      revision: 1,
      agents: [
        { id: 'rotated-controller', displayName: 'Rotated Controller', role: 'controller', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
        { id: 'luna', displayName: 'Rotated Luna', role: 'builder', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] },
        { id: 'fixture-observer', displayName: 'Fixture Observer', role: 'observer', provider: 'codex', enabled: true, assignedPhase: null, phasePriority: [] }
      ],
      relationships: [{ from: 'rotated-controller', to: 'luna', type: 'manages' }]
    };
    assertions += 1;
    assert.throws(() => authorizedMissionAgent(null, rotatedOrg), error => error?.code === 'BRIDGE_ACTOR_REFUSED', 'a changed org cannot supply an omitted actor');
    equal(authorizedMissionAgent('rotated-controller', rotatedOrg), 'rotated-controller', 'an explicit controller remains authorized in the changed org');
    const rotatedActions = createAuditedMissionActions({
      roots: { primary: root }, actor: 'rotated-controller', agentOrg: rotatedOrg, audit: auditApi, policy: { assertActive() {} },
      executeTool: toolset.execute,
      runLane: async options => completedLane(options)
    });
    const rotatedReply = await rotatedActions.reply({ idempotencyKey: 'rotated-reply-1', threadId: 'rotated-thread', message: 'Rotated fixture.' });
    equal(rotatedReply.receipt.actor, 'rotated-controller', 'durable actions retain the explicitly bound controller');
    const observerActions = createAuditedMissionActions({
      roots: { primary: root }, actor: 'fixture-observer', agentOrg: rotatedOrg,
      audit: auditApi, policy: { assertActive() {} }, executeTool: toolset.execute
    });
    const observerReply = await observerActions.reply({ idempotencyKey: 'observer-reply-1', threadId: 'observer-thread', message: 'Read-only role report.' });
    equal(observerReply.receipt.actor, 'fixture-observer', 'a reporting-capable non-controller keeps its own identity');
    const queueBeforeObserver = fs.readFileSync(queueFile, 'utf8');
    const auditBeforeObserver = auditApi.events.length;
    await rejects(() => observerActions.queue({ rootId: 'primary', expectedHash: queueWriter.inspectQueueCorpus({ queueFile }).sha256,
      operation: 'open', title: 'Refused observer mutation', authority: 'R1135', brief: 'must not be written' }), 'BRIDGE_ACTOR_REFUSED');
    equal(fs.readFileSync(queueFile, 'utf8'), queueBeforeObserver, 'report permission cannot mutate the queue');
    equal(auditApi.events.length, auditBeforeObserver, 'role denial precedes all write receipts');
    const guardActions = createAuditedMissionActions({
      roots: { primary: root }, actor: controllerActor, audit: auditApi, executeTool: toolset.execute,
      policy: { assertActive() { throw new Error('fixture guard closed'); } }
    });
    await rejects(() => guardActions.reply({ idempotencyKey: 'guard-1', threadId: 'owner-thread', message: 'blocked' }), 'BRIDGE_GUARD_REFUSED');
    const absentActions = createAuditedMissionActions({
      roots: { primary: root }, actor: controllerActor, audit: auditApi, policy: { assertActive() {} },
      executeTool: async () => { throw Object.assign(new Error('offline'), { code: 'DEPENDENCY_OFFLINE' }); }
    });
    await rejects(() => absentActions.readReport({ rootId: 'primary', relativePath: 'P5-REPORT.md' }), 'DEPENDENCY_OFFLINE');

    const token = crypto.randomBytes(32);
    // Inject a KNOWN bootstrap proof rather than letting the server mint one.
    // Two reasons, both real:
    //   1. R1162/N9 made /v1/bootstrap require a local file-proof, because a
    //      browser Origin header is forgeable by any local non-browser client
    //      and so was never authorization. This test predates that and called
    //      the endpoint with no proof, so it asserted 200 against a server that
    //      correctly answers 401 -- a stale expectation, not a code defect.
    //   2. Without an injected proof, mintBootstrapProof() UNLINKS AND RECREATES
    //      the production state/mission-bridge-bootstrap-proof.json. Running the
    //      test suite would invalidate a live bridge's proof as a side effect.
    const bootstrapProof = crypto.randomBytes(32);
    const bridge = createMissionBridgeServer({
      token,
      bootstrapProof,
      allowedOrigins: ['http://127.0.0.2:4600'],
      actions,
      runtimeFile,
      allowTestRuntimeFile: true,
      allowTestPortZero: true,
      runtimeDependencies: { platform: 'test', clock: () => 1_775_000_000_000, pid: 43210 }
    });
    const address = await bridge.listen(0);
    try {
      const runtime = await httpJson(address.baseUrl, '/v1/runtime');
      equal(runtime.status, 200, 'origin-bound runtime discovery needs no bearer');
      equal(runtime.body.baseUrl, address.baseUrl, 'runtime endpoint reports the actual bound baseUrl');
      equal(runtime.body.port, address.port, 'runtime endpoint reports the actual bound port');
      equal(runtime.body.pid, 43210, 'runtime endpoint reports the injected process identity');
      equal(typeof runtime.body.startedAt, 'string', 'runtime endpoint reports a timestamp');
      const runtimeRecord = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      assert.deepEqual(runtimeRecord, address.runtime, 'local discovery file contains only the normalized runtime record');
      assertions += 1;
      assert.deepEqual(Object.keys(runtimeRecord).sort(), ['baseUrl', 'pid', 'port', 'startedAt'], 'discovery file has no bearer/token field');
      equal(JSON.stringify(runtime.body).includes(token.toString('base64url')), false, 'runtime endpoint never contains the bearer');
      equal(fs.readFileSync(runtimeFile, 'utf8').includes(token.toString('base64url')), false, 'runtime discovery file never contains the bearer');
      // The N9 property itself: an allowed origin with NO proof is refused.
      // This is the exact pre-fix behaviour that made the endpoint unsafe, so
      // it is asserted here rather than left to the unit suite alone.
      const unproven = await httpJson(address.baseUrl, '/v1/bootstrap');
      equal(unproven.status, 401, 'an allowed origin without the local file proof is refused');
      equal(unproven.body.error.code, 'BRIDGE_BOOTSTRAP_PROOF_REQUIRED', 'the refusal names the missing proof');
      const wrongProof = await httpJson(address.baseUrl, `/v1/bootstrap?proof=${crypto.randomBytes(32).toString('base64url')}`);
      equal(wrongProof.status, 401, 'a well-formed but different proof is refused');
      const bootstrap = await httpJson(address.baseUrl, `/v1/bootstrap?proof=${bootstrapProof.toString('base64url')}`);
      equal(bootstrap.status, 200, 'allowed origin holding the local file proof can bootstrap');
      equal(bootstrap.body.token, token.toString('base64url'), 'bootstrap returns the in-memory bearer');
      equal(bootstrap.body.capabilities.includes('terminate'), true, 'bootstrap advertises the terminate action');
      const unauthorized = await httpJson(address.baseUrl, '/v1/status', { token: crypto.randomBytes(32).toString('base64url') });
      equal(unauthorized.status, 401, 'wrong bearer is refused');
      equal(unauthorized.body.error.code, 'BRIDGE_UNAUTHORIZED', 'unauthorized refusal is typed');
      const status = await httpJson(address.baseUrl, '/v1/status', { token: bootstrap.body.token });
      equal(status.status, 200, 'authorized status succeeds');
      equal(status.body.actions.includes('terminate'), true, 'status preserves existing actions and includes terminate');
      equal(status.body.queues.primary.ok, true, 'status exposes a strict audited queue snapshot');
      equal(status.body.queues.primary.hash, queueWriter.inspectQueueCorpus({ queueFile }).sha256, 'queue snapshot hash matches the canonical indexed corpus');
      // Until 2026-08-22 status carried a `channels.discord` block; Discord left
      // the product entirely, and the key had no sibling, so the whole block
      // went with it rather than being re-keyed.
      equal(Object.hasOwn(status.body, 'channels'), false, 'status carries no per-channel block now that Discord is gone');
      equal(JSON.stringify(status.body).toLowerCase().includes('discord'), false, 'nothing in status names Discord');
      const malformed = await httpJson(address.baseUrl, '/v1/actions/report-read', {
        method: 'POST', token: bootstrap.body.token, body: { rootId: 'missing', relativePath: 'P5-REPORT.md' }
      });
      equal(malformed.status, 400, 'malformed target is refused');
      equal(malformed.body.error.code, 'BRIDGE_TARGET_MALFORMED', 'malformed target refusal is typed');
      const oversized = await httpJson(address.baseUrl, '/v1/actions/dispatch', {
        method: 'POST', token: bootstrap.body.token, body: { padding: 'x'.repeat(MAX_BODY_BYTES + 1) }
      });
      equal(oversized.status, 413, 'oversized body returns an HTTP refusal instead of resetting the connection');
      equal(oversized.body.error.code, 'BRIDGE_BODY_TOO_LARGE', 'oversized-body refusal is typed');
      const timedBody = await partialJson(address.baseUrl, '/v1/actions/dispatch', bootstrap.body.token);
      equal(timedBody.status, 408, 'incomplete body returns a bounded timeout response');
      equal(timedBody.body.error.code, 'BRIDGE_BODY_TIMEOUT', 'body-timeout refusal is typed');
      const wrongOrigin = await httpJson(address.baseUrl, '/v1/bootstrap', { origin: 'http://evil.invalid' });
      equal(wrongOrigin.status, 403, 'foreign origin is refused');
      equal(wrongOrigin.body.error.code, 'BRIDGE_ORIGIN_REFUSED', 'origin refusal is typed');
      const runtimeWrongOrigin = await httpJson(address.baseUrl, '/v1/runtime', { origin: 'http://evil.invalid' });
      equal(runtimeWrongOrigin.status, 403, 'runtime discovery is origin-bound even though it needs no bearer');
    } finally {
      await bridge.close();
    }
    equal(fs.existsSync(runtimeFile), false, 'graceful close removes its matching runtime discovery record');

    const declaredOrigins = [
      'http://localhost:4600',
      'http://127.0.0.1:4600',
      ...Array.from({ length: 9 }, (_value, index) => `http://127.0.0.1:${4601 + index}`)
    ];
    const conflict = await occupyPort(4610);
    const expectedDynamicPort = await firstAvailablePort(DEFAULT_PORTS);
    ok(expectedDynamicPort !== null, 'dynamic-port fixture has an available default port');
    const forcedBridge = createMissionBridgeServer({
      // bootstrapProof injected for the same reason the token is: minting would
      // unlink the live bridge's production proof in state/ (see mintBootstrapProof).
      token: crypto.randomBytes(32), bootstrapProof: crypto.randomBytes(32),
      allowedOrigins: declaredOrigins, actions,
      runtimeFile: path.join(root, 'mission-bridge-forced-runtime.json'), allowTestRuntimeFile: true,
      runtimeDependencies: { platform: 'test' }
    });
    await rejects(() => forcedBridge.listen(0), 'BRIDGE_PORT_INVALID');
    await rejects(() => forcedBridge.listen(4610), 'BRIDGE_PORT_UNAVAILABLE');
    const dynamicRuntimeFile = path.join(root, 'mission-bridge-dynamic-runtime.json');
    const dynamicBridge = createMissionBridgeServer({
      token: crypto.randomBytes(32), bootstrapProof: crypto.randomBytes(32),
      allowedOrigins: declaredOrigins, actions,
      runtimeFile: dynamicRuntimeFile, allowTestRuntimeFile: true,
      runtimeDependencies: { platform: 'test', clock: () => 1_775_000_100_000, pid: 43211 }
    });
    let dynamicListening = false;
    try {
      const dynamicAddress = await dynamicBridge.listen();
      dynamicListening = true;
      equal(dynamicAddress.port, expectedDynamicPort, 'dynamic fallback selects the first available default port');
      equal(dynamicAddress.baseUrl, `http://127.0.0.1:${expectedDynamicPort}`, 'dynamic fallback reports the actual baseUrl');
      const dynamicRecord = JSON.parse(fs.readFileSync(dynamicRuntimeFile, 'utf8'));
      equal(dynamicRecord.port, expectedDynamicPort, 'dynamic fallback discovery file records the selected port');
      equal(dynamicRecord.baseUrl, dynamicAddress.baseUrl, 'dynamic fallback discovery file records the bound baseUrl');
      for (const appPort of Array.from({ length: 9 }, (_value, index) => 4601 + index)) {
        const appOrigin = await httpJson(dynamicAddress.baseUrl, '/v1/runtime', { origin: `http://127.0.0.1:${appPort}` });
        equal(appOrigin.status, 200, `app origin 127.0.0.1:${appPort} is accepted`);
      }
      const browserOrigin = await httpJson(dynamicAddress.baseUrl, '/v1/runtime', { origin: 'http://127.0.0.1:4600' });
      equal(browserOrigin.status, 200, 'the existing browser origin remains accepted');
      const localhostBrowser = await httpJson(dynamicAddress.baseUrl, '/v1/runtime', { origin: 'http://localhost:4600' });
      equal(localhostBrowser.status, 200, 'the existing localhost browser origin remains accepted');
      const aboveApp = await httpJson(dynamicAddress.baseUrl, '/v1/runtime', { origin: 'http://127.0.0.1:4610' });
      equal(aboveApp.status, 403, 'an app origin above the declared range is refused');
      const wrongHostApp = await httpJson(dynamicAddress.baseUrl, '/v1/runtime', { origin: 'http://localhost:4601' });
      equal(wrongHostApp.status, 403, 'an undeclared hostname on an in-range app port is refused');
    } finally {
      if (dynamicListening) await dynamicBridge.close();
      await closeListener(conflict.server);
    }

    const occupiedRange = [];
    try {
      for (const port of DEFAULT_PORTS) occupiedRange.push(await occupyPort(port));
      const exhaustedRuntimeFile = path.join(root, 'mission-bridge-exhausted-runtime.json');
      const exhaustedBridge = createMissionBridgeServer({
        token: crypto.randomBytes(32), bootstrapProof: crypto.randomBytes(32),
        allowedOrigins: declaredOrigins, actions,
        runtimeFile: exhaustedRuntimeFile, allowTestRuntimeFile: true,
        runtimeDependencies: { platform: 'test' }
      });
      await rejects(() => exhaustedBridge.listen(), 'BRIDGE_PORT_RANGE_EXHAUSTED');
      equal(fs.existsSync(exhaustedRuntimeFile), false, 'all-ports-busy refusal writes no runtime discovery record');
    } finally {
      for (const occupied of occupiedRange.reverse()) await closeListener(occupied.server);
    }

    const aclRuntimeFile = path.join(root, 'mission-bridge-runtime-acl.json');
    const aclCalls = [];
    const aclRecord = {
      baseUrl: 'http://127.0.0.1:4610', port: 4610,
      startedAt: '2026-08-06T08:00:00.000Z', pid: 45678
    };
    fs.writeFileSync(aclRuntimeFile, '{"stale":true}\n', 'utf8');
    const writtenRuntime = writeRuntimeDiscovery(aclRecord, {
      runtimeFile: aclRuntimeFile,
      allowTestRuntimeFile: true,
      platform: 'win32',
      ownerPrincipal: 'WORKGROUP\\Owner',
      spawnSyncImpl(command, args, options) {
        aclCalls.push({ command, args, options });
        return { status: 0, error: null };
      }
    });
    equal(aclCalls.length, 1, 'runtime discovery applies one Windows owner-only ACL');
    assert.deepEqual(JSON.parse(fs.readFileSync(aclRuntimeFile, 'utf8')), aclRecord,
      'one atomic rename replaces a stale discovery record after the temporary file is secured');
    equal(aclCalls[0].command, '\\\\.\\GLOBALROOT\\SystemRoot\\System32\\icacls.exe', 'runtime discovery uses the fixed system icacls boundary');
    ok(aclCalls[0].args.includes('/inheritance:r') && aclCalls[0].args.includes('WORKGROUP\\Owner:(F)'), 'runtime discovery removes inheritance and grants only the owner full control');
    removeRuntimeDiscovery(writtenRuntime.record, { runtimeFile: aclRuntimeFile });
    equal(fs.existsSync(aclRuntimeFile), false, 'matching runtime discovery can be removed without touching another process record');

    const serializedAudit = JSON.stringify(auditApi.events);
    equal(serializedAudit.includes(token.toString('base64url')), false, 'bearer never enters audit events');
    ok(auditApi.events.some(event => event.action === 'controller.agent.launch'), 'dispatch writes canonical launch event');
    ok(auditApi.events.some(event => event.action === 'controller.agent.launch.terminal'), 'dispatch writes canonical exactly-once terminal event');
    ok(auditApi.events.some(event => event.action === 'host.read_file.intent'), 'report read writes canonical host intent');
    ok(auditApi.events.some(event => event.action === 'memory.set'), 'the thread reply uses an audited memory write');
    ok(auditApi.events.some(event => event.action === 'build.queue.claim.intent'), 'queue claim is admitted before mutation');
    ok(auditApi.events.some(event => event.action === 'build.queue.close'), 'queue close writes outcome receipt');
    ok(auditApi.events.some(event => event.action === 'build.queue.open.intent'), 'queue open is admitted before mutation');
    ok(auditApi.events.some(event => event.action === 'build.queue.open'), 'queue open writes a durable outcome receipt');
    equal(JSON.stringify(auditApi.events).includes(goalBrief), false, 'queue-open audit records only brief hashes, never goal text');
    assertions += 1;
    assert.throws(() => bridgeCli.parseArgs(['--actor', controllerActor, '--origin', 'http://127.0.0.2:4600', '--root', `primary=${root}`]),
      /Unknown flag --actor/, 'a startup flag cannot override per-request authenticated identity');
    equal(Object.hasOwn(bridgeCli.parseArgs(['--origin', 'http://127.0.0.2:4600', '--root', `primary=${root}`]), 'actor'), false,
      'the CLI does not manufacture a startup actor');
    equal(bridgeCli.parseArgs(['--origin', 'http://127.0.0.1:4600', '--root', `primary=${root}`]).port, null, 'CLI omission leaves the bounded 4610-4619 scan active');
    equal(bridgeCli.parseArgs(['--origin', 'http://127.0.0.1:4600', '--root', `primary=${root}`, '--port', '4617']).port, 4617, '--port forces one exact valid port');
    assertions += 1;
    assert.throws(() => bridgeCli.parseArgs(['--origin', 'http://127.0.0.1:4600', '--root', `primary=${root}`, '--port', '4610junk']), /--port must be an integer/, 'CLI refuses a partially numeric forced port');
    assertions += 1;
    assert.throws(() => bridgeCli.parseArgs(['--origin', 'http://127.0.0.1:4600', '--root', `primary=${root}`, '--port', '0']), /--port must be an integer/, 'CLI refuses port zero rather than requesting a random listener');

    /* THE OUTCOME OF A LAUNCH MUST BE READABLE, NOT ONLY RECORDABLE.
     *
     * dispatch() returns when the lane has STARTED. Until launch-status existed
     * there was no second question to ask, so the screen's last word on a job was
     * always "the assistant is starting on it now" -- true for a second, then
     * indistinguishable from a lane that finished, failed, or never ran.
     *
     * The four answers are asserted here because the difference between them is
     * the whole point: an outcome we hold a signed receipt for, a lane still
     * inside its cap, a lane past its cap with nothing written down, and an id
     * the ledger does not know. The third and fourth must never be reported as
     * failures -- both mean "we do not know", and they mean it for different
     * reasons a support conversation needs to tell apart. */
    const finished = await actions.launchStatus({ launchId: dispatched.receipt.launchId });
    equal(finished.receipt.action, 'launch-status', 'the launch status receipt is typed');
    equal(finished.receipt.launchId, dispatched.receipt.launchId, 'the status answers about the launch that was asked for');
    equal(finished.receipt.state, 'completed', 'a lane whose mock exited zero reports its recorded outcome');
    equal(finished.receipt.stale, false, 'a launch with a signed terminal receipt is never stale');
    equal(finished.receipt.terminal.terminalState, 'completed', 'the signed terminal receipt travels with the status');
    ok(typeof finished.receipt.terminal.terminalAt === 'string' && finished.receipt.terminal.terminalAt.length > 0,
      'the status says when the outcome was written down');
    equal(Object.hasOwn(finished.receipt.terminal, 'failureReason'), false, 'successful launch-status keeps its existing terminal shape');
    equal(finished.receipt.agentId, 'luna', 'the status names the agent that ran, not the one that asked');
    equal(finished.receipt.objectiveRef, 'phase5-fixture', 'the status names the job in the words it was handed over under');
    const claudeStatus = await actions.launchStatus({ launchId: claudeDispatch.receipt.launchId });
    equal(claudeStatus.receipt.agentId, firstDeclaredClaudeSeat, 'a Claude lane reports its own pooled-seat outcome, not the previous lane\'s');

    const unknown = await actions.launchStatus({ launchId: `launch_${'z'.repeat(32)}` });
    equal(unknown.receipt.state, 'unrecorded', 'a well-formed id the ledger never signed is unrecorded, not failed');
    equal(unknown.receipt.terminal, null, 'an unrecorded launch carries no invented terminal receipt');
    await rejects(() => actions.launchStatus({ launchId: 'not-a-launch-id' }), 'BRIDGE_TARGET_MALFORMED');
    /* The id shape is `launch_` plus base64url, which contains underscores --
     * exactly what SAFE_ID_RE excludes. Pinned because using safeId() here would
     * have refused every launch id the product has ever minted. */
    ok(/^launch_[A-Za-z0-9_-]{16,64}$/.test(dispatched.receipt.launchId), 'a real minted launch id matches the shape the action accepts');
    await rejects(() => actions.launchStatus({ launchId: dispatched.receipt.launchId, rootId: 'primary' }), 'BRIDGE_INPUT_INVALID');
    ok((await actions.status()).actions.includes('launch-status'), 'the bridge declares launch-status among the actions it serves');
    equal(policyCalls.find(call => call.action === 'mission.bridge.launch-status').options.outward, false,
      'reading a launch outcome survives a kill event, like every other pure read');

    /* THE ARGV BUILDERS MUST RUN AT EVERY TIER THE PRODUCT SHIPS.
     *
     * Both builders branch on confinement, and until this block existed only the
     * unrestricted branch of claudeArgs was ever executed by a test -- the whole
     * suite passed with `--disallowedTools CONFINED_LANE_DISALLOWED_TOOLS.join(',')`
     * sitting in the confined branch referencing an identifier defined nowhere.
     * Nothing caught it: an undefined free variable is valid syntax, so `node --check`
     * is silent, and the payload packer copies the file rather than executing it. The
     * first thing to find out would have been a customer's guided lane, dying with a
     * ReferenceError before the agent was spawned.
     *
     * This asserts only what cannot be wrong: the call returns, and every element is
     * a non-empty string. It deliberately pins no flag NAMES, so a lane changing its
     * own posture stays free to do so without editing this test. */
    const localNode = { runtime: 'ollama', model: 'qwen2.5:7b', host: '127.0.0.1', port: 11434 };
    const BUILDERS = Object.freeze({
      claude: Object.freeze({ name: 'claudeArgs', build: (tier, s) => claudeArgs({ root, tier, permissionSession: s }) }),
      codex: Object.freeze({ name: 'codexArgs', build: (tier, s) => codexArgs({ root, tier, permissionSession: s }) }),
      local: Object.freeze({ name: 'localArgs', build: (_tier, s) => localArgs({ root, node: localNode, permissionSession: s }) })
    });
    for (const [level, levelSession] of Object.entries(INSTALL_TIER_SESSIONS)) {
      for (const [tierName, tier] of Object.entries(TIERS)) {
        const builder = BUILDERS[tier.kind];
        ok(builder, `every shipped tier names a kind this test knows how to launch (${tierName}: ${tier.kind})`);
        const where = `${builder.name} for the ${tierName} tier at the ${level} level`;
        let argv;
        assertions += 1;
        assert.doesNotThrow(() => { argv = builder.build(tier, levelSession); }, `${where} builds a command line`);
        ok(Array.isArray(argv) && argv.length > 0, `${where} returns arguments`);
        const unusable = argv.filter(entry => typeof entry !== 'string' || entry.length === 0);
        equal(unusable.length, 0, `${where} emits only usable arguments`);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`mission-bridge: ${assertions} assertions passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error.code || 'ERROR'}: ${error.stack || error}\n`);
  process.exitCode = 1;
});
