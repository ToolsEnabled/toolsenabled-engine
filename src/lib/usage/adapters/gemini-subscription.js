'use strict';

const { createProviderAllowanceAdapter } = require('./provider-allowance');

function createGeminiSubscriptionAdapter({ readAllowance } = {}) {
  return createProviderAllowanceAdapter({ id: 'gemini-subscription', readAllowance });
}

module.exports = Object.freeze({ createGeminiSubscriptionAdapter });
