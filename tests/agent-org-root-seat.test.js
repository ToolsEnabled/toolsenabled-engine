'use strict';
/* The organisation's root seat, and the one thing a start knows about it that
 * its shipped declaration does not: which provider it actually runs on.
 *
 * The defect this covers, measured on the owner's own tree on 2026-09-02: a
 * Controller circle could never bind an identity, so every agent.spawn it made
 * was refused. The root seat ships with provider "none" -- nobody has run it --
 * and a session's binding requires the seat's provider to equal the provider the
 * session runs on. Nothing was broken; the seat simply still said nobody had
 * run it, and no caller could say otherwise.
 *
 * `adoptProvider` is that sentence, and these tests hold it narrow: off by
 * default, silent when the provider already matches, and never a way around the
 * role rule. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentOrgStore } = require('../src/lib/agent-org-store');

/* The shipped organisation, over a scratch overlay: the root seat under test is
   the one this product actually declares, not a fixture that could drift from
   it. */
const BASELINE = path.join(__dirname, '..', 'config', 'agent-org.json');

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-org-root-seat-'));
  try {
    run(createAgentOrgStore({ baselineFile: BASELINE, overlayFile: path.join(dir, 'agent-org.json') }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const seatOf = (store, id) => store.read().org.agents.find(agent => agent.id === id) || null;

test('by default an existing seat is left exactly as it is, provider included', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    assert.ok(root, 'the shipped organisation declares a controller');
    const before = root.provider;

    const answer = store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude' });
    assert.equal(answer.unchanged, true, 'the seat already exists, so nothing was written');
    assert.equal(seatOf(store, root.id).provider, before, 'and its provider is untouched');
  });
});

test('adoptProvider lets the seat learn which provider it is being run on', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    const answer = store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    assert.equal(answer.unchanged, false);
    assert.equal(answer.adoptedProvider, true);
    assert.equal(answer.seat.provider, 'claude');
    assert.equal(seatOf(store, root.id).provider, 'claude', 'and it survives a re-read from disk');
    assert.equal(seatOf(store, root.id).role, 'controller', 'nothing else about the seat moved');
    assert.equal(seatOf(store, root.id).enabled, true);
  });
});

test('adopting the provider it already has writes nothing', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    const revision = store.read().org.revision;
    const answer = store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    assert.equal(answer.unchanged, true);
    assert.equal(store.read().org.revision, revision, 'a second start does not churn the organisation');
  });
});

test('adoptProvider is not a way around the role rule', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    assert.throws(
      () => store.ensureSeat({ id: root.id, role: 'worker', provider: 'claude', adoptProvider: true }),
      error => error.code === 'AGENT_ORG_STORE_SEAT_ROLE_DIFFERS',
      'a differing role still refuses by name, whatever the provider says',
    );
    assert.equal(seatOf(store, root.id).role, 'controller');
  });
});

test('a second organisation root is still refused, which is why binding to the first one is the fix', () => {
  withStore(store => {
    assert.throws(
      () => store.ensureSeat({ id: 'node-1-abc', role: 'controller', provider: 'claude' }),
      error => error.code === 'AGENT_ORG_STORE_CONTROLLER_EXISTS',
      'this is the refusal a tree Controller circle used to hit, and it is correct',
    );
  });
});
