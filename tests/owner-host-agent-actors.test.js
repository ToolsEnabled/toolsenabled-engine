'use strict';

// EVERY GROK TREE START REFUSED, AND THE SENTENCE NAMED THE WRONG CAUSE.
//
// src/owner-host.js holds the set of assistant programs the server will accept
// as a calling principal. It read ['codex', 'claude', 'gemini', 'local'].
// Grok was never in it. validBindSession() tests
// `!AGENT_ACTORS.has(value.provider)`, directPrincipal() turns that miss into
// OWNER_HOST_SESSION_BINDING_INVALID, and the app maps that code to "This
// start did not carry the exact saved session identity, so no agent program
// was started. Reload this screen, then retry."
//
// Nothing in that sentence names the real cause, and nothing the person can do
// on that screen changes it. Reloading does not add a name to a frozen set, so
// the instruction the refusal gives is the one action guaranteed not to work.
// Every Grok start refused, every time, for as long as the name was missing.
//
// The rest of the installation already ran Grok. src/lib/agent-engine/
// acp-process.js lists it beside gemini as a provider it starts,
// src/lib/multi-account/registry.js records its home variable and sign-in
// file, and src/lib/setup/machine-record.js will WRITE 'grok' into a generated
// .mcp.json as the calling principal. One set -- in the single place that
// READS that principal -- disagreed with all of them.
//
// WHAT THIS FILE ASSERTS, and why in this order.
//
// 1. By behaviour, through a real owner host, a real socket and a real bind: a
//    Grok principal must come back bound, with a credential, exactly as a
//    Claude one does. The Claude bind runs in the same test against the same
//    host, so a host that refuses everything (a broken fixture) cannot pass by
//    symmetry, and a host that accepts everything is caught by the nonsense
//    provider that must still refuse.
//
// 2. By comparison across the three independent lists this repository keeps.
//    They are NOT the same list and must not be merged: each narrows one
//    shared fact -- which assistant programs this installation can run -- for
//    its own job, and machine-record.js says in its own comment why it stays
//    separate (what it may WRITE is not what the server will READ). So this
//    pins the DIRECTION of each containment and the exact residue of each
//    difference. A provider added to one list and forgotten in another fails
//    here by name, which is the failure that did not happen for grok.

const { activate } = require('./lib/isolated-environment');
const isolated = activate('owner-host-agent-actors');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOwnerHost, AGENT_ACTORS } = require('../src/owner-host');
const machineRecord = require('../src/lib/setup/machine-record');
const rLedgerGate = require('../src/lib/r-ledger-agent-gate');

// One seat per provider under test, all enabled, all at the same revisions, so
// the only thing that can differ between the binds below is the provider name.
const ORG_REVISION = 4;
const ROLE_REVISION = 2;
const SEATS = Object.freeze([
  Object.freeze({ id: 'seat-claude', provider: 'claude' }),
  Object.freeze({ id: 'seat-grok', provider: 'grok' }),
  Object.freeze({ id: 'seat-nonsense', provider: 'not-an-assistant' })
]);

function principalFor(seat) {
  return {
    sessionId: `session-${seat.id}`,
    agentId: seat.id,
    provider: seat.provider,
    roleId: 'worker',
    expectedOrgRevision: ORG_REVISION,
    expectedRoleRevision: ROLE_REVISION
  };
}

function hostFor(t) {
  const host = createOwnerHost({
    allowTestPaths: true,
    platform: 'test',
    pipeName: process.platform === 'win32'
      ? `\\\\.\\pipe\\AgentActors-${crypto.randomUUID()}`
      : path.join(isolated.root, `owner-${crypto.randomUUID().slice(0, 8)}.sock`),
    capabilityFile: path.join(isolated.root, 'owner.json'),
    controlCapabilityFile: path.join(isolated.root, 'control.json'),
    principals: { ownerPrincipal: 'TESTHOST\\agent-actors', clientPrincipal: 'TESTHOST\\agent-actors' },
    broker: {
      MAX_MESSAGE_BYTES: 1024,
      processLine() {},
      resolvePermissionSession: () => ({ origin: 'local', tier: 'full' })
    },
    readInstalledOrg() {
      return {
        org: {
          revision: ORG_REVISION,
          agents: SEATS.map(seat => ({ id: seat.id, role: 'worker', provider: seat.provider, enabled: true }))
        },
        roleRecord: { definition: { id: 'worker' }, revision: ROLE_REVISION }
      };
    }
  });
  t.after(() => host.close());
  return host;
}

