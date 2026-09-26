'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { createBroker, normalizeMessage, ROUTES } = require('../../src/lib/agent-comms/broker');

const agents = ['agent-a', 'agent-b', 'agent-c'].map(agentId => ({
  agentId,
  machineId: 'machine',
  route: ROUTES.LOCAL,
  sessionId: `session-${agentId}`
}));

function options(t, knownAgents = agents, deliver = async attempt => ({
  delivered: true,
  messageId: attempt.messageId
})) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    stateFile: path.join(directory, 'broker.json'),
    knownAgents,
    transport: { deliver },
    now: () => 1234,
    processIdentity: pid => ({
      status: 'ALIVE',
      processStartIdentity: `test-process-start:${pid}`
    }),
    livenessReceiver: {
      getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; }
    }
  };
}

function message(id, recipientAgentId) {
  return { messageId: id, recipientAgentId, body: id };
}

function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) { resolve(); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() >= deadline) { reject(new Error('timed out waiting for concurrent broker drains')); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function childCompletion(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('traffic for one recipient does not block a different registered recipient', async t => {
  const configured = options(t, agents, async () => ({ delivered: false }));
  const first = createBroker(configured);
  assert.equal((await first.send(message('to-b', 'agent-b'))).spooled, true);

  const second = createBroker({
    ...configured,
    transport: {
      async deliver(attempt) {
        return { delivered: true, messageId: attempt.messageId };
      }
    }
  });
  assert.equal((await second.send(message('to-c', 'agent-c'))).delivered, true);
  assert.equal(second.getSpool()[0].recipientAgentId, 'agent-b');
});

test('a deregistered recipient is dead-lettered instead of blocking broker startup', async t => {
  const configured = options(t, agents, async () => ({ delivered: false }));
  const first = createBroker(configured);
  await first.send(message('stale', 'agent-b'));

  const reopened = createBroker({ ...configured, knownAgents: [agents[0], agents[2]] });
  const state = reopened.getState();
  assert.equal(state.spool.length, 0);
  assert.equal(state.deadLetters.length, 1);
  assert.equal(state.deadLetters[0].reason, 'RECIPIENT_NOT_IN_DIRECTORY');
  assert.equal(state.deadLetters[0].entry.messageId, 'stale');
});

test('a recovery packet may overlap one receipt, but duplicate delivery receipt ids are corrupt', async t => {
  const configured = options(t);
  const broker = createBroker(configured);
  await broker.send(message('delivered', 'agent-b'));

  const recoverable = broker.getState();
  recoverable.spool.push({
    sequence: recoverable.nextSequence++,
    messageId: recoverable.deliveries[0].messageId,
    recipientAgentId: recoverable.deliveries[0].recipientAgentId,
    recipientMachineId: recoverable.deliveries[0].recipientMachineId,
    fingerprint: recoverable.deliveries[0].fingerprint,
    enqueuedAtMs: 1234,
    message: message('delivered', 'agent-b')
  });
  fs.writeFileSync(configured.stateFile, `\uFEFF${JSON.stringify(recoverable)}`, 'utf8');

  const reopened = createBroker(configured);
  assert.equal(reopened.getState().spool.length, 0);
  assert.equal(reopened.getState().deliveries.length, 1);

  const corrupt = reopened.getState();
  corrupt.deliveries.push({ ...corrupt.deliveries[0] });
  fs.writeFileSync(configured.stateFile, JSON.stringify(corrupt), 'utf8');
  assert.throws(
    () => createBroker(configured),
    error => error.code === 'BROKER_STATE_CORRUPT'
      && /delivery message identity is duplicated/.test(error.message)
  );
});

test('a receipt never discards a conflicting spool packet that merely reuses its message id', async t => {
  const configured = options(t);
  const broker = createBroker(configured);
  await broker.send(message('conflicting-overlap', 'agent-b'));

  const corrupt = broker.getState();
  const differentMessage = {
    messageId: 'conflicting-overlap',
    recipientAgentId: 'agent-b',
    body: 'a different packet that was never delivered'
  };
  const normalized = normalizeMessage(differentMessage);
  assert.notEqual(normalized.fingerprint, corrupt.deliveries[0].fingerprint,
    'the adversarial packet must differ from the delivered packet');
  corrupt.spool.push({
    sequence: corrupt.nextSequence++,
    messageId: normalized.messageId,
    recipientAgentId: normalized.recipientAgentId,
    recipientMachineId: normalized.recipientMachineId,
    fingerprint: normalized.fingerprint,
    enqueuedAtMs: 1234,
    message: differentMessage
  });
  fs.writeFileSync(configured.stateFile, JSON.stringify(corrupt), 'utf8');

  assert.throws(
    () => createBroker(configured),
    error => error.code === 'BROKER_STATE_CORRUPT'
      && /conflicts with the delivery receipt/.test(error.message)
  );
  assert.equal(JSON.parse(fs.readFileSync(configured.stateFile, 'utf8')).spool.length, 1,
    'the conflicting packet was rewritten or silently pruned');
});

test('a dead letter cannot reuse a delivered message identity with a different packet', async t => {
  const configured = options(t);
  const broker = createBroker(configured);
  await broker.send(message('dead-letter-conflict', 'agent-b'));
  const corrupt = broker.getState();
  const different = { messageId: 'dead-letter-conflict', recipientAgentId: 'agent-b', body: 'different' };
  const normalized = normalizeMessage(different);
  corrupt.deadLetters.push({
    deadLetteredAtMs: 1234,
    reason: 'RECIPIENT_NOT_IN_DIRECTORY',
    entry: {
      sequence: corrupt.nextSequence++,
      messageId: normalized.messageId,
      recipientAgentId: normalized.recipientAgentId,
      recipientMachineId: normalized.recipientMachineId,
      fingerprint: normalized.fingerprint,
      enqueuedAtMs: 1234,
      message: different
    }
  });
  fs.writeFileSync(configured.stateFile, JSON.stringify(corrupt), 'utf8');
  assert.throws(() => createBroker(configured), error => error.code === 'BROKER_STATE_CORRUPT'
    && /dead-letter identity conflicts/.test(error.message));
});

test('dead PID and legacy empty locks are recovered without flattening broker state', t => {
  const configured = options(t);
  const broker = createBroker(configured);
  const before = broker.getState();
  const lockFile = `${configured.stateFile}.lock`;

  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, at: '2026-01-01T00:00:00.000Z' }), 'utf8');
  const deadRecovered = createBroker({ ...configured, isProcessAlive: () => false });
  assert.deepEqual(deadRecovered.getState(), before);
  assert.equal(fs.existsSync(lockFile), false);

  const lockNow = Date.now();
  fs.writeFileSync(lockFile, '', 'utf8');
  fs.utimesSync(lockFile, new Date(lockNow - 120_000), new Date(lockNow - 120_000));
  const legacyRecovered = createBroker({ ...configured, lockNow: () => lockNow });
  assert.deepEqual(legacyRecovered.getState(), before);
  assert.equal(fs.existsSync(lockFile), false);
});

