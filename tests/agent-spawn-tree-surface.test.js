'use strict';
/* agent.spawn's second surface: a circle on the person's visible tree.
 *
 * The rules under test are the ones that keep the two surfaces honest with each
 * other. The identity and workspace gates run for BOTH, so a tree circle is not
 * a way around either. The route decision is obeyed rather than second-guessed,
 * including its refusals -- an assistant told "put them on the tree" that
 * silently got a detached lane would report a team the person cannot find. And
 * the lane's own arguments are refused by name on the tree surface rather than
 * accepted and ignored, because accepting a turn cap this surface cannot honour
 * is a promise it cannot keep.
 *
 * The last test is the regression guard that matters most: with the route
 * answering "lane", the request handed to the mission bridge is byte-identical
 * to the one this tool has always produced. */
require('./lib/isolated-environment').activate('agent-spawn-tree-surface');

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSubagent, executeTool } = require('../src/lib/tool-registry');
const treeSpawnHostModule = require('../src/lib/agent-tree-spawn');
const permissionTierPolicy = require('../src/lib/permission-tier-policy');
const { toolNameDigest } = require('../src/lib/fra-capability-manifest');

/* Let node:test own completion and its reconciled summary. The historical
 * exit-forcing wrapper hid the audit worker's reference leak and cut off TAP
 * totals. audit-admission now releases its idle worker after each batch; an
 * actual lifecycle leak must fail the bounded runner, not bypass completion. */

const VALID_CONTRACT = [
  'CONTRACT/1',
  'role      WORKER',
  'target    src/lib/tool-registry.js',
  'do        carry out one bounded piece of work',
  'because   0 of 12 pieces of this lane have returned evidence so far',
  'done      the dispatcher receives evidence and one verdict',
  'report    REPORT-tree-worker.md'
].join('\n');

const WORKSPACE = process.platform === 'win32' ? 'C:\\fixture\\workspace' : '/fixture/workspace';
// This fixture tests downstream tree/tier guards after the owner binds a role.
const TREE_ROLE = Object.freeze({
  functions: Object.freeze(['agent.spawn', 'agent.stop', 'agent.restart', 'agent.resume', 'agent.remove']),
  requiresDirectUserAuthorization: false,
});

/* A context that passes every gate ahead of the surface branch. */
function treeContext(overrides = {}) {
  return {
    agentId: 'controller',
    agentPrincipal: { sessionId: 'chat-parent-1' },
    agentRole: TREE_ROLE,
    permissionSession: { origin: 'local', tier: 'full' },
    workspaceRoots: [WORKSPACE],
    ...overrides
  };
}

/* A route policy that answers exactly what a test wants, and a tree that
   records what it was asked for. */
const routeAnswering = answer => ({ subagentRoute: () => answer });
function fakeTree({ onTree = true, spawn } = {}) {
  const calls = [];
  return {
    calls,
    isTreeSession: () => onTree,
    spawnOnTree: async request => {
      calls.push(request);
      return spawn ? spawn(request) : { ok: true, nodeId: 'node-9-abc', sessionId: 'chat-child-1', displayName: 'Worker 1' };
    }
  };
}

const codeOf = async promise => {
  try { await promise; return null; } catch (error) { return error.code; }
};

test('a tree route hands the application the parent session, the role, the tier and the expanded brief, and returns what it answers', async () => {
  const tree = fakeTree();
  const answer = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree', treeRole: 'worker' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree', choice: 'Let the assistant decide' }), treeSpawn: tree, apiSheet: '' }
  );
  assert.deepEqual(answer, { ok: true, nodeId: 'node-9-abc', sessionId: 'chat-child-1', displayName: 'Worker 1' });
  assert.equal(tree.calls.length, 1);
  const request = tree.calls[0];
  assert.equal(request.parentSessionId, 'chat-parent-1', 'the parent is the calling session, never a name the caller passed');
  assert.equal(request.role, 'worker');
  assert.equal(request.tier, 'claude-sonnet');
  assert.match(request.brief, /ROLE: WORKER working in src\/lib\/tool-registry\.js/, 'the circle opens with the expanded contract');
  assert.match(request.objectiveRef, /^contract-[0-9a-f]{16}$/);
});

