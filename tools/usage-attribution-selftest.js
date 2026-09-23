#!/usr/bin/env node
'use strict';

// Focused R1162 tests. Provider calls inject audit sinks; no production audit
// or state database is opened by this test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const model = require('../src/lib/providers/model');
const query = require('./usage-attribution-query');

let passed = 0;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-usage-attribution-'));

function directory(...parts) {
  const target = path.join(...parts);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function writeJson(file, value) {
  directory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function check(name, body) {
  return Promise.resolve().then(body).then(() => {
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  });
}

function launchRecord(agentId, role, worktree, runId = `run-${agentId}`) {
  return { schemaVersion: 1, agentId, role, worktree, runId };
}

function event(sequence, action, details) {
  return { sequence, timestamp: `2026-08-07T00:00:${String(sequence).padStart(2, '0')}.000Z`, action, details };
}

(async () => {
  try {
    await check('exact environment identity resolves through its launch record', () => {
      const repoRoot = directory(testRoot, 'exact-lane');
      const launchDir = directory(testRoot, 'exact-launch');
      writeJson(path.join(launchDir, 'lane-one.json'), launchRecord('lane-one', 'worker', repoRoot));
      const result = model.providerUsageAttribution({
        repoRoot,
        env: { TOOLSENABLED_AGENT_ID: 'lane-one', TOOLSENABLED_AGENT_LAUNCH_DIR: launchDir },
        fs
      });
      assert.deepEqual(result, {
        agentId: 'lane-one', agentRole: 'worker', agentAttributionSource: 'agent-launch',
        agentAttributionProvenance: 'MEASURED', agentRunId: 'run-lane-one'
      });
    });

    await check('static agent identity falls back to the declared organization', () => {
      const repoRoot = directory(testRoot, 'organization');
      writeJson(path.join(repoRoot, 'config', 'agent-org.json'), {
        schemaVersion: 1,
        agents: [{ id: 'coordinator-sol', role: 'controller' }]
      });
      const result = model.providerUsageAttribution({
        repoRoot, env: { TOOLSENABLED_AGENT_ID: 'coordinator-sol' }, fs
      });
      assert.deepEqual(result, {
        agentId: 'coordinator-sol', agentRole: 'controller',
        agentAttributionSource: 'agent-org', agentAttributionProvenance: 'DERIVED'
      });
    });

    await check('a unique launch record can identify a lane-bound provider process by worktree', () => {
      const repoRoot = directory(testRoot, 'worktree-match');
      writeJson(path.join(repoRoot, 'state', 'agent-launch', 'lane-two.json'),
        launchRecord('lane-two', 'reviewer', repoRoot));
      const result = model.providerUsageAttribution({ repoRoot, env: {}, fs });
      assert.equal(result.agentId, 'lane-two');
      assert.equal(result.agentRole, 'reviewer');
      assert.equal(result.agentAttributionSource, 'agent-launch');
      assert.equal(result.agentAttributionProvenance, 'MEASURED');
    });

    await check('a linked worktree discovers launch state from the common worktree root', () => {
      const mainRoot = directory(testRoot, 'common-root');
      const repoRoot = directory(testRoot, 'linked-root');
      const gitDir = directory(mainRoot, '.git', 'worktrees', 'linked-root');
      fs.writeFileSync(path.join(repoRoot, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n', 'utf8');
      writeJson(path.join(mainRoot, 'state', 'agent-launch', 'linked-agent.json'),
        launchRecord('linked-agent', 'worker', repoRoot));
      const result = model.providerUsageAttribution({ repoRoot, env: {}, fs });
      assert.equal(result.agentId, 'linked-agent');
      assert.equal(result.agentRole, 'worker');
    });

    await check('ambiguous worktree identity is reported honestly as a direct session', () => {
      const repoRoot = directory(testRoot, 'ambiguous');
      writeJson(path.join(repoRoot, 'state', 'agent-launch', 'first.json'),
        launchRecord('first', 'worker', repoRoot));
      writeJson(path.join(repoRoot, 'state', 'agent-launch', 'second.json'),
        launchRecord('second', 'manager', repoRoot));
      assert.deepEqual(model.providerUsageAttribution({ repoRoot, env: {}, fs }), {
        agentId: 'direct-session', agentRole: 'direct-session',
        agentAttributionSource: 'direct-session', agentAttributionProvenance: 'DERIVED'
      });
    });

    await check('an explicit but unresolved identity remains UNKNOWN instead of borrowing a role', () => {
      const repoRoot = directory(testRoot, 'unresolved');
      assert.deepEqual(model.providerUsageAttribution({
        repoRoot, env: { TOOLSENABLED_AGENT_ID: 'missing-agent' }, fs
      }), {
        agentId: 'missing-agent', agentRole: 'unattributed',
        agentAttributionSource: 'environment-unresolved', agentAttributionProvenance: 'UNKNOWN'
      });
    });

    await check('resolver failure is additive and does not break an existing model completion', async () => {
      const auditCalls = [];
      const result = await model.complete({ prompt: 'bounded attribution fallback' }, {
        probe: async () => ({ available: true }),
        pickModel: () => ({ available: true, model: 'qwen3.5:4b', tier: 'workhorse' }),
        chat: async () => ({
          message: { role: 'assistant', content: 'completed' },
          prompt_eval_count: 4, eval_count: 3, total_duration: 12_000_000
        }),
        state: { recordModelUsage() {} },
        auditRequire: (...args) => { auditCalls.push(args); return { durable: true }; },
        auditRecord: (...args) => { auditCalls.push(args); return { durable: true }; },
        usageAttribution: () => { throw new Error('identity unavailable'); }
      });
      assert.equal(result.output, 'completed');
      const completed = auditCalls.find(call => call[0] === 'model.complete');
      assert.ok(completed);
      assert.equal(completed[2].agentId, 'direct-session');
      assert.equal(completed[2].agentRole, 'direct-session');
      assert.equal(completed[2].agentAttributionProvenance, 'DERIVED');
      assert.equal(completed[2].promptTokens, 4);
      assert.equal(completed[2].evalTokens, 3);
    });

    await check('reader aggregates only canonical leaf events without double-counting wrappers', () => {
      const observation = query.aggregateEvents([
        event(1, 'vertex.gemini.complete', {
          accountAlias: 'pool-a', promptTokens: 10, billableOutputTokens: 4,
          agentId: 'lane-one', agentRole: 'worker', agentAttributionSource: 'agent-launch',
          agentAttributionProvenance: 'MEASURED'
        }),
        event(2, 'vertex.gemini.seat_complete', {
          accountAlias: 'pool-a', promptTokens: 3, billableOutputTokens: 2,
          agentId: 'lane-two', agentRole: 'worker', agentAttributionSource: 'agent-launch',
          agentAttributionProvenance: 'MEASURED'
        }),
        event(3, 'model.complete', {
          promptTokens: 7, evalTokens: 5,
          agentId: 'direct-session', agentRole: 'direct-session', agentAttributionSource: 'direct-session',
          agentAttributionProvenance: 'DERIVED'
        }),
        event(4, 'model.role_complete', { promptTokens: 7, evalTokens: 5 }),
        event(5, 'controller.status', {})
      ], { limit: 20, generatedAt: '2026-08-07T00:01:00.000Z' });
      assert.equal(observation.coverage.state, 'complete');
      assert.equal(observation.coverage.excludedEvents.overlapWrapper, 1);
      assert.equal(observation.coverage.excludedEvents.nonUsage, 1);
      assert.equal(observation.totals.tokens, 31);
      assert.equal(observation.totals.calls, 3);
      assert.deepEqual(observation.rows, [
        {
          pool: 'local-machine', provider: 'local', role: 'direct-session', tokens: 12, calls: 1,
          tokenProvenance: 'MEASURED', attributionProvenance: 'DERIVED'
        },
        {
          pool: 'pool-a', provider: 'gemini', role: 'worker', tokens: 19, calls: 2,
          tokenProvenance: 'MEASURED', attributionProvenance: 'MEASURED'
        }
      ]);
    });

    await check('reader marks legacy unattributed usage partial and never presents a false total', () => {
      const observation = query.aggregateEvents([
        event(8, 'research.hermes_complete', { promptTokens: 9, evalTokens: 1 }),
        event(9, 'model.complete', {
          promptTokens: 2, evalTokens: 3,
          agentId: 'lane-one', agentRole: 'worker', agentAttributionSource: 'agent-launch',
          agentAttributionProvenance: 'MEASURED'
        })
      ], { limit: 20, generatedAt: '2026-08-07T00:01:00.000Z' });
      assert.equal(observation.coverage.state, 'partial');
      assert.equal(observation.coverage.complete, false);
      assert.equal(observation.coverage.excludedEvents.missingAttribution, 1);
      assert.equal(observation.totals.tokens, null);
      assert.equal(observation.totals.measuredLowerBoundTokens, 5);
    });

    await check('CLI arguments and reader boundary reject unbounded selectors', () => {
      assert.deepEqual(query.parseArguments(['--limit', '17', '--pretty']), { limit: 17, pretty: true, help: false });
      assert.throws(() => query.parseArguments(['--limit', '201']), /1 through 200/);
      assert.throws(() => query.parseArguments(['--database', 'state/audit.sqlite3']), /Unknown argument/);
      assert.throws(() => query.aggregateEvents(new Array(201).fill({})), /at most 200/);
    });
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
  process.stdout.write(`usage attribution selftest: ${passed}/${passed} passed\n`);
})().catch(error => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
