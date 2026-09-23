'use strict';

require('../lib/isolated-environment').activate('vertex-gemini');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vertex = require('../../src/lib/providers/vertex-gemini');

const identity = {
  alias: 'fixed-alias',
  email: 'fixed@example.test',
  projectId: 'fixed-project'
};
const vertexConfig = {
  version: 2,
  operatorAuthorized: true,
  accountAlias: identity.alias,
  accountEmail: identity.email,
  projectId: identity.projectId,
  location: vertex.LOCATION,
  model: vertex.MODEL,
  thinkingBudget: vertex.THINKING_BUDGET,
  trialOnly: true,
  noFullAccountActivation: true
};
const accountRegistry = {
  resolve: () => identity.alias,
  load: () => ({ accounts: { [identity.alias]: { email: identity.email } } }),
  list: () => [{ alias: identity.alias, email: identity.email }]
};

function overrides(record) {
  return {
    vertexConfig,
    accountRegistry,
    assertActive: () => {},
    gcloudAvailable: () => true,
    run: (_command, args) => {
      if (args[0] === 'auth' && args[1] === 'list') {
        return { status: 0, stdout: JSON.stringify([{ account: identity.email, status: 'INACTIVE' }]), stderr: '' };
      }
      if (args[0] === 'auth' && args[1] === 'print-access-token') {
        return { status: 0, stdout: 'a'.repeat(16), stderr: '' };
      }
      throw new Error(`unexpected gcloud invocation: ${args.join(' ')}`);
    },
    request: async () => { throw new vertex.VertexGeminiError('VERTEX_API_UNAVAILABLE', 'provider unavailable'); },
    usageAttribution: () => 'fixture',
    record,
    now: () => 10
  };
}

(async () => {
  const createHash = crypto.createHash;
  crypto.createHash = () => ({
    update(value) { this.value = value; return this; },
    digest() {
      const field = this.value === identity.alias ? 'ACCOUNT_ALIAS_SHA256'
        : this.value === identity.email ? 'ACCOUNT_EMAIL_SHA256' : 'PROJECT_ID_SHA256';
      return vertex[field];
    }
  });
  try {
    await assert.rejects(
      () => vertex.geminiComplete({ prompt: 'name the failure', selfReview: false }, overrides(() => {})),
      error => error.code === 'VERTEX_API_UNAVAILABLE',
      'when the failure audit happened, the caller still receives the operation failure'
    );
    await assert.rejects(
      () => vertex.geminiComplete({ prompt: 'name the failure', selfReview: false }, overrides(() => { throw new Error('audit offline'); })),
      error => error.code === 'VERTEX_FAILURE_AUDIT_UNAVAILABLE'
        && error.details.originalCode === 'VERTEX_API_UNAVAILABLE',
      'the caller distinguishes an established failure audit from one that could not be established'
    );
  } finally {
    crypto.createHash = createHash;
  }
  console.log('vertex-gemini silent-catch distinction test passed (no provider was invoked).');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
