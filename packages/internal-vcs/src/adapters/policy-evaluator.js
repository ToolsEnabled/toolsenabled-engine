'use strict';

const { declareAdapter } = require('./contract');

/** Resolves versioned policy and emits attestations for exact immutable inputs. */
module.exports = declareAdapter('PolicyEvaluator', {
  resolvePolicy: { request: 'policyRevisionId+consumerAttestationId?', result: 'PolicyAttestation' },
  evaluate: { request: 'subjectId+action+immutableInputIds', result: 'PolicyEvaluation' },
  attest: { request: 'PolicyEvaluation+FenceBinding[]', result: 'PolicyAttestation' },
});