test('a Grok session binds through the owner host exactly as a Claude one does', async t => {
  const host = hostFor(t);
  await host.listen();

  // The control case. If this ever fails the fixture is wrong, not the product,
  // and the Grok assertion below carries no information.
  const claude = await host.bindSession(principalFor(SEATS[0]));
  assert.equal(claude.bound, true, 'the control Claude session must bind, or this fixture proves nothing');
  assert.match(claude.credential, /^[A-Za-z0-9_-]{43}$/, 'a bound session is issued a credential');

  // The defect. Same host, same seat shape, same revisions: only the provider
  // name differs, so a refusal here can only be the provider name.
  const grok = await host.bindSession(principalFor(SEATS[1]));
  assert.equal(grok.bound, true, 'a Grok session must bind; the app already offers Grok tiers and the engine starts it');
  assert.match(grok.credential, /^[A-Za-z0-9_-]{43}$/, 'a bound Grok session is issued a credential');
  assert.notEqual(grok.credential, claude.credential, 'each bound session gets its own credential');

  // The host must still be a gate, not a pass-through: an unknown program is
  // refused with the same code the Grok start used to get.
  await assert.rejects(() => host.bindSession(principalFor(SEATS[2])),
    { code: 'OWNER_HOST_SESSION_BINDING_INVALID' },
    'a name no provider answers to must still be refused');

  // And the refusal must remain exact rather than becoming a wildcard: the
  // session that was refused holds no binding.
  assert.equal(host.sessionBindings.size, 2, 'only the two real assistants hold bindings');
});

test('the three assistant-name lists differ only where each says it differs', () => {
  // What the MCP server will READ as a calling principal. This is the widest
  // list and the canonical one: a name absent here cannot hold a session no
  // matter which other list has it.
  const reads = new Set(AGENT_ACTORS);
  // What src/lib/setup/machine-record.js may WRITE into a generated .mcp.json.
  // Deliberately its own frozen list -- see the comment above it -- because a
  // generator able to write an unsupported name would produce a document whose
  // actor-bound tools refuse at runtime, in a grandchild process nobody is
  // watching.
  const writes = new Set(machineRecord.AGENT_ACTORS);
  // Which declared control-plane actor a spooled owner turn belongs to. This
  // one is not a provider list: 'human' is in it because a person types turns.
  const ledger = new Set(rLedgerGate.AGENT_ACTORS);

  assert.ok(reads.size > 0 && writes.size > 0 && ledger.size > 0, 'each list must actually be readable here');

  // DIRECTION 1. Never generate a configuration naming a principal the server
  // will refuse. This is the containment machine-record.js already claims in
  // its own comment, and it is the one that broke: 'grok' was writable and
  // unreadable, so a generated document started a session the server killed.
  assert.deepEqual([...writes].filter(name => !reads.has(name)).sort(), [],
    'setup may write only principals the owner host will accept');
  assert.equal(writes.has('local'), true, 'Local launches generated tool servers under its own authenticated actor');
  assert.equal(ledger.has('local'), true, 'Local owner turns and Ledger filings retain their provider attribution');

  // DIRECTION 2. Every assistant that may file on the owner ledger must be
  // able to hold a bound session, or it can file records it could never have
  // been running to produce.
  assert.deepEqual([...ledger].filter(name => name !== 'human' && !reads.has(name)).sort(), [],
    'every ledger-filing assistant must be a principal the owner host will accept');

  // THE RESIDUES, pinned by name. These are the only differences that are
  // allowed to exist, and each is here for a stated reason:
  //   'human' -- a person is not an assistant program and never binds a
  //              session, but does type the turns the ledger attributes.
  // A new provider added to one list and forgotten in another lands in one of
  // these two comparisons by name, which is exactly what did not happen here.
  assert.deepEqual([...reads].filter(name => !writes.has(name)).sort(), [],
    'every accepted assistant now has a generated tool-document actor');
  assert.deepEqual([...reads].filter(name => !ledger.has(name)).sort(), [],
    'every accepted assistant has attributable owner turns and Ledger filings');
  assert.deepEqual([...ledger].filter(name => !reads.has(name)).sort(), ['human'],
    'the only ledger actor that is not a bindable assistant is the person');
});
