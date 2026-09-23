/* R73/OW31 paired structured-provider acceptance fixture.
 *
 * This is the engine half of tools/astra-native-acceptance.mjs. It exercises
 * the real Codex adapter against an in-process JSON-RPC peer, keeping provider
 * activity out of the run while asserting the exact structured model and
 * reasoningEffort fields a native app-server response supplies. The app-side
 * driver separately proves the real child-process transport and argv.
 */
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { CodexAdapter, CODEX_CLI_VERSION } = require('../../src/lib/agent-engine/codex-adapter');

const ENGINE_BASE_REF = 'f3d8bb3d81fb6a1868a13b2c4f1dbb1dafd0544c';

function exactEngineBaseGuard() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ENGINE_BASE_REF, head], { stdio: 'ignore' });
  } catch {
    assert.fail(`engine HEAD ${head} is not descended from reviewed pair ${ENGINE_BASE_REF}`);
  }
  return head;
}

class FixtureTransport {
  constructor() {
    this.writes = [];
    this.listeners = new Set();
  }

  write(line) {
    const request = JSON.parse(line);
    this.writes.push(request);
    if (request.method === 'initialize') {
      this.emit({ id: request.id, result: {
        userAgent: 'astra-native-acceptance-structured-fixture',
        codexHome: '/tmp/astra-native-acceptance',
        platformFamily: 'linux',
        platformOs: 'linux',
      } });
    }
  }

  onData(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message) {
    const line = `${JSON.stringify(message)}\n`;
    for (const listener of this.listeners) listener(line);
  }
}

function requestFor(transport, method) {
  const requests = transport.writes.filter(request => request.method === method);
  assert.equal(requests.length > 0, true, `fixture emitted no ${method} request`);
  return requests.at(-1);
}

async function main() {
  const engineHead = exactEngineBaseGuard();
  const transport = new FixtureTransport();
  const adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION, retryDelayMs: 0 });
  await adapter.initialize();

  const expected = [
    { name: 'astra-default', model: 'gpt-6-astra', effort: 'medium' },
    { name: 'astra-high', model: 'gpt-6-astra', effort: 'high' },
    { name: 'astra-max', model: 'gpt-6-astra', effort: 'max' },
    /* A non-Astra control prevents a hard-coded model assertion from looking
       like provider acceptance. The same parser must preserve Luna exactly. */
    { name: 'luna-control', model: 'gpt-5.6-luna', effort: 'medium' },
  ];

  for (const [index, item] of expected.entries()) {
    const pending = adapter.startThread({ model: item.model, approvalPolicy: 'never', sandbox: 'read-only' });
    const request = requestFor(transport, 'thread/start');
    assert.deepEqual(request.params, { model: item.model, approvalPolicy: 'never', sandbox: 'read-only' },
      `${item.name} changed the structured launch request`);
    transport.emit({ id: request.id, result: {
      thread: { id: `astra-native-acceptance-${index}` },
      model: item.model,
      reasoningEffort: item.effort,
    } });
    const started = await pending;
    assert.equal(started.threadId, `astra-native-acceptance-${index}`);
    assert.equal(started.model, item.model, `${item.name} lost the structured model field`);
    assert.equal(started.reasoningEffort, item.effort, `${item.name} lost the structured effort field`);
  }

  const beforeInvalid = transport.writes.length;
  await assert.rejects(
    adapter.startThread({ model: 'gpt-6-astra', effort: 'not-an-effort' }),
    error => error?.code === 'AGENT_ENGINE_CONTRACT_INVALID',
    'an unsupported effort must be refused before it reaches the provider',
  );
  assert.equal(transport.writes.length, beforeInvalid,
    'the unsupported effort reached the provider before validation');

  adapter.close();
  console.log(`Astra native structured fixture passed (engine ${engineHead}; medium/high/max + Luna control; invalid effort refused before transport).`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

