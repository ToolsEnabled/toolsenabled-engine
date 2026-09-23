// EXECUTABLE CHANGE — testcanfail-tests-models-cli-session-usage-js
//
// DISCRIMINATING MUTATION: in a scratch copy, collectCliSessionUsage duplicated
// every emitted observation (`flatMap(item => [item, item])`). Before this
// change the complete test stayed green:
//   CLI session usage tests passed (dedup, cumulative-total, incremental cursor, content containment).
// The requiredObservation assertions below make that mutation red:
//   AssertionError [ERR_ASSERTION]: claude must emit exactly one observation
//   2 !== 1
// The scratch source was separate from src/, and the repository source remained
// byte-for-byte unchanged. The restored/unmutated green run is quoted below:
//   CLI session usage tests passed (dedup, cumulative-total, incremental cursor, content containment).
//
// SHAPE CENSUS: (1) NOT-FOUND — no loop/forEach assertion; (2) NOT-FOUND — no
// exit-status or truthy process-return assertion; (3) NOT-FOUND — no test-side
// try/catch or optional chain; (4) NOT-FOUND — no mock of the usage reader;
// (5) NOT-FOUND — no skip or platform precondition guard; (6) NOT-FOUND — no
// expected value computed by the production reader. Preconditions: all met.

'use strict';

// Proves the two local CLI usage readers against the exact record shapes those
// CLIs actually write, using synthetic fixtures rather than the owner's real
// transcripts. The two duplication hazards below are not hypothetical -- both
// were measured on this machine's real corpora on 2026-07-28 and both would
// silently inflate the dashboard if handled naively.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cliSessionUsage = require('../../src/lib/cli-session-usage');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-session-usage-'));
const claudeRoot = path.join(root, 'claude');
const codexRoot = path.join(root, 'codex');
fs.mkdirSync(path.join(claudeRoot, 'project-a'), { recursive: true });
fs.mkdirSync(path.join(codexRoot, '2026', '07', '28'), { recursive: true });

function writeLines(file, records) {
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function requiredObservation(result, provider) {
  const matches = result.observations.filter(item => item.provider === provider);
  assert.equal(matches.length, 1, `${provider} must emit exactly one observation`);
  return matches[0];
}

function claudeAssistant({ requestId, input, cacheCreate, cacheRead, output, entrypoint = 'claude-vscode', at = '2026-07-28T11:00:00.000Z' }) {
  return {
    type: 'assistant', requestId, timestamp: at, entrypoint, isSidechain: false,
    message: {
      id: requestId.replace('req_', 'msg_'), role: 'assistant', model: 'claude-opus-5',
      // Real transcripts carry the owner's prompts and the provider's prose
      // here. The reader must never look at it.
      content: [{ type: 'text', text: 'CLI_SESSION_CONTENT_CANARY_88117' }],
      usage: {
        input_tokens: input, cache_creation_input_tokens: cacheCreate,
        cache_read_input_tokens: cacheRead, output_tokens: output, service_tier: 'standard'
      }
    }
  };
}

// --- Claude Code -------------------------------------------------------------
//
// HAZARD: one assistant API response is written once per content block, so a
// reply with text plus N tool_use blocks appears as N+1 records carrying the
// IDENTICAL usage object. Measured on a real 20 MB session: 2,365 usage records
// for 1,150 unique requestIds, and naive summation over-counted output tokens
// 2.43x. Grouping by requestId is exact, not an approximation.
const claudeFile = path.join(claudeRoot, 'project-a', 'session-1.jsonl');
writeLines(claudeFile, [
  claudeAssistant({ requestId: 'req_001', input: 2, cacheCreate: 100, cacheRead: 1000, output: 30 }),
  claudeAssistant({ requestId: 'req_001', input: 2, cacheCreate: 100, cacheRead: 1000, output: 30 }),
  claudeAssistant({ requestId: 'req_001', input: 2, cacheCreate: 100, cacheRead: 1000, output: 30 }),
  { type: 'user', timestamp: '2026-07-28T11:00:01.000Z', message: { role: 'user', content: 'ignored' } },
  claudeAssistant({ requestId: 'req_002', input: 5, cacheCreate: 0, cacheRead: 2000, output: 40, at: '2026-07-28T11:05:00.000Z' }),
  // A broker-launched `claude -p` run writes into this same tree and is ALREADY
  // metered by the durable-run broker's lifecycle path. Counting it here too would
  // double count one real API call across two measurement sources.
  claudeAssistant({ requestId: 'req_003', input: 999, cacheCreate: 999, cacheRead: 999, output: 999, entrypoint: 'sdk-cli' })
]);

const first = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: {} });
const claude = requiredObservation(first, 'claude');
assert.equal(claude.operationCount, 2, 'three records for one requestId are one API call, and the sdk-cli record is excluded');
assert.equal(claude.reportedTokens, (2 + 100 + 1000 + 30) + (5 + 0 + 2000 + 40));
assert.equal(claude.durationMs, null, 'Claude Code records no latency, so duration stays unavailable rather than becoming zero');
assert.equal(claude.outputBytes, null, 'output bytes are never derived from transcript size');
assert.equal(claude.brokerExcluded, true, 'the entrypoint partition is what makes this source safe to add to the lifecycle meter');
assert.equal(claude.coverage, 'complete');
assert.equal(claude.window.startedAt, '2026-07-28T11:00:00.000Z');
assert.equal(claude.window.endedAt, '2026-07-28T11:05:00.000Z');

