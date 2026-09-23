'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localProfileServicesRoot, LOCAL_PROFILE_MARKER } = require('../src/lib/local-user-profile');
const { messageDelivery } = require('../src/lib/agent-message-delivery');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-user-profile-'));
try {
  const stateRoot = path.join(root, 'capability');
  fs.mkdirSync(stateRoot);
  assert.equal(localProfileServicesRoot(stateRoot), null);
  const marker = path.join(root, LOCAL_PROFILE_MARKER);
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, services: 'services' }));
  assert.throws(() => localProfileServicesRoot(stateRoot), { code: 'LOCAL_PROFILE_INVALID' });
  fs.mkdirSync(path.join(root, 'services'));
  assert.equal(localProfileServicesRoot(stateRoot), path.join(root, 'services'));
  const { resolveServicesRoot } = require('../src/lib/durable-memory-file');
  assert.equal(resolveServicesRoot({ env: { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot } }), path.join(root, 'services'));
  for (const value of [{ schemaVersion: 2, services: 'services' }, { schemaVersion: 1, services: '../escape' }, { schemaVersion: 1, services: 'services', extra: true }]) {
    fs.writeFileSync(marker, JSON.stringify(value));
    assert.throws(() => localProfileServicesRoot(stateRoot), { code: 'LOCAL_PROFILE_INVALID' });
  }
  fs.writeFileSync(marker, '{bad');
  assert.throws(() => localProfileServicesRoot(stateRoot), { code: 'LOCAL_PROFILE_INVALID' });
  assert.throws(() => localProfileServicesRoot(stateRoot, { assertPath() { throw new Error('fence'); } }), /fence/);
  for (const [value, mode] of [['Instant','instant'], ['Timer','timer'], ['End of turn','end-of-turn']]) {
    assert.deepEqual(messageDelivery({ read: () => ({ values: { 'agent.message_delivery': value, 'agent.message_queue_seconds': 12 } }) }), { mode, intervalMs: 12000 });
  }
  console.log('Local profile marker validation and message delivery settings passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
