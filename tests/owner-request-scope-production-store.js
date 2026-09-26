// EXECUTABLE CHANGE
'use strict';

// Q64 production-store wiring. Every filesystem assertion uses a private
// temporary state directory; no test opens the runtime production state path.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/lib/owner-request-scope-store');
const launch = require('../src/lib/controller-launch-record');
const agentOrg = require('../src/lib/agent-org');
const spawnRecord = require('../tools/spawn-record');
const { rootPath } = require('../src/lib/runtime');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected,
  `${label || ''}: expected ${expected}`);

function rule(overrides = {}) {
  return {
    schemaVersion: 1,
    ruleId: 'rule_production_global',
    ruleKey: 'work.mode',
    scopeKind: 'global',
    threadId: null,
    sourceRequestId: 'R173',
    issuedAt: '2023-11-14T22:13:18.000Z',
    expiresAt: null,
    decisionSummary: 'Use the bounded production launch mode.',
    evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
    ownerVerbatim: 'production scope rules must remain explicit.',
    ...overrides
  };
}

function appendInput(scopeRule, expectedRevision) {
  const input = { rule: scopeRule, ownerEventRef: scopeRule.sourceRequestId };
  if (expectedRevision !== undefined) input.expectedRevision = expectedRevision;
  return input;
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve(__dirname, '..'),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, pid: child.pid }));
  });
}

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for child filesystem setup'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

const HOLD_LOCK_SOURCE = String.raw`
  'use strict';
  const fs = require('node:fs');
  const lockFile = process.argv[1];
  const descriptor = fs.openSync(lockFile, 'wx', 0o600);
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }), 'utf8');
  fs.fsyncSync(descriptor);
  process.stdout.write('ready\n');
  setInterval(() => {}, 1_000);
`;

const APPEND_SOURCE = String.raw`
  'use strict';
  const store = require(process.argv[1]);
  const input = JSON.parse(process.argv[2]);
  const file = process.argv[3];
  try {
    const result = store.appendScopeRule(input, { file });
    process.stdout.write(JSON.stringify({ ok: true, revision: result.revision, ruleId: result.rule.ruleId }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error && error.code }) + '\n');
    process.exitCode = 2;
  }
`;

// Pause after a real filesystem read, without changing its bytes or error.
// This fixes the dangerous interleaving instead of hoping two children happen
// to overlap: A has read the dead holder, while B tries to enter the mutation.
const PAUSED_APPEND_SOURCE = String.raw`
  'use strict';
  const fs = require('node:fs');
  const pausedStoreFile = process.argv[3];
  const phase = process.argv[4];
  const gate = process.argv[5];
  const read = fs.readFileSync;
  let paused = false;
  fs.readFileSync = function(target, ...args) {
    let value, failure;
    try { value = read.call(this, target, ...args); } catch (error) { failure = error; }
    if (!paused && target === (phase === 'stale' ? pausedStoreFile + '.lock' : pausedStoreFile)) {
      paused = true;
      fs.writeFileSync(gate + '.paused', 'paused');
      const deadline = Date.now() + 10_000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(gate + '.release')) {
        if (Date.now() >= deadline) throw new Error('timed out waiting for test read gate');
        Atomics.wait(pause, 0, 0, 5);
      }
    }
    if (failure) throw failure;
    return value;
  };
` + APPEND_SOURCE;

async function crashLockHolder(lockFile) {
  const holder = spawn(process.execPath, ['-e', HOLD_LOCK_SOURCE, lockFile], {
    cwd: path.resolve(__dirname, '..'), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let stderr = '';
  let exited = false;
  holder.stdout.on('data', chunk => { output += chunk; });
  holder.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    holder.once('error', reject);
    holder.once('close', (exitCode, signal) => { exited = true; resolve({ exitCode, signal }); });
  });
  try {
    // Existence alone can precede the JSON write. Kill only the child which
    // acknowledged its complete, fsynced real lock record.
    await waitFor(() => output === 'ready\n' || exited, 5_000);
    assert.equal(output, 'ready\n', stderr || 'lock holder exited before publishing its record');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, holder.pid);
  } finally {
    if (!exited) holder.kill('SIGTERM');
    await closed;
  }
}

const PARALLEL_APPEND_SOURCE = String.raw`
  'use strict';
  const store = require(process.argv[1]);
  const file = process.argv[2];
  const inputs = JSON.parse(process.argv[3]);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const completed = [];
  for (const input of inputs) {
    let result = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { result = store.appendScopeRule(input, { file }); break; }
      catch (error) {
        if (!error || error.code !== 'OWNER_SCOPE_STORE_BUSY') throw error;
        Atomics.wait(pause, 0, 0, 5);
      }
    }
    if (!result) throw new Error('writer exhausted busy retries');
    completed.push(result.rule.ruleId);
  }
  process.stdout.write(JSON.stringify({ ok: true, completed }) + '\n');
`;

