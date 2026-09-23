'use strict';

const isolated = require('./lib/isolated-environment').activate('owner-prompt-platform-results');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { test, after } = require('node:test');
const actualPlatform = process.platform;
const priorDisplay = process.env.DISPLAY, priorWayland = process.env.WAYLAND_DISPLAY;
delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
after(() => { if (priorDisplay !== undefined) process.env.DISPLAY = priorDisplay; if (priorWayland !== undefined) process.env.WAYLAND_DISPLAY = priorWayland; });
Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
after(() => Object.defineProperty(process, 'platform', { configurable: true, value: actualPlatform }));

// Only the OS runner boundary is intercepted. Queue persistence, cancellation,
// registry dispatch and taxonomy are the real implementation in isolated state.
let runnerSpawnAttempts = 0;
const originalSpawn = childProcess.spawn;
childProcess.spawn = () => { runnerSpawnAttempts += 1; throw new Error('unexpected Windows runner spawn'); };
const queue = require('../src/lib/providers/owner-prompt-queue');
childProcess.spawn = originalSpawn;
const taxonomy = require('../src/lib/error-taxonomy');
const presenceFile = require.resolve('../src/lib/vault-presence');
require.cache[presenceFile] = { id: presenceFile, filename: presenceFile, loaded: true,
  exports: { vaultRecordPresence: () => ({ present: false, readable: true, code: 'VAULT_RECORD_ABSENT', detail: null }) } };
const { executeTool } = require('../src/lib/tool-registry');
const workspace = path.join(isolated.root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const context = { agentActor: 'codex',
  agentRole: { functions: ['system.credential_request', 'payment_method.card_register', 'payment_method.card_status'],
    requiresDirectUserAuthorization: false },
  permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' }, workspaceRoots: [workspace] };

test('a missing Linux desktop refuses before any native process launch', () => {
  assert.throws(() => queue.launchWaitingDialog(), error => {
    assert.equal(error.code, 'OWNER_PROMPT_RUNNER_UNAVAILABLE');
    assert.match(error.message, /private owner form/);
    const failure = taxonomy.publicFailure(taxonomy.adaptToolError(error));
    assert.equal(failure.code, 'UNAVAILABLE');
    assert.equal(failure.retryable, true);
    return true;
  });
  assert.equal(runnerSpawnAttempts, 0);
});

for (const [name, arguments_] of [
  ['system.credential_request', {
    credential: 'custom', customName: 'isolated_prompt_platform',
    requestContext: { purpose: 'Check isolated queued request', scope: 'Private test fixture only', lifetime: 'Until fixture cancellation' },
    acknowledgement: { formId: 'credential_value', contractVersion: 1, fieldIds: ['credential_value'],
      contractHash: 'fa5d89143fb1482a522f668a5192819daf552e80f026514c461b52c07a4efa47' }
  }],
  ['payment_method.card_register', {
    acknowledgement: { formId: 'payment_card_default', contractVersion: 2,
      fieldIds: ['given_name', 'family_name', 'card_number', 'expiration', 'postal_code'],
      contractHash: '155a49fd93a0f907eac24b1d188d71bf8fb8651389020ef81653db81497caaa8' }
  }]
]) {
  test(`${name} retains a cancellable id and discloses the unavailable form launcher`, async () => {
    let result;
    try {
      result = await executeTool(name, arguments_, context);
      assert.equal(result.status, 'queued');
      assert.equal(result.launcherRequested, false);
      assert.equal(result.launchFailure, 'OWNER_PROMPT_RUNNER_UNAVAILABLE', 'both native forms require a desktop session');
      assert.equal(result.storage, 'pending-owner-local-encrypted-vault');
      const item = queue.readQueue().items.find(item => item.requestId === result.requestId);
      assert.ok(item);
      assert.equal(item.status, 'queued');
      assert.equal(item.requester, 'codex');
      assert.equal(Object.hasOwn(item, 'value'), false);
      assert.equal(runnerSpawnAttempts, 0);
    } finally {
      if (result) assert.equal(queue.cancel({ requestId: result.requestId }).status, 'cancelled');
    }
  });
}

test('Linux card presence describes encrypted local custody without claiming DPAPI', async () => {
  const result = await executeTool('payment_method.card_status', {}, context);
  assert.equal(result.present, false);
  assert.equal(result.checked, true);
  assert.equal(result.storage, 'local-encrypted-vault');
  assert.equal(result.exposed, false);
});

test('deduplicated Linux requests retain the unavailable launcher result without another queue event', async () => {
  const args = {
    credential: 'custom', customName: 'isolated_prompt_replay',
    requestContext: { purpose: 'Check isolated request replay', scope: 'Private test fixture only', lifetime: 'Until fixture cancellation' },
    acknowledgement: { formId: 'credential_value', contractVersion: 1, fieldIds: ['credential_value'],
      contractHash: 'fa5d89143fb1482a522f668a5192819daf552e80f026514c461b52c07a4efa47' }
  };
  let first;
  try {
    first = await executeTool('system.credential_request', args, context);
    const replay = await executeTool('system.credential_request', args, context);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(replay.launcherRequested, false);
    assert.equal(replay.launchFailure, 'OWNER_PROMPT_RUNNER_UNAVAILABLE');
    assert.equal(queue.readQueue().events.filter(event => event.requestId === first.requestId).length, 1);
    assert.equal(runnerSpawnAttempts, 0);
  } finally {
    if (first) queue.cancel({ requestId: first.requestId });
  }
});

test('automatic missing-secret requests expose their prerequisite and cancellable id through both MCP representations', () => {
  const runtime = require('../src/lib/runtime');
  const { toolError } = require('../src/mcp-server');
  const vault = require('../src/lib/vault-linux');
  const originalGet = vault.get;
  // Only the absent-vault boundary is simulated; runtime prompting, durable
  // deduplication and the MCP serializer are their production implementations.
  vault.get = () => { throw Object.assign(new Error('missing fixture'), { code: 'SECRET_NOT_CONFIGURED' }); };
  const metadata = { requester: 'codex', requestContext: {
    purpose: 'Run github.repo_get', scope: 'Private test fixture only', lifetime: 'Until fixture cancellation'
  } };
  const beforeIds = new Set(queue.readQueue().items.map(item => item.requestId));
  let firstId;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(() => runtime.withCredentialPrompt(() => runtime.getSecret('github_pat'), metadata), error => {
        assert.equal(error.code, 'OWNER_PROMPT_RUNNER_UNAVAILABLE');
        assert.match(error.requestId, /^owner-prompt-[a-f0-9-]{36}$/);
        if (firstId) assert.equal(error.requestId, firstId);
        firstId = error.requestId;
        error.privateValue = 'private-vault-detail-canary';
        const packet = toolError(error);
        assert.equal(packet.structuredContent.error.requestId, firstId);
        assert.equal(packet.structuredContent.error.taxonomy.code, 'UNAVAILABLE');
        assert.equal(packet.structuredContent.error.taxonomy.retryable, true);
        assert.match(packet.content[0].text, /temporarily unavailable/);
        assert.ok(packet.content[0].text.includes(firstId));
        assert.doesNotMatch(JSON.stringify(packet), /private-vault-detail-canary|Wait for the durable/);
        const persisted = queue.readQueue().items.find(item => item.requestId === firstId);
        assert.equal(persisted.status, 'queued');
        assert.equal(Object.hasOwn(persisted, 'value'), false);
        return true;
      });
    }
    assert.equal(queue.readQueue().events.filter(event => event.requestId === firstId).length, 1);
    assert.equal(runnerSpawnAttempts, 0);
  } finally {
    vault.get = originalGet;
    for (const item of queue.readQueue().items) {
      if (!beforeIds.has(item.requestId) && item.status === 'queued') queue.cancel({ requestId: item.requestId });
    }
  }
});

