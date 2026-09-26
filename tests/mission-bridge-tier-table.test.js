'use strict';

/* THE DISPATCH TIER TABLE AFTER THE 1.0.48 PROVIDER-THEN-MODEL PICKER.
 *
 * Product requirement: users can select every model a provider offers,
 * Opus 5 and Sonnet 5 included. Until this table named them, Opus 5
 * could not be reached at all and Sonnet 5 only through the moving `sonnet`
 * alias. The ten pinned Claude rows below are transcribed from the model
 * catalog Claude Code served this machine on 2026-09-25
 * (Claude Code's local model-catalog cache): the id, and whether
 * the model takes an effort at all.
 *
 * Four copies of this vocabulary exist and nothing ties them together except
 * tests: the TIERS rows, the agent.spawn tier enum and its two descriptions,
 * the shipped org's seats, and the usage-window model family. Each check below
 * calls the real function with the real row, so a row that one copy knows and
 * another does not fails here by name.
 *
 * WHY THE NEW CODEX MODELS ARE NOT HERE. gpt-6-sol and gpt-6-luna would need a
 * seat each. A saved organisation overlay (src/lib/agent-org-store.js read())
 * is a snapshot of the baseline taken at its first write, and it never adopts
 * a seat a later baseline adds; ensureSeat writes that overlay the first time
 * any tree agent starts. So on every existing installation a new Codex seat
 * would be missing and dispatch would refuse the row with
 * BRIDGE_AGENT_DECLARATION_MISSING. They stay tree-only rows in the
 * application for 1.0.48, and the Codex rows here stay exactly four. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-bridge-tier-table-'));
require('./lib/isolated-environment').configure(testRoot);
require('./lib/agent-api-mode-fixture').selectAgentApiMode('Enabled');

const actions = require('../src/lib/mission-bridge/actions');
const agentOrg = require('../src/lib/agent-org');
const registry = require('../src/lib/tool-registry');
const { claudeWindows } = require('../src/lib/multi-account/usage-windows');
const claudeInstall = require('../src/lib/agent-engine/claude-cli-install');

/* The whole table, in the order agent.spawn describes it. Written out rather
   than read from TIERS, because an expected value the subject computed would
   pass against any drift. */
const CODEX_IDS = Object.freeze(['astra', 'luna', 'terra', 'sol']);
const ALIAS_CLAUDE_IDS = Object.freeze(['claude-fable', 'claude-sonnet', 'claude-opus']);
const PINNED_CLAUDE = Object.freeze([
  ['claude-opus-5-5', 'premium'],
  ['claude-opus-5', 'premium'],
  ['claude-sonnet-5', 'standard'],
  ['claude-fable-5-1', 'cheap'],
  ['claude-fable-5', 'cheap'],
  ['claude-haiku-4-5', 'cheap'],
  ['claude-opus-4-8', 'premium'],
  ['claude-opus-4-7', 'premium'],
  ['claude-opus-4-6', 'premium'],
  ['claude-sonnet-4-6', 'standard']
]);
const PINNED_CLAUDE_IDS = Object.freeze(PINNED_CLAUDE.map(([id]) => id));
const EXPECTED_IDS = Object.freeze([...CODEX_IDS, ...ALIAS_CLAUDE_IDS, ...PINNED_CLAUDE_IDS, 'local']);
const CLASSES = Object.freeze(['cheap', 'standard', 'premium']);
const FULL_SESSION = Object.freeze({ origin: 'local', tier: 'full' });
/* No seat is busy and no Claude seat has an account registry to consult, so a
   refusal below can only mean the declaration itself is wrong. */
const FREE_SEATS = Object.freeze({ readRegistry: () => ({ agents: {} }), claudeSeatAccount: () => null });

function shippedOrg() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  return agentOrg.normalizeOrg(raw);
}

function refusalCode(run) {
  try { run(); } catch (error) { return error && error.code; }
  return null;
}

