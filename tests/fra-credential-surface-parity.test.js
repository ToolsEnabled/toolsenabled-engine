'use strict';

/*
 * TWO READERS, ONE POLICY.
 *
 * The FRA workspace broker and the repo-file tool both hand file bytes to a
 * caller, and each used to decide for itself what a credential is. They drifted.
 * Measured 2026-09-24, the repo surface served every one of these while the FRA
 * surface refused them: .ssh/id_rsa, projects/.aws/credentials,
 * nested/.gnupg/secring.gpg, a/.docker/config.json, backup/id_rsa.bak,
 * deploy/.p12, svc/serviceaccount.json, app/.azure/token and
 * deep/.config/gcloud/creds.db. A second reader with weaker rules is not a
 * second layer of defence; it is the hole.
 *
 * Separately, the FRA surface itself was anchoring the SSH rule to the exact
 * basename, so a ROTATED key was listed and its body served -- a real
 * `-----BEGIN OPENSSH PRIVATE KEY-----` came back through the read path for
 * `backup/id_rsa.bak` while the unsuffixed `backup/id_rsa` was correctly
 * refused.
 *
 * This case pins both: the named paths are refused, and the two surfaces agree.
 * It fails against the unpatched policy on every REFUSED entry below.
 */

const assert = require('node:assert/strict');
const policy = require('../src/lib/fra-workspace-policy');
const repoFiles = require('../src/lib/providers/repo-files');

const workspaceRefuses = value => policy.isExcludedDirectoryPath(value)
  || policy.isCredentialOrHistoryPath(value)
  || policy.isProtectedEnvironmentPath(value);

const repoRefuses = (value) => {
  try { repoFiles.resolveInsideRepo(value); return false; } catch { return true; }
};

// Each of these was measured reachable on at least one surface before 2026-09-24.
const REFUSED = [
  // A rotated or backed-up private key is still a private key.
  'backup/id_rsa.bak', 'keys/id_rsa_old', 'deploy/id_ed25519.bak', 'x/id_ecdsa-backup',
  // Key material named by extension alone.
  '.key', 'deploy/.p12', 'a/b/.pfx', '.kdbx',
  // A service-account key does not need a separator to be one.
  'serviceaccount.json', 'serviceAccount.json', 'service.account.json', 'serviceaccount-prod.json',
  // Cloud CLI credential directories.
  '.config/doctl/config.yaml', '.config/op/config', '.config/hub',
  // The home-shaped stores, at depth rather than only at the first segment.
  'projects/.ssh/id_rsa', 'projects/.aws/credentials', 'nested/.gnupg/secring.gpg',
  'a/.docker/config.json', 'app/.azure/token', 'deep/.config/gcloud/creds.db',
  // Credential directories named plainly, and a file inside one.
  'x/credentials/aws.json', 'team/secrets/prod.json',
];

// Ordinary source must stay reachable; the checks are on whole segments and
// real extensions, never on a substring.
const NAVIGABLE = [
  'src/app.js', 'docs/README.md', 'server.crt', 'tls.cer',
  'src/monkey.js', 'lib/serviceaccountant.md', 'config/hubble.json',
  'tools/optimize.js', 'packages/core/index.ts',
];

for (const value of REFUSED) {
  assert.equal(workspaceRefuses(value), true, `FRA workspace surface must refuse ${value}`);
  assert.equal(repoRefuses(value), true, `repo-file surface must refuse ${value}`);
}

for (const value of NAVIGABLE) {
  assert.equal(workspaceRefuses(value), false, `FRA workspace surface must still serve ${value}`);
}

/* The unsuffixed key was never the only one that mattered. */
assert.equal(workspaceRefuses('backup/id_rsa'), true);
assert.equal(workspaceRefuses('backup/id_rsa.bak'), true);

/* A file with a dedicated writer keeps its own, more actionable refusal. */
assert.equal(repoFiles.WRITE_PROTECTED_FILES.has('.claude/settings.json'), true);

console.log('FRA/repo credential surface parity GREEN');
