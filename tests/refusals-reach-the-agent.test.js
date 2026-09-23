'use strict';
/* A REFUSAL HAS TO REACH THE AGENT THAT CAUSED IT.
 *
 * MEASURED 2026-09-03 on the owner's own fleet. agent.spawn was refused 41
 * times out of 51 attempts in three hours, and every single refusal reached the
 * calling agent as one sentence:
 *
 *     "The required service is temporarily unavailable. Try again later."
 *
 * A manager retried on that sentence eleven times across half an hour and then
 * reported "agent.spawn is unavailable, so neither lane has a worker". The
 * Controller concluded "Blocked and staying blocked. No worker can be created
 * by anyone." Neither was true. The real reasons were sitting in the audit log
 * the whole time -- a contract 817 characters over the ceiling, an argument
 * belonging to a different surface, a parent the view thought had finished --
 * and each one told the agent exactly what to change.
 *
 * TWO INDEPENDENT FAULTS PRODUCED THAT SENTENCE, and this file holds both.
 *
 *   1. CLASSIFICATION. error-taxonomy's UNAVAILABLE rule matches the token
 *      'SPAWN', which was meant for a child process that failed to start. It
 *      also matches every deterministic refusal whose code contains the word.
 *      A refusal classified as an outage is marked retryable, and a retryable
 *      answer is an instruction to wait.
 *
 *   2. PRESENTATION. mcp-server returned the taxonomy's fixed per-class
 *      summary as the tool's text, so even a correctly classified refusal
 *      arrived without its reason. structuredContent carried it; nothing an
 *      agent reads does.
 *
 * Fixing either alone leaves the loop: a correctly classified refusal with no
 * reason still cannot be acted on, and a well-worded refusal marked retryable
 * still says "try again later" alongside it.
 *
 *   node --test tests/refusals-reach-the-agent.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const taxonomy = require('../src/lib/error-taxonomy.js');
const { toolError } = require('../src/mcp-server.js');
const { StateStoreError } = require('../src/lib/state-store.js');

test('tree lifecycle refusal code survives the text-only MCP representation', async () => {
  const tree = require('../src/lib/agent-tree-spawn');
  const refusal = Object.assign(new Error('Tree lifecycle authority refused this request.'), {
    code: 'TREE_DELEGATION_REFUSED', details: { private: 'synthetic private authority detail' }
  });
  tree.installTreeSpawnHost({ spawn() {}, isTreeSession: () => true,
    confinedTreeLifecycleVersion: 1, commandConfined() { throw refusal; } });
  try {
    for (const verb of ['resume', 'restart']) {
      let caught;
      try { await tree.commandOnTree(verb, { confined: true, parentSessionId: 'parent', nodeId: 'child' }); }
      catch (error) { caught = error; }
      assert.equal(caught, refusal, 'the host command does not discard the original code');
      const result = JSON.parse(JSON.stringify(toolError(caught)));
      assert.equal(result.content[0].text,
        'Tree lifecycle authority refused this request.\n{"code":"TREE_DELEGATION_REFUSED"}');
      assert.equal(result.structuredContent.error.code, 'TREE_DELEGATION_REFUSED');
      assert.equal(result.structuredContent.error.taxonomy.retryable, false);
      assert.doesNotMatch(JSON.stringify(result), /synthetic private authority detail/);
    }
  } finally { tree.clearTreeSpawnHost(); }
});

test('text code projection is exact and closed, not an arbitrary provider-code channel', () => {
  for (const code of ['TREE_DELEGATION_REFUSED_PRIVATE', 'TREE_DELEGATION_REFUSED\nprivate',
    'private-provider-code', 'SIGNATURE_INVALID']) {
    const result = toolError(Object.assign(new Error('synthetic reason'), { code }));
    assert.equal(result.content[0].text.includes(code), false, code);
    assert.equal(result.content[0].text.includes('{"code"'), false, code);
  }
});

/* The codes the live fleet actually produced, with the sentence each one
   carries. Every string here was read out of the audit log. */
