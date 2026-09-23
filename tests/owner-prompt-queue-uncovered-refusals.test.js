'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../src/lib/providers/owner-prompt-queue');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-refusals-'));
const eventQueueFile = path.join(root, 'events', 'queue.json');
let spawned = 0;
const refusalOptions = {
  queueFile: eventQueueFile,
  spawn() {
    spawned += 1;
    return { pid: 1234, unref() {} };
  }
};

// Cursor validation happens before the queue is read. An invalid request must
// therefore throw the public refusal, return no result, and leave no durable or
// temporary state behind.
let eventResult = Symbol('events did not return');
assert.throws(
  () => { eventResult = queue.events({ afterSequence: -1, limit: 50 }, refusalOptions); },
  error => error && error.code === 'OWNER_PROMPT_EVENTS_INVALID'
    && error.message === 'The owner prompt event cursor is invalid.',
  'events must refuse a negative cursor with its stable safe error'
);
assert.equal(typeof eventResult, 'symbol', 'refused events must not return a result');
assert.equal(fs.existsSync(path.dirname(eventQueueFile)), false,
  'invalid event input must not create a queue directory, queue, or lock');
assert.equal(spawned, 0, 'invalid event input must not spawn the owner prompt runner');

// A well-formed id can still name no stored request. Seed a deliberately
// non-canonical representation so byte equality proves cancel did not rewrite
// the queue while refusing the missing id.
const cancelDirectory = path.join(root, 'cancel');
const cancelQueueFile = path.join(cancelDirectory, 'queue.json');
fs.mkdirSync(cancelDirectory, { recursive: true });
const originalQueueBytes = Buffer.from('{"version":1,"nextSequence":1,"items":[],"events":[]}\n');
fs.writeFileSync(cancelQueueFile, originalQueueBytes);
const originalQueueHash = crypto.createHash('sha256').update(originalQueueBytes).digest('hex');
let cancelResult = Symbol('cancel did not return');
assert.throws(
  () => {
    cancelResult = queue.cancel(
      { requestId: 'owner-prompt-00000000-0000-4000-8000-000000000000' },
      { ...refusalOptions, queueFile: cancelQueueFile }
    );
  },
  error => error && error.code === 'OWNER_PROMPT_NOT_FOUND'
    && error.message === 'The owner prompt request is unavailable.',
  'cancel must refuse a valid but unknown request id with its stable safe error'
);
assert.equal(typeof cancelResult, 'symbol', 'refused cancellation must not return a result');
const afterQueueBytes = fs.readFileSync(cancelQueueFile);
assert.equal(crypto.createHash('sha256').update(afterQueueBytes).digest('hex'), originalQueueHash,
  'missing-request refusal must leave the durable queue byte-identical');
assert.deepEqual(fs.readdirSync(cancelDirectory), ['queue.json'],
  'missing-request refusal must remove its lock and write no temporary file');
assert.equal(spawned, 0, 'missing-request cancellation must not spawn the owner prompt runner');

fs.rmSync(root, { recursive: true, force: true });
console.log('owner prompt queue uncovered refusals: ok');
