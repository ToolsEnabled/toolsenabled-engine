'use strict';

/* WHAT A SUBSCRIPTION CLI ACTUALLY PRINTS, AND WHAT THE GATEWAY MAKES OF IT.
 *
 * Every fake child below writes the output shape of the INSTALLED CLI it
 * stands in for (codex-cli 0.156 `exec --json` JSONL events, Claude Code
 * 2.1 `--print --output-format json`, Gemini CLI 0.58 `--output-format json`),
 * including the exact quota sentences those binaries carry. No provider is
 * started and no credential is read. */

require('../lib/isolated-environment').activate('cli-provider-gateway-output');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CliProviderGateway,
  RELEASE_REVIEW_GEMINI_MODEL,
  runArgv
} = require('../../src/lib/providers/cli-provider-gateway');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-provider-output-'));
let checks = 0;

function enabledState(name, provider) {
  const stateFile = path.join(root, name);
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    providers: { codex: provider === 'codex', claude: provider === 'claude', gemini: provider === 'gemini' },
    controlRevisions: { codex: 0, claude: 0, gemini: 0 },
    lastVerifiedAt: {},
    lastCheck: {}
  }));
  return stateFile;
}

/* A child that writes the given chunks (Buffers, so a chunk boundary can fall
   inside a multi-byte character exactly as a pipe read can), then exits. */
function scriptedChild({ stdout = [], stderr = [], code = 0, ignoreTerm = false, exitOnSignal = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGTERM' && ignoreTerm) return true;
    if (exitOnSignal) setImmediate(() => child.emit('close', null, signal));
    return true;
  };
  if (code !== null) {
    setImmediate(() => {
      for (const chunk of stdout) child.stdout.emit('data', chunk);
      for (const chunk of stderr) child.stderr.emit('data', chunk);
      setImmediate(() => child.emit('close', code));
    });
  }
  return child;
}

function gatewayFor(provider, child, { observer = null, extra = {} } = {}) {
  const stateFile = enabledState(`${provider}-${checks}-${Math.random().toString(16).slice(2)}.json`, provider);
  const gateway = new CliProviderGateway({
    stateFile,
    assertActive() {},
    auditRecord() { return { ok: true }; },
    executableFor: () => ({ command: `fake-${provider}`, prefixArgs: [] }),
    environmentFactory: () => ({ PATH: process.env.PATH || '' }),
    spawnImpl: () => child,
    ...extra
  });
  // The confinement/session environment is covered by its own suites; these
  // checks are about output handling, so the spawn environment is fixed.
  gateway.environmentFor = () => ({ PATH: process.env.PATH || '' });
  return { gateway, stateFile, observer };
}

function jsonl(events) {
  return events.map(event => `${JSON.stringify(event)}\n`).join('');
}