// --- Codex CLI ---------------------------------------------------------------
//
// HAZARD: `total_token_usage` is a running cumulative total and
// `last_token_usage` is the latest call's delta, and they disagree. On a real
// 966-line rollout, summing the deltas gave 13,318,969 against a final
// cumulative 13,163,589, because context-compaction calls report a delta the
// running total deliberately does not absorb. The cumulative field is
// authoritative; a decrease means a resumed thread restarted the counter.
function codexTokenEvent(total, last, at = '2026-07-28T11:10:00.000Z') {
  return {
    timestamp: at, type: 'event_msg',
    payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
      last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last },
      model_context_window: 258400
    } }
  };
}
const codexFile = path.join(codexRoot, '2026', '07', '28', 'rollout-2026-07-28T11-00-00-aaaa.jsonl');
writeLines(codexFile, [
  { timestamp: '2026-07-28T11:09:00.000Z', type: 'session_meta', payload: { cwd: 'ignored', cli_version: '1' } },
  codexTokenEvent(1000, 1000),
  codexTokenEvent(3000, 2000),
  // A compaction call: it reports a delta the cumulative total does not absorb.
  // Crediting that delta is exactly the over-count this reader must avoid.
  codexTokenEvent(3000, 500),
  codexTokenEvent(4500, 1500, '2026-07-28T11:20:00.000Z'),
  { timestamp: '2026-07-28T11:20:01.000Z', type: 'event_msg', payload: {
    type: 'task_complete', turn_id: 't1', duration_ms: 1757, time_to_first_token_ms: 1586,
    last_agent_message: 'CLI_SESSION_CONTENT_CANARY_88117'
  } }
]);

const second = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: {} });
const codex = requiredObservation(second, 'codex');
assert.equal(codex.reportedTokens, 4500, 'the authoritative cumulative total wins over the sum of per-call deltas');
assert.equal(codex.operationCount, 4);
assert.equal(codex.durationMs, 1757, 'Codex does record turn wall time, so that column is real');
assert.equal(codex.outputBytes, null);
assert.equal(codex.brokerExcluded, false, 'the rollout format has no discriminator for a broker-launched run');

// --- incremental re-reads ----------------------------------------------------
//
// The corpora are append-only and large (~1.4 GB of Claude transcripts, ~4.7 GB
// of Codex rollouts here), so runs are incremental. Re-running with the returned
// cursors must credit NOTHING, and appending must credit only the appended part
// -- including across the duplicate-group and cumulative-total boundaries that
// a naive offset cursor would get wrong.
const unchanged = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: second.cursors });
const unchangedClaude = requiredObservation(unchanged, 'claude');
assert.equal(unchangedClaude.operationCount, 0);
assert.equal(unchangedClaude.reportedTokens, null,
  'a scan that measured nothing reports null units, never a fabricated zero total');
const unchangedCodex = requiredObservation(unchanged, 'codex');
assert.equal(unchangedCodex.operationCount, 0);
assert.equal(unchangedCodex.reportedTokens, null);

