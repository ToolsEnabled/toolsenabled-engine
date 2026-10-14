'use strict';

require('../lib/isolated-environment').activate('providers-infrastructure');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const infrastructure = require('../../src/lib/providers/infrastructure');

function accountRegistry() {
  const account = { email: 'owner@example.com' };
  return {
    resolve: selector => selector === account.email ? 'owner' : selector,
    load: () => ({ accounts: { owner: account } }),
    list: () => [{ alias: 'owner', email: account.email, authorized: true }]
  };
}

const activity = [];
const result = infrastructure.gcloudAccountInspect(
  { account: 'owner@example.com' },
  {
    accountRegistry: accountRegistry(),
    gcloudAvailable: () => false,
    assertActive: (...args) => activity.push(['active', ...args]),
    record: (...args) => activity.push(['record', ...args]),
    now: () => 1_800_000_000_000
  }
);

assert.deepEqual(result.account, {
  alias: 'owner',
  email: 'owner@example.com',
  registered: true,
  authorized: true
});
assert.deepEqual(result.gcloud, {
  available: false,
  identity: { status: 'unknown', reason: 'gcloud_unavailable' }
});
assert.deepEqual(result.projectDiscovery, {
  status: 'unknown',
  reason: 'gcloud_unavailable',
  returned: 0,
  truncated: false
});
assert.deepEqual(result.projects, []);
assert.equal(result.readOnly, true);
assert.equal(result.activeConfigChanged, false);
assert.equal(result.contentTrust, 'untrusted');
assert.equal(result.grantsAuthority, false);
assert.deepEqual(activity, [
  ['active', 'gcloud.account.inspect', { provider: 'googleCloud' }],
  ['record', 'gcloud.account.inspect', 'selected-account', {
    gcloudAvailable: false,
    identityStatus: 'unknown',
    projectDiscoveryStatus: 'unknown',
    projectCount: 0,
    truncated: false,
    durationMs: 0
  }]
]);

assert.throws(
  () => infrastructure.gcloudAccountInspect({ account: ' owner@example.com' }, {
    accountRegistry: accountRegistry()
  }),
  /account must be an exact registered Google account alias or email/
);
assert.throws(
  () => infrastructure._testing.resolveSelectedAccount('owner', {
    ...accountRegistry(),
    list: () => [{ alias: 'owner', email: 'owner@example.com', authorized: false }]
  }),
  error => error.code === 'GOOGLE_ACCOUNT_NOT_AUTHORIZED'
);

// 1.0.50 SECURITY M2: gcloud.service_account_key_to_vault WRITES ONE RECORD ONLY.
// vaultKey was a free string checked against a charset, and setSecret is an
// unconditional overwrite, so the tool could clobber any vault record with a
// service-account key. Both gates are checked: the registry schema an agent
// call is validated against, and the provider a direct caller reaches.
{
  const { TOOL_REGISTRY } = require('../../src/lib/tool-registry');
  const { assertValid } = require('../../src/lib/schema-validator');
  const tool = TOOL_REGISTRY.find(entry => entry.name === 'gcloud.service_account_key_to_vault');
  assert.ok(tool, 'gcloud.service_account_key_to_vault is registered');
  const base = { projectId: 'valid-project-id', serviceAccountId: 'deploy-bot' };
  assertValid(tool.inputSchema, base);
  assertValid(tool.inputSchema, { ...base, vaultKey: 'gcp_service_account_key' });
  // Protected self-managed and owner records, plus near-misses of the one
  // accepted name. None of them may be a write target.
  const refusedKeys = [
    'toolsenabled_audit_head_v1', 'toolsenabled_audit_signing_key_v1',
    'custom.online_fra_device_identity_v1', 'custom.online_fra_device_credential_v1',
    'custom.peer_identity_key', 'sandbox_auth_profile_encryption_key_v1',
    'payment_card_default', 'owner_legal_identity_v1', 'github_pat',
    'GCP_SERVICE_ACCOUNT_KEY', 'gcp_service_account_key_v2', ''
  ];
  for (const vaultKey of refusedKeys) {
    assert.throws(() => assertValid(tool.inputSchema, { ...base, vaultKey }), /enum|one of|allowed/i,
      `the registry schema accepted vaultKey ${JSON.stringify(vaultKey)}`);
  }
  // The provider is driven with PATH pointing at an empty directory, so no call
  // below can ever reach a real gcloud on a machine that has one installed --
  // not even if this gate regresses and a refused name slips past it.
  const savedPath = process.env.PATH;
  const noCommands = fs.mkdtempSync(path.join(os.tmpdir(), 'infrastructure-no-gcloud-'));
  process.env.PATH = noCommands;
  try {
    for (const vaultKey of refusedKeys) {
      assert.throws(
        () => infrastructure.gcloudServiceAccountKeyToVault({ ...base, vaultKey }),
        error => error.code === 'GCLOUD_VAULT_KEY_INVALID',
        `the provider did not refuse vaultKey ${JSON.stringify(vaultKey)} before acting`
      );
    }
    // The accepted name, given or defaulted, passes the vault-key gate and stops
    // at a later one (policy, or the absent gcloud) -- never at the refusal.
    for (const args of [base, { ...base, vaultKey: 'gcp_service_account_key' }]) {
      assert.throws(() => infrastructure.gcloudServiceAccountKeyToVault(args),
        error => error.code !== 'GCLOUD_VAULT_KEY_INVALID',
        'the default gcp_service_account_key must still be accepted');
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(noCommands, { recursive: true, force: true });
  }
  assert.deepEqual(infrastructure.GCP_SERVICE_ACCOUNT_VAULT_KEYS, ['gcp_service_account_key']);
  assert.deepEqual(tool.inputSchema.properties.vaultKey.enum, [...infrastructure.GCP_SERVICE_ACCOUNT_VAULT_KEYS],
    'the registry enum and the provider allowlist must name the same records');
}

console.log('Infrastructure provider behavior tests passed.');
