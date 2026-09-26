'use strict';

const { declareAdapter } = require('./contract');

/** Authentication, authorization scope, key status, and prospective revocation. */
module.exports = declareAdapter('IdentityAuthority', {
  authenticate: { request: 'opaqueCredentialReference', result: 'authenticatedPrincipalId|VcsError' },
  authorize: { request: 'principalId+ScopeSelector[]+actions', result: 'AuthorizationDecision' },
  inspectKeyStatus: { request: 'principalId+keyReference', result: 'AuthorizationDecision' },
  inspectRevocation: { request: 'principalId+authoritySnapshotId', result: 'AuthorizationDecision' },
});
