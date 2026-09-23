'use strict';

/* Behaviour test for the official Claude CLI adapter's exported model mapping.
 * Run alone with:
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-adapter.test.js
 */

const assert = require('node:assert/strict');
const {
  claudeArgs,
  cliModelFor
} = require('../../src/lib/agent-engine/claude-cli-adapter');

const THREAD_ID = '7cf7c88e-6912-4388-a181-78aef262c494';

assert.equal(cliModelFor('claude/sonnet'), 'sonnet',
  'a product tier must be translated to the bare model alias accepted by the Claude CLI');
assert.equal(cliModelFor('opus'), 'opus',
  'an already bare model alias must pass through unchanged');
assert.equal(cliModelFor(''), null,
  'an empty model selection must be represented as absent');

const args = claudeArgs({
  threadId: THREAD_ID,
  threadOptions: { model: 'claude/sonnet', effort: 'max' },
  agentApi: false
});
assert.equal(args[args.indexOf('--model') + 1], 'sonnet',
  'the generated process argv must carry the translated bare model alias');
assert.equal(args[args.indexOf('--effort') + 1], 'max',
  'the generated process argv must carry the requested Claude effort');

const opusArgs = claudeArgs({
  threadId: THREAD_ID,
  threadOptions: { model: 'claude/opus', effort: 'max' },
  agentApi: false
});
assert.equal(opusArgs[opusArgs.indexOf('--model') + 1], 'opus');
assert.equal(opusArgs[opusArgs.indexOf('--effort') + 1], 'max');

assert.throws(
  () => claudeArgs({ threadId: THREAD_ID, threadOptions: { effort: 'minimal' }, agentApi: false }),
  error => error && error.code === 'CLAUDE_CLI_EFFORT_UNSUPPORTED',
  'an effort Claude does not support must refuse rather than silently default'
);

process.stdout.write('Claude CLI adapter model mapping tests passed.\n');
for (const makeArgs of [claudeArgs, require('../../src/lib/agent-engine/claude-cli-adapter').claudeResumeArgs]) {
  const restricted = makeArgs({ threadId: THREAD_ID, roleFunctionsOnly: true, agentApi: false });
  assert.equal(restricted.filter(a => a === '--tools').length, 1);
  assert.equal(restricted[restricted.indexOf('--tools') + 1], '');
  assert.equal(restricted[restricted.indexOf('--setting-sources') + 1], '');
  assert.ok(restricted.includes('--disable-slash-commands'));
  assert.throws(() => makeArgs({ threadId: THREAD_ID, roleFunctionsOnly: true,
    extraArgs: ['--tools', 'Bash'] }), e => e.code === 'CLAUDE_ROLE_TOOLS_INVALID');
}
