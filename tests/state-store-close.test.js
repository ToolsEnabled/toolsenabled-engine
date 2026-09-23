'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.resolve(__dirname, '../src/lib/state-store.js');

function nativeCase(t, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'state-close-native-'));
  const databaseFile = path.join(directory, 'state', 'toolsenabled.sqlite3');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const api = require(process.argv[1]);
    const file = process.argv[2];
    const sealed = action => assert.throws(action, error => error.code === 'STATE_STORE_CLOSED');
    ${body}
    console.log('native-state-close-passed');
  `, modulePath, databaseFile], {
    cwd: directory,
    env: { ...process.env, TOOLSENABLED_STATE_ROOT: directory, TOOLSENABLED_STATE_PATH: databaseFile },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.signal, null, run.stderr);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /native-state-close-passed/);
}

test('ordinary singleton close releases the actual SQLite handle and preserves reopen behavior', t => nativeCase(t, `
  const store = api.getStateStore();
  store.setMemory({ namespace: 'reset-test', key: 'retained', value: 'durable content' });
  const connection = store._db;
  assert.ok(fs.existsSync(file + '-wal'));
  assert.equal(api.closeStateStore(), true);
  assert.equal(api.closeStateStore(), false);
  assert.throws(() => connection.prepare('SELECT 1').get());
  assert.equal(fs.existsSync(file + '-wal'), false);
  assert.equal(fs.existsSync(file + '-shm'), false);
  assert.equal(store.getMemory({ namespace: 'reset-test', key: 'retained' }).value, 'durable content');
  assert.equal(store.close(), true);
  assert.equal(api.getStateStore().getMemory({ namespace: 'reset-test', key: 'retained' }).value, 'durable content');
  assert.equal(api.closeStateStore(), true);
`));

test('terminal close releases native WAL ownership and rejects cached readers and later singleton lookup after deletion', t => nativeCase(t, `
  const store = api.getStateStore();
  store.setMemory({ namespace: 'reset-test', key: 'retained', value: 'durable content' });
  const connection = store._db;
  assert.ok(fs.statSync(file + '-wal').size > 0);
  assert.deepEqual(api.sealAndCloseStateStore(), { ok: true, closed: true });
  assert.throws(() => connection.prepare('SELECT 1').get());
  assert.equal(fs.existsSync(file + '-wal'), false);
  assert.equal(fs.existsSync(file + '-shm'), false);
  fs.rmSync(path.dirname(file), { recursive: true });
  sealed(() => store.getMemory({ namespace: 'reset-test', key: 'retained' }));
  sealed(() => store.setMemory({ namespace: 'reset-test', key: 'late', value: 'must not be written' }));
  sealed(() => store.transaction(() => assert.fail('a late transaction must never run')));
  sealed(() => api.getStateStore());
  assert.deepEqual(api.sealAndCloseStateStore(), { ok: true, closed: false });
  assert.equal(api.closeStateStore(), false);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'late operations must not resurrect the directory');
`));

test('terminal close of an unopened singleton creates no database and remains sealed on repeat', t => nativeCase(t, `
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.deepEqual(api.sealAndCloseStateStore(), { ok: true, closed: false });
  assert.deepEqual(api.sealAndCloseStateStore(), { ok: true, closed: false });
  sealed(() => api.getStateStore());
  assert.equal(api.closeStateStore(), false);
  assert.equal(fs.existsSync(path.dirname(file)), false);
