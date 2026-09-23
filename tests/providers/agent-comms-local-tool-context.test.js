'use strict';

// THE BOUND SESSION HAS TO SURVIVE THE DISPATCHER, NOT ONLY THE PROVIDER.
//
// tests/providers/agent-comms-local-caller-session.test.js already proves the
// provider passes `context` through to the directory, and the two tools are
// defined as `(args, context) => agentCommsLocal().send(args, context)`. Both
// were true while the feature was dead, because neither is the place that
// decides whether a handler is CALLED with a context: executeTool() in
// src/lib/tool-registry.js keeps one list of tool names whose handlers take
// (args, context), and calls every other handler with (args) alone.
//
// agent_comms.send_local and agent_comms.local_roster were absent from that
// list. Their handlers therefore received `context === undefined`, provider
// callerSessionId() answered null for every caller, and the directory fell
// back to names alone -- which is exactly the "TWO TREES ON ONE COMPUTER"
// case tree-node-directory.js documents at length: two live rows named
// "Worker", one per tree, and every send or roster refused
// TREE_SENDER_AMBIGUOUS including from the circle making the call. The whole
// point of taking the session from the owner host's binding rather than the
// caller's words is that it lets the directory pick the right row, and no
// test between the provider and the tool surface could see that it never
// arrived.
//
// So this drives the real chokepoint, executeTool(), with the provider
// replaced in the module cache -- the provider itself is not what is on trial
// here, the dispatcher is.

require('../lib/isolated-environment').activate('agent-comms-local-tool-context');

const assert = require('node:assert/strict');
const test = require('node:test');

/* node:test must finish its own TAP summary. audit-admission releases its idle
 * worker after a batch, so the obsolete process.exit workaround both conceals
 * lifecycle regressions and truncates strict completion evidence. */

/* Seeded BEFORE tool-registry is required. The registry reaches the provider
   through a deferred require, so replacing the cache entry first is enough and
   no source is patched. */
const PROVIDER_ID = require.resolve('../../src/lib/providers/agent-comms-local');
const seen = [];
require.cache[PROVIDER_ID] = {
  id: PROVIDER_ID,
  filename: PROVIDER_ID,
  loaded: true,
  children: [],
  paths: [],
  exports: Object.freeze({
    async send(args, context) {
      seen.push({ tool: 'send', context });
      return Object.freeze({ accepted: false, code: 'STUB_REFUSED', reason: 'stubbed for this test', reachable: [] });
    },
    roster(args, context) {
      seen.push({ tool: 'roster', context });
      return Object.freeze({ from: args && args.from, reachable: [], unavailable: [] });
    }
  })
};

const { executeTool } = require('../../src/lib/tool-registry');

/* The tier a real install runs its circles at, the same one
   tests/agent-spawn-tree-surface.test.js drives the lifecycle verbs through. */
const STANDARD = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });
const PRINCIPAL = Object.freeze({ kind: 'agent-session', sessionId: 'chat-principal', agentId: 'node-1' });
const COMMS_ROLE = Object.freeze({
  functions: Object.freeze(['agent_comms.local_roster', 'agent_comms.send_local']),
  requiresDirectUserAuthorization: false,
});

test('agent_comms.local_roster reaches its handler with the session the owner host bound', async () => {
  seen.length = 0;
  await executeTool('agent_comms.local_roster', { from: 'Worker' }, {
    agentSessionId: 'chat-bound',
    agentPrincipal: PRINCIPAL,
    agentRole: COMMS_ROLE,
    permissionSession: STANDARD
  });

  assert.equal(seen.length, 1, 'the roster handler did not run at all');
  const { context } = seen[0];
  assert.ok(context && typeof context === 'object',
    'agent_comms.local_roster is not on executeTool\'s context-aware list, so its handler was called with (args) alone and '
    + 'the provider has no session to hand the directory -- two live circles sharing a name stay ambiguous forever');
  assert.equal(context.agentSessionId, 'chat-bound');
  assert.equal(context.agentPrincipal && context.agentPrincipal.sessionId, 'chat-principal',
    'the declared identity the directory prefers did not survive the dispatcher');
});

test('agent_comms.send_local reaches its handler with the same bound session', async () => {
  seen.length = 0;
  await executeTool('agent_comms.send_local', { from: 'Worker', to: 'Manager', body: 'hello' }, {
    agentSessionId: 'chat-bound',
    agentPrincipal: PRINCIPAL,
    agentRole: COMMS_ROLE,
    permissionSession: STANDARD
  });

  assert.equal(seen.length, 1, 'the send handler did not run at all');
  const { context } = seen[0];
  assert.ok(context && typeof context === 'object',
    'agent_comms.send_local is not on executeTool\'s context-aware list, so a send from a circle whose name another tree '
    + 'also uses is refused TREE_SENDER_AMBIGUOUS even though the owner host knows exactly which row is calling');
  assert.equal(context.agentSessionId, 'chat-bound');
  assert.equal(context.agentPrincipal && context.agentPrincipal.sessionId, 'chat-principal');
});

/* AND NOTHING THE CALLER WROTE BECOMES THE ANSWER, from either direction. The
   list decides whether a context is passed; it must never turn an argument
   into one, and a caller nobody vouched for must reach the handler with no
   session rather than with one it wrote itself. */
test('a caller cannot write its own session, and one nobody vouched for arrives with none', async () => {
  seen.length = 0;
  await assert.rejects(
    () => executeTool('agent_comms.local_roster', { from: 'Worker', agentSessionId: 'chat-claimed-by-the-caller' }, {
      permissionSession: STANDARD
    }),
    error => error && error.code === 'INVALID_PARAMS',
    'the tool schema now accepts a caller-written session id alongside the name, so the two could disagree'
  );
  assert.equal(seen.length, 0, 'a refused call must not reach the provider at all');

  await executeTool('agent_comms.local_roster', { from: 'Worker' }, { permissionSession: STANDARD });
  assert.equal(seen.length, 1, 'the roster handler did not run at all');
  const { context } = seen[0];
  assert.ok(context && typeof context === 'object', 'the handler was called with (args) alone');
  assert.equal(context.agentSessionId, undefined,
    'a caller the owner host could not vouch for was handed a session anyway');
  assert.equal(context.agentPrincipal, undefined);
});

test('an authenticated caller without a bound role cannot reach either local communications handler', async () => {
  seen.length = 0;
  for (const [tool, args] of [
    ['agent_comms.local_roster', { from: 'Worker' }],
    ['agent_comms.send_local', { from: 'Worker', to: 'Manager', body: 'hello' }],
  ]) {
    await assert.rejects(executeTool(tool, args, {
      agentPrincipal: PRINCIPAL, permissionSession: STANDARD,
    }), { code: 'ROLE_POLICY_REQUIRED' });
  }
  assert.equal(seen.length, 0);
});