const REAL_REFUSALS = Object.freeze([
  ['AGENT_SPAWN_TREE_BRIEF_TOO_LONG',
    "The expanded contract is 4817 characters and a circle's opening message holds 4000."],
  ['AGENT_SPAWN_TREE_ARGUMENT_REFUSED',
    '"turns" belongs to a detached lane.'],
  ['AGENT_SPAWN_TREE_ROLE_UNKNOWN',
    '"boss" is not the name of a role this computer declares.'],
  ['MC_TREE_SPAWN_PARENT_NOT_RUNNING',
    'The application could not add that assistant to the tree.'],
  ['AGENT_SPAWN_TREE_ROUTE_CLOSED',
    'This computer is set to keep assistants off the tree.'],
]);

/* THE REFUSALS agent.spawn GAINED WITH effort/provider/model (2026-09-19), and
   why they are listed HERE rather than appended to REAL_REFUSALS above: not one
   of them has been in the live audit log, because the arguments that raise them
   did not exist until this change. They are held to exactly the same two rules
   all the same -- a caller must be told to change its input rather than to
   wait, and must be shown the tool's own sentence.
 *
 * EVERY ONE OF THESE CODES CONTAINS THE TOKEN `SPAWN`, which is the whole
 * reason this file exists: error-taxonomy's UNAVAILABLE rule matches that
 * token, and a refusal that falls through to it is marked retryable and comes
 * back to the agent as "try again later". They classify correctly only because
 * each one also names its own refusal, and that rule is checked FIRST. A future
 * code named AGENT_SPAWN_EFFORT_UNKNOWN rather than ..._REFUSED would silently
 * rejoin the eleven-retry loop this file was written for. */
const SPAWN_CHOICE_REFUSALS = Object.freeze([
  ['AGENT_SPAWN_EFFORT_REFUSED',
    'Subagent spawn refused: "banana" is not a reasoning effort this computer accepts, so nothing was started.'],
  ['AGENT_SPAWN_PROVIDER_REFUSED',
    'Subagent spawn refused: tier "claude-opus" already fixes the provider to claude, and provider "codex" contradicts it.'],
  ['AGENT_SPAWN_MODEL_REFUSED',
    'Subagent spawn refused: model "claude/opus" contradicts tier "astra", which already fixes the model.'],
  ['AGENT_SPAWN_LANE_ARGUMENT_REFUSED',
    'Subagent spawn refused: "effort" is chosen for a circle on the visible tree, and this spawn is going to a detached lane.'],
  ['AGENT_SPAWN_TIER_REFUSED',
    'Subagent spawn refused: effort, provider and model are checked against the tier, and "banana" is not a tier this computer declares.'],
]);

function classify(code) {
  const error = new Error('refused');
  error.code = code;
  return taxonomy.publicFailure(taxonomy.adaptToolError(error));
}

test('a deliberate refusal is not classified as an outage, so nothing tells the agent to wait', () => {
  for (const [code] of [...REAL_REFUSALS, ...SPAWN_CHOICE_REFUSALS]) {
    const typed = classify(code);
    assert.equal(typed.classification, 'retry-after-input',
      `${code} is an answer the caller can act on, not an outage to wait out`);
    assert.equal(typed.retryable, false,
      `${code} will never succeed on a retry, so marking it retryable sends the agent round the loop`);
  }
});

test('a child process that really did fail to start still retries', () => {
  /* The token 'SPAWN' is in the UNAVAILABLE rule for a reason and that reason
     is still good. The fix is ordering, not deletion: a code that names its own
     refusal is classified by that first, and everything else falls through. */
  for (const code of ['PROCESS_SPAWN_FAILED', 'BROWSER_SPAWN_FAILED']) {
    const typed = classify(code);
    assert.equal(typed.classification, 'retry-after-time', code);
    assert.equal(typed.retryable, true, `${code} is a transport story and waiting is the right advice`);
  }
});

