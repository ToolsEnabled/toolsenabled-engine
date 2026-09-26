'use strict';

/* AN OLD BUT WORKING CLAUDE CLI IS NEVER REFUSED; IT IS DESCRIBED. AND A
 * MISSING ONE IS TOLD, IN ONE SENTENCE, HOW TO BE INSTALLED.
 *
 * WHAT WAS WRONG. The tier rows name a model ALIAS (`opus`), the argv sends
 * that alias unchanged, and Claude Code resolves the word by ITS version:
 * 2.1.280 serves claude-opus-5-5 (Opus 5.5), 2.1.279 and older serve
 * claude-opus-5 -- silently. A person who chose the premium tier on an older
 * CLI got the older model and was told nothing, while the alternative (sending
 * a concrete id) would have made every older CLI fail outright. The dispatch
 * keeps sending the alias, so the old CLI keeps working, and now the receipt
 * plus an audit event beside the launch say which model the person is getting
 * and what would change it.
 *
 * Also pinned here: the not-installed refusal ends with the product's ONE
 * install sentence (claude-cli-install.js installGuidance) -- official
 * installer for this platform, npm second with its Node 22 note, a NEW
 * terminal window, then `claude auth login` -- and never sends anyone to
 * WinGet, whose feed trails the official channel by releases.
 *
 * SHAPE. Modelled on tests/mission-bridge-no-paid-provider-switch.test.js:
 * every provider seam is injected, so the machine running this suite needs no
 * Claude Code and no ledger. Each scenario dispatches ONCE into its own root:
 * the lane runner takes the presence state lock per root, and a suite run
 * with deletions neutralised cannot release it for a second dispatch.
 *
 * NON-DELETING. Fixture roots are created under the isolated test root when
 * one is configured (otherwise the OS temp directory), retained, and their
 * paths printed at the end. There is no teardown that removes anything.
 *
 *   node tests/run-isolated.js tests/mission-bridge-claude-cli-advisory.test.js
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CLAUDE_CLI_ADVISORY_ACTION,
  TIERS,
  createMissionActions,
  detectClaudeCliPresence
} = require('../src/lib/mission-bridge/actions');
const { installGuidance } = require('../src/lib/agent-engine/claude-cli-install');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');

const OLD_CLI = '2.1.278 (Claude Code)';
const CURRENT_CLI = '2.1.280 (Claude Code)';
const OLD_ADVISORY = 'Claude Code 2.1.278 serves the opus alias as Opus 5 (claude-opus-5); 2.1.280 or newer serves Opus 5.5 (claude-opus-5-5). Update Claude Code to get it.';

const retainedRoots = [];
let serial = 0;

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const event = { sequence: events.length + 1, action, target, details, ...extra };
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

/* One root per scenario, retained. Deterministic names under the configured
   isolated root so a reader of the run can find each one. */
function retainedRoot(label) {
  serial += 1;
  const base = process.env.TOOLSENABLED_TEST_ROOT || os.tmpdir();
  const root = path.join(base, `claude-cli-advisory-${process.pid}-${serial}-${label}`);
  fs.mkdirSync(root, { recursive: true });
  retainedRoots.push(root);
  return root;
}

/* THE AUDIT SETTING IS PART OF THE FIXTURE NOW.
 *
 * capturePolicy reads it through options.loadSettings, and the default is Basic
 * (operation-audit.js: "A readable default/false setting is Basic"). Cases that
 * assert a LEDGER event have to say they are running under Full, because in
 * Basic the launch writes no controller.agent.launch event at all and the
 * advisory that is keyed to it must not be written either. */
const FULL_AUDIT_SETTINGS = Object.freeze({
  values: { 'audit.enabled': true, 'audit.activity': 'Full' },
  provenance: { 'audit.enabled': { source: 'user' }, 'audit.activity': { source: 'user' } },
  rejected: []
});

function fixture(label, { claudeCliVersion, claudeCliPresent = () => true, auditSettings = null } = {}) {
  const root = retainedRoot(label);
  const org = declaredOrg();
  const audit = auditFixture();
  const lanes = [];
  const probes = [];
  const actions = createMissionActions({
    roots: { isolated: root },
    ...(auditSettings ? { loadSettings: () => auditSettings } : {}),
    actor: enabledControllerId(org),
    agentOrg: org,
    audit,
    policy: { assertActive() {} },
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    env: { PATH: process.env.PATH },
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    claudeCliPresent,
    claudeCliVersion: async environment => {
      probes.push(environment);
      if (typeof claudeCliVersion === 'function') return claudeCliVersion();
      return claudeCliVersion;
    },
    ensureMcpConfig: () => ({ file: null, generated: false }),
    claudeArgs: () => ['--claude-cli-advisory-fixture'],
    laneDependencies: {
      stateFile: path.join(root, 'isolated-state', 'agent-presence.json'),
      mailboxDir: path.join(root, 'isolated-state', 'mailbox'),
      launchDir: path.join(root, 'isolated-state', 'launch'),
      buildOnboardingPacket: () => 'ONBOARDING PACKET STUB (test).\n'
    },
    spawn() { throw new Error('this fixture must never spawn a provider'); },
    async runLane(options) {
      lanes.push(options);
      const runId = crypto.randomUUID();
      return {
        runId,
        taskId: 'claude-cli-advisory-task',
        terminal: {
          agentId: options.agentId, runId, currentTask: 'claude-cli-advisory-task',
          status: 'finished', exitCode: 0, lastVerdict: 'VERDICT: injected terminal; no provider was contacted'
        }
      };
    }
  });
  return { root, actions, audit, lanes, probes };
}

