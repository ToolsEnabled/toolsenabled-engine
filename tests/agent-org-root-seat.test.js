'use strict';
/* The organisation's root seat, and the one thing a start knows about it that
 * its shipped declaration does not: which provider it actually runs on.
 *
 * The defect this covers, measured on a live tree on 2026-09-02: a
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

/* EVERY CONTROLLER CIRCLE, IN EVERY TREE, IS THIS ONE SEAT.
 *
 * So a start on a second provider is a second conversation of the same actor.
 * It used to REWRITE the seat's provider, and the owner host revoked every live
 * Controller on the old provider at its next line (two per-line-recheck
 * revocations, each ~40 ms after a Codex Controller resume). Once that rewrite
 * was refused instead, a Claude Controller could not start at all while a
 * Codex one ran.
 * The seat now lists both. */
test('a Codex root seat adopting Claude keeps Codex and adds Claude', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'codex', adoptProvider: true });
    assert.equal(seatOf(store, root.id).provider, 'codex', 'precondition: the first start taught the seat Codex');
    assert.equal(Object.hasOwn(seatOf(store, root.id), 'providers'), false, 'one provider is still the old shape');

    const answer = store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    assert.equal(answer.unchanged, false);
    assert.equal(answer.adoptedProvider, true);
    assert.equal(answer.seat.provider, 'codex', 'the provider a live Codex Controller is bound with is not replaced');
    assert.deepEqual([...answer.seat.providers], ['codex', 'claude'], 'Claude is added beside it');
    const reread = seatOf(store, root.id);
    assert.equal(reread.provider, 'codex', 'and that survives a re-read from disk');
    assert.deepEqual([...reread.providers], ['codex', 'claude']);
    assert.equal(reread.role, 'controller');
    assert.equal(reread.enabled, true);
  });
});

test('adopting a provider the root already carries writes nothing', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'codex', adoptProvider: true });
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    const revision = store.read().org.revision;
    for (const provider of ['codex', 'claude']) {
      const answer = store.ensureSeat({ id: root.id, role: 'controller', provider, adoptProvider: true });
      assert.equal(answer.unchanged, true, `a further ${provider} start does not churn the organisation`);
    }
    assert.equal(store.read().org.revision, revision);
  });
});

test('adopting "none" takes nothing away from the root seat', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'codex', adoptProvider: true });
    const answer = store.ensureSeat({ id: root.id, role: 'controller', provider: 'none', adoptProvider: true });
    assert.equal(answer.unchanged, true);
    assert.equal(seatOf(store, root.id).provider, 'codex');
  });
});

test('the root seat\'s providers survive every other write to the organisation', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'codex', adoptProvider: true });
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    // A tree spawn declares its child's seat; a drag reparents; a release
    // removes a seat. None of them is about the root, and none may drop a
    // provider a live Controller runs on.
    store.ensureSeat({ id: 'node-7-child', role: 'worker', provider: 'codex', nodeId: 'node-7-child' });
    const other = store.read().org.agents.find(agent => agent.id !== root.id && agent.role !== 'controller' && agent.id !== 'node-7-child');
    store.reparent({ agentId: other.id, parentId: 'node-7-child' });
    store.releaseSeat({ id: 'node-7-child' });
    assert.deepEqual([...seatOf(store, root.id).providers], ['codex', 'claude']);
  });
});

test('a seat that belongs to one tree node still has its provider replaced by adoption', () => {
  withStore(store => {
    store.ensureSeat({ id: 'node-8-solo', role: 'worker', provider: 'codex', nodeId: 'node-8-solo' });
    const answer = store.ensureSeat({ id: 'node-8-solo', role: 'worker', provider: 'claude', adoptProvider: true, nodeId: 'node-8-solo' });
    assert.equal(answer.adoptedProvider, true);
    assert.equal(seatOf(store, 'node-8-solo').provider, 'claude', 'the node moved to Claude; its seat moves with it');
    assert.equal(Object.hasOwn(seatOf(store, 'node-8-solo'), 'providers'), false, 'and carries no second provider');
  });
});

test('a node seat the owner gave a second provider is not rewritten by a start on either one', () => {
  withStore(store => {
    store.ensureSeat({ id: 'node-9-listed', role: 'worker', provider: 'codex', nodeId: 'node-9-listed' });
    const document = store.exportOrg();
    document.agents.find(agent => agent.id === 'node-9-listed').providers = ['codex', 'claude'];
    store.write(document);
    const revision = store.read().org.revision;
    const answer = store.ensureSeat({ id: 'node-9-listed', role: 'worker', provider: 'claude', adoptProvider: true, nodeId: 'node-9-listed' });
    assert.equal(answer.unchanged, true, 'the seat already carries Claude');
    assert.equal(store.read().org.revision, revision);
    assert.deepEqual([...seatOf(store, 'node-9-listed').providers], ['codex', 'claude']);
    store.ensureSeat({ id: 'node-9-listed', role: 'worker', provider: 'gemini', adoptProvider: true, nodeId: 'node-9-listed' });
    assert.equal(seatOf(store, 'node-9-listed').provider, 'gemini', 'a provider it does not carry still replaces, as on every node seat');
    assert.equal(Object.hasOwn(seatOf(store, 'node-9-listed'), 'providers'), false);
  });
});

test('a deliberate edit of the organisation still replaces the root seat\'s providers', () => {
  withStore(store => {
    const root = store.read().org.agents.find(agent => agent.role === 'controller');
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'codex', adoptProvider: true });
    store.ensureSeat({ id: root.id, role: 'controller', provider: 'claude', adoptProvider: true });
    const document = store.exportOrg();
    const edited = document.agents.find(agent => agent.id === root.id);
    edited.provider = 'gemini';
    delete edited.providers;
    store.write(document);
    const reread = seatOf(store, root.id);
    assert.equal(reread.provider, 'gemini');
    assert.equal(Object.hasOwn(reread, 'providers'), false, 'the owner\'s edit is the whole answer, not a union with it');
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
