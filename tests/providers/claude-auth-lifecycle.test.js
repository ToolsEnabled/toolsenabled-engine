'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { probeClaudeAuth } = require('../../src/lib/providers/claude-auth-probe');
const { probeLifecycleOf } = require('../../src/lib/multi-account/probe-lifecycle');

const EMPTY = { type: 'exit', activeProcesses: 0, exitCode: 0 };
const STATUS = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  email: 'synthetic@example.invalid', subscriptionType: 'sample-plan' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function spawnSeam({ receipt = Promise.resolve(EMPTY), status = STATUS, exitCode = 0 } = {}) {
  let options;
  const spawnImpl = (_command, _args, value) => {
    options = value;
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.jobOutcome = receipt;
    let closed = false;
    const close = () => { if (!closed) { closed = true; child.emit('close', exitCode, null); } };
    child.kill = () => { setImmediate(close); return true; };
    child.terminateJob = async () => { close(); return receipt; };
    setImmediate(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(status))); close(); });
    return child;
  };
  return { spawnImpl, get options() { return options; } };
}

function probe(seam) {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-auth');
  return probeClaudeAuth({ capability: false, configDir: fixture, cwd: fixture,
    executable: { command: 'synthetic-claude', prefixArgs: [] }, baseEnvironment: { PATH: 'fixture-only' },
    spawnImpl: seam.spawnImpl, statusTimeoutMs: 25 });
}

test('auth status waits for owned tree cleanup after its direct CLI exits', async () => {
  const custody = deferred();
  const seam = spawnSeam({ receipt: custody.promise });
  let settled = false;
  const reading = probe(seam).then(result => { settled = true; return result; });
  await tick(); await tick();
  const settledBeforeCleanup = settled;
  custody.resolve(EMPTY);
  const result = await reading;
  assert.equal(settledBeforeCleanup, false, 'auth identity must not escape while its provider tree remains active');
  assert.equal(result.account, 'synthetic@example.invalid');
  assert.equal(result.capabilityRan, false);
  assert.equal(probeLifecycleOf(result), 'closed');
  assert.equal(seam.options.containProcessTree, true);
  assert.equal(seam.options.windowsHide, true);
});

test('auth rejects unproved cleanup with the same retained cleanup operation', async () => {
  const seam = spawnSeam({ receipt: Promise.resolve({ type: 'exit', activeProcesses: 1 }) });
  await assert.rejects(probe(seam), error => error.code === 'CODEX_PROCESS_CLEANUP_UNPROVEN'
    && typeof error.retryCleanup === 'function');
});

test('an oversized auth reply cannot supply a selectable identity or billing route', async () => {
  const seam = spawnSeam({ status: { ...STATUS, padding: 'x'.repeat(1024 * 1024) } });
  const result = await probe(seam);
  assert.equal(result.state, 'indeterminate');
  assert.equal(result.account, null);
  assert.equal(result.billingSource, null);
  assert.equal(result.usable, false);
  assert.equal(result.canFailover, false);
  assert.ok(JSON.stringify(result).length < 2048);
});

test('a caught auth spawn exception carries no invented never-started receipt', async () => {
  const result = await probe({ spawnImpl() { throw Object.assign(new Error('synthetic spawn failure'), { code: 'ENOENT' }); } });
  assert.equal(result.state, 'indeterminate');
  assert.equal(probeLifecycleOf(result), null);
});

test('a contradictory failed status command spends no allowance', async () => {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-auth');
  for (const exitCode of [1, 2]) {
    const seam = spawnSeam({ exitCode });
    const calls = [];
    const result = await probeClaudeAuth({ capability: true, configDir: fixture, cwd: fixture,
      executable: { command: 'synthetic-claude', prefixArgs: [] },
      baseEnvironment: { PATH: 'fixture-only' },
      spawnImpl(command, args, options) {
        calls.push(args);
        return seam.spawnImpl(command, args, options);
      } });
    assert.deepEqual(calls, [['auth', 'status', '--json']], 'failed status must not trigger a paid capability request');
    assert.equal(result.state, 'indeterminate');
    assert.equal(result.usable, false);
    assert.equal(result.canFailover, false);
    assert.equal(result.capabilityRan, false);
  }
});

test('a consistent successful status requires measured capability success for usability', async () => {
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-auth');
  const calls = [];
  const result = await probeClaudeAuth({ capability: true, configDir: fixture, cwd: fixture,
    executable: { command: 'synthetic-claude', prefixArgs: [] },
    baseEnvironment: { PATH: 'fixture-only' },
    spawnImpl(command, args, options) {
      calls.push(args);
      return spawnSeam({ status: calls.length === 1 ? STATUS : { type: 'result', is_error: false, result: 'ok' } })
        .spawnImpl(command, args, options);
    } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['auth', 'status', '--json']);
  assert.ok(calls[1].includes('--print'));
  assert.equal(result.state, 'authenticated');
  assert.equal(result.usable, true);
  assert.equal(result.capabilityRan, true);
});

test('native auth status observes the same selected API and cloud settings as a launch', async () => {
  const seam = spawnSeam({ status: { ...STATUS, apiKeySource: 'ANTHROPIC_API_KEY' } });
  const settings = { ANTHROPIC_API_KEY:'fixture', anthropic_auth_token:'fixture',
    CLAUDE_CODE_OAUTH_TOKEN:'fixture', CLAUDE_CODE_USE_VERTEX:'1',
    GOOGLE_APPLICATION_CREDENTIALS:'fixture-path', AWS_PROFILE:'fixture-profile' };
  const fixture = path.join(path.parse(process.cwd()).root, 'synthetic-claude-auth');
  const result = await probeClaudeAuth({ capability:false, configDir:fixture, cwd:fixture,
    executable:{command:'synthetic-claude',prefixArgs:[]},
    baseEnvironment:{PATH:'fixture-only',...settings}, spawnImpl:seam.spawnImpl });
  for (const [name,value] of Object.entries(settings)) {
    assert.ok(seam.options.env[name] === value, `Native status removed ${name}`);
  }
  assert.equal(result.billingSource,'api_key');
  assert.equal(result.capabilityRan,false);
  assert.equal(result.state,'indeterminate');
});
