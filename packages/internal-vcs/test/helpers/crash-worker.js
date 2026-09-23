'use strict';

const { createFileControlStore } = require('../../src/m1/control-store');

const [root, crashPhase, dedupeKey] = process.argv.slice(2);
const store = createFileControlStore({
  root,
  faultInjector(phase) {
    if (phase === crashPhase) process.exit(91);
  },
});
store.appendEvent({
  eventType: 'worker.crash-fixture',
  payload: { crashPhase },
  dedupeKey,
  occurredAt: '2026-08-06T12:00:00.000Z',
});
