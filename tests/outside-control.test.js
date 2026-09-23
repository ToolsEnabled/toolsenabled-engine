'use strict';
/* The one reader of `app.outside_control`, and the registry row it reads.
 *
 * The rule under test is the provenance rule: a port opens only for an explicit
 * true that somebody chose. Every other shape -- off, a string "true", a true
 * nobody chose, no row, an unreadable settings layer -- is a closed port with
 * its reason named, and none of them throws. The last two tests read the real
 * registry and the real settings loader against a temporary settings file, so
 * the row this module names is the row the product ships. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SETTING_ID,
  DEFAULT_PORT,
  ADDRESS,
  outsideControlPolicy,
} = require('../src/lib/outside-control');

const answer = (value, source) => () => ({
  values: { [SETTING_ID]: value },
  provenance: source === undefined ? {} : { [SETTING_ID]: { source, atMs: 1, directive: null } },
});

test('shipped off: false with default provenance keeps the port closed', () => {
  const decision = outsideControlPolicy({ loadSettings: answer(false, 'default') });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'off');
  assert.equal(decision.port, DEFAULT_PORT, 'the port is named even while closed, so the shell can say which one stays shut');
  assert.equal(decision.address, ADDRESS);
});

test('true that nobody chose is not on', () => {
  const decision = outsideControlPolicy({ loadSettings: answer(true, 'default') });
  assert.equal(decision.enabled, false);
  assert.equal(decision.reason, 'not-chosen');
  assert.equal(decision.source, 'default');
  const unstamped = outsideControlPolicy({ loadSettings: answer(true) });
  assert.equal(unstamped.enabled, false, 'no provenance record reads as default');
  assert.equal(unstamped.reason, 'not-chosen');
});

test('true chosen by the person, or by the installer, opens the loopback port', () => {
  for (const source of ['user', 'installer']) {
    const decision = outsideControlPolicy({ loadSettings: answer(true, source) });
    assert.equal(decision.enabled, true, source);
    assert.equal(decision.reason, 'chosen');
    assert.equal(decision.source, source);
    assert.equal(decision.port, 9223);
    assert.equal(decision.address, '127.0.0.1', 'never a routable address');
    assert.ok(Object.isFrozen(decision));
  }
});

test('only the boolean true counts', () => {
  for (const value of ['true', 1, 'on', {}, null, undefined]) {
    const decision = outsideControlPolicy({ loadSettings: answer(value, 'user') });
    assert.equal(decision.enabled, false, JSON.stringify(value));
    assert.equal(decision.reason, 'off');
  }
});

test('no row, and an unreadable settings layer, are closed ports with the reason named -- never a throw', () => {
  const noRow = outsideControlPolicy({ loadSettings: () => ({ values: {}, provenance: {} }) });
  assert.equal(noRow.enabled, false);
  assert.equal(noRow.reason, 'not-declared');
  const broken = outsideControlPolicy({ loadSettings: () => { throw new Error('disk gone'); } });
  assert.equal(broken.enabled, false);
  assert.equal(broken.reason, 'settings-unreadable');
  assert.equal(broken.detail, 'disk gone');
  const nothing = outsideControlPolicy({ loadSettings: () => null });
  assert.equal(nothing.enabled, false);
  assert.equal(nothing.reason, 'not-declared');
});

test('the shipped registry declares the row: a toggle, off, in the agent section, naming this module as its enforcer', () => {
  const { loadRegistry } = require('../src/lib/settings-registry');
  const entry = loadRegistry().byId.get(SETTING_ID);
  assert.ok(entry, `${SETTING_ID} is in config/settings-registry.json`);
  assert.equal(entry.control, 'toggle');
  assert.equal(entry.default, false, 'a public copy ships with the port closed');
  assert.match(entry.enforcedBy, /src\/lib\/outside-control\.js/);
  assert.match(entry.consequence, /next time the app starts/i, 'the row says the port opens at a start, not while running');
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'settings-registry.json'), 'utf8'));
  assert.equal(typeof registry.titles[SETTING_ID], 'string', 'the row has a plain name for the settings page');
});

test('the real settings loader: the row reads off with default provenance, and on only from a file the person wrote', () => {
  const { loadSettings } = require('../src/lib/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-control-'));
  try {
    const valuesPath = path.join(dir, 'settings.json');
    const read = () => loadSettings({ valuesPath });
    const shipped = outsideControlPolicy({ loadSettings: read });
    assert.equal(shipped.enabled, false);
    assert.equal(shipped.reason, 'off');

    fs.writeFileSync(valuesPath, JSON.stringify({
      values: { [SETTING_ID]: true },
      provenance: { [SETTING_ID]: { source: 'user', atMs: 1, directive: null } },
      revision: 1,
    }));
    const chosen = outsideControlPolicy({ loadSettings: read });
    assert.equal(chosen.enabled, true, 'a true the person wrote opens it');
    assert.equal(chosen.source, 'user');

    fs.writeFileSync(valuesPath, JSON.stringify({
      values: { [SETTING_ID]: true },
      provenance: { [SETTING_ID]: { source: 'default', atMs: 1, directive: null } },
      revision: 2,
    }));
    const unchosen = outsideControlPolicy({ loadSettings: read });
    assert.equal(unchosen.enabled, false, 'a true stamped default is not a choice');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