function savedCheck(stateFile, provider) {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { enabled: state.providers[provider], check: state.lastCheck[provider] || null };
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(error && error.message || error).split('\n')[0].slice(0, 300)}`);
  }
}

(async () => {
  await check('codex --json: a long tool trace does not push the final answer and usage out of the captured stream', async () => {
    // A read-only review legitimately runs commands; their aggregated output
    // arrives before the final agent_message. 200 KiB of it is ordinary.
    const bulky = 'x'.repeat(4000);
    const events = [{ type: 'thread.started', thread_id: 't-1' }, { type: 'turn.started' }];
    for (let index = 0; index < 50; index += 1) {
      events.push({ type: 'item.completed', item: { id: `item_${index}`, type: 'command_execution', command: 'cat file', aggregated_output: bulky, exit_code: 0, status: 'completed' } });
    }
    events.push({ type: 'item.completed', item: { id: 'item_final', type: 'agent_message', text: 'Final review: no blocking issues.' } });
    events.push({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 34, reasoning_output_tokens: 10 } });
    const stream = Buffer.from(jsonl(events), 'utf8');
    assert.ok(stream.length > 150 * 1024, 'fixture must exceed the old 48 KiB capture');
    // Delivered in pipe-sized pieces, as a real read would.
    const pieces = [];
    for (let offset = 0; offset < stream.length; offset += 65536) pieces.push(stream.subarray(offset, offset + 65536));
    const observed = [];
    const { gateway } = gatewayFor('codex', scriptedChild({ stdout: pieces }));
    const completion = await gateway.complete('codex', 'review', { terminalObserver: record => observed.push(record) });
    assert.equal(completion.responseText, 'Final review: no blocking issues.');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].outcome, 'success');
    assert.deepEqual(observed[0].usage, { reportedTokens: 1234, costMicros: null });
  });

  await check('codex --json: a stream with events but no agent_message is never returned as the answer', async () => {
    const stream = jsonl([
      { type: 'thread.started', thread_id: 't-2' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'thinking' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1 } }
    ]);
    const { gateway } = gatewayFor('codex', scriptedChild({ stdout: [Buffer.from(stream)] }));
    await assert.rejects(gateway.complete('codex', 'hello'), error => error?.code === 'PROVIDER_EMPTY_RESPONSE',
      'raw JSONL protocol events must not be presented as the provider answer');
  });

  await check('codex --json: a usage-limit turn.failed on stdout marks the account rate limited', async () => {
    const message = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:12 PM.";
    const stream = jsonl([
      { type: 'thread.started', thread_id: 't-3' },
      { type: 'turn.started' },
      { type: 'error', message },
      { type: 'turn.failed', error: { message } }
    ]);
    const { gateway, stateFile } = gatewayFor('codex', scriptedChild({ stdout: [Buffer.from(stream)], code: 1 }));
    await assert.rejects(gateway.complete('codex', 'hello'),
      error => error?.code === 'PROVIDER_UNUSABLE' && /rate limited|usage limit/i.test(error.message));
    const saved = savedCheck(stateFile, 'codex');
    assert.equal(saved.enabled, false);
    assert.equal(saved.check?.status, 'rate_limited');
  });

  await check('claude: the CLI\'s "You\'ve hit your limit" result is a rate limit, not a sign-in problem', async () => {
    const result = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true,
      result: "You've hit your limit · resets 3pm (America/Los_Angeles)",
      usage: { input_tokens: 0, output_tokens: 0 }
    });
    const { gateway, stateFile } = gatewayFor('claude', scriptedChild({ stdout: [Buffer.from(result)], code: 1 }));
    await assert.rejects(gateway.complete('claude', 'hello'), error => error?.code === 'PROVIDER_UNUSABLE');
    assert.equal(savedCheck(stateFile, 'claude').check?.status, 'rate_limited');
  });

  await check('gemini: "You have exhausted your daily quota" is a rate limit', async () => {
    const identity = { ok: true, identity: { email: 'owner@example.com', authType: 'oauth-personal' }, durationMs: 1 };
    const { gateway, stateFile } = gatewayFor('gemini', scriptedChild({
      stderr: [Buffer.from('Error when talking to Gemini API: You have exhausted your daily quota on this model.\n')],
      code: 1
    }), { extra: { geminiAbout: async () => identity, googleAccountEmail: () => 'owner@example.com' } });
    await assert.rejects(gateway.complete('gemini', 'hello', { model: RELEASE_REVIEW_GEMINI_MODEL }),
      error => error?.code === 'PROVIDER_UNUSABLE');
    assert.equal(savedCheck(stateFile, 'gemini').check?.status, 'rate_limited');
  });

  await check('an unclassified completion failure keeps the provider on and does not send the person to sign in', async () => {
    const message = 'stream disconnected before completion: error sending request for url';
    const stream = jsonl([{ type: 'thread.started', thread_id: 't-4' }, { type: 'turn.failed', error: { message } }]);
    const { gateway, stateFile } = gatewayFor('codex', scriptedChild({ stdout: [Buffer.from(stream)], code: 1 }));
    await assert.rejects(gateway.complete('codex', 'hello'), error => error?.code === 'PROVIDER_FAILED'
      && !/sign in|readiness check/i.test(error.message));
    const saved = savedCheck(stateFile, 'codex');
    assert.equal(saved.enabled, true, 'a transient failure must not turn the provider off');
    assert.equal(saved.check, null);
  });

  await check('turning Grok On is refused by name, before any child or saved-control change', async () => {
    let spawns = 0;
    const stateFile = enabledState('grok-on.json', 'codex');
    const before = fs.readFileSync(stateFile, 'utf8');
    const gateway = new CliProviderGateway({
      stateFile,
      assertActive() {},
      auditRecord() { return { ok: true }; },
      executableFor: () => ({ command: 'fake-grok', prefixArgs: [] }),
      spawnImpl: () => { spawns += 1; return scriptedChild({ stdout: [Buffer.from('grok 1.0.0\n')] }); }
    });
    gateway.environmentFor = () => ({ PATH: process.env.PATH || '' });
    await assert.rejects(gateway.setEnabled('grok', true), error => error?.code === 'PROVIDER_TEXT_ROUTE_UNSUPPORTED');
    await assert.rejects(gateway.complete('grok', 'hello'), error => error?.code === 'PROVIDER_TEXT_ROUTE_UNSUPPORTED');
    assert.equal(spawns, 0, 'no provider child may start for a route that does not exist');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'the saved controls must be untouched');
    // Off stays available for every known provider.
    const off = await gateway.setEnabled('grok', false);
    assert.equal(off.enabled, false);
  });

  await check('a multi-byte character split across two pipe reads reaches the answer intact', async () => {
    const answer = 'Price: 42€ — déjà vu 🚀';
    const document = Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: answer }), 'utf8');
    const euro = document.indexOf(Buffer.from('€', 'utf8'));
    assert.ok(euro > 0);
    // Split inside the three-byte euro sign.
    const { gateway } = gatewayFor('claude', scriptedChild({ stdout: [document.subarray(0, euro + 1), document.subarray(euro + 1)] }));
    const completion = await gateway.complete('claude', 'hello');
    assert.equal(completion.responseText, answer);
    assert.ok(!completion.responseText.includes('�'));
  });

  await check('a timed-out child that ignores SIGTERM is killed, not left running', async () => {
    const child = scriptedChild({ code: null, ignoreTerm: true });
    const result = await runArgv('fake', [], {
      timeoutMs: 20,
      killGraceMs: 30,
      spawnImpl: () => child,
      cwd: root,
      env: {}
    });
    assert.equal(result.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  });

  await check('a child that exits on SIGTERM is not sent SIGKILL', async () => {
    const child = scriptedChild({ code: null });
    const controller = new AbortController();
    const pending = runArgv('fake', [], { timeoutMs: 5000, killGraceMs: 30, signal: controller.signal, spawnImpl: () => child, cwd: root, env: {} });
    setTimeout(() => controller.abort(), 5);
    const result = await pending;
    assert.equal(result.cancelled, true);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(child.signals, ['SIGTERM']);
  });

  if (failures.length) throw new Error(`${failures.length} output-handling check(s) failed: ${failures.join(' | ')}`);
  console.log(`CLI provider gateway output-handling tests passed (${checks} checks; no provider was started).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
