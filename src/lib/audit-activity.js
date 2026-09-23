'use strict';

// Optional summaries use one trusted settings snapshot. Legacy preferences
// remain dormant until the separate audit feature is explicitly enabled.
const SETTING_ID = 'audit.activity';
const MODES = Object.freeze(['Full', 'Essential', 'Off']);

function activityMode(options = {}) {
  return require('./runtime-policy').runtimePolicy(options).activity;
}

function shouldRecordToolActivity(outcome, options) {
  // An unrecognized outcome must not become an unrecorded failure.
  const policy = require('./runtime-policy').runtimePolicy(options);
  if (!policy.auditEnabled) return false;
  if (!['succeeded', 'failed'].includes(outcome)) return true;
  const mode = policy.activity;
  return mode === 'Full' || (mode === 'Essential' && outcome === 'failed');
}

module.exports = Object.freeze({ SETTING_ID, MODES, activityMode, shouldRecordToolActivity });
