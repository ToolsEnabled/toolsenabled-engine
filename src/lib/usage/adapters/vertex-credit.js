'use strict';

const { createProviderAllowanceAdapter } = require('./provider-allowance');

function createVertexCreditAdapter({ readAllowance } = {}) {
  return createProviderAllowanceAdapter({ id: 'vertex-credit', readAllowance });
}

module.exports = Object.freeze({ createVertexCreditAdapter });