test('the role defaults to the contract role in lower case, so a manager contract makes a manager circle', async () => {
  const tree = fakeTree();
  await spawnSubagent(
    { contract: VALID_CONTRACT.replace('role      WORKER', 'role      MANAGER'), tier: 'claude-opus', surface: 'tree' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
  );
  assert.equal(tree.calls[0].role, 'manager');
  assert.equal(tree.calls[0].tier, 'claude-opus', 'opus managers and sonnet workers are both nameable');
});

/* Before this fix, only planner/manager/worker's lowercased CONTRACT role
 * happened to equal a declared tree role (src/lib/agent-org.js's ROLES); the
 * other six -- IMPLEMENTER, INVESTIGATOR, TESTER, VERIFIER, HARVESTER,
 * COORDINATOR -- produced a treeRole this computer does not declare, refused
 * downstream once the spawn reached the application (measured for
 * INVESTIGATOR in REPORT-bugs-worker-20260906.md, "6 of the 9 valid contract
 * roles"). Each of the 9 is asserted here against tool-registry.js's own
 * CONTRACT_ROLE_TO_TREE_ROLE map, not against a re-derived expectation. */
test('every CONTRACT/1 role maps to a declared tree role when treeRole is omitted, not just the three that already agreed', async () => {
  const expected = {
    IMPLEMENTER: 'worker', INVESTIGATOR: 'worker', TESTER: 'worker',
    VERIFIER: 'worker', HARVESTER: 'worker', WORKER: 'worker',
    PLANNER: 'planner',
    MANAGER: 'manager', COORDINATOR: 'manager'
  };
  for (const [contractRole, wantTreeRole] of Object.entries(expected)) {
    const tree = fakeTree();
    await spawnSubagent(
      { contract: VALID_CONTRACT.replace('role      WORKER', `role      ${contractRole}`), tier: 'claude-sonnet', surface: 'tree' },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    );
    assert.equal(tree.calls.length, 1, `${contractRole}: the circle is still started`);
    assert.equal(tree.calls[0].role, wantTreeRole, `${contractRole} must default to declared tree role "${wantTreeRole}"`);
  }
});

test('an explicit treeRole that disagrees with the mapped default is used and warned about, never refused', async () => {
  const tree = fakeTree();
  const answer = await spawnSubagent(
    { contract: VALID_CONTRACT.replace('role      WORKER', 'role      INVESTIGATOR'), tier: 'claude-sonnet', surface: 'tree', treeRole: 'planner' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
  );
  assert.equal(tree.calls.length, 1, 'a disagreement is a warning, not a refusal: the circle is still started');
  assert.equal(tree.calls[0].role, 'planner', 'the explicit treeRole always wins over the mapped default');
  assert.ok(answer.treeRoleWarning, 'the reply names the disagreement');
  assert.equal(answer.treeRoleWarning.contractRole, 'INVESTIGATOR');
  assert.equal(answer.treeRoleWarning.mappedTreeRole, 'worker');
  assert.equal(answer.treeRoleWarning.explicitTreeRole, 'planner');

  /* And when the explicit treeRole agrees with the mapped default, no warning
     is attached at all -- absence is the ordinary case. */
  const agreeing = fakeTree();
  const clean = await spawnSubagent(
    { contract: VALID_CONTRACT.replace('role      WORKER', 'role      INVESTIGATOR'), tier: 'claude-sonnet', surface: 'tree', treeRole: 'worker' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: agreeing, apiSheet: '' }
  );
  assert.equal(Object.hasOwn(clean, 'treeRoleWarning'), false, 'an explicit treeRole matching the mapped default carries no warning');
});

test('a refusal from the route is raised with its own code, never downgraded to the other surface', async () => {
  const tree = fakeTree();
  for (const refusal of [
    { ok: false, code: 'AGENT_SPAWN_TREE_ROUTE_CLOSED', reason: 'set to keep them off your tree' },
    { ok: false, code: 'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT', reason: 'the assistant asking is not on a tree' },
    { ok: false, code: 'AGENT_SPAWN_ROUTE_UNKNOWN', reason: 'not one of the two' }
  ]) {
    const code = await codeOf(spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
      treeContext(),
      { subagentRoute: routeAnswering(refusal), treeSpawn: tree, apiSheet: '' }
    ));
    assert.equal(code, refusal.code);
  }
  assert.equal(tree.calls.length, 0, 'a refused route starts nothing');
});

test("a circle on the tree gets no turn or timeout cap, and the answer names what was set aside", async () => {
  /* Owner, 2026-09-19: "i dont want a turn or timeout cap". Measured 2026-09-03
     before that: three spawns refused in one evening for `turns`, each a
     manager that had to read the refusal, drop the argument and try again.
     The argument means nothing here; it is not a reason to start nothing. */
  for (const [name, value] of [['turns', 4], ['timeoutSeconds', 600], ['parentLaunchId', 'launch_abcdefghijklmnop']]) {
    const tree = fakeTree();
    const answer = await spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree', [name]: value },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    );
    assert.equal(tree.calls.length, 1, `${name}: the circle is still started`);
    assert.ok(Array.isArray(answer.notApplied), `${name}: the reply says what was set aside`);
    assert.deepEqual(answer.notApplied.map(entry => entry.name), [name]);
    /* WHAT THE APPLICATION IS HANDED IS THE CAP THAT EXISTS, and there is
       none: no cap object, and neither bound under any name. A `why` sentence
       promising no cap over a request that carries one would read the same. */
    const request = tree.calls[0];
    for (const key of ['cap', 'turns', 'timeoutSeconds', 'capMs', 'parentLaunchId']) {
      assert.equal(Object.hasOwn(request, key), false,
        `${name}: a circle on the tree is handed no ${key}; its limits are its conversation and the stop button`);
    }
  }

  /* The two caps say they are caps, in the answer, so a caller reading only
     the reply learns that nothing will end this circle early. */
  const capped = fakeTree();
  const cappedAnswer = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree', turns: 4, timeoutSeconds: 600 },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: capped, apiSheet: '' }
  );
  assert.deepEqual(cappedAnswer.notApplied.map(entry => entry.name), ['turns', 'timeoutSeconds']);
  for (const entry of cappedAnswer.notApplied) assert.match(entry.why, /no (turn|timeout) cap at all/, entry.name);

  /* And a spawn with none of them carries no such field at all: absence is
     the ordinary case and must stay byte-identical. */
  const plain = fakeTree();
  const clean = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: plain, apiSheet: '' }
  );
  assert.equal(Object.hasOwn(clean, 'notApplied'), false);
});