function dispatchInput(objectiveRef) {
  return {
    rootId: 'isolated',
    tier: 'claude-opus',
    objectiveRef,
    brief: 'Bounded fixture dispatch for the Claude CLI advisory.',
    cap: { kind: 'turns', value: 1, capMs: 60_000 }
  };
}

test('the premium Claude tier sends the opus alias, which is what makes the advisory necessary', () => {
  assert.equal(TIERS['claude-opus'].cliModel, 'opus');
  assert.equal(TIERS['claude-opus'].kind, 'claude');
});

test('an older CLI still dispatches, and the receipt plus an audit event say which model it serves', async () => {
  // Under Full: this case asserts the advisory reaches the LEDGER, which only
  // happens when the launch record it is keyed to reaches the ledger too.
  const f = fixture('old-cli', { claudeCliVersion: OLD_CLI, auditSettings: FULL_AUDIT_SETTINGS });
  const result = await f.actions.dispatch(dispatchInput('claude-cli-advisory-old'));
  assert.equal(result.ok, true);
  assert.equal(result.receipt.kind, 'claude', 'the lane was dispatched, not refused');
  assert.equal(f.lanes.length, 1, 'the lane ran');
  assert.equal(f.probes.length, 1, 'the version is probed exactly once per dispatch');
  assert.equal(typeof f.probes[0].PATH, 'string', 'the probe runs in the dispatch environment the lane will start with');
  assert.deepEqual(result.receipt.claudeCli, {
    version: OLD_CLI,
    requestedModel: 'opus',
    expectedModel: 'claude-opus-5',
    advisory: OLD_ADVISORY
  });
  assert.ok(Object.isFrozen(result.receipt.claudeCli));
  const advisories = f.audit.events.filter(event => event.action === CLAUDE_CLI_ADVISORY_ACTION);
  assert.equal(advisories.length, 1, 'exactly one advisory event is recorded');
  assert.equal(advisories[0].target, result.receipt.launchId, 'the advisory is keyed on the launch it describes');
  assert.deepEqual(advisories[0].details, {
    kind: 'claude-cli-model', version: OLD_CLI, requestedModel: 'opus', expectedModel: 'claude-opus-5', advisory: OLD_ADVISORY
  });
  const launchIndex = f.audit.events.findIndex(event => event.action === 'controller.agent.launch');
  assert.ok(launchIndex >= 0 && launchIndex < f.audit.events.indexOf(advisories[0]), 'the advisory follows the launch record it belongs to');
  assert.equal(f.lanes[0].childArgs.includes('--claude-cli-advisory-fixture'), true, 'the argv is the tier argv, untouched by the advisory');
});

test('a current CLI gets the newest model, no advisory sentence and no advisory event', async () => {
  const f = fixture('current-cli', { claudeCliVersion: CURRENT_CLI });
  const result = await f.actions.dispatch(dispatchInput('claude-cli-advisory-current'));
  assert.equal(result.receipt.kind, 'claude');
  assert.deepEqual(result.receipt.claudeCli, {
    version: CURRENT_CLI,
    requestedModel: 'opus',
    expectedModel: 'claude-opus-5-5',
    advisory: null
  });
  assert.equal(f.audit.events.filter(event => event.action === CLAUDE_CLI_ADVISORY_ACTION).length, 0);
});

test('a version that cannot be read is null, guesses nothing, and never refuses the dispatch', async () => {
  const f = fixture('unreadable-version', { claudeCliVersion: () => { throw new Error('probe exploded'); } });
  const result = await f.actions.dispatch(dispatchInput('claude-cli-advisory-unreadable'));
  assert.equal(result.receipt.kind, 'claude', 'a failed probe is not a refusal');
  assert.deepEqual(result.receipt.claudeCli, { version: null, requestedModel: 'opus', expectedModel: null, advisory: null });
  assert.equal(f.audit.events.filter(event => event.action === CLAUDE_CLI_ADVISORY_ACTION).length, 0);
  const g = fixture('null-version', { claudeCliVersion: null });
  const nothing = await g.actions.dispatch(dispatchInput('claude-cli-advisory-null'));
  assert.deepEqual(nothing.receipt.claudeCli, { version: null, requestedModel: 'opus', expectedModel: null, advisory: null });
});

