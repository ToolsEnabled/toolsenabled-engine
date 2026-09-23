/*
 * Mutation check: changed `if (basename === '.env') return true;` to return false.
 * The edit landed in src/lib/fra-workspace-policy.js and was verified before running.
 * This isolated test file went red with exit code 1 on the mutated module.
 * The module was then restored to its original SHA-256.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const policy = require('../src/lib/fra-workspace-policy');

const environmentPaths = new Map([
  ['.env', true],
  ['services/api/.env.production', true],
  ['services\\api\\.ENV.local', true],
  ['.env.example', false],
  ['services/api/.env.template', false],
  ['services/api/.env.sample', false],
  ['services/api/environment.json', false]
]);
for (const [candidate, protectedPath] of environmentPaths) {
  assert.equal(policy.isProtectedEnvironmentPath(candidate), protectedPath, candidate);
}

const credentialPaths = new Map([
  ['.npmrc', true],
  ['home/.config/gh/hosts.yml', true],
  ['home/.azure/accessTokens.json', true],
  ['home/.bash_history', true],
  ['app/session-store.json', true],
  ['app/credentials.production.yaml', true],
  ['app/.env.production', true],
  ['app/.env.example', false],
  ['app/session-notes.txt', false],
  ['app/tokenizer.json', false]
]);
for (const [candidate, credentialPath] of credentialPaths) {
  assert.equal(policy.isCredentialOrHistoryPath(candidate), credentialPath, candidate);
}

assert.deepEqual(policy.WORKSPACE_POLICY_DESCRIPTOR, {
  schemaVersion: 1,
  pathInputs: false,
  sessionScopedHandles: true,
  nativeHandleIdentity: true,
  staleIdentityRefused: true,
  reparsesRefused: true,
  hardLinksRefused: true,
  excludedDirectories: ['.git', 'logs', 'node_modules', 'profiles', 'state', 'vault'],
  maxFileBytes: 512 * 1024,
  maxReadBytes: 256 * 1024,
  maxDirectoryEntries: 2000,
  maxPageEntries: 100,
  maxHandlesPerSession: 4096
});
assert.equal(policy.WORKSPACE_POLICY_DIGEST, crypto.createHash('sha256')
  .update('ToolsEnabled/FRA/workspace-policy/v1', 'utf8').update('\0', 'utf8')
  .update(JSON.stringify(policy.WORKSPACE_POLICY_DESCRIPTOR), 'utf8')
  .digest('hex'));
assert.equal(Object.isFrozen(policy.WORKSPACE_POLICY_DESCRIPTOR), true);
assert.equal(Object.isFrozen(policy.WORKSPACE_POLICY_DESCRIPTOR.excludedDirectories), true);

console.log('FRA workspace policy classifies protected paths and pins its advertised limits.');
