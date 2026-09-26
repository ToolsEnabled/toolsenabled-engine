'use strict';

const { declareAdapter } = require('./contract');

/** Injected monotonic and wall clocks for leases and expiring evidence. */
module.exports = declareAdapter('Clock', {
  now: { request: 'none', result: 'wallClockTimestamp' },
  monotonicNow: { request: 'none', result: 'monotonicTimestamp' },
});
