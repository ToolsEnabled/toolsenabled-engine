'use strict';

/* THE TOOL, NOT THE MODULE.
 *
 * tests/capability-recall*.test.js already prove find() itself. These two prove
 * the thing that was missing until now: that an agent can REACH it -- that
 * `capability.find` is registered, dispatches through executeTool like any other
 * tool, answers within its bounds, and refuses in a way that cannot be misread.
 *
 * EACH CASE RUNS IN ITS OWN PROCESS, deliberately. src/lib/capability-recall/
 * artifact.js loads the index once per process and freezes it ("LOAD THE INDEX
 * ONCE PER PROCESS, FREEZE IT, AND SHARE IT"), so two cases in one process would
 * share whatever the first one did to that cache -- and the second case here is
 * precisely about the index being unreadable. Running them cold also exercises
 * the path a real session takes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'config', 'capability-index.json');

function runCase(source) {
  const out = execFileSync(process.execPath, ['-e', source], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/* A session that is allowed everything, so the narrowing under test is the
 * tool's own and not a tier refusal arriving first. */
const SESSION = `const policy = require('./src/lib/permission-tier-policy');
  const session = policy.INSTALL_TIER_SESSIONS[policy.INSTALL_TIERS[policy.INSTALL_TIERS.length - 1]];`;

// ---------------------------------------------------------------------------
// 1. It answers, and the answer stays inside its bounds and inside the session.
// ---------------------------------------------------------------------------
{
  const result = runCase(`${SESSION}
    const { executeTool, registeredTools } = require('./src/lib/tool-registry');
    executeTool('capability.find', { query: 'send a message to another agent', limit: 3 },
      { permissionSession: session })
      .then(answer => {
        const allowed = registeredTools({ permissionSession: session }).map(entry => entry.name);
        console.log(JSON.stringify({
          outcome: answer.outcome,
          count: answer.tools.length,
          ids: answer.tools.map(tool => tool.id),
          textLength: String(answer.text || '').length,
          outsideSession: answer.tools.map(tool => tool.id).filter(id => !allowed.includes(id))
        }));
      });`);

  assert.ok(result.count > 0, 'a plain request for a real capability returned nothing');
  assert.ok(result.count <= 3, `limit 3 was not honoured: ${result.count} matches`);
  assert.ok(result.textLength > 0, 'the answer carried no words for the agent to read');
  assert.deepEqual(result.outsideSession, [],
    'the answer named a tool this session is not allowed to call');
  assert.notEqual(result.outcome, 'unavailable', 'a readable index reported itself unavailable');
}

// ---------------------------------------------------------------------------
// 1b. The narrowing is the point, so it is tested where it can FAIL.
//
// Case 1 runs at the widest tier, where every tool is allowed and "nothing
// outside the session" is true however the handler behaves -- it guards a
// regression, it does not catch one. This case narrows the session to four
// tools -- itself plus three host tools -- and asks a question whose best
// answers all lie OUTSIDE that set. If the handler stopped passing allowedIds,
// the answer would name agent_comms.send_local and this assertion would fail.
// ---------------------------------------------------------------------------
{
  const result = runCase(`${SESSION}
    const { executeTool } = require('./src/lib/tool-registry');
    const only = ['capability.find', 'host.read_file', 'host.list_dir', 'host.exec'];
    executeTool('capability.find', { query: 'send a message to another agent' },
      { permissionSession: session, allowedToolNames: only })
      .then(answer => console.log(JSON.stringify({
        outcome: answer.outcome,
        ids: answer.tools.map(tool => tool.id),
        outside: answer.tools.map(tool => tool.id).filter(id => !only.includes(id))
      })));`);

  assert.deepEqual(result.outside, [],
    `a narrowed session was offered tools it cannot call: ${result.ids.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2. An unreadable index says NOTHING WAS SEARCHED -- never "no tool exists".
//
// This is the whole reason the refusal wording matters. An agent that reads
// "no matches" when the index simply could not be opened concludes the product
// cannot do the thing, and stops asking. The words have to carry the difference.
// ---------------------------------------------------------------------------
{
  const moved = `${INDEX}.moved-for-test`;
  assert.ok(fs.existsSync(INDEX), 'the capability index is missing before the test moved it');
  fs.renameSync(INDEX, moved);
  let result;
  try {
    result = runCase(`${SESSION}
      const { executeTool } = require('./src/lib/tool-registry');
      executeTool('capability.find', { query: 'send a message to another agent' },
        { permissionSession: session })
        .then(answer => console.log(JSON.stringify({
          outcome: answer.outcome, code: answer.code, count: answer.tools.length, text: answer.text
        })));`);
  } finally {
    fs.renameSync(moved, INDEX);
  }

  assert.equal(result.outcome, 'unavailable', 'an unreadable index did not report itself unavailable');
  assert.equal(result.count, 0);
  assert.ok(result.code, 'the refusal carried no code to log');
  assert.match(result.text, /nothing was searched/i,
    'the refusal did not say that nothing was searched');
  assert.doesNotMatch(result.text, /\bno (tool|match|result)s? (exist|found|were found)\b/i,
    'the refusal reads as an absence of tools rather than an absence of a search');
  assert.ok(fs.existsSync(INDEX), 'the test did not put the index back');
}

console.log('capability.find tool tests passed');
