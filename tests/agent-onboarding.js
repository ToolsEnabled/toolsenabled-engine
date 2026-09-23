// EXECUTABLE CHANGE — testcanfail-tests-agent-onboarding-js
//
// Discrimination report (2026-08-26): the two role-definition assertions below
// derived their expected values from roleDefinition(), the same role library
// buildPacket() uses. Mutation: in a temporary edit to src/lib/agent-roles.js,
// change planner.name to "Mutated Planner" and planner.owns to
// "MUTATED planner ownership". Before the independent assertions were added,
// both same-code comparisons still passed (execution continued to the unrelated
// local precondition failure for missing .codex/hooks.json). With the independent
// assertions, the run goes RED with:
//   AssertionError [ERR_ASSERTION]: the packet carries the independently specified planner ownership contract
//   + actual - expected
//   + 'MUTATED planner ownership'
//   - 'Read-only synthesis of goals, gates, dependencies, capacity, and a phased lookahead for the controller.'
// The source file was restored byte-for-byte (SHA-256
// e102b7d7943919b95935759fafe94bc0a398c6ec5aabcd36f4356e7d64c853f0).
//
// NOT-FOUND (1): every potentially empty loop is backed by an independent
// non-empty/count assertion, a fixed literal input, or a later cardinality
// assertion. NOT-FOUND (2): successful child processes are checked for status
// zero and then for parsed subject output; the refusal checks its structured
// output in addition to status 1. NOT-FOUND (3): no catch or optional chain
// swallows a tested failure. NOT-FOUND (4): dependency fakes establish inputs;
// assertions inspect the real packet/renderer rather than a mock of them.
// NOT-FOUND (5): there are no skips or platform guards. NOT-FOUND (6), beyond
// the two strengthened comparisons: expected values are literals or independently
// constructed fixture facts rather than results computed by the subject.
//
// Per-installation hook declarations are exercised through owned temporary
// fixtures below; this test never depends on or edits an operator's hook files.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const onboarding = require('../src/lib/agent-onboarding');
const onboardingCli = require('../tools/agent-onboarding');
const agentOrg = require('../src/lib/agent-org');
const { roleDefinition } = require('../src/lib/agent-roles');
const { featureLine } = require('../src/lib/capability-features');

const NOW = Date.parse('2026-08-08T17:00:00.000Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-agent-onboarding-'));

