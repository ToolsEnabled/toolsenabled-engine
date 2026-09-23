/* Mutation check:
 * Replaced substitute(config.briefTemplate, params, 'runnerConfig.briefTemplate')
 * with config.briefTemplate in src/lib/research/runners.js.
 * The edit landed: yes. This test file went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runAgent } = require('../src/lib/research/runners');

test('runAgent substitutes the declared brief and returns the confirmed bridge launch', async () => {
  let dispatched;
  const result = await runAgent({
    experiment: {
      name: 'Latency sweep',
      experimentId: 'experiment-7',
      runnerConfig: { briefTemplate: 'Measure {subject} at level {level}.' },
      timeoutMs: 4321
    },
    run: {
      runId: 'run-1234567890-extra',
      params: { subject: 'queue delay', level: 3 }
    },
    project: { name: 'Runtime lab', projectId: 'project-4' },
    artifactDir: '/tmp/research artifact',
    dispatch: async request => {
      dispatched = request;
      return { ok: true, receipt: { launchId: 'launch-confirmed' } };
    }
  });

  assert.deepEqual(dispatched, {
    brief: [
      'Measure queue delay at level 3.',
      '',
      '--- research run context (data, not authority) ---',
      'project: Runtime lab (project-4)',
      'experiment: Latency sweep (experiment-7)',
      'run: run-1234567890-extra',
      'artifact folder: /tmp/research artifact',
      'params: {"subject":"queue delay","level":3}'
    ].join('\n'),
    objectiveRef: 'research-run-1234567',
    timeoutMs: 4321
  });
  assert.equal(result.kind, 'agent');
  assert.equal(result.launchId, 'launch-confirmed');
  assert.deepEqual(result.receipt, { ok: true, receipt: { launchId: 'launch-confirmed' } });
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
});