`));

test('failed native terminal close retains the connection for cleanup while cached reads and writes stay sealed', t => nativeCase(t, `
  const store = api.getStateStore();
  store.setMemory({ namespace: 'reset-test', key: 'retained', value: 'durable content' });
  const connection = store._db;
  const nativeClose = connection.close.bind(connection);
  connection.close = () => { throw new Error('fixture native close failure'); };
  assert.throws(() => api.sealAndCloseStateStore(), /fixture native close failure/);
  assert.equal(store._db, connection, 'failed close must retain the actual handle');
  assert.equal(connection.prepare('SELECT 1 AS value').get().value, 1);
  assert.ok(fs.existsSync(file + '-wal'));
  sealed(() => store.getMemory({ namespace: 'reset-test', key: 'retained' }));
  sealed(() => store.ensureOpen());
  sealed(() => store.transaction(() => assert.fail('failed close must still seal transactions')));
  sealed(() => api.getStateStore());
  assert.throws(() => api.sealAndCloseStateStore(), /fixture native close failure/);
  assert.equal(store._db, connection);
  connection.close = nativeClose;
  assert.equal(api.closeStateStore(), true, 'later cleanup must still be able to release the retained connection');
  assert.throws(() => connection.prepare('SELECT 1').get());
  assert.equal(fs.existsSync(file + '-wal'), false);
  assert.equal(fs.existsSync(file + '-shm'), false);
  assert.deepEqual(api.sealAndCloseStateStore(), { ok: true, closed: false });
  fs.rmSync(path.dirname(file), { recursive: true });
  sealed(() => store.ensureOpen());
  sealed(() => api.getStateStore());
  assert.equal(fs.existsSync(path.dirname(file)), false);
