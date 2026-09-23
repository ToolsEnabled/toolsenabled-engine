'use strict';

const assert = require('node:assert/strict');

const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');
const {
  createTerminateAction,
  terminateWindowsTree
} = require('../src/lib/mission-bridge/termination');

const INPUT = Object.freeze({
  idempotencyKey: 'termination-refusal-coverage',
  agentId: 'worker-7',
  expectedRunId: '11111111-1111-4111-8111-111111111111',
  expectedPid: 4242
});

function expectCode(code) {
  return error => error instanceof MissionBridgeError && error.code === code;
}

function emptyAudit(counters) {
  return {
    findEvents() { counters.lookups += 1; return []; },
    conditionalRecord() { counters.writes += 1; throw new Error('must not write'); },
    requireRecord() { counters.writes += 1; throw new Error('must not write'); }
  };
}

async function main() {
  {
    let spawned = 0;
    await assert.rejects(
      terminateWindowsTree(INPUT.expectedPid, {
        platform: 'linux',
        spawnImpl() { spawned += 1; throw new Error('must not spawn'); }
      }),
      expectCode('BRIDGE_TERMINATE_PLATFORM_UNSUPPORTED')
    );
    assert.equal(spawned, 0, 'unsupported platforms refuse before spawning taskkill');
  }

  {
    const counters = { lookups: 0, writes: 0, registryReads: 0, terminations: 0 };
    const terminate = createTerminateAction({
      actor: 'controller',
      audit: emptyAudit(counters),
      presence: {
        assertAgentId: value => value,
        readRegistry() { counters.registryReads += 1; throw new Error('registry offline'); }
      },
      terminateProcess() { counters.terminations += 1; }
    });
    await assert.rejects(terminate(INPUT), expectCode('BRIDGE_TERMINATE_REGISTRY_UNAVAILABLE'));
    assert.equal(counters.registryReads, 1, 'the injected registry failure was driven');
    assert.equal(counters.writes, 0, 'registry refusal does not claim an audit intent');
    assert.equal(counters.terminations, 0, 'registry refusal does not terminate a process');
  }

  {
    const counters = { lookups: 0, writes: 0, registryReads: 0, terminations: 0 };
    const terminate = createTerminateAction({
      actor: 'controller',
      audit: null,
      presence: {
        assertAgentId: value => value,
        readRegistry() { counters.registryReads += 1; return { agents: {} }; }
      },
      terminateProcess() { counters.terminations += 1; }
    });
    await assert.rejects(terminate(INPUT), expectCode('BRIDGE_TERMINATE_AUDIT_UNAVAILABLE'));
    assert.deepEqual(counters, { lookups: 0, writes: 0, registryReads: 0, terminations: 0 },
      'missing audit dependency refuses before registry access, writes, or termination');
  }

  {
    const counters = { lookups: 0, writes: 0, authorizations: 0, terminations: 0 };
    const record = { runId: INPUT.expectedRunId, pid: INPUT.expectedPid, status: 'running' };
    const terminate = createTerminateAction({
      actor: 'controller',
      audit: emptyAudit(counters),
      presence: {
        assertAgentId: value => value,
        readRegistry: () => ({ agents: { [INPUT.agentId]: record } })
      },
      assertAuthorized() {
        counters.authorizations += 1;
        throw Object.assign(new Error('wake target disappeared'), { code: 'AGENT_WAKE_TARGET_UNKNOWN' });
      },
      terminateProcess() { counters.terminations += 1; }
    });
    await assert.rejects(terminate(INPUT), expectCode('BRIDGE_TERMINATE_AGENT_UNKNOWN'));
    assert.equal(counters.authorizations, 1, 'the wake authorization refusal was driven');
    assert.equal(counters.writes, 0, 'authorization refusal does not claim an audit intent');
    assert.equal(counters.terminations, 0, 'authorization refusal does not terminate a process');
  }

  console.log('mission-bridge-termination-refusals: 14 assertions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