/* A LIST OF CODES IN A TEST FILE PROVES NOTHING ON ITS OWN. This one drives
   the real agent.spawn with real arguments and carries whatever it throws
   through the real transport, so the codes above are the tool's, not a copy of
   them -- and so a rename that left this list behind fails here rather than
   shipping a refusal the agent is told to wait out. */
test('the refusals agent.spawn raises for a bad effort, provider or model reach the agent as themselves', async () => {
  const { spawnSubagent } = require('../src/lib/tool-registry');
  const contract = [
    'CONTRACT/1',
    'role      WORKER',
    'target    src/lib/tool-registry.js',
    'do        carry out one bounded piece of work',
    'because   0 of 12 pieces of this lane have returned evidence so far',
    'done      the dispatcher receives evidence and one verdict',
    'report    REPORT-refusal-worker.md'
  ].join('\n');
  const workspace = process.platform === 'win32' ? 'C:\\fixture\\workspace' : '/fixture/workspace';
  const context = {
    agentId: 'controller',
    agentPrincipal: { sessionId: 'chat-parent-1' },
    agentRole: { functions: ['agent.spawn'], requiresDirectUserAuthorization: false },
    permissionSession: { origin: 'local', tier: 'full' },
    workspaceRoots: [workspace]
  };
  const started = [];
  const treeSpawn = {
    isTreeSession: () => true,
    spawnOnTree: async request => { started.push(request); return { ok: true, nodeId: 'node-9-abc' }; }
  };
  const cases = [
    [{ surface: 'tree', tier: 'astra', effort: 'banana' }, 'AGENT_SPAWN_EFFORT_REFUSED'],
    /* `none` is in the cross-provider vocabulary and is one of the two values
       Claude's own launcher refuses (CLAUDE_CLI_EFFORT_UNSUPPORTED). `xhigh`
       on this same tier is ACCEPTED and is covered in
       tests/agent-spawn-tree-surface.test.js -- the owner's managers run
       claude-opus at exactly that depth. */
    [{ surface: 'tree', tier: 'claude-opus', effort: 'none' }, 'AGENT_SPAWN_EFFORT_REFUSED'],
    [{ surface: 'tree', tier: 'local', effort: 'high' }, 'AGENT_SPAWN_EFFORT_REFUSED'],
    [{ surface: 'tree', tier: 'claude-opus', provider: 'codex' }, 'AGENT_SPAWN_PROVIDER_REFUSED'],
    [{ surface: 'tree', tier: 'astra', model: 'claude/opus' }, 'AGENT_SPAWN_MODEL_REFUSED'],
    [{ surface: 'lane', tier: 'astra', effort: 'xhigh' }, 'AGENT_SPAWN_LANE_ARGUMENT_REFUSED'],
  ];
  for (const [args, expected] of cases) {
    const route = args.surface === 'tree' ? 'tree' : 'lane';
    let caught = null;
    try {
      await spawnSubagent({ contract, ...args }, context, {
        subagentRoute: { subagentRoute: () => ({ ok: true, route }) },
        treeSpawn,
        apiSheet: '',
        createMissionActions: () => ({ dispatch: () => { throw new Error('a refused spawn must not dispatch a lane'); } })
      });
    } catch (error) { caught = error; }
    assert.ok(caught, `${expected}: ${JSON.stringify(args)} must be refused`);
    assert.equal(caught.code, expected, JSON.stringify(args));

    /* The whole point of this file: the sentence the tool wrote is the
       sentence the agent reads, and it is not marked retryable. */
    const result = JSON.parse(JSON.stringify(toolError(caught)));
    assert.equal(result.content[0].text, caught.message, expected);
    assert.equal(result.structuredContent.error.taxonomy.retryable, false,
      `${expected} can never succeed on a retry, so telling the agent to wait sends it round the loop`);
    assert.equal(result.structuredContent.error.taxonomy.classification, 'retry-after-input', expected);
  }
  assert.equal(started.length, 0, 'not one of these refusals drew a circle on the person’s tree first');
});

