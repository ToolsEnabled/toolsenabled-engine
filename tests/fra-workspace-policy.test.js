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

const { excludedDirectoryPatterns, excludedFilePatterns, ...descriptor } = policy.WORKSPACE_POLICY_DESCRIPTOR;
assert.deepEqual(descriptor, {
  schemaVersion: 1,
  pathInputs: false,
  sessionScopedHandles: true,
  nativeHandleIdentity: true,
  staleIdentityRefused: true,
  reparsesRefused: true,
  hardLinksRefused: true,
  /* Declared deliberately, because this census is the point: the digest binds
     it, so a name may not join or leave the policy without being written here.
     The 2026-09-24 additions close a measured containment gap -- `.gpg`,
     `credentials` and `secrets` previously matched only as FILE names, so the
     directory was refused while a file inside it was served, and the ten
     remaining names matched nothing at all. */
  excludedDirectories: ['.aws', '.azure', '.chef', '.credentials', '.docker', '.gcloud', '.gemini',
    '.git', '.gnupg', '.gpg', '.kube', '.mozilla', '.nuget', '.password-store', '.secrets',
    '.ssh', '.subversion', '.terraform.d', '.thunderbird',
    'credentials', 'logs', 'node_modules', 'profiles', 'secrets', 'state', 'vault'],
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
for (const patterns of [excludedDirectoryPatterns, excludedFilePatterns]) {
  assert.ok(Array.isArray(patterns) && patterns.length > 0);
  assert.equal(Object.isFrozen(patterns), true);
  assert.ok(patterns.every(pattern => typeof pattern === 'string' && pattern.startsWith('/')));
}
// The descriptor must bind file/store rules as well as directory names.
const changed = { ...policy.WORKSPACE_POLICY_DESCRIPTOR, excludedFilePatterns: [] };
assert.notEqual(policy.WORKSPACE_POLICY_DIGEST, crypto.createHash('sha256')
  .update('ToolsEnabled/FRA/workspace-policy/v1\0', 'utf8').update(JSON.stringify(changed)).digest('hex'));

console.log('FRA workspace policy classifies protected paths and pins its advertised limits.');
