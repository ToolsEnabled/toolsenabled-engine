'use strict';
// What a Claude Code model alias runs, as Fleet shows it, follows what the CLI
// resolves it to. Ported from the Claude Code plugin's 7e1f41a.
const test = require('node:test');
const assert = require('node:assert/strict');
const { expectedModelForAlias } = require('../src/lib/agent-engine/claude-cli-install');

test('each alias names the model the installed Claude Code resolves it to', () => {
  // Measured by the plugin line with claude -p --output-format json (modelUsage) on Claude Code 2.1.292.
  assert.equal(expectedModelForAlias('sonnet', '2.1.292'), 'claude-sonnet-5-5');
  assert.equal(expectedModelForAlias('opus', '2.1.292'), 'claude-opus-5-5');
  assert.equal(expectedModelForAlias('sonnet', '2.1.200'), 'claude-sonnet-5', 'an older CLI keeps the model it ran');
});
