'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backfill } = require('../src/lib/fleet-supervisor/roster/backfill.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-backfill-test-'));
const stateFile = path.join(directory, 'fleet-supervisor.json');
const logFile = path.join(directory, 'fleet-supervisor.log');
const eventsFile = path.join(directory, 'agent-roster-events.jsonl');

try {
  const fvpmLane = {
    laneId: 'lane-fvpm',
    itemId: 'R103::backfill',
    attempt: 2,
    status: 'failed',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    startedAt: '2026-08-27T09:00:00.000Z',
    endedAt: '2026-08-27T09:01:00.000Z',
    snapshot: { complete: true },
    billing: {
      backend: 'vertex',
      project: 'safe-project-id',
      account: 'private@example.com'
    },
    outcome: {
      ok: false,
      code: 'FLEET_VERTEX_PROJECT_MISSING',
      transient: false,
      durationMs: 60000,
      detail: 'A vertex lane requires an explicit Google Cloud project id.'
    }
  };

  fs.writeFileSync(stateFile, JSON.stringify({
    lanes: { [fvpmLane.laneId]: fvpmLane },
    history: [{
      event: 'verification',
      laneId: fvpmLane.laneId,
      itemId: fvpmLane.itemId,
      attempt: fvpmLane.attempt,
      at: '2026-08-27T09:02:00.000Z',
      verdict: 'accepted',
      reviewer: 'reviewer-1',
      score: 95,
      reason: 'evidence verified'
    }],
    items: {}
  }));
  fs.writeFileSync(logFile, '');

  const first = backfill({ stateFile, logFile, eventsFile });
  assert.deepEqual(first.emitted, {
    total: 2,
    'lane-outcome': 1,
    'review-verdict': 1,
    park: 0
  });
  assert.deepEqual(first.fvpmRegression, {
    fvpmEvents: 1,
    agentAttributable: 0,
    ok: true,
    offenders: []
  });

  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  const outcome = events.find((event) => event.kind === 'lane-outcome');
  const verdict = events.find((event) => event.kind === 'review-verdict');
  assert.deepEqual(outcome.attribution, { class: 'infra-fault', rule: 'R-FVPM' });
  assert.deepEqual(outcome.billing, { backend: 'vertex', project: 'safe-project-id' },
    'backfill must not copy the private billing account into an event');
  assert.equal(verdict.verdict.verdict, 'accepted');
  assert.deepEqual(verdict.attribution, { class: 'agent-attributable', rule: 'V-AGENT' });

  const second = backfill({ stateFile, logFile, eventsFile });
  assert.equal(second.emitted.total, 0, 'replaying identical sources must be idempotent');
  assert.equal(second.skipped.duplicateEventId, 2);
  assert.equal(fs.readFileSync(eventsFile, 'utf8').trim().split('\n').length, 2);

  console.log('fleet-supervisor roster backfill: behaviour checks passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