test('a normally queued request exposes only its validated request id, including to text-only MCP clients', () => {
  const { toolError } = require('../src/mcp-server');
  const requestId = 'owner-prompt-00000000-0000-4000-8000-000000000001';
  const packet = toolError(Object.assign(new Error('Owner credential input is queued.'), {
    code: 'OWNER_PROMPT_QUEUED', requestId, privateValue: 'private-vault-detail-canary'
  }));
  assert.equal(packet.structuredContent.error.requestId, requestId);
  assert.ok(packet.content[0].text.includes(requestId));
  assert.doesNotMatch(JSON.stringify(packet), /private-vault-detail-canary/);
});

test('MCP does not surface arbitrary error fields or malformed owner request ids', () => {
  const { toolError } = require('../src/mcp-server');
  for (const [code, requestId] of [
    ['UNKNOWN_PROVIDER_FAILURE', 'owner-prompt-00000000-0000-4000-8000-000000000001'],
    ['OWNER_PROMPT_QUEUED', 'private-vault-detail-canary'],
    ['OWNER_PROMPT_QUEUED', 'owner-prompt-------------------------------------'],
    ['OWNER_PROMPT_UNRECOGNIZED', 'owner-prompt-00000000-0000-4000-8000-000000000001']
  ]) {
    const packet = toolError(Object.assign(new Error('Operation unavailable.'), { code, requestId }));
    assert.equal(Object.hasOwn(packet.structuredContent.error, 'requestId'), false);
    assert.ok(!packet.content[0].text.includes(requestId));
  }
});
