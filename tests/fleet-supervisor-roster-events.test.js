'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const events = require('../src/lib/fleet-supervisor/roster/events.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-roster-events-'));
const eventFile = path.join(tempRoot, 'nested', 'events.jsonl');
let passed = 0;

function check(label, assertion) {
  assertion();
  passed += 1;
  process.stdout.write(`  ok: ${label}\n`);
}

process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));
process.stdout.write('fleet-supervisor roster events behavior\n');

const first = events.rosterErrorEvent({
  hookPoint: 'dispatch',
  message: 'fixture failure',
  laneId: 'lane-1',
  itemId: 'ITEM-1',
  at: '2026-08-27T10:00:00.000Z'
});
const second = events.rosterErrorEvent({
  hookPoint: 'verdict',
  message: 'another fixture failure',
  laneId: 'lane-2',
  itemId: 'ITEM-2',
  at: '2026-08-27T10:01:00.000Z'
});

check('appendEvent creates the parent directory and persists a valid event', () => {
  assert.deepEqual(events.appendEvent(eventFile, first), {
    appended: true,
    eventId: first.eventId,
    reason: null
  });
  assert.deepEqual(events.readEvents(eventFile).events, [first]);
});

check('appendEvent is idempotent for an eventId', () => {
  assert.deepEqual(events.appendEvent(eventFile, first), {
    appended: false,
    eventId: first.eventId,
    reason: 'duplicate'
  });
  assert.equal(fs.readFileSync(eventFile, 'utf8').trim().split('\n').length, 1);
});

fs.appendFileSync(eventFile, [
  '{not json}',
  JSON.stringify({ ...second, unexpectedAgentClaim: 'tests passed' }),
  JSON.stringify(first),
  JSON.stringify(second),
  ''
].join('\n'));

check('readEvents reports malformed and invalid lines instead of silently losing them', () => {
  const loaded = events.readEvents(eventFile);
  assert.deepEqual(loaded.corrupt.map(entry => entry.lineNumber), [2, 3]);
  assert.match(loaded.corrupt[0].error, /^not JSON:/);
  assert.match(loaded.corrupt[1].error, /unexpectedAgentClaim: not in the v1 whitelist/);
});

check('readEvents keeps the first occurrence, reports duplicates, and continues with later events', () => {
  const loaded = events.readEvents(eventFile);
  assert.deepEqual(loaded.events.map(event => event.eventId), [first.eventId, second.eventId]);
  assert.deepEqual(loaded.duplicates, [{ lineNumber: 4, eventId: first.eventId }]);
  assert.deepEqual([...loaded.eventIds], [first.eventId, second.eventId]);
});

check('createEventLog reuses its loaded id set across appends', () => {
  const log = events.createEventLog(eventFile);
  assert.deepEqual(log.corruptAtLoad.map(entry => entry.lineNumber), [2, 3]);
  assert.deepEqual(log.duplicatesAtLoad, [{ lineNumber: 4, eventId: first.eventId }]);
  assert.equal(log.append(second).appended, false);
  assert.equal(log.append(events.rosterErrorEvent({
    hookPoint: 'dispatch',
    message: 'third fixture failure',
    at: '2026-08-27T10:02:00.000Z'
  })).appended, true);
  assert.equal(log.read().events.length, 3);
});

process.stdout.write(`fleet-supervisor roster events behavior: ${passed} checks passed\n`);
