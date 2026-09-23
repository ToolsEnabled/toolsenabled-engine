'use strict';
/* Where an assistant's own assistants appear.
 *
 * The rule under test is the separation the module exists for: this row decides
 * tree-or-lane for a spawn that came through THIS product's tool, and it never
 * reads `agent.agent_api`, which decides something else entirely (whether the
 * assistant also keeps its own built-in `Task`). A test that had to stub the
 * API setting to get an answer here would be evidence the two had been welded
 * together again, so none of these do.
 *
 * The last test reads the shipped registry, so the option strings this module
 * branches on are the ones the person can actually pick. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SUBAGENT_ROUTE_SETTING_ID,
  ROUTE,
  CHOICE,
  CHOICES,
  DEFAULT_CHOICE,
  subagentRouteSetting,
  subagentRoute
} = require('../src/lib/agent-subagent-route');

const answer = (value, source) => () => ({
  values: value === undefined ? {} : { [SUBAGENT_ROUTE_SETTING_ID]: value },
  provenance: source === undefined ? {} : { [SUBAGENT_ROUTE_SETTING_ID]: { source, atMs: 1, directive: null } }
});

/* ------------------------------ the setting ------------------------------ */

test('the shipped answer leaves the choice to the assistant, and a value nobody chose cannot force one', () => {
  assert.equal(DEFAULT_CHOICE, CHOICE.ASSISTANT);

  const absent = subagentRouteSetting({ loadSettings: answer(undefined) });
  assert.equal(absent.choice, CHOICE.ASSISTANT);
  assert.equal(absent.chosen, false);
  assert.equal(absent.reason, 'not-declared');

  const unchosen = subagentRouteSetting({ loadSettings: answer(CHOICE.TREE, 'default') });
  assert.equal(unchosen.choice, CHOICE.ASSISTANT, 'a default cannot force every spawn onto the tree');
  assert.equal(unchosen.reason, 'not-chosen');

  for (const source of ['user', 'installer']) {
    const chosen = subagentRouteSetting({ loadSettings: answer(CHOICE.LANE, source) });
    assert.equal(chosen.choice, CHOICE.LANE, source);
    assert.equal(chosen.chosen, true);
    assert.equal(chosen.source, source);
  }
});

test('an unreadable or unrecognised setting leaves the shipped answer standing, and never throws', () => {
  const broken = subagentRouteSetting({ loadSettings: () => { throw new Error('disk gone'); } });
  assert.equal(broken.choice, CHOICE.ASSISTANT);
  assert.equal(broken.reason, 'settings-unreadable');
  assert.equal(broken.detail, 'disk gone');

  const odd = subagentRouteSetting({ loadSettings: answer('Sometimes', 'user') });
  assert.equal(odd.choice, CHOICE.ASSISTANT);
  assert.equal(odd.reason, 'not-recognised');

  assert.equal(subagentRouteSetting({ loadSettings: () => null }).choice, CHOICE.ASSISTANT);
});

/* ------------------------------ always on the tree ------------------------------ */

test('"Always on your tree" puts every spawn from a tree circle on the tree, whatever it asked for', () => {
  for (const requested of [ROUTE.TREE, null]) {
    const decision = subagentRoute({ choice: CHOICE.TREE, callerIsTreeCircle: true, requested });
    assert.equal(decision.ok, true, String(requested));
    assert.equal(decision.route, ROUTE.TREE);
    assert.equal(decision.choice, CHOICE.TREE);
  }
});

test('"Always on your tree" refuses a spawn that asked to stay off it, rather than quietly redirecting it', () => {
  const decision = subagentRoute({ choice: CHOICE.TREE, callerIsTreeCircle: true, requested: ROUTE.LANE });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'AGENT_SPAWN_LANE_ROUTE_CLOSED');
  assert.equal(decision.route, null);
});

test('"Always on your tree" refuses an assistant that is not itself on a tree, because there is nowhere to put the new one', () => {
  const decision = subagentRoute({ choice: CHOICE.TREE, callerIsTreeCircle: false });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT');
  assert.match(decision.reason, /not itself on a tree/);
});

/* ------------------------------ never on the tree ------------------------------ */

test('"Never on your tree" keeps every spawn off it, and says so when one asked to join', () => {
  for (const requested of [ROUTE.LANE, null]) {
    const decision = subagentRoute({ choice: CHOICE.LANE, callerIsTreeCircle: true, requested });
    assert.equal(decision.ok, true, String(requested));
    assert.equal(decision.route, ROUTE.LANE);
  }
  const refused = subagentRoute({ choice: CHOICE.LANE, callerIsTreeCircle: true, requested: ROUTE.TREE });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'AGENT_SPAWN_TREE_ROUTE_CLOSED');
});