function makeAudit(clock) {
  const events = [];
  let sequence = 0;
  return {
    events,
    requireRecord(action, target, details) {
      sequence += 1;
      const entry = {
        sequence,
        eventId: `production-scope-${sequence}`,
        eventHash: hash(`${action}:${target}:${sequence}`),
        event: { action, target, details, timestamp: new Date(clock()).toISOString() }
      };
      events.push(entry);
      return { durable: true, anchored: true, sequence, eventHash: entry.eventHash };
    },
    findEvents({ action, target, limit = 100 }) {
      return events.filter(entry => entry.event.action === action && entry.event.target === target).slice(0, limit);
    },
    tail(limit = 20) {
      return events.slice(-limit).map(entry => ({ ...entry.event, sequence: entry.sequence,
        eventId: entry.eventId, eventHash: entry.eventHash }));
    }
  };
}

const org = agentOrg.normalizeOrg({
  revision: 1,
  agents: [
    { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'codex', enabled: true },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true, phasePriority: [] }
  ],
  relationships: [{ from: 'claude', to: 'luna', type: 'manages' }]
}, { maxAgents: 2 });

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-q64-production-store-'));
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks += 1; };
  try {
    // The state directory is injected into the production seam. This proves
    // resolution derives from a state root, not a literal machine path, while
    // keeping this suite entirely outside real production state.
    const stateDirectory = path.join(tempRoot, 'state-root');
    const productionStore = store.createScopeStore({ stateDirectory });
    check(store.productionScopeStoreFile() === rootPath('state', store.STORE_FILE_NAME),
      'production default derives from the runtime state root without a literal machine path');
    check(productionStore.file === path.join(path.resolve(stateDirectory), store.STORE_FILE_NAME),
      'production store file derives from the injected state directory');
    check(productionStore.file !== store.DEFAULT_FILE,
      'test seam does not fall through to the runtime production default');
    check(store.productionScopeStoreFile({ stateDirectory }) === productionStore.file,
      'the explicit production path resolver and bound store agree');

    const first = productionStore.append(appendInput(rule(), 0));
    check(first.revision === 1 && first.durable === true,
      'bound production-store seam writes through the real temporary filesystem');
    code(() => productionStore.append(appendInput(rule({
      ruleId: 'rule_stale_revision', ruleKey: 'work.stale'
    }), 0)), 'OWNER_SCOPE_STORE_REVISION_CONFLICT', 'real filesystem stale revision fence');
    checks += 1;

    // A child process is the lock owner, then is terminated without cleanup.
    // Two post-crash writers race against its on-disk lock under the same
    // revision fence: one recovery commits, and the other is BUSY or fenced.
    const crashFile = path.join(tempRoot, 'crash', store.STORE_FILE_NAME);
    fs.mkdirSync(path.dirname(crashFile), { recursive: true });
    const lockFile = `${crashFile}.lock`;
    await crashLockHolder(lockFile);
    check(fs.existsSync(lockFile), 'killed real writer leaves its lock file behind');

    const crashedInputs = [
      appendInput(rule({ ruleId: 'rule_crash_reclaimer_a', ruleKey: 'crash.a' }), 0),
      appendInput(rule({ ruleId: 'rule_crash_reclaimer_b', ruleKey: 'crash.b' }), 0)
    ];
    const moduleFile = path.resolve(__dirname, '..', 'src', 'lib', 'owner-request-scope-store.js');
    const recovered = await Promise.all(crashedInputs.map(input => runChild([
      '-e', APPEND_SOURCE, moduleFile, JSON.stringify(input), crashFile
    ])));
    const recoveredResults = recovered.map(result => JSON.parse(result.stdout));
    check(recovered.length === crashedInputs.length && recoveredResults.length === crashedInputs.length,
      'both crash-recovery children return a parseable result, preventing vacuous collection checks');
    check(recoveredResults.filter(result => result.ok).length === 1,
      'exactly one writer commits through the reclaimed crash lock');
    check(recoveredResults.filter(result => !result.ok).every(result =>
      ['OWNER_SCOPE_STORE_BUSY', 'OWNER_SCOPE_STORE_REVISION_CONFLICT'].includes(result.code)),
    'the losing crash-recovery writer is refused without a second mutation');
    const recoveredStore = store.readScopeStore({ file: crashFile });
    check(recoveredStore.revision === 1 && recoveredStore.rules.length === 1 && !fs.existsSync(lockFile),
      'crash lock is reclaimed once, released, and leaves a valid real-filesystem store');

    const pausedFile = path.join(tempRoot, 'paused-recovery', store.STORE_FILE_NAME);
    fs.mkdirSync(path.dirname(pausedFile), { recursive: true });
    await crashLockHolder(`${pausedFile}.lock`);
    const staleGate = path.join(tempRoot, 'stale-reader');
    const workGate = path.join(tempRoot, 'other-writer');
    let firstResult, secondResult;
    const pausedRuns = [];
    try {
      pausedRuns.push(runChild(['-e', PAUSED_APPEND_SOURCE, moduleFile,
        JSON.stringify(crashedInputs[0]), pausedFile, 'stale', staleGate])
        .then(result => { firstResult = result; }));
      await waitFor(() => fs.existsSync(`${staleGate}.paused`) || firstResult, 5_000);
      check(fs.existsSync(`${staleGate}.paused`), 'first real writer pauses after reading the dead holder');
      pausedRuns.push(runChild(['-e', PAUSED_APPEND_SOURCE, moduleFile,
        JSON.stringify(crashedInputs[1]), pausedFile, 'work', workGate])
        .then(result => { secondResult = result; }));
      await waitFor(() => fs.existsSync(`${workGate}.paused`) || secondResult, 5_000);
      fs.writeFileSync(`${staleGate}.release`, 'release');
      await pausedRuns[0];
    } finally {
      fs.writeFileSync(`${staleGate}.release`, 'release');
      fs.writeFileSync(`${workGate}.release`, 'release');
      await Promise.all(pausedRuns);
    }
    const pausedResults = [firstResult, secondResult].map(result => {
      assert.equal(result.stderr, '');
      return JSON.parse(result.stdout);
    });
    const committed = pausedResults.filter(result => result.ok);
    check(committed.length === 1,
      `a paused stale-lock reader cannot steal another writer's replacement: ${JSON.stringify(pausedResults)}`);
    check(pausedResults.filter(result => !result.ok).length === 1
      && pausedResults.filter(result => !result.ok).every(result =>
        ['OWNER_SCOPE_STORE_BUSY', 'OWNER_SCOPE_STORE_REVISION_CONFLICT'].includes(result.code)),
    'the refused paused-recovery contender cannot report a committed mutation');
    const pausedStore = store.readScopeStore({ file: pausedFile });
    check(pausedStore.revision === 1 && pausedStore.rules.length === 1
      && pausedStore.rules[0].ruleId === committed[0].ruleId && !fs.existsSync(`${pausedFile}.lock`),
    'paused crash recovery retains exactly the acknowledged rule and releases the lock');

    // Independent writers use the real lock, atomic rename, and verified
    // reads. They retry only the expected BUSY result; a valid revision/rule
    // count proves no interleaving produced partial JSON or a lost record.
    const concurrentFile = path.join(tempRoot, 'concurrent', store.STORE_FILE_NAME);
    const makeInputs = prefix => Array.from({ length: 8 }, (_, index) => {
      const scoped = rule({
        ruleId: `rule_parallel_${prefix}_${index}`,
        ruleKey: `parallel.${prefix}.${index}`,
        decisionSummary: `Parallel ${prefix} writer item ${index}.`
      });
      return appendInput(scoped);
    });
    const parallelRuns = await Promise.all(['a', 'b'].map(prefix => runChild([
      '-e', PARALLEL_APPEND_SOURCE, moduleFile, concurrentFile, JSON.stringify(makeInputs(prefix))
    ])));
    check(parallelRuns.length === 2,
      'both requested concurrent child processes return results before collection-wide assertions');
    check(parallelRuns.every(result => result.exitCode === 0 && result.stderr === ''),
      'both real-filesystem concurrent writers complete after bounded BUSY retries');
    const parallelResults = parallelRuns.map(result => JSON.parse(result.stdout));
    check(parallelResults.length === 2,
      'both concurrent child outputs parse before collection-wide assertions');
    check(parallelResults.every(result => result.ok && result.completed.length === 8),
      'each concurrent writer durably records every distinct rule');
    const expectedCompletedRuleIds = ['a', 'b'].map(prefix =>
      makeInputs(prefix).map(input => input.rule.ruleId).sort());
    check(parallelResults.every((result, index) =>
      JSON.stringify([...result.completed].sort()) === JSON.stringify(expectedCompletedRuleIds[index])),
    'each child reports the exact rule identities returned by the production append operation');
    const concurrentStore = store.readScopeStore({ file: concurrentFile });
    check(concurrentStore.revision === 16 && concurrentStore.rules.length === 16
      && new Set(concurrentStore.rules.map(entry => entry.ruleId)).size === 16
      && !fs.existsSync(`${concurrentFile}.lock`),
    'concurrent real writers leave one parseable, complete, unlocked store');

    // The controller consumes the bound real store through scopeStore, not a
    // fake reader, and returns the exact non-authorizing packet for the agent
    // dispatcher to put in its brief. The spawn helper preserves that handoff.
    const launchStateDirectory = path.join(tempRoot, 'launch-state');
    const launchStore = store.createScopeStore({ stateDirectory: launchStateDirectory });
    const launchRule = rule({
      ruleId: 'rule_launch_brief_thread',
      ruleKey: 'launch.brief',
      scopeKind: 'thread',
      threadId: 'thread-production',
      decisionSummary: 'This owner rule is visible in the dispatched agent brief.',
      ownerVerbatim: 'this bounded instruction applies only to the production thread.'
    });
    const launchWrite = launchStore.append(appendInput(launchRule, 0));
    const clock = () => 1_700_000_000_000;
    const audit = makeAudit(clock);
    const launched = spawnRecord.recordSpawn({
      requestingActor: 'claude', targetAgentId: 'luna', objectiveRef: 'Q64', model: 'luna-cheap-tier',
      threadId: 'thread-production', scopeStoreRevision: launchWrite.revision
    }, { org, audit, clock, scopeStore: launchStore });
    check(launched.record.scopePacket.rules[0].ruleId === 'rule_launch_brief_thread',
      'launch resolves the scope rule from the bound real store');
    check(launched.dispatchBrief.scopePacket !== null
      && JSON.stringify(launched.dispatchBrief.scopePacket) === JSON.stringify(launched.record.scopePacket),
    'spawn helper returns the resolved scope packet in the dispatch brief');
    check(launched.dispatchBrief.informational === true && launched.dispatchBrief.grantsAuthority === false
      && launched.dispatchBrief.scopePacket.grantsAuthority === false
      && !Object.hasOwn(launched.dispatchBrief, 'targetActivation')
      && !Object.hasOwn(launched.dispatchBrief, 'executorPayloadHash'),
    'dispatch brief is explicitly informational and carries no authority binding');

    console.log(`owner-request-scope-production-store: ${checks} checks passed`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});

