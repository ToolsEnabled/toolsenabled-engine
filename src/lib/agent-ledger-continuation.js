'use strict';

// Composition boundary: controller scheduling receives a verified task reader
// instead of importing Ledger storage. The public path retains its historical
// default reader for callers that do not inject one.
const store = require('./owner-request-store');
const controller = require('./ledger-continuation-controller');

function readWork(options = {}) {
  const reader = options.store || store;
  const all = reader.readAll({ kinds: ['T'], includeProposed: false });
  if (require('./runtime-policy').runtimePolicy({ loadSettings: options.readSettings }).verifyHistory) {
    const chain = reader.verifyHistory();
    if (chain.ok !== true) throw Object.assign(new Error('The task ledger history cannot be verified.'), { code: chain.code || 'LEDGER_HISTORY_UNVERIFIED' });
  }
  return all.records;
}

function createLedgerContinuation(options = {}) {
  if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
    return controller.createLedgerContinuation(options);
  }
  const readTasks = options.readTasks === undefined ? () => readWork(options) : options.readTasks;
  return controller.createLedgerContinuation({ ...options, readTasks,
    selectTasks: (...args) => store.selectForContext(...args) });
}

module.exports = {
  readWork,
  SETTING_ID: controller.SETTING_ID,
  INTERVAL_MS: controller.INTERVAL_MS,
  MAX_UNCHANGED_TURNS: controller.MAX_UNCHANGED_TURNS,
  HELD_STATUSES: controller.HELD_STATUSES,
  HELD_PAUSE: controller.HELD_PAUSE,
  MANAGER_OUTAGE_HOLD: controller.MANAGER_OUTAGE_HOLD,
  MANAGER_OUTAGE_RELEASE: controller.MANAGER_OUTAGE_RELEASE,
  enabled: controller.enabled,
  createLedgerContinuation
};