test('an unrelated transport failure is untouched', () => {
  for (const [code, expected] of [['ECONNRESET', 'retry-after-time'], ['SQLITE_BUSY', 'retry-after-time']]) {
    assert.equal(classify(code).classification, expected, code);
  }
});

test("the tool's own sentence is what the agent is shown for a refusal", () => {
  // The real transport function is exported now. Exercise it, rather than
  // copying its branch into the test and accepting a matching source string.
  assert.equal(REAL_REFUSALS.length, 5);
  assert.equal(SPAWN_CHOICE_REFUSALS.length, 5);
  for (const [code, sentence] of [...REAL_REFUSALS, ...SPAWN_CHOICE_REFUSALS]) {
    const typed = classify(code);
    const result = toolError(Object.assign(new Error(sentence), { code }));
    assert.equal(result.content[0].text, sentence,
      `${code} must be shown as itself, not as "${typed.safeSummary}"`);
    assert.equal(result.structuredContent.error.message, sentence);
    assert.equal(result.structuredContent.error.code, code);
    assert.deepEqual(result.structuredContent.error.taxonomy, typed);
  }
});

test('a retryable failure still answers with the fixed summary, which is all there is to say', () => {
  const typed = classify('ECONNRESET');
  assert.equal(typed.retryable, true);
  const result = toolError(Object.assign(new Error('private transport reason'), { code: 'ECONNRESET' }));
  assert.equal(result.content[0].text, typed.safeSummary,
    'for a dropped transport "try again later" is the whole truth and must not be replaced');
});

test('policy refusals retain a bounded, redacted reason without changing the retry contract', () => {
  const error = Object.assign(new Error(`Choose the declared root. Bearer ${'x'.repeat(32)}`), { code: 'POLICY_DENIED' });
  const result = toolError(error);
  assert.match(result.content[0].text, /Choose the declared root\./);
  assert.doesNotMatch(JSON.stringify(result), new RegExp('x'.repeat(32)));
  assert.equal(result.structuredContent.error.taxonomy.retryable, false);
  assert.equal(result.structuredContent.error.taxonomy.code, 'POLICY_DENIED');
});

test('terminal provider and security failures do not publish source prose or details', () => {
  const sources = [
    ['SIGNATURE_INVALID', 'VERIFICATION_FAILED'],
    ['PADDLE_WEBHOOK_SIGNATURE_INVALID', 'VERIFICATION_FAILED'],
    ['PROVIDER_OUTPUT_INVALID', 'MALFORMED_OUTPUT'],
    ['INJECTION_DETECTED', 'INJECTION_DETECTED'],
    ['SANDBOX_VIOLATION', 'SANDBOX_VIOLATION'],
    ['MODEL_PROVIDER_INTERRUPTED', 'MODEL_PROVIDER_INTERRUPTED'],
    ['OPERATION_UNCERTAIN', 'INTERNAL_ERROR'],
  ];
  assert.equal(sources.length, 7);
  for (const [code, expected] of sources) {
    const result = toolError(new StateStoreError(code, 'private provider prose', { note: 'private provider detail' }));
    const typed = result.structuredContent.error.taxonomy;
    assert.equal(typed.code, expected, code);
    assert.equal(result.content[0].text, typed.safeSummary, code);
    assert.equal(result.structuredContent.error.message, typed.safeSummary, code);
    assert.equal(Object.hasOwn(result.structuredContent.error, 'details'), false, code);
    assert.doesNotMatch(JSON.stringify(result), /private provider/);
    assert.equal(result.structuredContent.error.code, code, 'legacy code compatibility is separate from source prose');
  }
  const unknown = toolError(new Error('private uncoded provider prose'));
  assert.equal(unknown.structuredContent.error.taxonomy.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(unknown), /private uncoded/);
});
