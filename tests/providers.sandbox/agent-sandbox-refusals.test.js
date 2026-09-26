'use strict';

require('../lib/isolated-environment').activate('agent-sandbox-refusals');

// This legacy suite exercises required audit intent and refusal contracts.
const operationAudit = require('../../src/lib/operation-audit');
const requiredAuditPolicy = operationAudit.capturePolicy({ loadSettings: () => ({
  values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: []
}) });
operationAudit.withPolicy(requiredAuditPolicy, () => {
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONTRACT,
  createSandboxProvider,
  profileIdFor
} = require('../../src/lib/providers/agent-sandbox');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-refusals-'));
const dockerCalls = [];

function provider(name, overrides = {}) {
  const authRoot = path.join(root, name);
  const auditEvents = [];
  const runDocker = args => {
    dockerCalls.push(args);
    return { status: 1, stdout: '', stderr: 'Docker must not be reached' };
  };
  const instance = createSandboxProvider({
    authRoot,
    disposableRoot: path.join(root, `${name}-disposable`),
    createGuardPath: path.join(root, `${name}-create.guard`),
    admissionGuardPath: path.join(root, 'admission.sqlite3'),
    runDocker,
    linuxWorkspace: { runDocker, prepare() { throw new Error('ACLs must not be reached'); }, pinnedEndpoint: 'synthetic-only' },
    getOrCreateSecret: () => Buffer.alloc(32, 9).toString('base64url'),
    audit: {
      redact: String,
      requireRecord(event, target, details) {
        auditEvents.push({ event, target, details });
        return { durable: true };
      }
    },
    ...overrides
  });
  return { instance, authRoot, auditEvents };
}

function refusal(code, callback) {
  assert.throws(callback, error => {
    assert.equal(error.name, 'AgentSandboxError');
    assert.equal(error.code, code);
    return true;
  });
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true })
    .map(String)
    .sort();
}

try {
  {
    const { instance, authRoot } = provider('not-found');
    const before = filesBelow(authRoot);
    refusal('SANDBOX_AUTH_PROFILE_NOT_FOUND', () => instance.leaseAuthProfile({
      profileId: profileIdFor('missing@example.test', 'browser'),
      agent: 'codex',
      taskKey: 'missing-profile-task'
    }));
    assert.deepEqual(filesBelow(authRoot), before, 'not-found refusal must not create profile state');
  }

  {
    const { instance, authRoot, auditEvents } = provider('bad-key', {
      getOrCreateSecret: () => 'not-a-32-byte-key'
    });
    const profileId = profileIdFor('bad-key@example.test', 'browser');
    refusal('SANDBOX_AUTH_KEY_INVALID', () => instance.createAuthProfile({
      account: 'bad-key@example.test', purpose: 'browser'
    }));
    assert.deepEqual(filesBelow(path.join(authRoot, profileId)), [],
      'invalid encryption key must leave no profile or guard file');
    assert.equal(auditEvents.length, 1, 'the durable create intent precedes encryption');
  }

  {
    const { instance, authRoot, auditEvents } = provider('audit-down', {
      audit: { redact: String, requireRecord: () => ({ durable: false }) }
    });
    const profileId = profileIdFor('audit@example.test', 'browser');
    refusal('SANDBOX_AUDIT_UNAVAILABLE', () => instance.createAuthProfile({
      account: 'audit@example.test', purpose: 'browser'
    }));
    assert.deepEqual(filesBelow(path.join(authRoot, profileId)), [],
      'failed durable intent must prevent encrypted profile and metadata writes');
    assert.deepEqual(auditEvents, []);
  }

  {
    const { instance, authRoot, auditEvents } = provider('incomplete');
    const profileId = profileIdFor('incomplete@example.test', 'browser');
    const profileRoot = path.join(authRoot, profileId);
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, 'foreign.txt'), 'preexisting');
    const before = filesBelow(profileRoot);
    refusal('SANDBOX_AUTH_PROFILE_INCOMPLETE', () => instance.createAuthProfile({
      account: 'incomplete@example.test', purpose: 'browser'
    }));
    assert.deepEqual(filesBelow(profileRoot), before, 'incomplete refusal must not alter foreign state');
    assert.equal(auditEvents.length, 0, 'incomplete state must refuse before recording a create intent');
  }

  {
    const { instance, authRoot, auditEvents } = provider('busy');
    const profileId = profileIdFor('busy@example.test', 'browser');
    const profileRoot = path.join(authRoot, profileId);
    fs.mkdirSync(profileRoot, { recursive: true });
    const guard = path.join(profileRoot, '.lease.guard.json');
    fs.writeFileSync(guard, `${JSON.stringify({ version: 1, pid: process.pid, createdAtMs: Date.now() })}\n`);
    const before = fs.readFileSync(guard, 'utf8');
    refusal('SANDBOX_AUTH_PROFILE_BUSY', () => instance.createAuthProfile({
      account: 'busy@example.test', purpose: 'browser'
    }));
    assert.equal(fs.readFileSync(guard, 'utf8'), before, 'busy refusal must neither steal nor rewrite the guard');
    assert.equal(auditEvents.length, 0);
  }

  {
    const { instance, authRoot } = provider('conflict');
    const account = 'conflict@example.test';
    const purpose = 'browser';
    const profileId = profileIdFor(account, purpose);
    instance.createAuthProfile({ account, purpose });
    const metadataPath = path.join(authRoot, profileId, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.account = 'foreign@example.test';
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
    const before = filesBelow(path.join(authRoot, profileId));
    refusal('SANDBOX_AUTH_PROFILE_CONFLICT', () => instance.createAuthProfile({ account, purpose }));
    assert.deepEqual(filesBelow(path.join(authRoot, profileId)), before,
      'identity conflict must not replace existing profile files');
    assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).account, 'foreign@example.test');
  }

  {
    const { instance } = provider('confirmations');
    const sandboxId = `sbx-${'1'.repeat(20)}`;
    const profileId = `auth-${'2'.repeat(20)}`;
    refusal('SANDBOX_CONFIRMATION_MISMATCH', () => instance.reap({
      sandboxId, confirmSandboxId: `sbx-${'3'.repeat(20)}`
    }));
    refusal('SANDBOX_CONFIRMATION_MISMATCH', () => instance.revokeAuthProfile({
      profileId, confirmProfileId: `auth-${'4'.repeat(20)}`
    }));
  }

  assert.deepEqual(dockerCalls, [], 'none of these refusals may inspect, create, or remove Docker resources');
  console.log('Agent sandbox driven refusal tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

});