test('a machine without Claude Code is refused with the product\'s one install sentence, before any probe or record', async () => {
  const f = fixture('absent-cli', { claudeCliVersion: CURRENT_CLI, claudeCliPresent: () => false });
  let refusal = null;
  try { await f.actions.dispatch(dispatchInput('claude-cli-advisory-absent')); } catch (error) { refusal = error; }
  assert.ok(refusal, 'the dispatch was refused');
  assert.equal(refusal.code, 'BRIDGE_CLAUDE_CLI_NOT_INSTALLED');
  assert.equal(refusal.status, 503);
  assert.ok(refusal.message.endsWith(installGuidance({ platform: process.platform })), 'the refusal ends with the shared install sentence, word for word');
  assert.ok(refusal.message.includes(process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash'),
    'the official installer for this platform is named');
  assert.ok(refusal.message.includes('npm install -g @anthropic-ai/claude-code') && refusal.message.includes('Node 22'));
  assert.ok(refusal.message.includes('NEW terminal window') && refusal.message.includes('claude auth login'));
  assert.ok(!/winget/i.test(refusal.message), 'WinGet is never recommended for a fresh install');
  assert.ok(!refusal.message.includes('claude login'), 'the old sign-in verb is gone');
  assert.deepEqual(f.probes, [], 'no version probe runs for a CLI that is not there');
  assert.deepEqual(f.lanes, [], 'no lane ran');
  assert.deepEqual(f.audit.events, [], 'no launch record was written');
});

test('presence that could not be established is refused as unknown, not as absent, and never probed', async () => {
  const f = fixture('unknown-cli', { claudeCliVersion: CURRENT_CLI, claudeCliPresent: () => null });
  await assert.rejects(() => f.actions.dispatch(dispatchInput('claude-cli-advisory-unknown')),
    error => error?.code === 'BRIDGE_CLAUDE_CLI_PRESENCE_UNKNOWN' && error?.status === 503);
  assert.deepEqual(f.probes, []);
  assert.deepEqual(f.audit.events, []);
});

test('the presence check walks the shared candidate list three-valued and never touches a relative PATH entry', () => {
  const absolute = path.join(os.tmpdir(), 'claude-presence-fixture');
  const environment = { PATH: [path.join(absolute, 'first'), path.join(absolute, 'second'), 'relative'].join(path.delimiter) };
  const seen = [];
  const statSync = outcome => candidate => {
    seen.push(candidate);
    const code = outcome(candidate);
    if (code === null) return { isFile: () => true };
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(detectClaudeCliPresence(environment, { statSync: statSync(() => 'ENOENT') }), false, 'ENOENT everywhere is a proven absence');
  assert.equal(detectClaudeCliPresence(environment, { statSync: statSync(candidate => (candidate.includes('first') ? 'EACCES' : 'ENOENT')) }), null,
    'an unreadable candidate keeps the answer unknown');
  assert.equal(detectClaudeCliPresence(environment, { statSync: statSync(candidate => (candidate.includes('second') ? null : 'EACCES')) }), true,
    'a later present candidate proves presence past an unreadable one');
  assert.ok(seen.every(candidate => path.isAbsolute(candidate)), 'every inspected candidate is absolute');
  assert.ok(seen.some(candidate => candidate.startsWith(path.join(absolute, 'first'))), 'PATH directories are inspected');
  assert.equal(detectClaudeCliPresence({}, { statSync: statSync(() => 'ENOENT') }), null, 'no PATH at all is not a search a shell would recognise');
  assert.equal(detectClaudeCliPresence(environment, { statSync() { throw new TypeError('not an error code'); } }), null, 'a failure without a code is unknown');
});

test.after(() => {
  process.stdout.write(`retained fixture roots (not removed):\n${retainedRoots.map(root => `  ${root}`).join('\n')}\n`);
});

/* IN BASIC, THE DEFAULT, NOTHING IS WRITTEN TO THE LEDGER -- AND THE PERSON IS
 * STILL TOLD.
 *
 * recordLaunch returns early on !auditPolicy.required and saves the launch
 * operationally, writing no controller.agent.launch event. The advisory is keyed
 * on that launch id, and was written anyway: the ledger got an advisory pointing
 * at a launch it does not hold, while the owner's audit setting was off. The
 * dangling key is the smaller half; the larger is that a setting the product
 * overrides for some events is not a setting.
 *
 * The advisory itself is not suppressed -- only its durable ledger write. The
 * receipt still carries it, because what the person is told does not depend on
 * whether they asked for an audit trail. */
test('in Basic the advisory reaches the receipt but never the ledger', async () => {
  const f = fixture('old-cli-basic', { claudeCliVersion: OLD_CLI });
  const result = await f.actions.dispatch(dispatchInput('claude-cli-advisory-basic'));
  assert.equal(result.ok, true, 'Basic must not refuse the dispatch');
  assert.equal(result.receipt.kind, 'claude');
  assert.equal(typeof result.receipt.claudeCli.advisory, 'string',
    'the person must still be told which model an old CLI serves');
  assert.ok(result.receipt.claudeCli.advisory.length > 0);

  assert.equal(f.audit.events.filter(event => event.action === CLAUDE_CLI_ADVISORY_ACTION).length, 0,
    'Basic wrote an advisory into the ledger while the owner had auditing off');
  assert.equal(f.audit.events.filter(event => event.action === 'controller.agent.launch').length, 0,
    'the control: Basic writes no launch record either, which is why the advisory has nothing to be keyed to');
});