test('agent.spawn offers exactly the dispatch tiers, in table order, with the pinned Claude models after claude-opus', () => {
  assert.deepEqual(Object.keys(actions.TIERS), EXPECTED_IDS,
    'the dispatch table is not the 1.0.48 table: codex four, the three Claude aliases, the ten pinned Claude models, local');
  const tier = registry.getTool('agent.spawn').inputSchema.properties.tier;
  assert.deepEqual(tier.enum, Object.keys(actions.TIERS),
    'agent.spawn accepts a different tier list from the one dispatch declares');
  assert.ok(tier.description.includes(`Claude: ${[...ALIAS_CLAUDE_IDS, ...PINNED_CLAUDE_IDS].join(', ')}.`),
    'the tier help does not list every Claude tier, aliases first, in table order');
});

test('every row names a dispatch class agent-org accepts, and the pinned Claude rows carry their own class', () => {
  for (const id of EXPECTED_IDS) {
    const row = actions.TIERS[id];
    assert.ok(row, `tier ${id} is not declared`);
    assert.ok(CLASSES.includes(row.tier), `tier ${id} has class ${row.tier}, not cheap, standard or premium`);
  }
  for (const [id, expected] of PINNED_CLAUDE) {
    assert.equal(actions.TIERS[id].tier, expected, `tier ${id} class`);
  }
});

test('every Codex row carries an explicit effort, so the Codex argv never says model_reasoning_effort=undefined', () => {
  const codexRows = Object.entries(actions.TIERS).filter(([, row]) => row.kind === 'codex');
  assert.deepEqual(codexRows.map(([id]) => id), CODEX_IDS,
    'a Codex row was added or removed; a new one needs a seat every saved org overlay already holds');
  for (const [id, row] of codexRows) {
    assert.equal(typeof row.effort, 'string', `tier ${id} has no effort`);
    const argv = actions.codexArgs({ root: testRoot, tier: row, permissionSession: FULL_SESSION });
    assert.ok(argv.includes(`model_reasoning_effort=${row.effort}`), `tier ${id}: ${argv.join(' ')}`);
    assert.ok(!argv.some(entry => String(entry).includes('undefined')), `tier ${id} argv carries "undefined"`);
  }
  /* Control: the hazard is real. A Codex row without an effort does reach the
     argv as the word "undefined", which is why the check above exists. */
  const { effort, ...effortless } = actions.TIERS.sol;
  assert.ok(effort);
  const broken = actions.codexArgs({ root: testRoot, tier: effortless, permissionSession: FULL_SESSION });
  assert.ok(broken.includes('model_reasoning_effort=undefined'));
});

/* THE DEPTHS EACH CODEX ROW TAKES, written out from ~/.codex/models_cache.json
   (codex-cli 0.156.0, 2026-09-25) rather than read from the table: every model
   lists low..ultra except gpt-5.6-luna, which has no ultra, and none lists
   `none` or `minimal`. The application offers exactly these (app
   src/orchestration-controls.js), so a spawn the engine accepts is one the
   application starts at the depth it was told. */
const CODEX_DEPTHS = Object.freeze({
  astra: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  luna: ['low', 'medium', 'high', 'xhigh', 'max'],
  terra: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  sol: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
});

test('each Codex row is held to the depths its model lists, and no Codex row takes none or minimal', () => {
  for (const id of CODEX_IDS) {
    const accepted = [];
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      let applied = null;
      try { applied = registry.resolveTreeModelChoice({ tier: id, effort }).effort; } catch (error) {
        assert.equal(error.code, 'AGENT_SPAWN_EFFORT_REFUSED', `${id}/${effort}`);
      }
      if (applied !== null) {
        assert.equal(applied, effort, `${id}/${effort}: a Codex depth runs as named`);
        accepted.push(effort);
      }
    }
    assert.deepEqual(accepted, CODEX_DEPTHS[id], `tier ${id} accepts a different set from its catalog entry`);
    assert.ok(accepted.includes(actions.TIERS[id].effort), `tier ${id}'s own default is one of its depths`);
  }
});