function write(relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

/* THE OWNER LEDGER LIVES WHERE THE PRODUCT WRITES IT. reports/ is runtime
   state: under the isolated runner (and on an install) it resolves under the
   state root, not the runtime root, and the packet reads it through the same
   resolver src/lib/owner-request-store.js writes through. Plant it there. */
const runtimeStateRoot = require('../src/lib/runtime-state-root');
const ownerLedgerFile = () => runtimeStateRoot.programOrStatePath(root, ['reports', 'OWNER-REQUEST-LEDGER.json']);
function writeOwnerLedger(value) {
  const file = ownerLedgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function writeHookFixtures() {
  const shellCommand = 'r="$(git rev-parse --show-toplevel)" && node "$r/tools/agent-onboarding.js" --hook';
  const handler = (limit) => ({
    hooks: [{
      command: shellCommand,
      commandWindows: "$r = git rev-parse --show-toplevel; & node (Join-Path $r 'tools/agent-onboarding.js') --hook",
      additionalContextLimit: limit
    }]
  });
  write('.codex/hooks.json', {
    hooks: {
      SessionStart: [handler(onboarding.MAX_RENDERED_BYTES.full)],
      SubagentStart: [handler(onboarding.MAX_RENDERED_BYTES.task)]
    }
  });
  write('.claude/settings.json', {
    hooks: {
      SessionStart: [
        handler(onboarding.MAX_RENDERED_BYTES.full),
        { hooks: [{ command: 'node tools/claude-session-autoregister.js' }] }
      ],
      SubagentStart: [handler(onboarding.MAX_RENDERED_BYTES.task)]
    }
  });
}

function presenceRecord(overrides = {}) {
  return {
    agentId: 'worker-seat',
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    recordRevision: 1,
    kind: 'codex',
    role: 'worker',
    tier: 'gpt-5.6-terra/high',
    reportsTo: 'controller-seat',
    dispatcher: 'controller-seat',
    lane: 'r1175-fixture',
    territory: 'src/lib/agent-onboarding.js;tests/agent-onboarding.js',
    currentTask: 'task-r1175-fixture',
    brief: path.join(root, 'BRIEF.md'),
    consoleLog: path.join(root, 'console.log'),
    worktree: root,
    launchSpec: path.join(root, 'launch.json'),
    pid: 4242,
    startedAt: NOW - 5000,
    lastHeartbeat: NOW - 1000,
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    usefulProgressSeq: 1,
    lastUsefulProgressAt: NOW - 2000,
    lastUsefulProgressKind: 'tool-success',
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null,
    ...overrides
  };
}

function fixtureOrg() {
  return {
    revision: 21,
    agents: [
      { id: 'controller-seat', displayName: 'Controller Seat', role: 'controller', provider: 'codex', enabled: true, $owns: ['Final acceptance.'] },
      { id: 'planner-seat', displayName: 'Planner Seat', role: 'planner', provider: 'codex', enabled: true, $owns: ['Read-only five-hour lookahead.'] },
      { id: 'worker-seat', displayName: 'Worker Seat', role: 'builder', provider: 'codex', enabled: true, $owns: ['Bounded implementation.'] }
    ],
    relationships: [
      { from: 'controller-seat', to: 'planner-seat', type: 'manages' },
      { from: 'controller-seat', to: 'worker-seat', type: 'manages' }
    ]
  };
}

function resetSources({ verbatim = 'OWNER VERBATIM: Build a mechanical dynamic onboarding packet.' } = {}) {
  write('config/agent-org.json', fixtureOrg());
  write('state/agent-presence.json', {
    schemaVersion: 1,
    revision: 4,
    updatedAt: NOW - 1000,
    agents: { 'worker-seat': presenceRecord() }
  });
  write('BUILD-QUEUE.md', [
    '# Queue',
    '',
    '## Q42 — Mechanical onboarding',
    '**Status:** IN-PROGRESS',
    'Build the bounded packet before more agents launch.',
    '',
    '## Q43 — Later work',
    '**Status:** OPEN',
    'Wait behind onboarding.'
  ].join('\n'));
  writeOwnerLedger({
    requests: [{
      id: 'R1175',
      verbatim,
      request: 'Mechanical onboarding',
      status: 'in-progress',
      gates: [
        { instruction: 'Every supported agent spawn receives the packet.', met: false },
        { instruction: 'No holder is hardcoded into a role.', met: false }
      ]
    }]
  });
}

// THE FEATURE LINE'S FIXTURE.
//
// The line is resolved against the session's OWN tool surface, so the fixture
// supplies one rather than letting the packet fall back to a null line -- which
// is what it did here until 2026-08-13, so nothing in this file had an opinion
// about the line at all while it was being dropped in production.
//
// `resolveFeatures` is stubbed because the real resolver's job (does this
// installation actually have the thing) is tested in tests/capability-features
// .test.js; what belongs HERE is what the packet does with the answer. But
// `featureLine` is the REAL function, so the rendered format follows the shipped
// formatter instead of a copy of it that can go stale.
const featureCalls = [];
const capabilityFeaturesFixture = {
  resolveFeatures(options) {
    featureCalls.push(options);
    return [
      { id: 'filekeeper', state: 'ready', reason: null },
      { id: 'grepsaver', state: 'degraded', reason: 'its index declares no cards' },
      { id: 'purchase-cart', state: 'absent', reason: "tools not in this session's surface: purchase_request" }
    ];
  },
  featureLine
};
const FIXTURE_TOOLS = Object.freeze([{ name: 'repo_read_file' }, { name: 'memory_get' }]);
const EXPECTED_FEATURE_LINE = '[filekeeper] [grepsaver: degraded]';

const dependencies = {
  clock: () => NOW,
  environment: {},
  capabilityFeatures: capabilityFeaturesFixture,
  listTools: () => FIXTURE_TOOLS.map(tool => ({ ...tool })),
  git: (cwd, args) => {
    assert.equal(cwd, root);
    assert.deepEqual(args, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--show-toplevel']);
    return { status: 0, stdout: `0123456789abcdef\nr1175/fixture\n${root}\n`, stderr: '' };
  },
  orient: topic => ({
    cards: [{ id: 'agent-lanes', path: root, status: 'FRESH' }],
    docRouter: [`route for ${topic}`],
    antiRoutes: ['do not cold-grep'],
    toolNamespaces: [{ namespace: 'code', toolCount: 7 }, { namespace: 'task', toolCount: 11 }],
    coverage: { state: 'matched' },
    trust: 'Cards are maps, not authority.'
  }),
  readClaims: () => [{
    key: 'claim/r1175-other',
    actor: 'other-worker',
    checkout: 'C:/fixture/other',
    paths: ['src/lib/agent-onboarding.js'],
    scope: 'Other worker owns the packet source.',
    expiresAt: '2026-08-09T00:00:00.000Z',
    updatedAt: NOW - 500
  }]
};

try {
  resetSources();
  const input = {
    runtimeRoot: root,
    projectRoot: root,
    scope: 'task',
    profile: 'planner',
    agentId: 'planner-seat',
    identityBinding: 'verified-launch',
    role: 'planner',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    tier: 'ultra',
    launchId: 'launch_fixture',
    directiveId: 'R1175',
    territory: ['src/lib/agent-onboarding.js'],
    topic: 'R1175 onboarding'
  };
  const first = onboarding.buildPacket(input, dependencies);
  const second = onboarding.buildPacket(input, dependencies);
  assert.deepEqual(second, first, 'equal sources and injected clock must produce a deterministic packet');
  assert.equal(first.packetVersion, 'toolsenabled.agent-onboarding.v1');
  assert.equal(first.grantsAuthority, false);
  assert.deepEqual(first.session, {
    agentId: 'planner-seat', role: 'planner', provider: 'codex', model: 'gpt-5.6-sol', tier: 'ultra',
    reportsTo: 'controller-seat', launchId: 'launch_fixture', identityBinding: 'verified-launch', assignmentSource: 'session-overlay'
  });
  // Derived from the shipped role library, not a quoted phrase. This assertion
  // used to match /lookahead synthesis/, which pinned one sentence's wording
  // rather than the property that matters -- that the packet carries the
  // definition of the session's own role. Rewording the library then failed a
  // test that had no opinion about the wording.
  assert.equal(first.roleDefinition.owns, roleDefinition('planner').owns);
  assert.equal(first.roleDefinition.name, roleDefinition('planner').name);
  assert.equal(first.roleDefinition.owns,
    'Turn a delegated objective into an executable workload plan with boundaries, dependencies, parallel tasks and acceptance criteria. Use the relevant overview and source records; identify existing work and reusable functions before proposing new work.',
    'the packet carries the independently specified planner ownership contract');
  assert.equal(first.roleDefinition.name, 'Planner',
    'the packet carries the independently specified planner role name');
  assert.equal(first.settings.revision, 21);
  assert.equal(first.settings.enabledAssignments.find(agent => agent.id === 'planner-seat').owns[0], 'Read-only five-hour lookahead.');
  const customRoleRecord = {
    id: 'release-captain',
    baseDefaultRole: 'manager',
    rules: {
      owns: 'Own the bounded release train.',
      mustNot: 'Change work outside the declared release.',
      handoff: 'Return reviewed release evidence to the controller.'
    }
  };
  const customOrgInput = fixtureOrg();
  customOrgInput.agents.find(agent => agent.id === 'planner-seat').role = 'release-captain';
  const customOrg = agentOrg.normalizeOrg(customOrgInput, {
    knownRoles: [{ id: 'release-captain', baseDefaultRole: 'manager' }]
  });
  const customPacket = onboarding.buildPacket({
    ...input,
    role: 'release-captain'
  }, {
    ...dependencies,
    agentOrgStores: {
      read: () => ({ source: 'overlay', damaged: null, org: customOrg, roles: [customRoleRecord] })
    }
  });
  assert.equal(customPacket.session.role, 'release-captain');
  assert.equal(customPacket.roleDefinition.name, 'Release Captain');
  assert.equal(customPacket.roleDefinition.owns, 'Own the bounded release train.');
  assert.deepEqual(customPacket.roleDefinition.rules, roleDefinition('manager').rules,
    'the onboarding directions sheet composes the customer role with its declared normal base role');
  assert.ok(customPacket.provenance.some(entry => entry.source === 'installed-agent-org-overlay'),
    'the packet identifies the customer overlay as its organisation source');
  const longRoleRules = Object.fromEntries(['owns', 'mustNot', 'handoff'].map(field =>
    [field, `${field}: START\n\n${'任务上下文。'.repeat(900)}\n${field}: END`]));
  for (const scope of ['minimal', 'task', 'full']) {
    const longPacket = onboarding.buildPacket({ ...input, role: 'release-captain', scope }, {
      ...dependencies,
      agentOrgStores: { read: () => ({ source: 'overlay', damaged: null, org: customOrg,
        roles: [{ ...customRoleRecord, rules: longRoleRules }] }) }
    });
    const rendered = onboarding.renderPacket(longPacket);
    for (const value of Object.values(longRoleRules)) assert.ok(rendered.includes(JSON.stringify(value)),
      `${scope} onboarding must carry every paragraph of the authored role instead of dropping its definition`);
    assert.ok(Buffer.byteLength(rendered, 'utf8') <= longPacket.budget.limitBytes);
    assert.ok(longPacket.budget.limitBytes <= onboarding.MAX_RENDERED_BYTES[scope] + 96_000,
      'the extra role context allowance must remain bounded');
  }
  assert.equal(first.directive.verbatim, 'OWNER VERBATIM: Build a mechanical dynamic onboarding packet.');
  assert.equal(first.directive.selection, 'explicit-directive');
  assert.equal(first.directive.openGateCount, 2);
  assert.deepEqual(first.goals.map(goal => goal.id), ['Q42', 'Q43']);
  assert.deepEqual(first.coordination.presence.overlaps[0].pairs, [['src/lib/agent-onboarding.js', 'src/lib/agent-onboarding.js']]);
  assert.deepEqual(first.coordination.claims.overlaps[0].pairs, [['src/lib/agent-onboarding.js', 'src/lib/agent-onboarding.js']]);
  assert.ok(first.mismatches.some(entry => entry.code === 'live-role-differs-from-settings'));
  assert.ok(first.unknowns.some(entry => entry.code === 'client-tool-advertisement-unobserved'));
  assert.ok(first.provenance.every(entry => entry.observedAt === '2026-08-08T17:00:00.000Z'));
  assert.equal(first.contextRoutes.toolNamespaces[0].namespace, 'code');

  const unverifiedHookIdentity = onboarding.buildPacket({
    ...input,
    agentId: 'planner-seat',
    identityBinding: 'hook-event-unverified',
    role: undefined,
    reportsTo: undefined
  }, dependencies);
  assert.equal(unverifiedHookIdentity.session.agentId, 'planner-seat');
  assert.equal(unverifiedHookIdentity.session.role, null,
    'an unverified hook event cannot select the configured holder role');
  assert.equal(unverifiedHookIdentity.session.reportsTo, 'controller-seat',
    'an exact configured identity receives its non-authoritative reporting line even when the hook cannot select its role');
  assert.equal(unverifiedHookIdentity.session.assignmentSource, 'unverified-session-observation');
  assert.ok(unverifiedHookIdentity.unknowns.some(entry => entry.code === 'session-identity-unverified'));
  const unverifiedHookText = onboarding.renderPacket(unverifiedHookIdentity);
  assert.match(unverifiedHookText,
    /^Tree address: you are "planner-seat", and your manager is "controller-seat"\.$/m,
    'the hook packet states the address in the parser-compatible prose shape');
  assert.match(unverifiedHookText, /call agent_comms\.send_local/,
    'the hook packet names the local agent channel before the agent has to discover it');
  assert.match(unverifiedHookText, /Replies come to you as new messages in this conversation\./,
    'the hook packet explains that local replies arrive as turns rather than through polling');
  const sessionLine = unverifiedHookText.split(/\r?\n/)
    .find(line => line.startsWith('Session (settings/session overlay; holder is never hardcoded):'));
  assert.ok(sessionLine);
  assert.doesNotMatch(sessionLine, /"reportsTo":/,
    'the reporting line is prose, not a buried field in the session JSON');

  const mutationInput = {
    ...input,
    profile: 'builder',
    role: 'builder',
    agentId: 'worker-seat',
    identityBinding: 'launcher-bound',
    directiveId: 'Q42'
  };
  const mutationPacket = onboarding.buildPacket(mutationInput, dependencies);
  assert.equal(mutationPacket.directive.id, 'R1175', 'a queue-directed builder still receives the latest open owner request');
  assert.equal(mutationPacket.directive.selection, 'latest-open-request');
  fs.rmSync(path.join(root, 'state', 'agent-presence.json'));
  assert.throws(() => onboarding.buildPacket(mutationInput, dependencies),
    error => error && error.code === 'AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED'
      && error.details.missing.includes('state/agent-presence.json'),
    'a mutation-capable profile refuses to launch without live presence');
  resetSources();

  /* BOTH ROOT SHAPES, PINNED, because the rule is now scoped by root and a
     scoping rule is exactly the kind that silently widens.

     NOT A STAGED PAYLOAD (a checkout, a worktree, an empty directory): every one
     of the five sources is still demanded, and the refusal keeps its exact
     sentence and its `missing` list -- delete the ledger and the presence file
     both, and the sentence names both. This is the behaviour every non-payload
     root had before the scoping and must keep after it. */
  fs.rmSync(ownerLedgerFile());
  fs.rmSync(path.join(root, 'state', 'agent-presence.json'));
  assert.throws(() => onboarding.buildPacket(mutationInput, dependencies),
    error => error && error.code === 'AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED'
      && error.message === 'Mutation-capable onboarding requires current settings, presence, claims, queue, and owner directive: state/agent-presence.json, reports/OWNER-REQUEST-LEDGER.json.'
      && error.details.missing.includes('state/agent-presence.json')
      && error.details.missing.includes('reports/OWNER-REQUEST-LEDGER.json'),
    'a checkout-shaped root still refuses a builder without the live context, with the same sentence');
  resetSources();

  /* STAGED PAYLOAD: the installed product's runtime root is the capability
     payload -- PAYLOAD.json and config/agent-org.json are there, and NONE of
     BUILD-QUEUE.md, state/agent-presence.json or reports/OWNER-REQUEST-LEDGER.json
     is, because none of them is a product file. Measured 2026-08-16 from the
     installed dispatch form: this refused every lane the app tried to start. A
     builder dispatched from that root must boot, and the packet must SAY the
     checkout context was not required rather than pretend it was read.

     The marker is PAYLOAD.json, positively: the same directory WITHOUT it is the
     empty-root case tests/agent-onboarding-hook-contract.js pins as fail-closed,
     so that is asserted here too, on the same fixture, one file apart. */
  const payloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-onboarding-payload-'));
  fs.mkdirSync(path.join(payloadRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'config', 'agent-org.json'), `${JSON.stringify(fixtureOrg(), null, 2)}\n`, 'utf8');
  const payloadDependencies = {
    ...dependencies,
    git: (cwd, args) => {
      assert.equal(cwd, payloadRoot);
      return { status: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
  };
  assert.throws(() => onboarding.buildPacket({ ...mutationInput, runtimeRoot: payloadRoot, projectRoot: payloadRoot }, payloadDependencies),
    error => error && error.code === 'AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED',
    'the same directory without PAYLOAD.json is not a payload and still fails closed');
  fs.writeFileSync(path.join(payloadRoot, 'PAYLOAD.json'), '{"schemaVersion":1,"bridgeEntrypoint":"tools/mission-bridge.js"}\n', 'utf8');
  const payloadPacket = onboarding.buildPacket({
    ...mutationInput,
    runtimeRoot: payloadRoot,
    projectRoot: payloadRoot
  }, payloadDependencies);
  assert.equal(payloadPacket.settings.revision, 21, 'the payload-hosted packet is still built from the payload organisation');
  assert.ok(payloadPacket.unknowns.some(entry => entry.code === 'live-mutation-context-not-required'),
    'a payload-hosted builder boots and the packet records that the checkout context was not required');
  assert.equal(payloadPacket.coordination.presence.revision, null, 'no presence was invented for the payload root');
  fs.rmSync(payloadRoot, { recursive: true, force: true });

  const rendered = onboarding.renderPacket(first);
  assert.ok(rendered.startsWith(`${onboarding.PACKET_BEGIN}\n`));
  assert.ok(rendered.endsWith(`${onboarding.PACKET_END}\n`));
  assert.ok(rendered.indexOf('## Session assignment and fixed role') < rendered.indexOf('## Project and directive'));
  assert.ok(Buffer.byteLength(rendered, 'utf8') <= onboarding.MAX_RENDERED_BYTES.task);
  assert.doesNotMatch(rendered, /coordinator-sol|Claude session is coordinator|local worker owns/i,
    'packet source must not embed historical role holders or disabled coordinator assumptions');

  // --- BYTE BUDGET --------------------------------------------------------
  // Mandated session-boot reading reached ~948 KB across four documents, which
  // no agent finishes; the packet that replaced the pointer to it must not be
  // free to drift the same way. These checks hold the ceiling, the order things
  // are given up in, and -- above all -- that a partial packet SAYS it is
  // partial. A packet that looks complete but is not is worse than a small one.

  // 1. The ceiling is real and reported, not aspirational.
  assert.ok(onboarding.MAX_RENDERED_BYTES.full <= 32 * 1024,
    'the full-scope ceiling must stay within a few percent of a small context window');
  assert.ok(onboarding.MAX_RENDERED_BYTES.minimal <= onboarding.MAX_RENDERED_BYTES.task
    && onboarding.MAX_RENDERED_BYTES.task <= onboarding.MAX_RENDERED_BYTES.full,
    'the ceiling must rise with scope, never fall');
  assert.equal(first.budget.limitBytes, onboarding.MAX_RENDERED_BYTES.task);
  assert.equal(first.budget.complete, true, 'an ordinary fixture packet fits without dropping anything');
  // R1549 inserted `recent` between `divergence` and `goals`. It is above goals
  // because it is the only section that RETIRES a fact the agent already holds
  // -- a queue phase an agent has not been shown costs it a slow start, while a
  // moved file it has not been told about costs it a wrong action -- and below
  // divergence because divergence doubts the facts this packet is stating.
  assert.deepEqual(first.budget.priorityOrder,
    ['identity', 'budget', 'fences', 'coordination', 'divergence', 'recent', 'goals', 'routes', 'provenance'],
    'the drop order is part of the contract, not an implementation detail');
  // The count in the packet must be the count OF the packet. An approximate
  // figure is worse than none: it gets quoted as if it were measured.
  const reportedBytes = /rendered\s+(\d+) bytes/.exec(rendered);
  assert.ok(reportedBytes, 'the packet must report its own byte count so drift is visible, not discovered');
  assert.equal(Number(reportedBytes[1]), Buffer.byteLength(rendered, 'utf8'),
    'the reported byte count must equal the actual rendered size');
  assert.match(rendered, /## Onboarding budget/);
  assert.doesNotMatch(rendered, /THIS PACKET IS INCOMPLETE/,
    'a complete packet must not cry incomplete');

  // 2. Oversized input truncates AND announces it. One owner directive is
  //    enough to blow the ceiling: 60 KB of verbatim with 40 gates rendered
  //    48,571 bytes before this budget existed, silently.
  resetSources();
  writeOwnerLedger({
    requests: [{
      id: 'R1175',
      verbatim: `OWNER VERBATIM: ${'directive text that will not fit. '.repeat(2000)}`,
      request: 'Oversized directive',
      status: 'in-progress',
      gates: Array.from({ length: 40 }, (unused, index) => ({ instruction: `gate ${index} ${'g'.repeat(1200)}`, met: false }))
    }]
  });
  const oversized = onboarding.buildPacket({ ...input, scope: 'full' }, dependencies);
  const oversizedText = onboarding.renderPacket(oversized);
  // Both bounds on purpose. The exported constant proves the code honours its
  // own ceiling; the literal proves the ceiling cannot be quietly raised to make
  // this pass. Before the budget, this same input rendered 48,571 bytes.
  assert.ok(Buffer.byteLength(oversizedText, 'utf8') <= onboarding.MAX_RENDERED_BYTES.full,
    'the ceiling is hard: oversized content must not be able to exceed it');
  assert.ok(Buffer.byteLength(oversizedText, 'utf8') <= 32 * 1024,
    'an oversized owner directive must not be able to spend more than 32 KB of boot context');
  assert.equal(oversized.budget.complete, false);
  assert.ok(oversized.budget.withinBodyLimit, 'the body must actually be brought under its limit, not merely flagged');
  assert.ok(oversized.budget.omitted.length > 0);
  // TRUNCATED HONESTLY: every drop names what went and where to read it.
  for (const entry of oversized.budget.omitted) {
    assert.ok(entry.title, 'a drop must name what was dropped');
    assert.ok(entry.readItAt, `a drop must say where to read ${entry.field}`);
  }
  assert.match(oversizedText, /THIS PACKET IS INCOMPLETE/,
    'a truncated packet must announce it, never cut silently');
  assert.match(oversizedText, /⚠ INCOMPLETE PACKET:/,
    'the incompleteness warning must reach the first block, which always renders');
  assert.match(oversizedText, /You were NOT shown these; do not read this packet as your full context/);
  assert.match(oversizedText, /read it: reports\/OWNER-REQUEST-LEDGER\.json|read it: node tools\//,
    'the packet must route the agent to what it did not receive');
  const oversizedReported = /rendered\s+(\d+) bytes/.exec(oversizedText);
  assert.equal(Number(oversizedReported[1]), Buffer.byteLength(oversizedText, 'utf8'));

  // 3. Priority is by damage, not by position in the file. The directive is
  //    what the session is judged against, so it survives the collision data,
  //    which survives the system map, which survives provenance.
  const survivors = oversized.budget.omitted.map(entry => entry.priority);
  const droppedRanks = new Set(survivors);
  assert.ok(droppedRanks.has('provenance'), 'provenance is the first thing given up');
  assert.ok(!droppedRanks.has('coordination') || droppedRanks.has('routes'),
    'collision data must never be given up while the system map is still held');
  assert.ok(oversized.directive && typeof oversized.directive.verbatim === 'string' && oversized.directive.verbatim.length > 0,
    'the owner directive is shortened as a last resort, never removed');
  assert.match(oversized.directive.verbatim, /read the whole thing in reports\/OWNER-REQUEST-LEDGER\.json entry R1175/,
    'a shortened verbatim must say it was cut and where the whole text lives');
  // One verbose owner request must not be able to spend the whole packet on
  // itself. Measured before the share cap: a 60 KB verbatim held 29,535 bytes
  // and pushed presence, claims and every overlap pair out of the packet.
  assert.ok(!oversized.budget.omitted.some(entry => entry.priority === 'coordination'),
    'a single oversized directive must not cost the session its collision data');
  assert.ok(Array.isArray(oversized.coordination.presence.live) && oversized.coordination.presence.live.length > 0,
    'the live presence roster survives an oversized directive');
  // The verbatim is prose and gives way first; gates are discrete instructions,
  // and surrendering all of them is how a session ends up not knowing what it
  // must do. Both must survive in part.
  assert.ok(oversized.directive.openGates.length > 0,
    'gates are instructions: they must not all be sacrificed to keep prose');
  assert.equal(oversized.directive.openGatesWithheldForBudget.openInLedger, 40,
    'a withheld-gate count must be stated against what the ledger holds open, not against what the packet happened to carry');
  assert.match(oversizedText, /open gate instruction\(s\) of the 40 the ledger holds open/);
  assert.equal(oversized.treeIdentity.runtime.repo, first.treeIdentity.runtime.repo,
    'tree identity is rank 1 and is never a candidate for the budget');
  assert.ok(oversizedText.includes(onboarding.PACKET_BEGIN) && oversizedText.endsWith(`${onboarding.PACKET_END}\n`),
    'a truncated packet is still a well-formed packet');

  // 4. A section that cannot be rendered leaves a marker in its place, so the
  //    gap is visible while reading and not only in the footer.
  const squeezed = onboarding.renderPacket({ ...oversized, scope: 'minimal' });
  assert.ok(Buffer.byteLength(squeezed, 'utf8') <= onboarding.MAX_RENDERED_BYTES.minimal);
  assert.match(squeezed, /\[OMITTED — .*You have NOT been shown this\. Read it yourself: /,
    'a section dropped at render time must be marked where it would have stood');
  assert.match(squeezed.split('\n\n')[0], /^TREE ✓ |^⚠ TREE /m,
    'the tree line survives every drop');

  // 5. THE FEATURE LINE SURVIVES THE TIGHTEST BUDGET THE PRODUCT SHIPS.
  //
  // Found 2026-08-13 by adversarial review. The line lived in `capabilities` and
  // `contextRoutes`, both rank 8, so it went on the budget's SECOND and THIRD
  // steps -- and the renderer, finding no line, printed "could not be resolved
  // this run" from a run in which it had resolved perfectly. That is not a
  // missing line but a false one, and it is exactly the failure the module
  // header calls the one worse than being small: the agent could not tell "not
  // reported" from "not happening". Measured that day at minimal scope: the body
  // came to 17,757 bytes against a 15,360 limit, so the budget was right to trim
  // and the ceiling was not the problem. The RANK was.
  assert.deepEqual(featureCalls[0].toolNames, ['repo_read_file', 'memory_get'],
    'the line must be resolved from THIS session\'s tool surface, never from a static list');
  assert.equal(first.sessionFeatures.line, EXPECTED_FEATURE_LINE);
  assert.equal(first.capabilities.features, undefined,
    'the line is stored once, at the top level; a rank-8 copy is how it was lost');
  assert.equal(first.contextRoutes.features, undefined,
    'and once means once -- it used to be carried in both containers');
  assert.ok(rendered.includes(`FEATURES YOU HAVE: ${EXPECTED_FEATURE_LINE}`));
  assert.ok(rendered.split('\n\n')[0].includes('FEATURES YOU HAVE: '),
    'the line rides in the first block, which is the block no budget can reach');
  assert.match(rendered, /grepsaver is installed but its index declares no cards/,
    'a degraded feature must say why, or an agent routes to an empty index anyway');

  // A body that genuinely cannot fit minimal scope. The $owns entries are capped
  // at 8 per agent and 1,200 bytes each by the collector, so three agents can
  // overflow the smallest ceiling without any owner text being involved -- the
  // point is a starved packet, not a starved directive.
  resetSources();
  write('config/agent-org.json', {
    ...fixtureOrg(),
    agents: fixtureOrg().agents.map(agent => ({
      ...agent,
      $owns: Array.from({ length: 8 }, (unused, index) => `owns ${index} ${'o'.repeat(1100)}`)
    }))
  });
  const starved = onboarding.buildPacket({ ...input, scope: 'minimal' }, dependencies);
  assert.equal(starved.budget.complete, false,
    'this fixture must actually overflow minimal scope, or the check below proves nothing');
  assert.ok(starved.budget.omitted.some(entry => entry.priority === 'routes'),
    'the routes-class fields must be among the drops: that is the case that used to take the line with them');
  assert.equal(starved.sessionFeatures.line, EXPECTED_FEATURE_LINE,
    'the feature line survives the tightest budget the product ships');
  const starvedText = onboarding.renderPacket(starved);
  assert.ok(Buffer.byteLength(starvedText, 'utf8') <= onboarding.MAX_RENDERED_BYTES.minimal,
    'and it survives inside the ceiling, not by raising it');
  assert.ok(starvedText.includes(`FEATURES YOU HAVE: ${EXPECTED_FEATURE_LINE}`),
    'a minimal packet that dropped its system map must still tell the agent what it has');
  assert.doesNotMatch(starvedText, /FEATURES YOU HAVE: could not be resolved/,
    'a budget drop must never be reported as a resolution failure; that is the packet lying about the machine');

  // The structural half. The check above proves today's packet keeps the line;
  // this one proves no future step can be written that takes it, which is how it
  // was lost the first time -- the line was placed inside a container that two
  // steps already pointed at, and no test noticed.
  for (const step of onboarding.BODY_TRIM_ORDER) {
    const target = `${step.container ? `${step.container}.` : ''}${step.key || '<directive share>'}`;
    assert.notEqual(step.container, 'sessionFeatures', `BODY_TRIM_ORDER step ${target} can reach the pinned feature line`);
    assert.notEqual(step.key, 'sessionFeatures', `BODY_TRIM_ORDER step ${target} can reach the pinned feature line`);
    assert.ok(!['identity', 'budget'].includes(step.priority),
      `BODY_TRIM_ORDER step ${target} surrenders rank "${step.priority}", which is never dropped`);
  }

  // Nothing pinned may be unbounded: renderPacket fails CLOSED over the ceiling,
  // and a hard failure at session boot is the most expensive failure this module
  // can produce. So the header's share of it is capped by width and by count,
  // and what is not shown is counted rather than silently dropped.
  const manyDegraded = onboarding.buildPacket({ ...input, scope: 'minimal' }, {
    ...dependencies,
    capabilityFeatures: {
      resolveFeatures: () => Array.from({ length: 9 }, (unused, index) => ({
        id: `feature-${index}`, state: 'degraded', reason: `reason ${index} ${'r'.repeat(600)}`
      })),
      featureLine
    }
  });
  assert.equal(manyDegraded.sessionFeatures.degraded.length, 4, 'the pinned block is bounded by count');
  assert.equal(manyDegraded.sessionFeatures.degradedNotShown, 5, 'what is not shown is counted, never silent');
  for (const entry of manyDegraded.sessionFeatures.degraded) {
    assert.ok(Buffer.byteLength(entry.reason, 'utf8') <= 160, 'a pinned reason is bounded in width as well as in number');
    assert.doesNotMatch(entry.reason, /\n/, 'pinned prose must stay on one line, whatever it was truncated out of');
  }
  assert.match(onboarding.renderPacket(manyDegraded), /and 5 further degraded feature\(s\)/);

  // The honest failure is still reachable, and now it means what it says: the
  // sentence is printed only when resolution ACTUALLY failed.
  const unresolved = onboarding.buildPacket(input, {
    ...dependencies,
    listTools: () => { throw Object.assign(new Error('no tool registry'), { code: 'NO_REGISTRY' }); }
  });
  assert.equal(unresolved.sessionFeatures.line, null);
  assert.ok(unresolved.unknowns.some(entry => entry.code === 'capability-features-unavailable'),
    'an unresolvable feature line is recorded as an unknown, not swallowed');
  assert.match(onboarding.renderPacket(unresolved), /FEATURES YOU HAVE: could not be resolved this run/);

  // 6. The drop order must stay the reverse of the priority order. Exactly ONE
  //    step is allowed to break it and the module names it: the `fences` share
  //    cap, which BOUNDS a field rather than dropping one, taken ahead of the
  //    collision data so a single verbose directive cannot spend the packet on
  //    itself. Anything else out of order is the drift the data-driven list
  //    exists to prevent.
  const rankOf = Object.fromEntries(onboarding.PACKET_PRIORITY.map(entry => [entry.id, entry.rank]));
  const rises = onboarding.BODY_TRIM_ORDER
    .map((step, index) => ({ step, previous: onboarding.BODY_TRIM_ORDER[index - 1] }))
    .filter(({ step, previous }) => previous && rankOf[step.priority] > rankOf[previous.priority]);
  assert.equal(rises.length, 1,
    `the drop order must be the reverse of the priority order but for the documented share cap; found ${rises.length} rank rises`);
  assert.equal(rises[0].previous.priority, 'fences');
  assert.equal(rises[0].previous.directiveShare, 0.5,
    'the one permitted rank rise is the directive SHARE CAP, which bounds a field rather than surrendering one');
  for (const step of onboarding.BODY_TRIM_ORDER) {
    assert.ok(Number.isFinite(rankOf[step.priority]),
      `BODY_TRIM_ORDER step ${step.key || '<directive share>'} names a priority PACKET_PRIORITY does not declare`);
  }

  resetSources();

  resetSources({ verbatim: 'Bearer abcdefghijklmnopqrstuvwxyz123456' });
  const screened = onboarding.buildPacket(input, dependencies);
  assert.equal(screened.directive.verbatim, '[withheld: secret-shaped content]');
  assert.ok(screened.unknowns.some(entry => entry.code === 'secret-shaped-content-withheld'));
  assert.doesNotMatch(onboarding.renderPacket(screened), /abcdefghijklmnopqrstuvwxyz123456/);

  const main = path.join(root, 'main-checkout');
  const linked = path.join(root, 'linked-checkout');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'linked-checkout'), { recursive: true });
  fs.mkdirSync(linked, { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'linked-checkout')}\n`, 'utf8');
  assert.equal(onboarding.linkedMainRoot(linked), main,
    'a linked worktree must resolve live settings/state from its main runtime checkout without a machine path hardcode');

  const coverage = new Map(onboarding.SPAWN_PATH_COVERAGE.map(entry => [entry.id, entry]));
  for (const required of ['agent-lane', 'luna-executor', 'fleet-planning', 'gemini-fleet', 'gemini-agentic', 'codex-session', 'claude-session']) {
    assert.ok(coverage.has(required), `spawn coverage manifest is missing ${required}`);
    assert.notEqual(coverage.get(required).strategy, 'uncovered');
  }
  assert.equal(coverage.get('sealed-reviewer-checker-calls').strategy, 'protocol-exception');

  const cliOptions = onboardingCli.parseArgs([
    process.execPath, 'tools/agent-onboarding.js', '--hook', '--provider', 'codex', '--scope', 'task'
  ]);
  assert.equal(cliOptions['--provider'], 'codex');
  const unverifiedPlannerHook = onboardingCli.inputFrom(cliOptions, {
    hook_event_name: 'SubagentStart', agent_id: 'dynamic-child-id', agent_type: 'planner', cwd: root, model: 'gpt-5.6-sol'
  }, {});
  assert.equal(unverifiedPlannerHook.role, undefined, 'an unauthenticated hook event cannot assign a role');
  assert.equal(unverifiedPlannerHook.profile, 'builder',
    'an unauthenticated role-like hook label cannot bypass live mutation-context checks');
  assert.equal(onboardingCli.profileFromEvent('shadow-manager'), 'builder',
    'the Shadow name has no special onboarding mechanics');
  assert.equal(onboardingCli.profileFromEvent('reviewer'), 'builder',
    'a shipped read-only role name is not trusted as a hook capability record');
  assert.equal(onboardingCli.profileFromEvent('checker'), 'builder',
    'an unauthenticated protocol-exception-like name cannot select a lighter profile');
  assert.equal(onboardingCli.profileFromEvent('release-captain'), 'builder',
    'a customer manager role enters the mutation-capable live-context profile instead of a static role allowlist');
  assert.equal(onboardingCli.profileFromEvent('unknown-mutating-agent'), 'builder',
    'an unknown subagent type fails into the mutation-capable live-context profile');
  assert.equal(onboardingCli.profileFromEvent(undefined, 'SubagentStart'), 'builder',
    'a SubagentStart event missing its type also fails into the live-context profile');
  assert.equal(onboardingCli.inputFrom(cliOptions, {
    hook_event_name: 'SubagentStart', agent_id: 'dynamic-child-id', cwd: root
  }, {}).identityBinding, 'hook-event-unverified', 'direct hook identity is explicitly unverified');
  assert.equal(onboardingCli.hookEnvelope('SubagentStart', 'fixture').hookSpecificOutput.hookEventName, 'SubagentStart');

  const repoRoot = path.resolve(__dirname, '..');
  writeHookFixtures();
  const codexHooks = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'hooks.json'), 'utf8'));
  const claudeSettings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  for (const [client, hooks] of [['codex', codexHooks.hooks], ['claude', claudeSettings.hooks]]) {
    for (const event of ['SessionStart', 'SubagentStart']) {
      assert.ok(Array.isArray(hooks[event]) && hooks[event].length > 0, `${client} has a mechanical ${event} route`);
      const command = hooks[event][0].hooks[0].command;
      assert.match(command, /tools\/agent-onboarding\.js/);
      assert.doesNotMatch(command, /coordinator-sol|opus5|fable5/i, `${client} hook must not bake a role holder`);
    }
  }
  assert.ok(codexHooks.hooks.SessionStart[0].hooks[0].additionalContextLimit >= onboarding.MAX_RENDERED_BYTES.full);
  assert.ok(codexHooks.hooks.SubagentStart[0].hooks[0].additionalContextLimit >= onboarding.MAX_RENDERED_BYTES.task);
  for (const eventName of ['SessionStart', 'SubagentStart']) {
    const hooked = spawnSync(process.execPath, [
      path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--provider', 'codex',
      '--runtime', root, '--project', root, '--scope', eventName === 'SessionStart' ? 'full' : 'task'
    ], {
      cwd: repoRoot,
      input: JSON.stringify({
        hook_event_name: eventName,
        ...(eventName === 'SubagentStart' ? { agent_type: 'observer' } : {}),
        cwd: root,
        model: 'gpt-5.6-sol'
      }),
      encoding: 'utf8', windowsHide: true, env: { ...process.env }
    });
    const envelope = JSON.parse(hooked.stdout);
    assert.equal(envelope.hookSpecificOutput.hookEventName, eventName);
    if (eventName === 'SubagentStart') {
      assert.equal(hooked.status, 1, 'an observer label cannot make an unauthenticated subagent skip live mutation context');
      assert.equal(envelope.continue, false);
      assert.match(envelope.hookSpecificOutput.additionalContext, /ONBOARDING FAILED CLOSED: AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/);
    } else {
      assert.equal(hooked.status, 0, hooked.stderr);
      assert.equal(envelope.continue, true);
      assert.match(envelope.hookSpecificOutput.additionalContext, /BEGIN TOOLSENABLED DYNAMIC ONBOARDING PACKET v1/);
    }
  }
  const proofEnvironment = {
    ...process.env,
    TOOLSENABLED_ONBOARDING_ALREADY_INJECTED: '1',
    TOOLSENABLED_ONBOARDING_PACKET_VERSION: onboarding.PACKET_VERSION,
    TOOLSENABLED_ONBOARDING_PACKET_HASH: 'a'.repeat(64),
    TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE: 'verified-launch',
    TOOLSENABLED_LAUNCH_ID: 'launch_fixture',
    TOOLSENABLED_LAUNCH_RECORD_HASH: 'b'.repeat(64),
    TOOLSENABLED_LAUNCH_AUDIT_SEQUENCE: '42',
    TOOLSENABLED_LAUNCH_AUDIT_EVENT_HASH: 'c'.repeat(64)
  };
  assert.equal(onboardingCli.verifiedSuppression(proofEnvironment, {
    verifyLaunchReceipt: receipt => ({ ...receipt, targetAgentId: 'fixture', model: 'fixture' })
  }), true, 'suppression requires a receipt accepted by the canonical verifier seam');
  const suppressed = spawnSync(process.execPath, [
    path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--provider', 'codex',
    '--runtime', root, '--project', root, '--scope', 'task'
  ], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'observer', cwd: repoRoot }),
    encoding: 'utf8',
    windowsHide: true,
    env: proofEnvironment
  });
  assert.equal(suppressed.status, 1, 'an unverified receipt must neither suppress onboarding nor bypass mutation context');
  const suppressedEnvelope = JSON.parse(suppressed.stdout);
  assert.equal(suppressedEnvelope.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(suppressedEnvelope.hookSpecificOutput.additionalContext, /AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/,
    'a syntactically shaped but canonically unverified receipt reaches the fail-closed builder gate');
  const spoofedSuppression = spawnSync(process.execPath, [
    path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--provider', 'codex',
    '--runtime', root, '--project', root, '--scope', 'task'
  ], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'observer', cwd: root }),
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOOLSENABLED_ONBOARDING_ALREADY_INJECTED: '1' }
  });
  assert.equal(spoofedSuppression.status, 1);
  assert.match(JSON.parse(spoofedSuppression.stdout).hookSpecificOutput.additionalContext,
    /AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED/,
    'an unverified boolean cannot suppress or weaken direct-session onboarding');
  const refused = spawnSync(process.execPath, [
    path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--provider', 'codex',
    '--runtime', root, '--project', root, '--profile', 'not-a-profile'
  ], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: 'SubagentStart', cwd: root }),
    encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  assert.equal(refused.status, 1);
  const refusedEnvelope = JSON.parse(refused.stdout);
  assert.equal(refusedEnvelope.continue, false, 'fatal packet construction fails the hook closed');
  assert.equal(refusedEnvelope.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.match(refusedEnvelope.stopReason, /AGENT_ONBOARDING_INPUT_INVALID/);

  // The owner's R ledgers ride PINNED in every packet, in obey-order, and a
  // thread rule comes back after a compaction with nothing but the harness's
  // own session_id. Owner design 2026-08-15 (four /Request* commands).
  resetSources();
  const rLedger = require('../src/lib/r-ledger');
  // The isolated runner deliberately configures a separate writable state
  // root. Write through the same program/state resolver buildPacket reads so
  // this fixture proves installed-path behavior instead of accidentally
  // placing its ledgers in a source-tree location production will not inspect.
  // Every tier now lands in the ONE canonical ledger the directive is read
  // from (src/lib/owner-request-store.js), beside the planted R1175.
  const rOpts = { rootPath: (...parts) => runtimeStateRoot.programOrStatePath(root, parts), needsApproval: false };
  rLedger.fileRequest({ scope: 'global', words: 'GLOBAL-RULE quiet desktop' }, rOpts);
  rLedger.fileRequest({ scope: 'session', key: 'sess-A', words: 'SESSION-RULE no pushes today' }, rOpts);
  rLedger.fileRequest({ scope: 'tree', key: 'root-agent', words: 'TREE-RULE from the root' }, rOpts);
  rLedger.fileRequest({ scope: 'tree', key: 'mid-agent', words: 'TREE-RULE from the manager' }, rOpts);
  const threadRule = rLedger.fileRequest({ scope: 'thread', key: 'thread-Z', words: 'THREAD-RULE show diffs first' }, rOpts);
  assert.equal(threadRule.path, ownerLedgerFile(), 'the standing rules and the directive are one file');
  const withRules = onboarding.buildPacket({
    ...input, scope: 'minimal', sessionId: 'sess-A', threadId: 'thread-Z', treeAnchors: ['root-agent', 'mid-agent']
  }, dependencies);
  assert.equal(withRules.ownerRequests.total, 6, 'the five filed rules and the planted in-progress directive, which is a standing request too');
  assert.deepEqual(withRules.ownerRequests.layers.map(layer => `${layer.scope}:${layer.key || ''}`),
    ['global:', 'session:sess-A', 'tree:root-agent', 'tree:mid-agent', 'thread:thread-Z'], 'obey-order: global, session, ancestors top-down, thread');
  // THE DIRECTIVE IS CHOSEN FROM THIS AGENT'S OWN CONTEXT ONLY. The latest
  // open request in the full context is the thread rule; a sibling thread and
  // branch see the manager's tree rule and thread-Z's rule as nobody's; a row
  // an agent filed that still waits for the person is never a directive.
  const latest = onboarding.buildPacket({
    ...input, directiveId: undefined, scope: 'minimal', sessionId: 'sess-A', threadId: 'thread-Z', treeAnchors: ['root-agent', 'mid-agent']
  }, dependencies);
  assert.equal(latest.directive.selection, 'latest-open-request');
  assert.equal(latest.directive.id, threadRule.id);
  const waiting = rLedger.fileRequest({ scope: 'global', words: 'WAITING-RULE an agent suggested this', filedBy: 'codex', proposed: true }, rOpts);
  const siblingDirective = onboarding.buildPacket({
    ...input, directiveId: undefined, scope: 'minimal', sessionId: 'sess-A', threadId: 'thread-Y', treeAnchors: ['root-agent']
  }, dependencies);
  assert.equal(siblingDirective.directive.id, 'R1178', 'the root tree rule is the latest open request a sibling branch can see');
  assert.notEqual(siblingDirective.directive.id, waiting.id, 'a waiting row is no agent\'s directive');
  const explicitWaiting = onboarding.buildPacket({ ...input, directiveId: waiting.id, scope: 'minimal', sessionId: 'sess-A' }, dependencies);
  assert.ok(explicitWaiting.unknowns.some(entry => entry.code === 'directive-request-not-found'), 'naming a waiting row outright still does not hand it over');

  // SUPERSEDED IS NOT OPEN. collectDirective classifies a record's status by
  // name against two regexes; 'superseded' (new, resolve()) matched neither
  // the proposed/declined/removed exclusion nor the done/not-possible-as-asked
  // one, so a rule the owner explicitly retired was still picked as if it were
  // the latest open directive. A fresh thread key so this probe cannot
  // disturb the fixtures built above or below.
  const supersededOld = rLedger.fileRequest({ scope: 'thread', key: 'superseded-thread', words: 'OLD-RULE superseded by a newer one' }, rOpts);
  rLedger.resolve({ id: supersededOld.id, status: 'superseded', reason: 'replaced' }, rOpts);
  const supersededPacket = onboarding.buildPacket({
    ...input, directiveId: undefined, scope: 'minimal', sessionId: 'sess-A', threadId: 'superseded-thread', treeAnchors: []
  }, dependencies);
  assert.notEqual(supersededPacket.directive && supersededPacket.directive.id, supersededOld.id,
    'a superseded rule is never auto-selected as the latest open directive');
  assert.notEqual(supersededPacket.directive && supersededPacket.directive.status, 'superseded',
    'the directive auto-selection never lands on a superseded record');
  assert.ok(supersededPacket.directive && supersededPacket.directive.verbatim.includes('SESSION-RULE no pushes today'),
    'falls back to the next standing rule this identity can see, exactly as it would for a declined or removed one');
  // CONTROL: naming a superseded directive outright still reads it, the same
  // as a done directive can still be read back by name -- only auto-selection
  // treats it as gone. If this control also failed, the suite would be
  // detecting a widened R gate rather than the auto-selection fix.
  const explicitSuperseded = onboarding.buildPacket({
    ...input, directiveId: supersededOld.id, scope: 'minimal', sessionId: 'sess-A', threadId: 'superseded-thread'
  }, dependencies);
  assert.equal(explicitSuperseded.directive && explicitSuperseded.directive.id, supersededOld.id,
    'naming a superseded directive outright still hands it over, same as a done one');
  assert.equal(explicitSuperseded.directive.status, 'superseded');

  rLedger.decide({ id: waiting.id, decision: 'decline' }, rOpts);
  const rulesText = onboarding.renderPacket(withRules);
  const rulesBlock = rulesText.slice(rulesText.indexOf('## Owner requests'), rulesText.indexOf('## Session assignment'));
  for (const words of ['GLOBAL-RULE quiet desktop', 'SESSION-RULE no pushes today', 'TREE-RULE from the root', 'TREE-RULE from the manager', 'THREAD-RULE show diffs first']) {
    assert.ok(rulesBlock.includes(words), `the rendered packet carries "${words}" verbatim`);
  }
  assert.ok(rulesText.indexOf('## Owner requests') < rulesText.indexOf('## Session assignment'), 'the rules block is pinned in the header, ahead of every droppable section');
  assert.ok(rulesBlock.indexOf('GLOBAL-RULE') < rulesBlock.indexOf('SESSION-RULE') && rulesBlock.indexOf('TREE-RULE from the root') < rulesBlock.indexOf('TREE-RULE from the manager') && rulesBlock.indexOf('TREE-RULE from the manager') < rulesBlock.indexOf('THREAD-RULE'), 'rendered in obey-order');
  // A sibling branch and a different thread see neither the manager's tree rule nor thread-Z's rule.
  const sibling = onboarding.buildPacket({ ...input, scope: 'minimal', sessionId: 'sess-A', threadId: 'thread-Y', treeAnchors: ['root-agent'] }, dependencies);
  const siblingText = onboarding.renderPacket(sibling);
  assert.ok(siblingText.includes('TREE-RULE from the root') && !siblingText.includes('TREE-RULE from the manager'), 'tree rules flow only downward from their anchor');
  assert.ok(!siblingText.includes('THREAD-RULE'), 'another thread never sees a thread rule');
  // No identity: global only, and the packet says the rest was not read.
  const anonymous = onboarding.buildPacket({ ...input, scope: 'minimal', sessionId: undefined, threadId: undefined, treeAnchors: [] }, dependencies);
  assert.equal(anonymous.ownerRequests.layers.length, 1);
  assert.ok(anonymous.unknowns.some(entry => entry.code === 'owner-requests-session-unknown'));
  // The post-compact SessionStart hook: session_id alone reaches the thread rule.
  const compactHook = spawnSync(process.execPath, [
    path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--runtime', root, '--project', root, '--profile', 'planner'
  ], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: 'thread-Z', cwd: root }),
    encoding: 'utf8', windowsHide: true, env: { ...process.env }
  });
  assert.equal(compactHook.status, 0, compactHook.stderr);
  const compactText = JSON.parse(compactHook.stdout).hookSpecificOutput.additionalContext;
  assert.ok(compactText.includes('THREAD-RULE show diffs first'), 'a thread rule is re-delivered after compaction from session_id alone');
  assert.ok(compactText.includes('GLOBAL-RULE quiet desktop'), 'and the global ledger rides with it');
  // A product-spawned child: environment carries thread id and ancestor chain.
  const childHook = spawnSync(process.execPath, [
    path.join(repoRoot, 'tools', 'agent-onboarding.js'), '--hook', '--runtime', root, '--project', root, '--profile', 'planner'
  ], {
    cwd: repoRoot,
    input: JSON.stringify({ hook_event_name: 'SubagentStart', session_id: 'sess-A', cwd: root }),
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOOLSENABLED_THREAD_ID: 'thread-Z', TOOLSENABLED_TREE_ANCESTORS: 'root-agent,mid-agent' }
  });
  assert.equal(childHook.status, 0, childHook.stderr);
  const childText = JSON.parse(childHook.stdout).hookSpecificOutput.additionalContext;
  for (const words of ['GLOBAL-RULE', 'SESSION-RULE', 'TREE-RULE from the root', 'TREE-RULE from the manager', 'THREAD-RULE']) {
    assert.ok(childText.includes(words), `a spawned child boots with ${words} from its environment identity`);
  }

  // THE PINNED BLOCK CAN NEVER KILL THE BOOT. Measured 2026-08-16 on the
  // installed build: ~36 filed /Request entries made every packet refuse
  // AGENT_ONBOARDING_PACKET_TOO_LARGE -- no agent could start, at any scope,
  // hooks and lanes alike. Over its share of the ceiling the block withholds
  // whole layers most-specific-first (thread, trees, session; global last),
  // the global layer sheds only its OLDEST entries, every withheld layer
  // names its file, and the packet still renders.
  const floodWords = 'FLOOD-RULE always check the run service is up before you touch the tree. '.repeat(30).trim();
  const ledgerPathBeforeFlood = ownerLedgerFile();
  const historyPathBeforeFlood = rOpts.rootPath('state', 'owner-request-record-events.jsonl');
  const ledgerBeforeFlood = fs.readFileSync(ledgerPathBeforeFlood, 'utf8');
  const historyBeforeFlood = fs.readFileSync(historyPathBeforeFlood, 'utf8');
  rLedger.fileRequest({ scope: 'thread', key: 'flood-thread', words: `THREAD-SMALL ${floodWords.slice(0, 80)}` }, rOpts);
  for (let index = 0; index < 12; index += 1) {
    rLedger.fileRequest({ scope: 'session', key: 'flood-sess', words: `SESSION-FLOOD ${index + 1} ${floodWords}` }, rOpts);
  }
  for (let index = 0; index < 15; index += 1) {
    rLedger.fileRequest({ scope: 'global', words: `GLOBAL-FLOOD ${index + 1} ${floodWords}` }, rOpts);
  }
  try {
    const flooded = onboarding.buildPacket({
      ...input, scope: 'task', sessionId: 'flood-sess', threadId: 'flood-thread', treeAnchors: []
    }, dependencies);
    assert.ok(flooded.unknowns.some(entry => entry.code === 'owner-requests-trimmed'), 'the trim is announced in unknowns');
    const floodedSession = flooded.ownerRequests.layers.find(layer => layer.scope === 'session');
    const floodedThread = flooded.ownerRequests.layers.find(layer => layer.scope === 'thread');
    const floodedGlobal = flooded.ownerRequests.layers.find(layer => layer.scope === 'global');
    assert.equal(floodedSession.requests.length, 0, 'an over-cap session layer is withheld whole');
    assert.equal(floodedSession.withheld.count, 12, 'the withheld record counts every session entry');
    assert.equal(floodedThread.requests.length, 0, 'the thread layer is withheld before global loses anything it need not');
    assert.ok(floodedGlobal.requests.length >= 1, 'the global layer is the last to shed and never empties');
    assert.ok(floodedGlobal.requests[floodedGlobal.requests.length - 1].words.includes('GLOBAL-FLOOD 15'),
      'global sheds OLDEST first: the newest filed entry survives');
    assert.ok(floodedGlobal.withheld && floodedGlobal.withheld.count > 0, 'the shed global entries are recorded');
    const floodedText = onboarding.renderPacket(flooded);
    assert.ok(Buffer.byteLength(floodedText, 'utf8') <= 24 * 1024, 'a flooded ledger still renders inside the scope ceiling');
    const ownerBlockStart = floodedText.indexOf('## Owner requests');
    const ownerBlockEnd = floodedText.indexOf('\n## ', ownerBlockStart + '## Owner requests'.length);
    const floodedBlock = floodedText.slice(ownerBlockStart, ownerBlockEnd < 0 ? undefined : ownerBlockEnd);
    const floodedBlockBytes = Buffer.byteLength(floodedBlock, 'utf8');
    const floodedBlockCeiling = Math.floor(24 * 1024 * 0.4) + 400;
    assert.ok(floodedBlockBytes <= floodedBlockCeiling,
      `the rendered block stays inside its share of the ceiling (${floodedBlockBytes} <= ${floodedBlockCeiling})`);
    assert.ok(floodedBlock.includes('withheld for space'), 'the packet says out loud that entries were withheld');
    assert.ok(floodedBlock.includes(floodedSession.path), 'a withheld layer names the file where its entries still live');
    assert.ok(floodedBlock.includes('GLOBAL-FLOOD 15 FLOOD'), 'the newest global entry rides verbatim');
    assert.ok(!floodedBlock.includes('GLOBAL-FLOOD 1 FLOOD'), 'the oldest global entry is the one withheld');
    // The measured real-world shape: the smallest scope also survives a flood.
    const floodedMinimal = onboarding.buildPacket({
      ...input, scope: 'minimal', sessionId: 'flood-sess', threadId: 'flood-thread', treeAnchors: []
    }, dependencies);
    assert.ok(Buffer.byteLength(onboarding.renderPacket(floodedMinimal), 'utf8') <= 16 * 1024,
      'no count of filed requests can push any scope over its ceiling');
  } finally {
    fs.writeFileSync(ledgerPathBeforeFlood, ledgerBeforeFlood);
    fs.writeFileSync(historyPathBeforeFlood, historyBeforeFlood);
  }

  console.log(`agent onboarding passed (${Object.keys(onboarding.ROLE_DEFINITIONS).length} fixed roles, ${coverage.size} spawn classes, ${Buffer.byteLength(rendered, 'utf8')} rendered bytes).`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