test('legacy empty-lock recovery never unlinks a live replacement generation', t => {
  const configured = options(t);
  createBroker(configured);
  const lockFile = `${configured.stateFile}.lock`;
  const lockNow = Date.now();
  fs.writeFileSync(lockFile, '', 'utf8');
  fs.utimesSync(lockFile, new Date(lockNow - 120_000), new Date(lockNow - 120_000));
  const originalStat = fs.statSync;
  let replaced = false;
  fs.statSync = function replaceAfterStat(target, ...args) {
    const metadata = originalStat.call(fs, target, ...args);
    if (!replaced && path.resolve(target) === path.resolve(lockFile)) {
      replaced = true;
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid, startedAt: '2026-01-01T00:00:00.000Z', nonce: 'live-replacement'
      }), { flag: 'wx' });
    }
    return metadata;
  };
  try {
    assert.throws(
      () => createBroker({ ...configured, lockNow: () => lockNow, lockTimeoutMs: 0 }),
      error => error.code === 'BROKER_STATE_LOCKED'
    );
  } finally {
    fs.statSync = originalStat;
  }
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).nonce, 'live-replacement');
  fs.rmSync(lockFile, { force: true });
});

test('a crashed external delivery claim is recovered as UNCERTAIN and is never resent', async t => {
  let calls = 0;
  const configured = options(t, agents, async () => { calls += 1; return { delivered: false }; });
  const broker = createBroker(configured);
  await broker.send(message('crash-claim', 'agent-a'));
  assert.equal(calls, 1);

  const state = broker.getState();
  state.spool[0].deliveryClaim = {
    claimId: 'crashed-process-claim',
    holderPid: 2147483646,
    claimedAtMs: 1234
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');

  const recovered = createBroker({ ...configured, isProcessAlive: () => true });
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(calls, 1, 'recovery called transport again after an indeterminate external side effect');
  assert.equal(recovered.getSpool()[0].transportOutcome, 'UNCERTAIN');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('an abandoned claim from the same or reused pid is recovered instead of blocking forever', async t => {
  const configured = options(t, agents, async () => ({ delivered: false }));
  const broker = createBroker(configured);
  await broker.send(message('same-pid-claim', 'agent-a'));
  const state = broker.getState();
  state.spool[0].deliveryClaim = {
    claimId: 'abandoned-same-process-claim',
    holderPid: process.pid,
    holderProcessStartIdentity: `test-process-start:${process.pid}`,
    claimedAtMs: 1234
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');
  const recovered = createBroker(configured);
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('a live recycled foreign pid with the wrong start identity becomes UNCERTAIN', async t => {
  let calls = 0;
  const configured = options(t, agents, async () => { calls += 1; return { delivered: false }; });
  const broker = createBroker(configured);
  await broker.send(message('recycled-foreign-pid', 'agent-a'));
  const state = broker.getState();
  state.spool[0].deliveryClaim = {
    claimId: 'foreign-recycled-generation',
    holderPid: 424242,
    holderProcessStartIdentity: 'test-process-start:older-generation',
    claimedAtMs: 1234
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');

  const recovered = createBroker(configured);
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(calls, 1, 'a recycled PID authorized a second transport attempt');
  assert.equal(recovered.getSpool()[0].transportOutcome, 'UNCERTAIN');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('reserve re-evaluates a foreign claim under the state lock before transport', async t => {
  let calls = 0;
  let foreignStatus = 'ALIVE';
  const foreignPid = 434343;
  const configured = options(t, agents, async () => { calls += 1; return { delivered: false }; });
  const processIdentity = targetPid => targetPid === foreignPid
    ? (foreignStatus === 'ALIVE'
      ? { status: 'ALIVE', processStartIdentity: 'foreign-live-generation' }
      : { status: foreignStatus })
    : configured.processIdentity(targetPid);
  const broker = createBroker({ ...configured, processIdentity });
  await broker.send(message('reserve-rechecks-holder', 'agent-a'));
  const state = broker.getState();
  state.spool[0].deliveryClaim = {
    claimId: 'foreign-live-then-dead',
    holderPid: foreignPid,
    holderProcessStartIdentity: 'foreign-live-generation',
    claimedAtMs: 1234
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');

  const recovered = createBroker({ ...configured, processIdentity });
  assert.equal(recovered.getSpool()[0].deliveryClaim.claimId, 'foreign-live-then-dead');
  foreignStatus = 'DEAD';
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(calls, 1, 'reserve transported after its holder died');
  assert.equal(recovered.getSpool()[0].transportOutcome, 'UNCERTAIN');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('an unobservable exact claim stays fail-closed and is never transported', async t => {
  let calls = 0;
  const foreignPid = 444444;
  const configured = options(t, agents, async () => { calls += 1; return { delivered: false }; });
  const broker = createBroker(configured);
  await broker.send(message('unknown-holder-identity', 'agent-a'));
  const state = broker.getState();
  state.spool[0].deliveryClaim = {
    claimId: 'foreign-identity-unobservable',
    holderPid: foreignPid,
    holderProcessStartIdentity: 'foreign-unknown-generation',
    claimedAtMs: 1234
  };
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');
  const processIdentity = targetPid => targetPid === foreignPid
    ? { status: 'UNKNOWN' }
    : configured.processIdentity(targetPid);

  const recovered = createBroker({ ...configured, processIdentity });
  for (let index = 0; index < 2; index += 1) {
    const drained = await recovered.drain('agent-a');
    assert.equal(drained.results[0].code, 'BROKER_DELIVERY_OWNERSHIP_UNKNOWN');
    assert.equal(drained.results[0].attempted, false);
  }
  assert.equal(calls, 1, 'unknown process identity authorized another transport attempt');
  assert.equal(recovered.getSpool()[0].deliveryClaim.claimId, 'foreign-identity-unobservable');
});

test('one crashed holder pid across several claimed entries costs one probe, not one per entry', async t => {
  // MEASURED against this installation's live local-broker.json: a process
  // that dies holding several reserved-but-unrecorded claims leaves them all
  // under its own pid. Building a broker walks every spool entry once, so
  // before the shared sweep cache this cost one real process-identity probe
  // PER ENTRY for what is always the same answer about the same pid --
  // spawnSync of powershell.exe in production, 5.3 s for either of the first
  // two spawns in a process and about 0.3 s after that (see
  // PROCESS_IDENTITY_PROBE_TIMEOUT_MS in broker.js), all on the critical path
  // of whichever agent_comms.send_local call happens to rebuild this broker.
  const foreignPid = 555555;
  const configured = options(t, agents, async () => ({ delivered: false }));
  const broker = createBroker(configured);
  await broker.send(message('shared-holder-1', 'agent-a'));
  await broker.send(message('shared-holder-2', 'agent-a'));
  await broker.send(message('shared-holder-3', 'agent-a'));
  const state = broker.getState();
  assert.equal(state.spool.length, 3, 'setup did not queue the three entries this test needs');
  for (const [index, entry] of state.spool.entries()) {
    entry.deliveryClaim = {
      claimId: `shared-crashed-claim-${index}`,
      holderPid: foreignPid,
      holderProcessStartIdentity: 'crashed-generation',
      claimedAtMs: 1234
    };
  }
  fs.writeFileSync(configured.stateFile, JSON.stringify(state), 'utf8');

  let probes = 0;
  const processIdentity = targetPid => {
    if (targetPid === foreignPid) probes += 1;
    return targetPid === foreignPid ? { status: 'UNKNOWN' } : configured.processIdentity(targetPid);
  };

  // createBroker's own constructor sweep is what must be deduplicated: it
  // finishes synchronously, before this call returns, so the count below is
  // already final.
  const recovered = createBroker({ ...configured, processIdentity });
  assert.equal(probes, 1,
    'three entries claimed by the same dead pid cost three identity probes instead of one');
  // Sharing the probe must not change the verdict: every entry is exactly as
  // unresolved as three separate probes would have left it -- still claimed,
  // still retained, nothing wrongly delivered or dead-lettered.
  const recoveredSpool = recovered.getSpool();
  assert.equal(recoveredSpool.length, 3);
  for (const entry of recoveredSpool) {
    assert.equal(entry.deliveryClaim.holderPid, foreignPid);
  }

  // The dedup must not survive past this one construction: a second broker
  // built later re-checks fresh, same as the single-entry case already
  // covered above ("reserve re-evaluates a foreign claim...").
  const again = createBroker({ ...configured, processIdentity });
  assert.equal(probes, 2, 'a later, separate broker construction reused a stale earlier answer');
  void again;
});

test('a post-transport clock failure cannot leak local active-claim ownership', async t => {
  let calls = 0;
  let clockCalls = 0;
  const configured = options(t, agents, async attempt => {
    calls += 1;
    return { delivered: true, messageId: attempt.messageId };
  });
  const failing = createBroker({
    ...configured,
    now() {
      clockCalls += 1;
      if (clockCalls === 4) throw new Error('post-transport clock failure');
      return 1234;
    }
  });
  await assert.rejects(
    failing.send(message('post-transport-clock-failure', 'agent-a')),
    /post-transport clock failure/
  );
  assert.equal(calls, 1);
  const claimed = JSON.parse(fs.readFileSync(configured.stateFile, 'utf8')).spool[0];
  assert.equal(claimed.deliveryClaim.holderPid, process.pid);
  assert.equal(claimed.deliveryClaim.holderProcessStartIdentity, `test-process-start:${process.pid}`);

  const recovered = createBroker(configured);
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(calls, 1, 'a leaked local marker kept or retried the abandoned claim');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('a post-transport state-commit failure cannot leak local active-claim ownership', async t => {
  let calls = 0;
  let refuseNextStateRename = false;
  const configured = options(t, agents, async attempt => {
    calls += 1;
    refuseNextStateRename = true;
    return { delivered: true, messageId: attempt.messageId };
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function failSelectedCommit(source, target) {
    if (refuseNextStateRename && path.resolve(target) === path.resolve(configured.stateFile)) {
      refuseNextStateRename = false;
      const error = new Error('injected post-transport commit failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRenameSync.apply(fs, arguments);
  };
  t.after(() => { fs.renameSync = originalRenameSync; });

  const failing = createBroker(configured);
  try {
    await assert.rejects(
      failing.send(message('post-transport-commit-failure', 'agent-a')),
      error => error.code === 'EIO' && /injected post-transport commit failure/.test(error.message)
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(calls, 1);
  const claimed = JSON.parse(fs.readFileSync(configured.stateFile, 'utf8')).spool[0];
  assert.equal(claimed.deliveryClaim.holderPid, process.pid);

  const recovered = createBroker(configured);
  const drained = await recovered.drain('agent-a');
  assert.equal(drained.results[0].code, 'BROKER_TRANSPORT_UNCERTAIN');
  assert.equal(drained.results[0].attempted, false);
  assert.equal(calls, 1, 'a commit failure left a marker that retained or retried the abandoned claim');
  assert.equal(Object.hasOwn(recovered.getSpool()[0], 'deliveryClaim'), false);
});

test('dead-letter wrappers and packet entries are exact and sequences are global', async t => {
  const configured = options(t, agents, async () => ({ delivered: false }));
  const broker = createBroker(configured);
  await broker.send(message('strict-dead-letter', 'agent-b'));
  const deadLettered = createBroker({ ...configured, knownAgents: [agents[0], agents[2]] });
  const valid = deadLettered.getState();
  assert.equal(valid.deadLetters.length, 1);

  const mutations = [
    ['wrapper extra field', state => { state.deadLetters[0].unexpected = true; }],
    ['entry extra field', state => { state.deadLetters[0].entry.unexpected = true; }],
    ['entry missing required field', state => { delete state.deadLetters[0].entry.fingerprint; }],
    ['invalid transport outcome', state => { state.deadLetters[0].entry.transportOutcome = 'FAILED'; }],
    ['claim extra field', state => {
      state.deadLetters[0].entry.deliveryClaim = {
        claimId: 'invalid-expanded-claim',
        holderPid: process.pid,
        holderProcessStartIdentity: `test-process-start:${process.pid}`,
        claimedAtMs: 1234,
        unexpected: true
      };
    }],
    ['duplicate global sequence', state => {
      const duplicate = message('duplicate-dead-letter-sequence', 'agent-a');
      const normalized = normalizeMessage(duplicate);
      state.spool.push({
        sequence: state.deadLetters[0].entry.sequence,
        messageId: normalized.messageId,
        recipientAgentId: normalized.recipientAgentId,
        recipientMachineId: normalized.recipientMachineId,
        fingerprint: normalized.fingerprint,
        enqueuedAtMs: 1234,
        message: duplicate
      });
    }]
  ];
  for (const [label, mutate] of mutations) {
    const corrupt = structuredClone(valid);
    mutate(corrupt);
    const serialized = JSON.stringify(corrupt);
    fs.writeFileSync(configured.stateFile, serialized, 'utf8');
    assert.throws(
      () => createBroker(configured),
      error => error.code === 'BROKER_STATE_CORRUPT',
      label
    );
    assert.equal(fs.readFileSync(configured.stateFile, 'utf8'), serialized,
      `${label} was rewritten instead of rejected`);
  }
});

test('a broker never dead-letters an entry while another delivery claim is active', async t => {
  let releaseTransport;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const release = new Promise(resolve => { releaseTransport = resolve; });
  t.after(() => releaseTransport());
  const configured = options(t, agents, async attempt => {
    markStarted();
    await release;
    return { delivered: true, messageId: attempt.messageId };
  });
  const first = createBroker(configured);
  const pending = first.send(message('active-claim-directory-race', 'agent-a'));
  await started;

  const second = createBroker({ ...configured, knownAgents: [agents[1], agents[2]] });
  const whileActive = second.getState();
  assert.equal(whileActive.spool.length, 1);
  assert.equal(whileActive.spool[0].messageId, 'active-claim-directory-race');
  assert.equal(whileActive.deadLetters.length, 0);
  assert.equal(typeof whileActive.spool[0].deliveryClaim.holderProcessStartIdentity, 'string');

  releaseTransport();
  const delivered = await pending;
  assert.equal(delivered.delivered, true);
  const final = createBroker(configured).getState();
  assert.equal(final.spool.length, 0);
  assert.equal(final.deadLetters.length, 0);
  assert.equal(final.deliveries.length, 1);
  assert.equal(final.deliveries[0].messageId, 'active-claim-directory-race');
});

test('the platform process identity adapter persists an exact current-process identity', async t => {
  let persistedClaim = null;
  const configured = options(t, agents, async attempt => {
    persistedClaim = JSON.parse(fs.readFileSync(configured.stateFile, 'utf8')).spool[0].deliveryClaim;
    return { delivered: true, messageId: attempt.messageId };
  });
  delete configured.processIdentity;
  const broker = createBroker(configured);
  const result = await broker.send(message('platform-process-identity', 'agent-a'));
  assert.equal(result.delivered, true, `platform identity failed closed with ${result.code}`);
  assert.equal(persistedClaim.holderPid, process.pid);
  assert.match(persistedClaim.holderProcessStartIdentity,
    process.platform === 'win32' ? /^windows-start-ticks:[0-9]+$/ : /^linux-proc-start:/);
});

test('two broker processes draining one spool call transport exactly once', async t => {
  const configured = options(t, agents, async () => ({ delivered: false }));
  const broker = createBroker(configured);
  await broker.send(message('cross-process-once', 'agent-a'));

  const directory = path.dirname(configured.stateFile);
  const helper = path.join(directory, 'drain-child.cjs');
  const readyFile = path.join(directory, 'drain-ready.txt');
  const goFile = path.join(directory, 'drain-go');
  const releaseFile = path.join(directory, 'transport-release');
  const callsFile = path.join(directory, 'transport-calls.txt');
  const modulePath = require.resolve('../../src/lib/agent-comms/broker');
  fs.writeFileSync(helper, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const [modulePath, stateFile, readyFile, goFile, releaseFile, callsFile] = process.argv.slice(2);",
    "const { createBroker, ROUTES } = require(modulePath);",
    "fs.appendFileSync(readyFile, process.pid + '\\n');",
    "(async () => {",
    "  while (!fs.existsSync(goFile)) await new Promise(resolve => setTimeout(resolve, 5));",
    "  const broker = createBroker({",
    "    stateFile,",
    "    knownAgents: [{ agentId: 'agent-a', machineId: 'machine', route: ROUTES.LOCAL, sessionId: 'session-agent-a' }],",
    "    livenessReceiver: { getAgent() { return { state: 'RUNNING', freshness: 'FRESH' }; } },",
    "    transport: { async deliver(attempt) {",
    "      fs.appendFileSync(callsFile, process.pid + '\\n');",
    "      while (!fs.existsSync(releaseFile)) await new Promise(resolve => setTimeout(resolve, 5));",
    "      return { delivered: true, messageId: attempt.messageId };",
    "    } },",
    "    now: () => 1234",
    "  });",
    "  process.stdout.write(JSON.stringify(await broker.drain('agent-a')));",
    "})().catch(error => { console.error(error && error.stack || error); process.exit(1); });",
    ''
  ].join('\n'), 'utf8');

  const children = [0, 1].map(() => spawn(process.execPath,
    [helper, modulePath, configured.stateFile, readyFile, goFile, releaseFile, callsFile], {
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  t.after(() => { for (const child of children) { try { child.kill(); } catch { /* already exited */ } } });
  const completions = children.map(childCompletion);
  await waitUntil(() => fs.existsSync(readyFile)
    && fs.readFileSync(readyFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length === 2);
  fs.writeFileSync(goFile, 'go', 'utf8');
  await waitUntil(() => fs.existsSync(callsFile));
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(releaseFile, 'release', 'utf8');
  const results = await Promise.all(completions);
  for (const result of results) {
    assert.equal(result.code, 0, `a broker drain child failed: ${result.stderr}`);
  }
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.equal(calls.length, 1, 'two processes called transport for the same durable packet');
  const final = createBroker(configured).getState();
  assert.equal(final.spool.length, 0);
  assert.equal(final.deliveries.length, 1);
  assert.equal(final.deliveries[0].messageId, 'cross-process-once');
});
