// Independent inventory guard for the built-in lane-scope policy.
'use strict';

const assert = require('node:assert/strict');
const { LANE_SCOPE_CROSS_MACHINE_TOOLS } = require('../src/lib/action-guards');

// This list is intentionally independent of the production set so deleting a
// required cross-machine tool cannot make a collection-driven test pass vacuously.
const requiredCrossMachineTools = [
  'gmail.send',
  'instagram.verify',
  'instagram.publish_image',
  'workstation.status',
  'workstation.install_cursor',
  'workstation.sync_cursor_extensions',
  'workstation.configure_agent_clients',
  'workstation.initialize_cursor_state',
  'workstation.launch_cursor',
  'iphone.handoff_status',
  'host.read_file',
  'host.write_file',
  'host.patch_file',
  'host.list_dir',
  'host.list_processes',
  'host.exec',
  'repo.read_file',
  'repo.write_file',
  'repo.list_dir',
  'agent_comms.send',
  'agent_comms.read'
];

for (const tool of requiredCrossMachineTools) {
  assert.ok(LANE_SCOPE_CROSS_MACHINE_TOOLS.has(tool),
    `required cross-machine tool is absent from the action guard: ${tool}`);
}

require('./surface.policy/action-guards.js');