/* EFFORT, PROVIDER AND MODEL ON THE TREE SURFACE.
 *
 * Owner, 2026-09-19: "you NEED to be able to select effort level when you spawn
 * agents". Measured the same morning: the schema had no effort, provider or
 * model at all, so every circle an assistant made ran at its tier's default
 * depth.
 *
 * Each case below calls with values and asserts what the APPLICATION was
 * handed and what the caller was told, never how the check is spelled. */
test('a chosen depth is applied, forwarded and echoed back, on Claude tiers as well as Codex ones', async () => {
  /* CLAUDE FIRST, BECAUSE CLAUDE IS THE COMMON CASE. The owner's own managers
     run claude-opus at xhigh and his builders claude-opus at medium; every
     circle in this lane is a claude-opus tree spawn. An earlier version of
     this gate refused effort on every claude tier, reading the tier row's
     `effort` column -- which is that tier's DEFAULT, not its allowed set. */
  for (const [tier, effort, appliedEffort] of [
    ['claude-opus', 'xhigh', 'xhigh'],
    ['claude-opus', 'medium', 'medium'],
    ['claude-sonnet', 'low', 'low'],
    ['claude-fable', 'max', 'max'],
    /* Claude calls its top depth `max`, so `ultra` -- the cross-provider
       vocabulary's own word -- applies as `max` and the receipt says so
       rather than repeating the request. */
    ['claude-opus', 'ultra', 'max'],
    ['astra', 'xhigh', 'xhigh'],
    ['luna', 'ultra', 'ultra'],
    ['terra', 'none', 'none'],
    ['sol', 'max', 'max'],
  ]) {
    const tree = fakeTree();
    const answer = await spawnSubagent(
      { contract: VALID_CONTRACT, tier, surface: 'tree', effort },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    );
    assert.equal(tree.calls.length, 1, `${tier}/${effort}: the circle is started`);
    assert.equal(tree.calls[0].effort, appliedEffort, `${tier}: the application is handed the chosen depth, not the tier default`);
    assert.equal(tree.calls[0].tier, tier);
    assert.deepEqual({ ...answer.applied }, { effort: appliedEffort },
      `${tier}: the receipt echoes the depth that will run, so the caller can see the choice took effect`);
  }

  /* Omitting it leaves the tier's own default in charge, and the answer says
     nothing it did not do. */
  const plain = fakeTree();
  const clean = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-opus', surface: 'tree' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: plain, apiSheet: '' }
  );
  assert.equal(Object.hasOwn(plain.calls[0], 'effort'), false, 'an unchosen depth is absent, never a value this tool invented');
  assert.equal(Object.hasOwn(clean, 'applied'), false);
});

/* THE CROSS-CHECK THAT MAKES THE PER-PROVIDER TABLE MORE THAN A COPY.
 *
 * tool-registry.js names the depths Claude takes and the mapping it applies.
 * The program that decides is src/lib/agent-engine/claude-cli-adapter.js, and
 * this drives ITS exported claudeArgs() with each value rather than matching
 * the spelling of one list against the other: what is asserted is that what
 * agent.spawn accepts is what the launcher will accept, and that what
 * agent.spawn echoes is the word that lands in argv. A table that drifts out
 * of agreement fails here, whichever side moved. */
test('what agent.spawn accepts and echoes for a Claude tier is what the Claude launcher really does', async () => {
  const { claudeArgs, ClaudeCliError } = require('../src/lib/agent-engine/claude-cli-adapter');
  const argvEffort = effort => {
    const argv = claudeArgs({ threadOptions: { effort }, cwd: WORKSPACE });
    const at = argv.indexOf('--effort');
    return at < 0 ? null : argv[at + 1];
  };

  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    const tree = fakeTree();
    const answer = await spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'claude-opus', surface: 'tree', effort },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    );
    assert.equal(tree.calls.length, 1, `${effort}: agent.spawn accepts it`);
    assert.equal(answer.applied.effort, argvEffort(effort),
      `${effort}: the receipt must name the word the Claude launcher actually puts after --effort`);
    assert.equal(tree.calls[0].effort, argvEffort(effort),
      `${effort}: and the application must be handed that same word`);
  }

  /* And the two the cross-provider vocabulary has that Claude does not. The
     launcher refuses them by name; agent.spawn must refuse them BEFORE a
     circle is drawn, or the person gets a circle on their tree whose session
     never opens. */
  for (const effort of ['none', 'minimal']) {
    assert.throws(() => claudeArgs({ threadOptions: { effort }, cwd: WORKSPACE }),
      error => error instanceof ClaudeCliError && error.code === 'CLAUDE_CLI_EFFORT_UNSUPPORTED',
      `${effort}: the launcher is expected to refuse this`);
    const tree = fakeTree();
    const code = await codeOf(spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'claude-opus', surface: 'tree', effort },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    ));
    assert.equal(code, 'AGENT_SPAWN_EFFORT_REFUSED', effort);
    assert.equal(tree.calls.length, 0, `${effort}: nothing is drawn on the person's tree`);
  }
});

