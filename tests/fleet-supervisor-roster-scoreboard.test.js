'use strict';

const assert = require('node:assert/strict');
const { buildScoreboard, serializeScoreboard } = require('../src/lib/fleet-supervisor/roster/scoreboard.js');

const config = {
  role: 'builder',
  provider: 'codex',
  model: 'gpt-5',
  backend: 'subscription',
  decomposed: false
};

const common = {
  v: 1,
  source: 'test',
  laneId: 'lane-1',
  itemId: 'Q1',
  attempt: 1,
  config,
  env: { headCommit: 'abc123' }
};

const events = [
  {
    ...common,
    eventId: 'outcome-1',
    kind: 'lane-outcome',
    at: '2026-08-27T10:00:00.000Z',
    outcome: { ok: false, code: 'EXIT_NONZERO' },
    attribution: { class: 'agent-attributable', rule: 'R-EXIT-AGENT' }
  },
  {
    ...common,
    eventId: 'verdict-1',
    kind: 'review-verdict',
    at: '2026-08-27T10:01:00.000Z',
    verdict: { verdict: 'accepted' },
    attribution: { class: 'agent-attributable', rule: 'V-ACCEPTED' }
  }
];

const board = buildScoreboard(events, { eventsFile: 'fixture-events.jsonl' });
const row = board.configs[0];

assert.equal(board.configs.length, 1, 'both events for one configuration produce one row');
assert.equal(row.counts.dispatched, 1, 'one lane is dispatched only once');
assert.deepEqual(row.counts.agentAttributable, {
  acceptedByReview: 1,
  rejectedByReview: 0,
  failedBeforeReview: 0
}, 'the later review verdict replaces the earlier lane failure instead of double-counting it');
assert.equal(row.stats.n, 1, 'the overridden lane contributes one posterior sample');
assert.equal(row.stats.successes, 1, 'the accepted review is the lane success');
assert.equal(board.generatedAt, events[1].at, 'generation time comes from the last event');
assert.equal(board.lastEventId, 'verdict-1');
assert.equal(board.eventsFile, 'fixture-events.jsonl');

const serialized = serializeScoreboard(board);
assert.equal(serialized, `${JSON.stringify(board, null, 2)}\n`, 'serialization is pretty JSON with one trailing newline');

console.log('fleet-supervisor roster scoreboard: 9 assertions passed');
