/* Mutation check (2026-08-27): durable audit outcomes control recorded providers.
 * Exact mutation: changed `status.durable === true` to `status.durable === false`.
 * Mutation landed: yes (the edited expression was printed from the module).
 * Result: this isolated test went red with exit code 1.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CURSOR_FILE,
  DEFAULT_MIN_INTERVAL_MS,
  ingestCliSessionUsage
} = require('../src/lib/cli-session-usage-ingest');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-session-usage-ingest-'));
const claudeRoot = path.join(root, 'claude');
const codexRoot = path.join(root, 'codex');
const cursorFile = path.join(root, 'state', 'cursor.json');
const nowMs = Date.now();

fs.mkdirSync(claudeRoot, { recursive: true });
fs.mkdirSync(codexRoot, { recursive: true });
fs.writeFileSync(path.join(claudeRoot, 'session.jsonl'), `${JSON.stringify({
  type: 'assistant',
  requestId: 'request-one',
  timestamp: new Date(nowMs - 1000).toISOString(),
  entrypoint: 'claude-vscode',
  message: {
    id: 'message-one',
    usage: { input_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 5, output_tokens: 7 }
  }
})}\n`);
fs.writeFileSync(path.join(codexRoot, 'rollout.jsonl'), `${JSON.stringify({
  timestamp: new Date(nowMs - 500).toISOString(),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 19 } } }
})}\n`);

const calls = [];
const audit = {
  record(action, target, details) {
    calls.push({ action, target, details });
    return { durable: target === 'claude' };
  }
};

const result = ingestCliSessionUsage({
  audit, cursorFile, claudeRoot, codexRoot, nowMs, minIntervalMs: DEFAULT_MIN_INTERVAL_MS
});

assert.equal(path.basename(CURSOR_FILE), 'cli-usage-cursor.json');
assert.equal(DEFAULT_MIN_INTERVAL_MS, 300000);
assert.equal(result.ran, true);
assert.equal(result.recorded, 1, 'only durable audit writes count as recorded');
assert.deepEqual(result.failedProviders, ['codex']);
assert.deepEqual(calls.map(({ action, target }) => [action, target]), [
  ['controller.cli_session.usage', 'claude'],
  ['controller.cli_session.usage', 'codex']
]);
assert.equal(calls[0].details.reportedTokens, 17, 'the collected observation is passed to audit.record');
assert.equal(calls[1].details.reportedTokens, 19);
assert.ok(Object.isFrozen(result));
assert.ok(Object.isFrozen(result.observations));
assert.ok(Object.isFrozen(result.failedProviders));

const cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
assert.equal(cursor.version, 1);
assert.equal(cursor.lastRunAtMs, nowMs);
assert.ok(Object.keys(cursor.cursors.claude).length > 0, 'a durable provider advances its cursor');
assert.deepEqual(cursor.cursors.codex, {}, 'a failed provider retains its prior cursor so usage is retried');

const throttled = ingestCliSessionUsage({
  audit, cursorFile, claudeRoot, codexRoot, nowMs: nowMs + 1
});
assert.deepEqual(throttled, { ran: false, reason: 'throttled', observations: [], recorded: 0 });
assert.equal(calls.length, 2, 'a throttled call performs no audit writes');

fs.rmSync(root, { recursive: true, force: true });
console.log('cli-session-usage-ingest behavior tests passed');