test('an effort outside the vocabulary, or named for a provider that has no depth setting, refuses before a circle is drawn', async () => {
  for (const [tier, effort] of [
    ['astra', 'banana'], ['astra', 'HIGH'], ['astra', ''],
    /* A local node has no reasoning-depth switch: searched two ways across
       src/lib/agent-engine/local-node-*.js and src/lib/local-node-runtime.js,
       the only "effort" in either is the phrase "Best effort" in a comment. */
    ['local', 'high'], ['local', 'medium'],
  ]) {
    const tree = fakeTree();
    const code = await codeOf(spawnSubagent(
      { contract: VALID_CONTRACT, tier, surface: 'tree', effort },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    ));
    assert.equal(code, 'AGENT_SPAWN_EFFORT_REFUSED', `${tier}/${effort || '(empty)'}`);
    assert.equal(tree.calls.length, 0, `${tier}/${effort || '(empty)'}: nothing is drawn on the person's tree`);
  }
});

test('provider and model confirm the tier and never override it: agreement applies, contradiction refuses', async () => {
  /* Measured 2026-09-19 against mission-bridge/actions.js TIERS: every tier
     this tool accepts already fixes both, so these two can only agree or
     contradict. Both spellings a tier row carries are an agreement. */
  for (const [tier, provider, model] of [
    ['astra', 'codex', 'gpt-6-astra'],
    ['claude-opus', 'claude', 'claude/opus'],
    ['claude-opus', 'claude', 'opus'],
    ['local', 'local', 'local/auto']
  ]) {
    const tree = fakeTree();
    const answer = await spawnSubagent(
      { contract: VALID_CONTRACT, tier, surface: 'tree', provider, model },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    );
    assert.equal(tree.calls.length, 1, `${tier}: a confirmation is not a reason to start nothing`);
    assert.equal(tree.calls[0].provider, provider);
    assert.equal(tree.calls[0].model, model);
    assert.deepEqual({ ...answer.applied }, { provider, model }, `${tier}: the receipt echoes both`);
  }

  for (const [tier, extra, expected] of [
    ['claude-opus', { provider: 'codex' }, 'AGENT_SPAWN_PROVIDER_REFUSED'],
    ['astra', { provider: 'claude' }, 'AGENT_SPAWN_PROVIDER_REFUSED'],
    ['astra', { model: 'claude/opus' }, 'AGENT_SPAWN_MODEL_REFUSED'],
    ['claude-fable', { model: 'gpt-6-astra' }, 'AGENT_SPAWN_MODEL_REFUSED'],
    ['astra', { provider: 'codex', model: 'gpt-5.6-luna' }, 'AGENT_SPAWN_MODEL_REFUSED']
  ]) {
    const tree = fakeTree();
    const code = await codeOf(spawnSubagent(
      { contract: VALID_CONTRACT, tier, surface: 'tree', ...extra },
      treeContext(),
      { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
    ));
    assert.equal(code, expected, `${tier} ${JSON.stringify(extra)}`);
    assert.equal(tree.calls.length, 0,
      `${tier}: nothing is started for a caller that would have been billed for a model it did not name`);
  }
});

test('effort, provider and model are refused by name on the lane surface rather than dropped in silence', async () => {
  /* mission-bridge/actions.js dispatch() admits rootId, tier, objectiveRef,
     brief, cap and parentLaunchId and nothing else, so there is nowhere on
     that surface for these three to go. Being handed a different assistant
     than the one you asked for is worse than being told no. */
  for (const extra of [{ effort: 'xhigh' }, { provider: 'codex' }, { model: 'gpt-6-astra' }]) {
    let dispatched = 0;
    const code = await codeOf(spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'astra', surface: 'lane', ...extra },
      treeContext(),
      {
        subagentRoute: routeAnswering({ ok: true, route: 'lane' }),
        treeSpawn: fakeTree({ onTree: false }),
        apiSheet: '',
        createMissionActions: () => ({ dispatch: () => { dispatched += 1; return { ok: true }; } })
      }
    ));
    assert.equal(code, 'AGENT_SPAWN_LANE_ARGUMENT_REFUSED', JSON.stringify(extra));
    assert.equal(dispatched, 0, `${JSON.stringify(extra)}: no lane is dispatched`);
  }
});

