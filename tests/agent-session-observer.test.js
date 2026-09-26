'use strict';

// Behavioural coverage for the public observer: use real JSONL files and call
// the exported API rather than asserting implementation text or private helpers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const observer = require('../src/lib/agent-session-observer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-session-observer-'));
const claudeRoot = path.join(root, 'claude');
const codexRoot = path.join(root, 'codex');
fs.mkdirSync(claudeRoot, { recursive: true });
fs.mkdirSync(codexRoot, { recursive: true });

function jsonl(file, records) {
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  process.stdout.write(`  ok ${label}\n`);
}

try {
  jsonl(path.join(claudeRoot, '123e4567-e89b-42d3-a456-426614174000.jsonl'), [{
    type: 'assistant', timestamp: '2026-08-27T10:00:00.000Z',
    sessionId: '123e4567-e89b-42d3-a456-426614174000', entrypoint: 'claude-vscode',
    version: '2.1.0', gitBranch: 'feature/observer', cwd: '/private/work/alpha', effort: 'high',
    message: { model: 'claude-opus-4-1', usage: { service_tier: 'standard' }, content: 'SECRET-MUST-NOT-ESCAPE' }
  }]);
  jsonl(path.join(codexRoot, 'rollout-fixture.jsonl'), [
    { type: 'session_meta', timestamp: '2026-08-27T11:00:00.000Z', payload: {
      id: '223e4567-e89b-42d3-a456-426614174000', originator: 'Codex Desktop',
      thread_source: 'user', agent_path: 'root', cli_version: '1.2.3', cwd: '/private/work/beta',
      git: { branch: 'main' }
    } },
    { type: 'turn_context', timestamp: '2026-08-27T11:01:00.000Z', payload: {
      model: 'gpt-5.6-terra', effort: 'medium', content: 'SECOND-SECRET-MUST-NOT-ESCAPE'
    } }
  ]);

  const result = observer.observeAgentSessions({
    claudeRoot, codexRoot, nowMs: Date.parse('2026-08-27T12:00:00.000Z')
  });

  check('real Claude and Codex JSONL sessions are observed newest first', () => {
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.sessions.map(session => session.provider), ['codex', 'claude']);
    assert.deepEqual(result.scans.map(scan => scan.filesRead), [1, 1]);
  });

  check('Codex metadata, model, effort, kind, and recorded cost tier are projected', () => {
    const codex = result.sessions[0];
    assert.equal(codex.sessionId, '223e4567-e89b-42d3-a456-426614174000');
    assert.equal(codex.surface, 'codex-desktop');
    assert.equal(codex.workspace, 'beta');
    assert.equal(codex.kind, 'interactive');
    assert.equal(codex.model, 'gpt-5.6-terra');
    assert.equal(codex.effort, 'medium');
    assert.equal(codex.typeLabel, 'gpt-5.6-terra (medium)');
    assert.equal(codex.costTier, 'standard');
  });

  check('Claude metadata is projected while an unmapped model remains honestly unknown', () => {
    const claude = result.sessions[1];
    assert.equal(claude.kind, 'interactive');
    assert.equal(claude.workspace, 'alpha');
    assert.equal(claude.model, 'claude-opus-4-1');
    assert.equal(claude.effort, 'high');
    assert.equal(claude.serviceTier, 'standard');
    assert.equal(claude.costTier, 'unknown');
    assert.match(claude.costTierReason, /no product tier mapping for Anthropic/);
  });

  check('free-form message content never escapes into the observation', () => {
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /SECRET-MUST-NOT-ESCAPE/);
    assert.doesNotMatch(serialized, /SECOND-SECRET-MUST-NOT-ESCAPE/);
  });

  check('the exported cost lookup accepts explicit overrides and rejects invented tiers', () => {
    assert.equal(observer.costTierForModel('codex', 'custom', { custom: 'cheap' }).costTier, 'cheap');
    assert.equal(observer.costTierForModel('codex', 'custom', { custom: 'free' }).costTier, 'unknown');
    assert.equal(observer.costTierForModel('codex', null).costTierReason,
      'no model id was observed in the scanned window');
  });

  check('a busy session root is could-not-tell, is not absence, and is not latched', () => {
    const originalStatSync = fs.statSync;
    const busyRoot = path.join(root, 'temporarily-busy');
    fs.mkdirSync(busyRoot);
    let busy = true;
    fs.statSync = function statSync(file, ...args) {
      if (file === busyRoot && busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return originalStatSync.call(this, file, ...args);
    };
    try {
      const unavailable = observer.observeAgentSessions({ claudeRoot: busyRoot, codexRoot, nowMs: Date.parse('2026-08-27T12:00:00.000Z') });
      assert.equal(unavailable.scans[0].rootPresent, null);
      assert.equal(unavailable.scans[0].inspectionErrorCode, observer.ROOT_INSPECTION_FAILED);
      assert.match(unavailable.coverageNotes[0], /does NOT claim the root is absent/);

      busy = false;
      const retried = observer.observeAgentSessions({ claudeRoot: busyRoot, codexRoot, nowMs: Date.parse('2026-08-27T12:00:00.000Z') });
      assert.equal(retried.scans[0].rootPresent, true, 'a transient inspection failure must not be cached or latched');
      assert.equal(retried.scans[0].inspectionErrorCode, null);

      const absent = observer.observeAgentSessions({ claudeRoot: path.join(root, 'genuinely-absent'), codexRoot, nowMs: Date.parse('2026-08-27T12:00:00.000Z') });
      assert.equal(absent.scans[0].rootPresent, false, 'ENOENT keeps the pre-existing absent answer');
      assert.equal(absent.scans[0].inspectionErrorCode, null);
      assert.strictEqual(require('../src/lib/agent-session-observer'), observer, 'Node still caches the successfully loaded observer module');
    } finally {
      fs.statSync = originalStatSync;
    }
  });

  check('selected saved IDs are read before the file cap and do not open unrelated or renamed conversations', () => {
    const selectedRoot = path.join(root, 'selected'); fs.mkdirSync(selectedRoot);
    const id = '323e4567-e89b-42d3-a456-426614174000';
    const requested = path.join(selectedRoot, `rollout-old-${id}.jsonl`);
    jsonl(requested, [{ type: 'session_meta', payload: { id, thread_source: 'user', originator: 'codex_cli_rs' } }]);
    fs.utimesSync(requested, new Date('2020-01-01'), new Date('2020-01-01'));
    jsonl(path.join(selectedRoot, 'rollout-unrelated.jsonl'), [{ type: 'session_meta', payload: { id: '423e4567-e89b-42d3-a456-426614174000' } }]);
    const captured = [];
    const selected = observer.observeAgentSessions({ providers: ['codex'], codexRoot: selectedRoot,
      selectedSessionIds: [id], maxFiles: 1, onSource: file => captured.push(file) });
    assert.deepEqual(selected.sessions.map(row => row.sessionId), [id]);
    assert.deepEqual(captured, [requested]);
    assert.equal(selected.scans[0].filesRead, 1);
    jsonl(requested, [{ type: 'session_meta', payload: { id: '423e4567-e89b-42d3-a456-426614174000' } }]);
    const renamed = observer.observeAgentSessions({ providers: ['codex'], codexRoot: selectedRoot, selectedSessionIds: [id] });
    assert.equal(renamed.sessions.length, 0);
    assert.equal(renamed.coverage, 'partial');
  });

  check('selected lookup accepts identifiers only and stays bounded', () => {
    for (const value of [[], ['../other/account'], ['not-a-uuid'], Array(9).fill('323e4567-e89b-42d3-a456-426614174000')]) {
      assert.throws(() => observer.observeAgentSessions({ selectedSessionIds: value }), /saved session identifiers/);
    }
  });

  console.log(`agent-session-observer tests passed (${checks} behavioural checks)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
