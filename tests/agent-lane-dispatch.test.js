'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dispatch = require('../src/lib/mission-bridge/agent-lane-dispatch.js');

const launchId = 'launch_0123456789abcdef';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lane-dispatch-'));

try {
  const checkpoint = dispatch.persistCheckpoint({ projectRoot: root, launchId });
  const expected = path.join(root, 'state', 'mission-bridge-checkpoints', `${launchId}.md`);

  assert.equal(checkpoint, expected, 'the checkpoint is persisted at the launch-specific path');
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), dispatch.initialCheckpointSeed(launchId),
    'an omitted checkpoint body persists the truthful first-run seed');
  assert.equal(fs.lstatSync(checkpoint).isFile(), true, 'the persisted checkpoint is a regular file');
  assert.equal(fs.lstatSync(checkpoint).isSymbolicLink(), false, 'the persisted checkpoint is not a symlink');

  assert.throws(
    () => dispatch.persistCheckpoint({ projectRoot: root, launchId, content: 'replacement progress' }),
    error => error?.code === 'BRIDGE_AGENT_CHECKPOINT_COLLISION' && error?.status === 409,
    'an existing launch checkpoint is never overwritten'
  );
  assert.equal(fs.readFileSync(checkpoint, 'utf8'), dispatch.initialCheckpointSeed(launchId),
    'a collision leaves the original checkpoint intact');

  const credentialLaunchId = 'launch_fedcba9876543210';
  assert.throws(
    () => dispatch.persistCheckpoint({
      projectRoot: root,
      launchId: credentialLaunchId,
      content: 'progress\napi_key=sk-0123456789abcdefghijklmnop'
    }),
    error => error?.code === 'BRIDGE_AGENT_CHECKPOINT_CREDENTIAL_REFUSED' && error?.status === 400,
    'credential-like checkpoint content is refused'
  );
  assert.equal(fs.existsSync(dispatch.checkpointPath(root, credentialLaunchId)), false,
    'refused credential content is not written to disk');

  console.log('agent-lane-dispatch tests passed (8 checks)');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