test('an expanded contract too long for a circle to open with is refused before anything is drawn', async () => {
  const tree = fakeTree();
  const code = await codeOf(spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: 'x'.repeat(12100) }
  ));
  assert.equal(code, 'AGENT_SPAWN_TREE_BRIEF_TOO_LONG');

  /* A brief of the size the live log actually showed being refused -- 4,229
     to 5,035 characters, eighteen times in one evening -- now starts. */
  const ordinary = fakeTree();
  await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: ordinary, apiSheet: 'x'.repeat(4800) }
  );
  assert.equal(ordinary.calls.length, 1, 'a 5,000-character expanded contract is an ordinary contract');
  assert.equal(tree.calls.length, 0);
});

test('the gates ahead of the surface still run: no identity, and no verified workspace, refuse before the route is even asked', async () => {
  let asked = 0;
  const counting = { subagentRoute: { subagentRoute: () => { asked += 1; return { ok: true, route: 'tree' }; } } };
  const tree = fakeTree();

  assert.equal(await codeOf(spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext({ agentId: 'NOT A VALID ID' }),
    { ...counting, treeSpawn: tree, apiSheet: '' }
  )), 'AGENT_SPAWN_IDENTITY_REQUIRED');

  assert.equal(await codeOf(spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext({ workspaceRoots: [] }),
    { ...counting, treeSpawn: tree, apiSheet: '' }
  )), 'AGENT_SPAWN_WORKSPACE_UNAVAILABLE');

  assert.equal(asked, 0, 'the route is not consulted for a spawn that was already refused');
  assert.equal(tree.calls.length, 0);
});

test('a tree spawn needs the same local Full session the lane surface needs', async () => {
  const tree = fakeTree();
  const narrowed = await codeOf(spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext({ permissionSession: { origin: 'local', tier: 'guarded' } }),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
  ));
  assert.equal(narrowed, 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED', 'a narrowed local session cannot put circles on the tree');

  /* A remote session claiming Full is refused a step earlier, by the rule that
     says a remote caller never holds Full at all. Asserted here so this file
     records which refusal actually answers, rather than the one you would
     guess from reading only the line this branch calls. */
  const remote = await codeOf(spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree' },
    treeContext({ permissionSession: { origin: 'remote', tier: 'full' } }),
    { subagentRoute: routeAnswering({ ok: true, route: 'tree' }), treeSpawn: tree, apiSheet: '' }
  ));
  assert.equal(remote, 'PERMISSION_REMOTE_FULL_REFUSED');
  assert.equal(tree.calls.length, 0);
});

test('with the route answering lane, the mission bridge receives exactly the request this tool has always produced', async () => {
  const dispatched = [];
  const createMissionActions = () => ({ dispatch: request => { dispatched.push(request); return { ok: true, receipt: { launchId: 'launch_fixture_lane_surface' } }; } });
  const tree = fakeTree({ onTree: true });
  const answer = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'claude-sonnet', turns: 3, timeoutSeconds: 600 },
    treeContext(),
    { subagentRoute: routeAnswering({ ok: true, route: 'lane' }), treeSpawn: tree, createMissionActions, apiSheet: '' }
  );
  assert.deepEqual(answer, { ok: true, receipt: { launchId: 'launch_fixture_lane_surface' } });
  assert.equal(tree.calls.length, 0, 'the lane route never touches the tree');
  assert.equal(dispatched.length, 1);
  const request = dispatched[0];
  assert.equal(request.rootId, 'workspace');
  assert.equal(request.tier, 'claude-sonnet');
  assert.deepEqual({ ...request.cap }, { kind: 'turns', value: 3, capMs: 600000 });
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'surface'), false, 'the surface is this tool\'s own decision and is not forwarded into the lane request');
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'treeRole'), false);
});

