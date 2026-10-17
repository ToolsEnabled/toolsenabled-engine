'use strict';
// Shared modules added by the Windows host line port name no agent, vendor or
// provider wire method: driver-specific vocabulary lives in that driver's own
// adapter modules and descriptor data. (Per-provider review of the port.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHARED = ['src/lib/agent-engine/input-contract.js', 'src/lib/host-launch-policy.js', 'src/lib/control-delivery.js',
  'src/lib/host-worker-interactions.js', 'src/lib/host-interaction-terminal.js', 'src/lib/ledger-continuation-controller.js',
  'src/lib/host-input-content.js'];

test('shared port modules carry no vendor names or provider wire methods', () => {
  for (const file of SHARED) {
    const body = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(body, /codex|claude|gemini|opencode|anthropic|openai|thread\/(?:start|resume)/i, file);
  }
});