// A duplicate of the LAST request id, appended after the cursor boundary, must
// still be recognised as the same API call.
fs.appendFileSync(claudeFile, `${JSON.stringify(claudeAssistant({ requestId: 'req_002', input: 5, cacheCreate: 0, cacheRead: 2000, output: 40 }))}\n`, 'utf8');
fs.appendFileSync(claudeFile, `${JSON.stringify(claudeAssistant({ requestId: 'req_004', input: 1, cacheCreate: 2, cacheRead: 3, output: 4 }))}\n`, 'utf8');
fs.appendFileSync(codexFile, `${JSON.stringify(codexTokenEvent(6000, 1500))}\n`, 'utf8');
const appended = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: second.cursors });
const appendedClaude = requiredObservation(appended, 'claude');
assert.equal(appendedClaude.operationCount, 1, 'a duplicate spanning the cursor boundary is still one API call');
assert.equal(appendedClaude.reportedTokens, 1 + 2 + 3 + 4);
const appendedCodex = requiredObservation(appended, 'codex');
assert.equal(appendedCodex.operationCount, 1);
assert.equal(appendedCodex.reportedTokens, 1500, 'only the cumulative increase since the cursor is credited');

// A trailing partial line (the live session file is being appended to right
// now) must be left for the next run rather than parsed half-written.
const partialCursors = appended.cursors;
fs.appendFileSync(claudeFile, '{"type":"assistant","requestId":"req_005","mess', 'utf8');
const partial = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: partialCursors });
assert.equal(requiredObservation(partial, 'claude').operationCount, 0);
fs.appendFileSync(claudeFile, `age":{"usage":{"input_tokens":7,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1},"id":"msg_005"},"timestamp":"2026-07-28T11:30:00.000Z","entrypoint":"claude-vscode"}\n`, 'utf8');
const completed = cliSessionUsage.collectCliSessionUsage({ nowMs: NOW, claudeRoot, codexRoot, cursors: partial.cursors });
const completedClaude = requiredObservation(completed, 'claude');
assert.equal(completedClaude.operationCount, 1);
assert.equal(completedClaude.reportedTokens, 8);

// --- content and identifier containment -------------------------------------
const serialized = JSON.stringify(appended.observations);
assert.doesNotMatch(serialized, /CLI_SESSION_CONTENT_CANARY_88117/, 'message content never leaves the reader');
assert.doesNotMatch(serialized, /req_|msg_|rollout-|\.jsonl|[A-Za-z]:\\/,
  'no request ids, transcript names, or filesystem paths appear in an observation');

// --- absent source is not zero -----------------------------------------------
const absent = cliSessionUsage.collectCliSessionUsage({
  nowMs: NOW, claudeRoot: path.join(root, 'nope-claude'), codexRoot: path.join(root, 'nope-codex'), cursors: {}
});
assert.equal(absent.observations.length, 0,
  'a CLI with no local record set at all emits no observation, so the projection keeps that provider unavailable instead of reporting a measured zero');

// --- audit-event round trip --------------------------------------------------
const event = {
  sequence: 5, timestamp: '2026-07-28T11:40:00.000Z',
  action: cliSessionUsage.CLI_SESSION_USAGE_ACTION, target: 'claude',
  details: requiredObservation(appended, 'claude')
};
const parsed = cliSessionUsage.usageFromAuditEvent(event);
assert.equal(parsed.provider, 'claude');
assert.equal(parsed.operationCount, 1);
assert.equal(parsed.reportedTokens, 10);
assert.equal(cliSessionUsage.usageFromAuditEvent({ ...event, action: 'something.else' }), null);
assert.equal(cliSessionUsage.usageFromAuditEvent({ ...event, details: { ...event.details, provider: 'gemini' } }), null,
  'only the two CLIs this reader actually understands may be attributed');
assert.equal(cliSessionUsage.usageFromAuditEvent({ ...event, details: { ...event.details, operationCount: -1 } }), null);
assert.equal(cliSessionUsage.usageFromAuditEvent({ ...event, details: { ...event.details, observationId: 'nope' } }), null,
  'without a well-formed observation id the same byte range could be counted twice');

fs.rmSync(root, { recursive: true, force: true });
console.log('CLI session usage tests passed (dedup, cumulative-total, incremental cursor, content containment).');