/* ---------------------------------------------------------------------------
 * AUDIT (page2/lifecycle-status-engine, HUNT-pass follow-up to cc68b2f).
 *
 * cc68b2f traced an asymmetry: agent.spawn's tree route calls
 * assertUnrestrictedSpawn(context.permissionSession) (the test six above this
 * one drives it, with an {origin:'local',tier:'guarded'} session), while
 * agent.restart/stop/remove's handler (treeLifecycle, src/lib/tool-registry.js)
 * calls nothing of the kind. It concluded this is deliberate, citing
 * tests/confined-tool-surface.test.js's dated CONTAINED table and the owner's
 * own words ("agents need to be able to delete and start and restart agents
 * under them", no tier caveat) -- correct, re-derived independently below --
 * but the commit's own account of WHICH GATE does the work does not survive
 * driving both tools through the real dispatch chokepoint, executeTool(),
 * rather than calling spawnSubagent directly with hand-built dependencies the
 * way every test above this one does.
 *
 * executeTool() runs permission-tier-policy.js's assertToolAllowed() BEFORE
 * any handler -- spawnSubagent and treeLifecycle alike -- ever sees the
 * request (src/lib/tool-registry.js, executeTool: "require('./permission-
 * tier-policy').assertToolAllowed(entry, context.permissionSession)"). At the
 * Standard install level -- {origin:'local',tier:'confined',profile:
 * 'workspace'}, the tier an ordinary confined USER actually runs at, per
 * INSTALL_TIER_SESSIONS -- that gate alone already refuses agent.spawn with
 * PERMISSION_CONFINED_UNCONFINABLE_REFUSED (confined-tool-surface.js classes
 * it UNCONFINABLE: "launches a subagent lane as a child process ... available
 * only at the Unrestricted level"), for BOTH the lane and the tree surface,
 * before spawnSubagent's own body -- and so its assertUnrestrictedSpawn call
 * three lines into the tree branch -- ever runs. The {origin:'local',
 * tier:'guarded'} session the earlier test constructs to reach that line
 * cannot occur on this path either: 'guarded' is a distinct TIER from
 * 'confined' (TIERS = ['full','guarded','confined','manifest']), and
 * executeTool's assertToolAllowed refuses agent.spawn for IT too, on a
 * different ground (its 'local-write' effect is outside GUARDED_EFFECTS =
 * ['local-read','external-read']). Proven by running BOTH tools through
 * executeTool() itself below rather than through spawnSubagent's own
 * dependency-injected shortcut.
 *
 * So at the tier that actually matters -- the one Standard installs run at --
 * the asymmetry cc68b2f found is real and confirmed here by real execution,
 * but the CONTAINED-vs-UNCONFINABLE classification (src/lib/confined-tool-
 * surface.js, reviewed and dated for this exact feature) is the gate doing
 * the work, not assertUnrestrictedSpawn. That call still guards a narrower
 * case this file does not attempt to fully characterise (a Manifest-tier
 * remote caller whose reviewed capability list happens to name agent.spawn),
 * which is a defence in depth, not the dispositive gate cc68b2f's prose
 * suggested it was. CORRECTION 2026-09-06: the prior conclusion of "no
 * defect" was wrong. Forwarding no tier does not preserve the original tier:
 * the renderer's ordinary restart selects CURRENT global policy and profile.
 * Standard restart now requires an explicitly paired lifecycle callback with
 * retained original authority and one-use replacement grants. The regression
 * below pins refusal of the formerly admitted old generic host. */
