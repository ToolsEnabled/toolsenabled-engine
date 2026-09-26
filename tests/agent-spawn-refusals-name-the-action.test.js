'use strict';

// THE THREE agent.spawn GATES A CALLER MEETS MOST, MEASURED.
//
// Evidence, this installation, capability/logs/actions.jsonl:
//   * 22 refusals reading, in full, "Subagent spawn refused because no exact
//     declared agent identity is transport-bound."
//   * 1 reading "Subagent spawn refused because workspaceRoot is not one of the
//     verified workspace roots recorded for this permission session."
//
// The first states a fact in vocabulary ("transport-bound") that appears
// nowhere in the request the caller can edit, and names no action. The second
// withholds the list it is comparing against -- confinedWorkspaceRoots() has
// already produced it one line above the throw -- so the caller is asked to
// match a set it cannot see.
//
// These checks assert the sentence each gate produces, by calling spawn with
// values. The gates themselves are unchanged: each case must still refuse,
// with the same code, before any mission action is constructed.

const assert = require('node:assert/strict');
const test = require('node:test');

const { spawnSubagent } = require('../src/lib/tool-registry');

const VALID_CONTRACT = [
  'CONTRACT/1',
  'role      IMPLEMENTER',
  'target    src/lib/tool-registry.js',
  'do        probe one bounded refusal sentence',
  'because   measured 22 refusals that named no action',
  'done      a caller observes the action named in the refusal',
  'report    REPORT-agent-spawn-refusal-probe.md'
].join('\n');

async function refusal(context, workspaceRoot) {
  let thrown = null;
  let constructed = false;
  try {
    await spawnSubagent(
      { contract: VALID_CONTRACT, tier: 'luna', ...(workspaceRoot === undefined ? {} : { workspaceRoot }) },
      context,
      {
        apiSheet: '',
        createMissionActions() {
          constructed = true;
          return { dispatch() { throw new Error('must not dispatch'); } };
        }
      }
    );
  } catch (error) { thrown = error; }
  assert.ok(thrown, 'the spawn must refuse');
  assert.equal(constructed, false, 'a refusal must not construct mission actions');
  return thrown;
}

test('an anonymous session is told why it has no identity and how to get one', async () => {
  const thrown = await refusal({ workspaceRoots: ['/verified/workspace'] }, undefined);

  assert.equal(thrown.code, 'AGENT_SPAWN_IDENTITY_REQUIRED', 'the refusal code is the contract and must not change');
  assert.match(thrown.message, /seat/i,
    `the caller must be told what supplies the identity; got: ${thrown.message}`);
  assert.match(thrown.message, /role/i,
    `the caller must be told the seat must match the node role; got: ${thrown.message}`);
  assert.match(thrown.message, /fresh session/i,
    `the caller must be told an already-running session stays anonymous; got: ${thrown.message}`);
  assert.doesNotMatch(thrown.message, /transport-bound/,
    'the sentence must not be stated in vocabulary that appears in no request field');
});

test('an empty recorded root list says it is an empty list, not a failed look', async () => {
  const thrown = await refusal({ agentActor: 'codex', agentId: 'root-alpha', workspaceRoots: [] }, undefined);

  assert.equal(thrown.code, 'AGENT_SPAWN_WORKSPACE_UNAVAILABLE');
  assert.match(thrown.message, /not a failed look/i,
    `an established absence must say so; got: ${thrown.message}`);
  assert.match(thrown.message, /record at least one workspace root/i,
    `the caller must be told the action; got: ${thrown.message}`);
  assert.match(thrown.message, /re-read on every spawn/i,
    'the caller must be told it does not need a restart, which is what makes the action worth taking');
});

test('a rejected workspaceRoot prints the roots it was compared against', async () => {
  const roots = ['/verified/workspace', '/second/workspace'];
  const thrown = await refusal({ agentActor: 'codex', agentId: 'root-alpha', workspaceRoots: roots }, '/other/workspace');

  assert.equal(thrown.code, 'AGENT_SPAWN_WORKSPACE_REFUSED');
  assert.match(thrown.message, /other[\\/]workspace/,
    `the sentence must quote back what the caller passed; got: ${thrown.message}`);
  for (const root of roots) {
    const tail = root.split('/').filter(Boolean).join('[\\\\/]');
    assert.match(thrown.message, new RegExp(tail),
      `the accepted root ${root} must be printed; got: ${thrown.message}`);
  }
  assert.match(thrown.message, /omit workspaceRoot to use the first/i,
    'the caller must be told the simplest way through');
});

test('a long root list is bounded and says how many it did not print', async () => {
  const roots = [];
  for (let index = 0; index < 11; index += 1) roots.push(`/workspace/root-${index}`);
  const thrown = await refusal({ agentActor: 'codex', agentId: 'root-alpha', workspaceRoots: roots }, '/other/workspace');

  assert.equal(thrown.code, 'AGENT_SPAWN_WORKSPACE_REFUSED');
  assert.match(thrown.message, /these 11/, `the total must be stated; got: ${thrown.message}`);
  assert.match(thrown.message, /and 3 more/, `the elision must be counted, not silent; got: ${thrown.message}`);
  assert.doesNotMatch(thrown.message, /root-10/, 'the printed list must actually be bounded');
});

test('a spawn that satisfies all three gates still reaches dispatch', async () => {
  let dispatched = null;
  const answer = await spawnSubagent(
    { contract: VALID_CONTRACT, tier: 'local', turns: 1, timeoutSeconds: 60, workspaceRoot: '/verified/workspace' },
    {
      agentActor: 'codex',
      agentId: 'root-alpha',
      workspaceRoots: ['/verified/workspace'],
      permissionSession: { origin: 'local', tier: 'full' }
    },
    {
      apiSheet: '',
      createMissionActions() {
        return { async dispatch(request) { dispatched = request; return { ok: true }; } };
      }
    }
  );

  assert.deepEqual(answer, { ok: true }, 'the gates must not have become universal refusals');
  assert.ok(dispatched, 'a satisfied spawn must reach dispatch');
});
