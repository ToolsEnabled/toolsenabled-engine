'use strict';

/* Behaviour test for the official Claude CLI adapter's exported model mapping.
 * Run alone with:
 *   node tests/run-isolated.js tests/agent-engine/claude-cli-adapter.test.js
 */

const assert = require('node:assert/strict');
const {
  claudeArgs,
  claudeResumeArgs,
  claudeForkArgs,
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


// Provider identifiers are opaque. Only declared names in the app's Claude
// namespace are translated; the selected value reaches new, resumed and forked CLI
// launches rather than being changed at a transport boundary.
const modelCases = [
  ['claude/sonnet', 'sonnet'],
  ['claude/claude-sonnet-4-6', 'claude-sonnet-4-6'],
  ['claude/opus', 'opus'],
  ['claude/fable', 'fable'],
  ['claude/custom-model', 'claude/custom-model'],
  ['claude/team/custom-model', 'claude/team/custom-model'],
  ['team/custom-model', 'team/custom-model'],
  ['arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6', 'arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6'],
  ['arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/profile-id', 'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/profile-id']
];
for (const [selected, expected] of modelCases) {
  assert.equal(cliModelFor(selected), expected);
  for (const makeArgs of [claudeArgs, claudeResumeArgs, claudeForkArgs]) {
    const launch = makeArgs({ threadId: THREAD_ID, sourceThreadId: 'fd4d2b55-58fc-4d87-932e-02cd3cb0f617',
      threadOptions: { model: selected }, agentApi: false });
    assert.equal(launch[launch.indexOf('--model') + 1], expected);
  }
}

process.stdout.write('Claude CLI adapter model mapping tests passed (36 opaque-ID and declared namespace checks).\n');
// Every value given to --setting-sources, in argv order.
const settingSourcesOf = argv => argv.flatMap((value, index) => value === '--setting-sources' ? [argv[index + 1]] : []);

for (const makeArgs of [claudeArgs, require('../../src/lib/agent-engine/claude-cli-adapter').claudeResumeArgs]) {
  const restricted = makeArgs({ threadId: THREAD_ID, roleFunctionsOnly: true, agentApi: false });
  assert.equal(restricted.filter(a => a === '--tools').length, 1);
  assert.equal(restricted[restricted.indexOf('--tools') + 1], '');
  assert.deepEqual(settingSourcesOf(restricted), ['user'],
      'native user authentication settings must remain available; only the folder\'s own settings are dropped');
  assert.ok(restricted.includes('--disable-slash-commands'));
  assert.throws(() => makeArgs({ threadId: THREAD_ID, roleFunctionsOnly: true,
    extraArgs: ['--tools', 'Bash'] }), e => e.code === 'CLAUDE_ROLE_TOOLS_INVALID');
}

/* 1.0.50 SECURITY REVIEW M1: A CONFINED LAUNCH NEVER READS THE FOLDER'S OWN
 * CLAUDE SETTINGS. A cloned repository's .claude/settings.json can declare
 * hooks and helper commands the CLI runs as this OS user before any tool call,
 * and permission rules that widen the level; `--print` shows no trust prompt.
 * Every confined launch (guided `plan`, standard `acceptEdits`, any narrower
 * or unrecognised mode, and the sandbox-derived fallback) names the person's
 * own `user` source only, in every agent API mode, on start, resume and copy.
 * The unrestricted level (`bypassPermissions`) is unchanged: no flag. */
const COPY_SOURCE_ID = 'fd4d2b55-58fc-4d87-932e-02cd3cb0f617';
let settingSourceChecks = 0;
for (const agentApi of ['Only', 'Optimized', 'Enabled', 'Disabled']) {
  for (const [launch, expected] of [
    [{ permissionMode: 'plan' }, ['user']],
    [{ permissionMode: 'acceptEdits' }, ['user']],
    [{ permissionMode: 'default' }, ['user']],
    [{ permissionMode: 'not-a-recorded-mode' }, ['user']],
    [{ threadOptions: { sandbox: 'read-only' } }, ['user']],
    [{ threadOptions: { sandbox: 'workspace-write' } }, ['user']],
    [{}, ['user']],
    [{ permissionMode: 'bypassPermissions' }, []],
    [{ threadOptions: { sandbox: 'danger-full-access' } }, []]
  ]) {
    for (const makeArgs of [claudeArgs, claudeResumeArgs, claudeForkArgs]) {
      const argv = makeArgs({ threadId: THREAD_ID, sourceThreadId: COPY_SOURCE_ID, agentApi, ...launch });
      assert.deepEqual(settingSourcesOf(argv), expected,
        `${makeArgs.name} under ${agentApi} with ${JSON.stringify(launch)} must name ${JSON.stringify(expected)} setting sources`);
      settingSourceChecks += 1;
    }
  }
}
process.stdout.write(`Claude CLI adapter confined setting-source tests passed (${settingSourceChecks} launches).\n`);