/*
Test-can-fail report (testcanfail-tests-owner-request-scope-production-store-js)

Mutation and discrimination:
- Temporarily changed appendScopeRule's successful return packet so its `rule.ruleId`
  was `mutated_return_rule_id`, while leaving the durable write intact. Before the
  exact-identity assertion, the unmodified test remained green:
    owner-request-scope-production-store: 16 checks passed
- With the exact-identity assertion, that same product mutation went red:
    AssertionError [ERR_ASSERTION]: each child reports the exact rule identities returned by the production append operation
        at check (/workspace/engine/tests/owner-request-scope-production-store.js:162:50)
        at main (/workspace/engine/tests/owner-request-scope-production-store.js:250:5)
  Process status was 1. This demonstrates that merely reporting eight arbitrary
  values is no longer accepted as evidence that the production append results
  identify the requested rules.
- The product file was restored byte-for-byte (SHA-256 before and after:
  981ee683613a00fa89f4112a67c29a8f3c2e9c2dfa0fcab160d8b77e4ef9b9e2).
  The restored run was green:
    owner-request-scope-production-store: 20 checks passed

Shape census:
1. EMPTY LOOP/COLLECTION: FOUND for collection-wide `every` assertions. Explicit
   cardinality checks now precede the recovered-result, child-run, and parsed-output
   collection assertions. The source arrays currently have fixed cardinality, but
   the evidence no longer depends implicitly on that setup detail.
2. EXIT STATUS/TRUTHY RETURN ALONE: NOT-FOUND. The child exit assertion also
   requires empty stderr, parseable JSON, semantic success, exact count, exact
   returned identities, and a complete independently read durable store.
3. SWALLOWING TRY/CATCH OR OPTIONAL CHAIN: NOT-FOUND. Child catch blocks serialize
   their error code and exit unsuccessfully; the top-level catch makes the test red.
4. MOCK OF THE SUBJECT: NOT-FOUND. `makeAudit` is an injected collaborator, while
   the asserted production store, controller launch resolution, and spawn-record
   handoff use their real modules.
5. SKIP/PRECONDITION NO-OP: NOT-FOUND. There is no skip or platform guard.
6. EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND. Expected paths, revisions,
   rule counts, flags, and requested rule IDs are constructed independently in
   this test; production return values are not used to derive their own oracle.

Unmet preconditions: none.
*/