test('every seat a tier draws on is declared in the shipped org for its provider, and dispatch allocates one', () => {
  const org = shippedOrg();
  for (const id of EXPECTED_IDS) {
    const row = actions.TIERS[id];
    assert.ok(row, `tier ${id} is not declared`);
    for (const seat of row.seats) {
      const declared = org.agents.find(agent => agent.id === seat);
      assert.ok(declared, `tier ${id} draws on seat ${seat}, which the shipped org does not declare`);
      assert.equal(declared.provider, row.provider, `seat ${seat} is declared for ${declared.provider}, tier ${id} runs ${row.provider}`);
    }
    const lane = actions.declaredLane(org, id, FREE_SEATS);
    assert.ok(row.seats.includes(lane.targetAgentId), `tier ${id} was given seat ${lane.targetAgentId}`);
    assert.equal(lane.model, row.model);
    assert.equal(lane.cliModel, row.cliModel);
  }
});

test('a pinned Claude row hands the CLI its own model id and no effort', () => {
  const opus5 = actions.claudeArgs({ root: testRoot, tier: actions.TIERS['claude-opus-5'], permissionSession: FULL_SESSION });
  const at = opus5.indexOf('--model');
  assert.ok(at >= 0, opus5.join(' '));
  assert.equal(opus5[at + 1], 'claude-opus-5');
  assert.ok(!opus5.includes('--effort'), 'the lane passes no effort; the model default applies');
  for (const id of PINNED_CLAUDE_IDS) {
    const row = actions.TIERS[id];
    assert.equal(row.kind, 'claude', id);
    assert.equal(row.provider, 'claude', id);
    assert.equal(row.model, `claude/${id}`, id);
    assert.equal(row.cliModel, id, id);
    assert.equal(Object.hasOwn(row, 'effort'), false, `${id} must not carry a default effort: the Claude lane passes none`);
    const argv = actions.claudeArgs({ root: testRoot, tier: row, permissionSession: FULL_SESSION });
    assert.equal(argv[argv.indexOf('--model') + 1], id, id);
  }
  /* The alias rows keep their aliases (tests elsewhere pin claude-opus to opus). */
  assert.equal(actions.TIERS['claude-opus'].cliModel, 'opus');
});

test('every pinned Claude model has a display name, and the one the catalog gates on a newer CLI says which', () => {
  for (const id of PINNED_CLAUDE_IDS) {
    assert.equal(typeof claudeInstall.MODEL_DISPLAY_NAMES[id], 'string', `${id} has no display name`);
  }
  for (const model of Object.keys(claudeInstall.MIN_CLI_VERSION_BY_MODEL)) {
    assert.ok(PINNED_CLAUDE_IDS.includes(model), `${model} has a minimum CLI version but no pinned row`);
  }
  assert.equal(claudeInstall.MIN_CLI_VERSION_BY_MODEL['claude-fable-5-1'], '2.1.251');
});

test('the weekly limit of each Claude row\'s own model family applies to that row', () => {
  /* The shared weekly entry is the ACTIVE one and the lowest. A row whose
     model family cannot be read falls back to the active entry and so reads
     10%, which is how a pinned row used to slip past an Opus-only or
     Sonnet-only weekly ceiling. */
  const reading = {
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 10, isActive: true, model: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 91, isActive: false, model: 'Opus' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 72, isActive: false, model: 'Sonnet' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 55, isActive: false, model: 'Fable' },
      { kind: 'weekly_scoped', group: 'weekly', percent: 33, isActive: false, model: 'Haiku' }
    ]
  };
  const expected = { opus: 91, sonnet: 72, fable: 55, haiku: 33 };
  const claudeRows = Object.entries(actions.TIERS).filter(([, row]) => row.kind === 'claude');
  assert.deepEqual(claudeRows.map(([id]) => id), [...ALIAS_CLAUDE_IDS, ...PINNED_CLAUDE_IDS]);
  for (const [id, row] of claudeRows) {
    const family = /(opus|sonnet|fable|haiku)/.exec(id)[1];
    for (const model of [row.model, row.cliModel]) {
      assert.equal(claudeWindows(reading, { model }).weekly.usedPercent, expected[family],
        `tier ${id} (${model}) is not held to the ${family} weekly limit`);
    }
  }
});

test('a tier name that is only an Object prototype key is refused as unknown, never a TypeError', () => {
  const org = shippedOrg();
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(refusalCode(() => actions.declaredLane(org, name, FREE_SEATS)), 'BRIDGE_TIER_REFUSED', name);
  }
});

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