test('Standard restart refuses an old generic host; it requires paired retained lifecycle authority', async () => {
  const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const calls = [];
  treeSpawnHostModule.installTreeSpawnHost({
    spawn: async () => { throw new Error('a restart must never draw a NEW circle, so this must never be called'); },
    isTreeSession: () => true,
    command: async request => { calls.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; }
  });
  try {
    const restartCode = await codeOf(executeTool('agent.restart',
      { nodeId: 'node-1' },
      { agentPrincipal: { sessionId: 'chat-parent-1' }, agentRole: TREE_ROLE, permissionSession: STANDARD }));
    assert.equal(restartCode, 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED');
    assert.equal(calls.length, 0, 'Standard must never use an old generic lifecycle start');

    const spawnCode = await codeOf(executeTool('agent.spawn',
      { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree', workspaceRoot: WORKSPACE },
      {
        agentId: 'controller',
        agentPrincipal: { sessionId: 'chat-parent-1' },
        agentRole: TREE_ROLE,
        permissionSession: STANDARD,
        workspaceRoots: [WORKSPACE]
      }));
    assert.equal(spawnCode, 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'the SAME session is refused agent.spawn generically, by the tool-surface classification -- '
      + 'not by PERMISSION_UNRESTRICTED_SPAWN_REFUSED, which would mean spawnSubagent\'s own body was reached');
  } finally {
    treeSpawnHostModule.clearTreeSpawnHost();
  }
});

/* ---------------------------------------------------------------------------
 * AUDIT (page2/lifecycle-status-engine, closing the one gap the trace above
 * named but did not chase): "a Manifest-tier remote caller whose reviewed
 * capability list happens to name agent.spawn".
 *
 * Unlike Confined, a Manifest session is not refused agent.spawn by the
 * CONTAINED/UNCONFINABLE table at all -- src/lib/permission-tier-policy.js's
 * assertToolAllowed() routes tier 'manifest' to assertManifestToolAllowed(),
 * which checks only REQUIRED_EXCLUDED_TOOLS/ALWAYS_BLOCKED_NAMESPACES (host.exec,
 * the clipboard and repo/host file surface -- agent.spawn is in neither) and
 * then `resolved.manifest.allowed.has(entry.name)`: a reviewed manifest that
 * names agent.spawn passes this gate and reaches spawnSubagent's own body,
 * where the tree branch's assertUnrestrictedSpawn is the ONLY thing left
 * standing between a remote FRA caller and drawing a new circle.
 *
 * Read closely, that call cannot be satisfied by ANY manifest session,
 * reviewed or not: permission-tier-policy.js's session() builds a tier
 * 'manifest' session ONLY for origin 'remote' (it throws
 * PERMISSION_MANIFEST_ORIGIN_REFUSED for a local caller trying to claim the
 * name), and assertUnrestrictedSpawn refuses unless origin === 'local'. A
 * manifest session's origin and 'local' are mutually exclusive by
 * construction, so no reviewed allowlist -- however it is worded -- can ever
 * satisfy assertUnrestrictedSpawn. This is provable from reading session()
 * and assertUnrestrictedSpawn together without running anything, and this
 * test is that proof made executable: a synthetic reviewed manifest that
 * DOES name agent.spawn (so the first gate is not what refuses it here)
 * still cannot reach spawnOnTree. */
test('a Manifest-tier session whose reviewed capability list names agent.spawn is still refused the tree route, by assertUnrestrictedSpawn\'s origin check, not the manifest allowlist', async () => {
  const names = ['agent.spawn'];
  const manifestSession = permissionTierPolicy.manifestSession({
    allowedToolNames: names,
    allowedToolNamesDigest: toolNameDigest(names),
  });
  assert.equal(manifestSession.origin, 'remote');
  assert.equal(manifestSession.manifest.allowed.has('agent.spawn'), true,
    'the fixture must actually name agent.spawn as reviewed, or this proves nothing about the second gate');

  treeSpawnHostModule.installTreeSpawnHost({
    spawn: async () => { throw new Error('a manifest-tier caller must never reach far enough to draw a circle'); },
    isTreeSession: () => true,
  });
  try {
    const spawnCode = await codeOf(executeTool('agent.spawn',
      { contract: VALID_CONTRACT, tier: 'claude-sonnet', surface: 'tree', workspaceRoot: WORKSPACE },
      {
        agentId: 'controller',
        agentPrincipal: { sessionId: 'chat-parent-1' },
        agentRole: TREE_ROLE,
        permissionSession: manifestSession,
        workspaceRoots: [WORKSPACE]
      }));
    assert.equal(spawnCode, 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED',
      'a reviewed manifest naming agent.spawn got PAST the tool-surface gate (unlike the Confined case above) -- '
      + 'assertUnrestrictedSpawn must be the one that still refuses it, by origin, not by tier alone');
  } finally {
    treeSpawnHostModule.clearTreeSpawnHost();
  }
});

/* ---------------------------------------------------------------------------
 * HUNT (page2/lifecycle-status-engine, third wave). No new logic defect found
 * in treeLifecycle (src/lib/tool-registry.js) after tracing it fully against
 * the same executeTool() chokepoint the audit above already established as
 * the real one, and the only place agent.stop/restart/remove differ from
 * commandOnTree's own already-pinned contract (tests/agent-tree-spawn.test.js)
 * is upstream of commandOnTree entirely -- treeLifecycle's OWN two guards,
 * which had no behavioural test anywhere on this branch before this one:
 * every existing test either drives commandOnTree directly (bypassing
 * treeLifecycle) or supplies a fully-valid { agentPrincipal: { sessionId },
 * isTreeSession: () => true } happy path. Quoted here so the next auditor can
 * tell what would have to change to make one of these wrong:
 *
 *   async function treeLifecycle(verb, args, context) {
 *     const treeSpawn = require('./agent-tree-spawn.js');
 *     const parentSessionId = context && context.agentPrincipal
 *       && typeof context.agentPrincipal.sessionId === 'string' && context.agentPrincipal.sessionId
 *       ? context.agentPrincipal.sessionId
 *       : null;
 *     if (!parentSessionId) {
 *       const error = new Error('A circle is changed by the circle above it, ...');
 *       error.code = 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT';
 *       throw error;
 *     }
 *     if (!treeSpawn.isTreeSession(parentSessionId)) {
 *       const error = new Error('This assistant is not a circle on the tree, ...');
 *       error.code = 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT';
 *       throw error;
 *     }
 *     return treeSpawn.commandOnTree(verb, { parentSessionId, nodeId: args.nodeId, ... });
 *   }
 *
 * Three riskiest paths this trace turned up, none refuted, all pinned below:
 *
 * 1. NO SESSION TO ACT FROM. args carries no parentSessionId field at all --
 *    the schema for all three tools declares only nodeId/treeId/
 *    expectedSessionId with additionalProperties:false, so a caller cannot
 *    even offer one -- and the only source is context.agentPrincipal.sessionId,
 *    established by the host, never the caller. A session running with no
 *    bound principal (or a malformed one) must be refused here, before
 *    isTreeSession is consulted at all and long before any node is named.
 *
 * 2. A REAL SESSION THAT IS NOT ITSELF A TREE CIRCLE. The commonest real
 *    reason these three tools are refused: an ordinary chat session, or a
 *    detached LANE subagent (surface:'lane', spawned specifically to stay
 *    off the tree) has a perfectly good bound session but no circles below
 *    it, because it has no place ON the tree at all. isTreeSession must
 *    return false for it and the refusal must land before commandOnTree ever
 *    learns which node was named -- a lane agent asking to stop a node it
 *    read the id of some other way must not get a node-shaped answer
 *    ("not below caller", "already running") that confirms the node exists.
 *
 * 3. NO CROSS-CALL CONTAMINATION. Neither treeLifecycle nor commandOnTree
 *    keeps any state keyed by nothing -- no memoised parentSessionId, no
 *    module-level cache -- so two different circles calling agent.stop back
 *    to back must each reach the application with THEIR OWN bound session,
 *    never a previous caller's. Pinned rather than assumed: this is exactly
 *    the shape ("state compared against a stale id") the sibling app-lane
 *    commit this same session made this wave (single-flight sharing in
 *    src/views/computers.js) exists to catch, and nothing here proved it
 *    could not happen to treeLifecycle by the same kind of accident.
 */
test('agent.stop/restart/remove refuse with no session to act from when the context carries no bound principal, before the application is ever asked', async () => {
  const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const calls = { isTreeSession: 0, command: 0 };
  treeSpawnHostModule.installTreeSpawnHost({
    confinedTreeLifecycleVersion: 1,
    commandConfined: async () => { calls.command += 1; throw new Error('must not reach a child'); },
    spawn: async () => { throw new Error('must never be called for a lifecycle verb'); },
    isTreeSession: () => { calls.isTreeSession += 1; return true; },
    command: async request => { calls.command += 1; return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; }
  });
  try {
    for (const agentPrincipal of [undefined, null, {}, { sessionId: '' }, { sessionId: 42 }]) {
      for (const [tool] of [['agent.stop'], ['agent.restart'], ['agent.remove']]) {
        const code = await codeOf(executeTool(tool, { nodeId: 'node-1' }, { agentPrincipal, agentRole: TREE_ROLE, permissionSession: STANDARD }));
        assert.equal(code, 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT',
          `${tool} with agentPrincipal ${JSON.stringify(agentPrincipal)} must refuse for having no session to act from`);
      }
    }
    assert.equal(calls.isTreeSession, 0,
      'a session that could not even be resolved must never reach far enough to ask the host whether it is a tree circle');
    assert.equal(calls.command, 0, 'the application must never be told a node id when the caller has no session at all');
  } finally {
    treeSpawnHostModule.clearTreeSpawnHost();
  }
});

test('agent.stop/restart/remove refuse a caller that is not itself a circle on the tree, before naming a node to the application', async () => {
  const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const calls = { isTreeSession: [], command: 0 };
  treeSpawnHostModule.installTreeSpawnHost({
    confinedTreeLifecycleVersion: 1,
    commandConfined: async () => { calls.command += 1; throw new Error('must not reach a child'); },
    spawn: async () => { throw new Error('must never be called for a lifecycle verb'); },
    isTreeSession: sessionId => { calls.isTreeSession.push(sessionId); return false; },
    command: async request => { calls.command += 1; return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; }
  });
  try {
    for (const [tool, verb] of [['agent.stop', 'stop'], ['agent.restart', 'restart'], ['agent.remove', 'remove']]) {
      const code = await codeOf(executeTool(tool,
        { nodeId: 'node-1' },
        { agentPrincipal: { sessionId: 'plain-chat-session' }, agentRole: TREE_ROLE, permissionSession: STANDARD }));
      assert.equal(code, 'AGENT_TREE_COMMAND_NOT_A_TREE_AGENT',
        `${verb}: a bound session that is not a tree circle must still be refused, not treated as having no session`);
    }
    assert.equal(calls.command, 0, 'a caller with no place on the tree must never learn whether the named node exists');
    assert.deepEqual(calls.isTreeSession, ['plain-chat-session', 'plain-chat-session', 'plain-chat-session'],
      'the check must actually run and be asked about THIS caller\'s own session for every verb, not be skipped');
  } finally {
    treeSpawnHostModule.clearTreeSpawnHost();
  }
});

test('the session an application-bound command carries is always the calling context\'s own, never a previous caller\'s', async () => {
  const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
  const calls = [];
  treeSpawnHostModule.installTreeSpawnHost({
    confinedTreeLifecycleVersion: 1,
    commandConfined: async request => { calls.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; },
    spawn: async () => { throw new Error('must never be called for a lifecycle verb'); },
    isTreeSession: () => true,
    command: async request => { calls.push(request); return { ok: true, nodeId: request.nodeId, sessionId: null, threadId: null }; }
  });
  try {
    await executeTool('agent.stop', { nodeId: 'node-alpha' },
      { agentPrincipal: { sessionId: 'circle-A' }, agentRole: TREE_ROLE, permissionSession: STANDARD });
    await executeTool('agent.remove', { nodeId: 'node-beta' },
      { agentPrincipal: { sessionId: 'circle-B' }, agentRole: TREE_ROLE, permissionSession: STANDARD });
    await executeTool('agent.restart', { nodeId: 'node-gamma' },
      { agentPrincipal: { sessionId: 'circle-A' }, agentRole: TREE_ROLE, permissionSession: STANDARD });

    assert.equal(calls.length, 3);
    assert.equal(calls[0].parentSessionId, 'circle-A');
    assert.equal(calls[1].parentSessionId, 'circle-B',
      'the second call must carry ITS OWN caller, not circle-A left over from the first');
    assert.equal(calls[2].parentSessionId, 'circle-A',
      'circle-A calling again after circle-B must carry circle-A again, not circle-B leaked forward');
    await assert.rejects(executeTool('agent.stop', { nodeId: 'node-alpha' }, {
      agentPrincipal: { sessionId: 'circle-A' }, permissionSession: STANDARD,
    }), { code: 'ROLE_POLICY_REQUIRED' });
    assert.equal(calls.length, 3, 'an authenticated caller without a bound role must not reach the application');
  } finally {
    treeSpawnHostModule.clearTreeSpawnHost();
  }
});