/* ------------------------------ left to the assistant ------------------------------ */

test('left to the assistant, what it asked for wins', () => {
  const onTree = subagentRoute({ choice: CHOICE.ASSISTANT, callerIsTreeCircle: true, requested: ROUTE.TREE });
  assert.equal(onTree.route, ROUTE.TREE);
  assert.match(onTree.why, /asked for a place on your tree/);

  const offTree = subagentRoute({ choice: CHOICE.ASSISTANT, callerIsTreeCircle: true, requested: ROUTE.LANE });
  assert.equal(offTree.route, ROUTE.LANE);
  assert.match(offTree.why, /asked to stay off your tree/);
});

test('left to the assistant and asked nothing, a tree circle hands work to circles beside it and everything else runs on its own', () => {
  const fromCircle = subagentRoute({ choice: CHOICE.ASSISTANT, callerIsTreeCircle: true, requested: null });
  assert.equal(fromCircle.route, ROUTE.TREE);
  assert.match(fromCircle.why, /already on your tree/);

  const fromLane = subagentRoute({ choice: CHOICE.ASSISTANT, callerIsTreeCircle: false, requested: null });
  assert.equal(fromLane.route, ROUTE.LANE);
  assert.match(fromLane.why, /has no place to put a circle/);
});

test('an assistant that is not on a tree cannot ask its way onto one', () => {
  const decision = subagentRoute({ choice: CHOICE.ASSISTANT, callerIsTreeCircle: false, requested: ROUTE.TREE });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'AGENT_SPAWN_TREE_NOT_A_TREE_AGENT');
});

test('a spawn that asks for a route that is not one of the two is refused by name', () => {
  for (const requested of ['visible', 'classic', 'Task', 7, {}]) {
    const decision = subagentRoute({ requested, callerIsTreeCircle: true, choice: CHOICE.ASSISTANT });
    assert.equal(decision.ok, false, String(requested));
    assert.equal(decision.code, 'AGENT_SPAWN_ROUTE_UNKNOWN');
  }
});

/* ------------------------------ read together ------------------------------ */

test('the decision reads the real settings layer when the caller hands it no choice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-route-'));
  try {
    const valuesPath = path.join(dir, 'settings.json');
    const { loadSettings } = require('../src/lib/settings');
    const read = () => loadSettings({ valuesPath });

    fs.writeFileSync(valuesPath, JSON.stringify({ values: {}, provenance: {}, revision: 1 }));
    const shipped = subagentRoute({ loadSettings: read, callerIsTreeCircle: true });
    assert.equal(shipped.route, ROUTE.TREE, 'shipped: a tree circle\'s children join it');
    assert.equal(shipped.choice, CHOICE.ASSISTANT);

    fs.writeFileSync(valuesPath, JSON.stringify({
      values: { [SUBAGENT_ROUTE_SETTING_ID]: CHOICE.LANE },
      provenance: { [SUBAGENT_ROUTE_SETTING_ID]: { source: 'user', atMs: 1, directive: null } },
      revision: 2
    }));
    assert.equal(subagentRoute({ loadSettings: read, callerIsTreeCircle: true }).route, ROUTE.LANE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped registry declares the row with exactly these options, at depth 1, naming this module', () => {
  const { loadRegistry } = require('../src/lib/settings-registry');
  const entry = loadRegistry().byId.get(SUBAGENT_ROUTE_SETTING_ID);
  assert.ok(entry, `${SUBAGENT_ROUTE_SETTING_ID} is in config/settings-registry.json`);
  assert.equal(entry.control, 'seg');
  assert.deepEqual([...entry.options], [...CHOICES], 'the options the person picks are the choices this module branches on');
  assert.equal(entry.default, DEFAULT_CHOICE);
  assert.equal(entry.depth, 1, 'a sibling of the API row, not a child: turning the API off does not stop agent.spawn, so nesting would grey out a control that still decides something');
  assert.match(entry.enforcedBy, /src\/lib\/agent-subagent-route\.js/);
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings-registry.json'), 'utf8'));
  assert.equal(typeof registry.titles[SUBAGENT_ROUTE_SETTING_ID], 'string', 'the row has a plain name for the settings page');
});