`));

// The continuation adapter uses the real, explicitly scoped SQLite store. Keep
// these lifecycle tests in this existing suite so recovery remains part of the
// source census and is exercised on both native platforms.
const continuationApi = require('../src/lib/agent-continuation-state');
function continuationFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-native-'));
  const file = path.join(directory, 'continuation.sqlite3');
  let stamp = 100000;
  const opened = [];
  const settings = { file, now: () => stamp, leaseMs: 1000, baseDelayMs: 1000, maxDelayMs: 4000, ...options };
  const open = () => { const store = continuationApi.createContinuationState(settings); opened.push(store); return store; };
  t.after(() => { for (const store of opened) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const descriptor = { sessionId: 'host-original', resumeThreadId: 'provider-thread', resumeThreadProvider: 'codex',
    resumeAccount: 'synthetic-account', cwd: directory, tier: 'codex-medium', effort: 'medium',
    requestKeys: { threadId: 'circle', treeAnchors: ['tree', 'circle'] },
    treeIdentity: { selfName: 'Worker', managerName: 'Coordinator' }, profileId: 'synthetic-profile',
    roleBinding: { id: 'worker', agentId: 'worker-seat', expectedOrgRevision: 2, expectedRoleRevision: 3 }, agentId: 'worker-seat' };
  return { file, descriptor, open, store: open(), advance: amount => { stamp += amount; }, now: () => stamp };
}
function readyContinuation(fixture) {
  const begun = fixture.store.begin(fixture.store.track(fixture.descriptor));
  return fixture.store.success(begun, { checkpoint: { taskId: 'T123', fingerprint: 'a'.repeat(64), unchanged: 2 } });
}

test('continuation intent and progress survive actual database close and process reopen without default state', t => {
  const f = continuationFixture(t);
  const ready = readyContinuation(f);
  f.store.close();
  const script = `
    const assert = require('node:assert/strict');
    const api = require(process.argv[1]);
    const store = api.createContinuationState({file:process.argv[2],now:()=>102000});
    const rows = store.dueRecoveries();
    assert.equal(rows.length,1); assert.equal(rows[0].status,'ready');
    assert.equal(rows[0].descriptor.sessionId,'host-original');
    assert.equal(rows[0].descriptor.resumeThreadId,'provider-thread');
    assert.equal(rows[0].descriptor.roleBinding.expectedRoleRevision,3);
    assert.deepEqual(rows[0].checkpoint,{taskId:'T123',fingerprint:'a'.repeat(64),unchanged:2});
    assert.equal(Object.hasOwn(rows[0],'claimId'),false);
    store.close(); console.log('continuation-reopened');
  `;
  const run = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../src/lib/agent-continuation-state.js'), f.file],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /continuation-reopened/);
  const reopened = f.open();
  assert.equal(reopened.get(ready.key).revision, ready.revision);
  assert.throws(() => f.store.get(ready.key), { code: 'CONTINUATION_CLOSED' });
});

test('one durable claim wins competing native processes and redacted status cannot impersonate its lease', async t => {
  const f = continuationFixture(t);
  const ready = readyContinuation(f);
  f.advance(1000);
  const { spawn } = require('node:child_process');
  const script = `
    const api = require(process.argv[1]);
    const store=api.createContinuationState({file:process.argv[2],now:()=>101000});
    const row=store.get(process.argv[3]);
    const claim=store.claim(row); console.log(JSON.stringify(claim)); store.close();
  `;
  const compete = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, path.resolve(__dirname, '../src/lib/agent-continuation-state.js'), f.file, ready.key], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const winners = (await Promise.all([compete(), compete()])).filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].status, 'claimed');
  const publicRow = f.store.get(ready.key);
  assert.throws(() => f.store.begin(publicRow), { code: 'CONTINUATION_FENCE_LOST' });
  assert.throws(() => f.store.success({ ...publicRow, status: 'idle' }), { code: 'CONTINUATION_FENCE_LOST' });
  const running = f.store.begin(winners[0]);
  assert.equal(running.status, 'running');
});

test('Stop persists across new session IDs on the same circle and defeats stale success, retry and heartbeat', t => {
  const f = continuationFixture(t);
  const running = f.store.begin(f.store.track(f.descriptor));
  const other = f.open();
  const stopped = other.stop(running.key);
  assert.equal(stopped.status, 'stopped');
  for (const action of [() => f.store.success(running), () => f.store.heartbeat(running),
    () => f.store.failed(running, { code: 'ECONNRESET' }, { retrySafe: true })]) {
    assert.throws(action, { code: 'CONTINUATION_FENCE_LOST' });
  }
  f.store.close();
  const reopened = f.open();
  const resumedDescriptor = { ...f.descriptor, sessionId: 'host-new' };
  assert.equal(reopened.track(resumedDescriptor).status, 'stopped');
  assert.deepEqual(reopened.dueRecoveries({ includeUncertain: true }), []);
  const manual = reopened.track(resumedDescriptor, { resume: true });
  assert.equal(manual.status, 'idle');
  assert.equal(manual.key, stopped.key);
  assert.equal(manual.descriptor.sessionId, 'host-new');
  assert.ok(manual.fence > stopped.fence);
  assert.equal(reopened.begin(manual).status, 'running');
});

test('unused claims recover but interrupted dispatch requires exact-thread terminal reconciliation', t => {
  const f = continuationFixture(t);
  const ready = readyContinuation(f);
  f.advance(1000);
  const unused = f.store.claim(f.store.get(ready.key));
  f.advance(1001);
  const recoveredUnused = f.store.dueRecoveries();
  assert.equal(recoveredUnused.length, 1);
  assert.equal(recoveredUnused[0].reason, 'unused_claim_expired');
  assert.throws(() => f.store.begin(unused), { code: 'CONTINUATION_FENCE_LOST' });
  const running = f.store.begin(f.store.claim(recoveredUnused[0]));
  f.advance(1001);
  assert.deepEqual(f.store.dueRecoveries(), []);
  const [uncertain] = f.store.dueRecoveries({ includeUncertain: true });
  assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.action, 'reconcile');
  assert.throws(() => f.store.success(running), { code: 'CONTINUATION_FENCE_LOST' });
  const claim = f.store.claim(uncertain);
  assert.equal(claim.status, 'reconciling');
  assert.throws(() => f.store.begin(claim), { code: 'CONTINUATION_FENCE_LOST' });
  assert.throws(() => f.store.reconcile(claim, { observedThreadId: 'another-thread', terminalStatus: 'completed' }), { code: 'CONTINUATION_RECONCILE_REFUSED' });
  assert.throws(() => f.store.reconcile(claim, { observedThreadId: 'provider-thread', terminalStatus: 'running' }), { code: 'CONTINUATION_RECONCILE_REFUSED' });
  const resolved = f.store.reconcile(claim, { observedThreadId: 'provider-thread', terminalStatus: 'completed' });
  assert.equal(resolved.status, 'ready'); assert.equal(resolved.reason, 'turn_completed');
  assert.equal(resolved.checkpoint.unchanged, 2, 'restart must retain the no-progress ratchet');
  assert.deepEqual(f.store.dueRecoveries(), []);
});

test('expired reconciliation remains uncertain and cancellation observed in the saved thread persists Stop', t => {
  const f = continuationFixture(t);
  const begun = f.store.begin(f.store.track(f.descriptor));
  f.advance(1001);
  const first = f.store.claim(f.store.dueRecoveries({ includeUncertain: true })[0]);
  f.advance(1001);
  assert.deepEqual(f.store.dueRecoveries(), []);
  assert.throws(() => f.store.reconcile(first, { observedThreadId: f.descriptor.resumeThreadId, terminalStatus: 'completed' }), { code: 'CONTINUATION_FENCE_LOST' });
  const next = f.store.claim(f.store.dueRecoveries({ includeUncertain: true })[0]);
  assert.equal(f.store.reconcile(next, { observedThreadId: f.descriptor.resumeThreadId, terminalStatus: 'cancelled' }).status, 'stopped');
  assert.ok(f.store.get(begun.key).fence > begun.fence);
});

test('safe transient retries retain exponential backoff and attempt budget across close/reopen', t => {
  const f = continuationFixture(t, { maxRetries: 3 });
  let store = f.store;
  let handle = store.begin(store.track(f.descriptor));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    handle = store.failed(handle, { code: 'ECONNRESET', message: 'not persisted' }, { retrySafe: true });
    assert.equal(handle.status, 'retry_wait'); assert.equal(handle.retries, attempt);
    const delay = [1000, 2000, 4000][attempt - 1];
    assert.equal(handle.dueAtMs, f.now() + delay);
    assert.deepEqual(store.dueRecoveries(), []);
    store.close(); store = f.open(); f.advance(delay);
    handle = store.begin(store.claim(store.dueRecoveries()[0]));
  }
  handle = store.failed(handle, { code: 'ECONNRESET' }, { retrySafe: true });
  assert.equal(handle.status, 'blocked'); assert.equal(handle.reason, 'retry_limit'); assert.equal(handle.retries, 3);
  assert.deepEqual(store.dueRecoveries({ includeUncertain: true }), []);
  assert.equal(store.track(f.descriptor).status, 'blocked');
});

test('default autonomous recovery spans a brief service outage and keeps its finite budget after restart', t => {
  const f = continuationFixture(t, { baseDelayMs: undefined, maxDelayMs: undefined });
  let store = f.store;
  let handle = store.begin(store.track(f.descriptor));
  for (const delay of [15000, 30000, 60000, 120000, 120000]) {
    handle = store.failed(handle, { code: 'SERVICE_UNAVAILABLE' }, { retrySafe: true });
    assert.equal(handle.status, 'retry_wait');
    assert.equal(handle.dueAtMs, f.now() + delay);
    store.close(); store = f.open();
    f.advance(delay - 1);
    assert.deepEqual(store.dueRecoveries(), []);
    f.advance(1);
    handle = store.begin(store.claim(store.dueRecoveries()[0]));
  }
  handle = store.failed(handle, { code: 'SERVICE_UNAVAILABLE' }, { retrySafe: true });
  assert.equal(handle.status, 'blocked');
  assert.equal(handle.reason, 'retry_limit');
  assert.equal(handle.retries, 5);
});

test('authentication, quota, cancellation and ambiguous failures never become retryable from a generic flag', t => {
  const f = continuationFixture(t);
  const failures = [{ code: 'ECONNRESET', status: 401 }, { code: 'ECONNRESET', status: 429 },
    { code: 'AUTH_REQUIRED' }, { code: 'QUOTA_EXCEEDED' }, { code: 'ABORT_ERR' }, { code: 'UNKNOWN', retryable: true },
    { code: 'ETIMEDOUT', retrySafe: false }];
  for (let index = 0; index < failures.length; index += 1) {
    const row = f.store.track({ ...f.descriptor, sessionId: `case-${index}`, requestKeys: null });
    const result = f.store.failed(row, failures[index], { retrySafe: failures[index].retrySafe !== false });
    assert.equal(result.status, 'blocked'); assert.equal(result.retries, 0);
  }
  assert.equal(continuationApi.classifyFailure({ code: 'ETIMEDOUT' }).retry, false);
  assert.deepEqual(f.store.dueRecoveries(), []);
});

test('lease heartbeat, checkpoint CAS and descriptor updates retain exact scope and reject stale writers', t => {
  const f = continuationFixture(t);
  let handle = f.store.begin(f.store.track(f.descriptor));
  const stale = handle;
  f.advance(800);
  handle = f.store.heartbeat(handle);
  assert.equal(handle.leaseUntilMs, f.now() + 1000);
  assert.throws(() => f.store.success(stale), { code: 'CONTINUATION_FENCE_LOST' });
  const checkpoint = { taskId: 'T456', fingerprint: 'b'.repeat(64), unchanged: 3 };
  handle = f.store.save(handle, { checkpoint, descriptor: { ...f.descriptor, resumeThreadId: 'new-confirmed-thread' } });
  assert.deepEqual(handle.checkpoint, checkpoint);
  assert.throws(() => f.store.save(handle, { descriptor: { ...f.descriptor, requestKeys: { threadId: 'other', treeAnchors: ['tree', 'other'] } } }), { code: 'CONTINUATION_INVALID' });
  assert.equal(f.store.success(handle).descriptor.resumeThreadId, 'new-confirmed-thread');
});

test('engagement survives reopen with a rollback-compatible checkpoint and rejects partial evidence', t => {
  const f = continuationFixture(t);
  let row = readyContinuation(f);
  const progress = { ...row.checkpoint, engagementTaskId: 'T122', engagementHostId: f.descriptor.sessionId };
  for (const patch of [{ engagementTaskId: 'T122' }, { engagementHostId: f.descriptor.sessionId }]) {
    assert.throws(() => f.store.save(row, { checkpoint: { ...row.checkpoint, ...patch } }), { code: 'CONTINUATION_INVALID' });
  }
  row = f.store.save(row, { checkpoint: progress });
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.get(row.key).checkpoint, progress);
  const raw = require('../src/lib/state-store').createStateStore({ file: f.file, clock: f.now });
  try {
    const value = raw.getMemory({ namespace: 'agent.continuation.v1', key: row.key }).value;
    assert.deepEqual(Object.keys(value.checkpoint).sort(), ['fingerprint', 'taskId', 'unchanged'], 'older engines retain their exact checkpoint schema');
    assert.deepEqual(value.engagement, { taskId: 'T122', hostId: f.descriptor.sessionId });
  } finally { raw.close(); }
  assert.equal(reopened.track(f.descriptor, { resume: true }).checkpoint, null, 'a new person episode drops the evidence');
});

test('continuation persistence refuses implicit files, authority fields, plaintext secrets and corrupted durable values', t => {
  assert.throws(() => continuationApi.createContinuationState(), { code: 'CONTINUATION_INVALID' });
  assert.throws(() => continuationApi.createContinuationState({ file: 'relative.sqlite3' }), { code: 'CONTINUATION_INVALID' });
  const f = continuationFixture(t);
  for (const field of ['credentials', 'delegationPermit', 'boundedWorkPermit', 'agentAuthority', 'acknowledgeLowMemory', 'role']) {
    assert.throws(() => f.store.track({ ...f.descriptor, [field]: {} }), { code: 'CONTINUATION_INVALID' });
  }
  assert.throws(() => f.store.track({ ...f.descriptor, profileId: 'sk-proj-' + 'a'.repeat(100) }), { code: 'MEMORY_SECRET_REJECTED' });
  const row = f.store.track(f.descriptor);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.file);
  db.prepare('UPDATE memory_entries SET value_hash = ? WHERE entry_key = ?').run('0'.repeat(64), row.key);
  db.close();
  assert.throws(() => f.store.dueRecoveries({ includeUncertain: true }), { code: 'MEMORY_ENTRY_INVALID' });
});

test('process exit and transient observation failure retain uncertainty until saved-thread reconciliation', t => {
  const f = continuationFixture(t);
  const running = f.store.begin(f.store.track(f.descriptor));
  for (const code of ['CLAUDE_CLI_EXITED', 'ACP_PROCESS_EXITED', 'AGY_CLI_EXITED', 'AGY_CLI_TURN_TIMEOUT']) {
    assert.deepEqual(continuationApi.classifyFailure({ code }, { retrySafe: true }),
      { retry: false, uncertain: true, reason: 'interrupted_turn' });
  }
  assert.equal(continuationApi.classifyFailure({ code: 'CLAUDE_CLI_CLOSED' }, { retrySafe: true }).retry, false);
  assert.equal(continuationApi.classifyFailure({ code: 'AGY_CLI_CLOSED' }, { retrySafe: true }).retry, false);
  const interrupted = f.store.failed(running, { code: 'CODEX_APP_SERVER_EXITED' }, { retrySafe: true });
  assert.equal(interrupted.status, 'uncertain');
  assert.deepEqual(f.store.dueRecoveries({ includeUncertain: true }), []);
  f.advance(1000);
  const first = f.store.claim(f.store.dueRecoveries({ includeUncertain: true })[0]);
  assert.throws(() => f.store.success(first), { code: 'CONTINUATION_FENCE_LOST' });
  const waiting = f.store.failed(first, { code: 'ECONNRESET' }, { retrySafe: true });
  assert.equal(waiting.status, 'uncertain'); assert.equal(waiting.reason, 'reconciliation_retry');
  assert.equal(waiting.retries, 1);
  assert.deepEqual(f.store.dueRecoveries({ includeUncertain: true }), []);
  f.advance(1000);
  const [next] = f.store.dueRecoveries({ includeUncertain: true });
  assert.equal(next.action, 'reconcile');
  const claim = f.store.claim(next);
  assert.equal(f.store.reconcile(claim, { observedThreadId: 'provider-thread', terminalStatus: 'completed' }).status, 'ready');
});

test('an observed host turn acquires its own fence before the continuation due time without reviving stopped work', t => {
  const f = continuationFixture(t);
  const ready = readyContinuation(f);
  assert.ok(ready.dueAtMs > f.now());
  assert.throws(() => f.store.begin(ready), { code: 'CONTINUATION_FENCE_LOST' });
  assert.throws(() => f.store.begin(ready, { observed: 'true' }), { code: 'CONTINUATION_INVALID' });
  const courier = f.store.begin(ready, { observed: true });
  assert.equal(courier.status, 'running'); assert.ok(courier.claimId);
  assert.throws(() => f.store.begin(ready, { observed: true }), { code: 'CONTINUATION_FENCE_LOST' });
  const waiting = f.store.failed(courier, { code: 'ECONNRESET' }, { retrySafe: true });
  assert.ok(waiting.dueAtMs > f.now());
  const observedRetry = f.store.begin(waiting, { observed: true });
  assert.equal(observedRetry.retries, 1, 'observing traffic must not reset the persisted retry budget');
  const stopped = f.store.stop(observedRetry.key);
  assert.throws(() => f.store.begin(stopped, { observed: true }), { code: 'CONTINUATION_FENCE_LOST' });
  assert.throws(() => f.store.success(observedRetry), { code: 'CONTINUATION_FENCE_LOST' });

  for (const code of ['AUTH_REQUIRED', 'CODEX_APP_SERVER_EXITED']) {
    const idle = f.store.track({ ...f.descriptor, sessionId: code, requestKeys: null });
    const blocked = f.store.failed(idle, { code });
    assert.ok(['blocked', 'uncertain'].includes(blocked.status));
    assert.throws(() => f.store.begin(blocked, { observed: true }), { code: 'CONTINUATION_FENCE_LOST' });
  }
});

test('observed shutdown interruption permits a new ledger review while retaining retry history and Stop fencing', t => {
  const f = continuationFixture(t);
  let handle = f.store.begin(f.store.track(f.descriptor));
  handle = f.store.save(handle, { checkpoint: { taskId: 'T789', fingerprint: 'c'.repeat(64), unchanged: 2 } });
  handle = f.store.failed(handle, { code: 'ECONNRESET' }, { retrySafe: true });
  f.advance(1000);
  handle = f.store.begin(f.store.claim(f.store.dueRecoveries()[0]));
  f.store.failed(handle, { code: 'CODEX_APP_SERVER_EXITED' });
  f.advance(1000);
  const observed = f.store.claim(f.store.dueRecoveries({ includeUncertain: true })[0]);
  assert.throws(() => f.store.reconcile(observed, { observedThreadId: 'provider-thread', terminalStatus: 'interrupted' }), { code: 'CONTINUATION_RECONCILE_REFUSED' });
  const next = f.store.reconcile(observed, { observedThreadId: 'provider-thread', terminalStatus: 'interrupted', retrySafe: true });
  assert.equal(next.status, 'ready'); assert.equal(next.reason, 'interruption_observed');
  assert.equal(next.retries, 1); assert.equal(next.checkpoint.unchanged, 2);
  assert.deepEqual(f.store.dueRecoveries(), []);
  f.store.stop(next.key);
  assert.throws(() => f.store.reconcile(observed, { observedThreadId: 'provider-thread', terminalStatus: 'interrupted', retrySafe: true }), { code: 'CONTINUATION_FENCE_LOST' });
  f.advance(1000);
  assert.deepEqual(f.store.dueRecoveries({ includeUncertain: true }), []);
});


test('missing native terminal evidence stays uncertain without repeated automatic observation', t => {
  const f = continuationFixture(t);
  const running = f.store.begin(f.store.track(f.descriptor));
  f.store.failed(running, { code: 'CLAUDE_CLI_EXITED' });
  f.advance(1000);
  const observed = f.store.claim(f.store.dueRecoveries({ includeUncertain: true })[0]);
  assert.throws(() => f.store.reconcile(observed, { observedThreadId: 'different-thread', terminalStatus: 'unknown' }), { code: 'CONTINUATION_RECONCILE_REFUSED' });
  const unknown = f.store.reconcile(observed, { observedThreadId: 'provider-thread', terminalStatus: 'unknown' });
  assert.equal(unknown.status, 'uncertain');
  assert.equal(unknown.reason, 'terminal_evidence_unavailable');
  f.advance(3600000);
  assert.deepEqual(f.store.dueRecoveries({ includeUncertain: true }), []);
  assert.equal(f.store.claim(unknown), null);
  assert.throws(() => f.store.success(observed), { code: 'CONTINUATION_FENCE_LOST' });
  assert.equal(f.store.track(f.descriptor, { resume: true }).status, 'idle', 'explicit owner resume is still available');
});
