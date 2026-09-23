'use strict';
// WHO ADDS STANDING RULES (owner, 2026-09-15): "the settings needs to include
// settings for either manually on the ledger page only, or ledger page and
// /request, or agent and such like now", and "agents shouldnt ask if its
// disabled either".
//
// One three-way choice, rules.filing_from, over every door into the rules
// ledger. The switch every reader was built on, rules.capture_spoken, stays in
// the catalogue and is kept in step by src/lib/settings.js: a chosen choice
// sets the switch, and an install that only ever saw the switch reads its
// choice off it. The gate answers from the choice when the person made one,
// tells an agent whether the typed /Request commands exist at all, and in
// every non-agent choice tells it neither to file, propose nor ask.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('./helpers/isolated-state-root');
const { loadSettings } = require('../src/lib/settings');
const { loadRegistry } = require('../src/lib/settings-registry');
const gate = require('../src/lib/r-ledger-agent-gate');

const CHOICE = 'rules.filing_from';
const SWITCH = 'rules.capture_spoken';
const user = { source: 'user', atMs: 1, directive: null };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-filing-from-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  return { dir, file, write: (values, provenance) => fs.writeFileSync(file, JSON.stringify({ revision: 1, values, provenance })) };
}

test('the catalogue carries the three-way choice beside the switch, shipped at the switch\'s old off meaning', () => {
  const registry = loadRegistry();
  const choice = registry.byId.get(CHOICE);
  assert.ok(choice, 'rules.filing_from is in the catalogue');
  assert.equal(choice.control, 'seg');
  assert.deepEqual(choice.options, ['Ledger page only', 'Ledger page and /Request', 'Agents too']);
  assert.equal(choice.default, 'Ledger page and /Request');
  assert.equal(choice.section, registry.byId.get(SWITCH).section);
  assert.equal(choice.depth, registry.byId.get(SWITCH).depth);
  assert.match(choice.enforcedBy, /src\/lib\/r-ledger-agent-gate\.js/);
  assert.match(choice.enforcedBy, /shell\/agent-host\.cjs/);
  assert.deepEqual(gate.FILING_FROM, { PAGE: 'Ledger page only', PAGE_AND_CHAT: 'Ledger page and /Request', AGENTS: 'Agents too' });
  assert.equal(gate.FILING_FROM_SETTING_ID, CHOICE);
});

test('an install that only ever chose the switch reads its choice off it, both ways', (t) => {
  const { file, write } = scratch(t);
  write({ [SWITCH]: true }, { [SWITCH]: user });
  let loaded = loadSettings({ valuesPath: file });
  assert.equal(loaded.values[CHOICE], 'Agents too');
  assert.equal(loaded.provenance[CHOICE].source, 'user');
  assert.equal(loaded.provenance[CHOICE].migratedFrom, SWITCH);
  assert.equal(loaded.values[SWITCH], true, 'the switch itself is untouched');
  let decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'auto');
  assert.equal(decision.chatFiling, true);
  assert.equal(decision.filingFrom, 'Agents too');

  write({ [SWITCH]: false }, { [SWITCH]: user });
  loaded = loadSettings({ valuesPath: file });
  assert.equal(loaded.values[CHOICE], 'Ledger page and /Request', 'off on the switch was "only you file rules, by typing /Request"');
  decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'off');
  assert.equal(decision.chatFiling, true);
});

test('a chosen three-way answer sets the switch, whatever the switch said before', (t) => {
  const { file, write } = scratch(t);
  write({ [CHOICE]: 'Ledger page only', [SWITCH]: true }, { [CHOICE]: user, [SWITCH]: user });
  let loaded = loadSettings({ valuesPath: file });
  assert.equal(loaded.values[SWITCH], false);
  assert.equal(loaded.provenance[SWITCH].migratedFrom, CHOICE);
  assert.equal(loaded.provenance[SWITCH].source, 'user', 'the derived switch carries a real choice\'s provenance so the gate reads it as chosen');
  let decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'off');
  assert.equal(decision.settingId, CHOICE, 'the decision names the row the person actually chose');
  assert.equal(decision.chatFiling, false, 'Ledger page only turns the typed commands off');
  assert.match(decision.why, /Ledger page only/);

  write({ [CHOICE]: 'Ledger page and /Request', [SWITCH]: true }, { [CHOICE]: user, [SWITCH]: user });
  decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'off');
  assert.equal(decision.chatFiling, true);

  write({ [CHOICE]: 'Agents too', [SWITCH]: false }, { [CHOICE]: user, [SWITCH]: user });
  loaded = loadSettings({ valuesPath: file });
  assert.equal(loaded.values[SWITCH], true);
  decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'auto');
  assert.equal(decision.state, 'enabled');
  assert.equal(decision.chatFiling, true);
});

test('nobody\'s choice decides nothing: a shipped default leaves agents off and the typed commands on', (t) => {
  const { file, write } = scratch(t);
  write({}, {});
  const loaded = loadSettings({ valuesPath: file });
  assert.equal(loaded.values[CHOICE], 'Ledger page and /Request');
  assert.equal(loaded.provenance[CHOICE].source, 'default');
  const decision = gate.loadAgentFilingMode({ valuesPath: file });
  assert.equal(decision.mode, 'off');
  assert.equal(decision.chatFiling, true);
  assert.equal(decision.filingFrom, 'Ledger page and /Request');
  // A raw document handed in with the two rows disagreeing answers from the
  // chosen row, not from the older switch.
  const raw = { values: { [SWITCH]: true, [CHOICE]: 'Ledger page only' }, provenance: { [SWITCH]: user, [CHOICE]: user }, rejected: [] };
  assert.equal(gate.agentFilingMode({ settings: raw }).mode, 'off');
  assert.equal(gate.chatFilingOf(raw), false);
  assert.equal(gate.chatFilingOf({ values: { [CHOICE]: 'Ledger page only' }, provenance: { [CHOICE]: { source: 'default', atMs: 0, directive: null } } }), true,
    'a default "Ledger page only" nobody chose does not take the typed commands away');
});

test('off means no asking: the tool refusal and every non-agent paragraph say so, and the page-only paragraph never names the typed commands', () => {
  assert.match(gate.REFUSAL_WHEN_OFF, /Do not ask the person whether to file it/);
  assert.match(gate.REFUSAL_WHEN_OFF, /"Who adds standing rules"/);
  assert.doesNotMatch(gate.REFUSAL_WHEN_OFF, /turn the setting on/);
  for (const chatFiling of [true, false]) {
    const paragraph = gate.requestContractParagraph('off', { canFile: true, chatFiling });
    assert.match(paragraph, /Agents do not file, propose or ask about standing rules/);
    assert.match(paragraph, /do not end your reply with a question about it/);
    assert.doesNotMatch(paragraph, /r_ledger\./);
    if (chatFiling) assert.match(paragraph, /\/Request/);
    else assert.doesNotMatch(paragraph, /\/Request/);
  }
  // With agents allowed, the paragraph is unchanged by the choice.
  assert.equal(gate.requestContractParagraph('auto', { canFile: true, chatFiling: false }), gate.requestContractParagraph('auto', { canFile: true }));
});
