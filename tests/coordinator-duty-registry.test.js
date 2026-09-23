// EXECUTABLE CHANGE
//
// Mutation report (testcanfail-tests-coordinator-duty-registry-test-js):
// - Strengthened "the registry module no longer requires any Telegram module".
//   Mutation: inserted a dead-code `require("../telegram-mutant.js")` into
//   duty-registry.js. Before this change the suite stayed green (36 checks)
//   because the scanner recognized only single-quoted require calls.
// - Shapes NOT-FOUND: vacuous product-derived loops (all are protected by an
//   independent cardinality assertion); exit-status/truthy-return-only checks;
//   swallowed failures via try/catch or optional chaining; assertions against a
//   mock of the subject itself; whole-file skips or silent platform guards; and
//   expected values computed by the same product code being checked.
// - Mutation RED output and the restored-source green run are recorded beside
//   the strengthened assertion below. No precondition was unmet.

'use strict';

// R100: the duty registry, and specifically the structural guarantee that the
// duty host CANNOT act on a human's behalf.
//
// The single most dangerous outcome of porting the coordinator onto a daemon
// is a daemon that starts answering the owner. The defence is structural, not
// a comment: judgement duties carry no run() function, validateRegistry
// refuses one that does, and the source of duty-registry.js is asserted never
// to import ownerChat.reply.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../src/lib/coordinator/duty-registry.js');
const { DUTY_OUTCOME } = require('../src/lib/coordinator/heartbeat.js');
const ownerChat = require('../src/lib/owner-chat.js');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coord-reg-'));
}

function referencesReplyCapability(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /\.\s*reply\b/.test(code)
    || /\[\s*(['"])reply\1\s*\]/.test(code)
    || /\{[^}]*\breply\b[^}]*\}\s*=\s*(?:ownerChat\b|require\s*\(\s*(['"])\.\.\/owner-chat\.js\1\s*\))/.test(code);
}

function makeCtx(overrides = {}) {
  return {
    now: () => 1_000_000,
    log: () => {},
    memo: {},
    cycle: { escalationChannel: {}, actionedDirectiveIds: [] },
    killSwitchActive: false,
    allowRestart: false,
    bridgePollStaleMs: 120_000,
    bridgeAckFailureWindowMs: 300_000,
    deps: {},
    ...overrides
  };
}

async function run() {
  process.stdout.write('coordinator-duty-registry\n');

  // --- THE STRUCTURAL GUARD ------------------------------------------------

  await check('the shipped registry validates', () => {
    const verdict = registry.validateRegistry();
    assert.equal(verdict.valid, true, verdict.errors.join('; '));
  });

  await check('every judgement duty ships with NO run() function', () => {
    for (const id of registry.JUDGEMENT_DUTY_IDS) {
      const duty = registry.getDuty(id);
      assert.equal(duty.run, undefined,
        `judgement duty ${id} carries executable code; the host would then have a path to act for a human`);
    }
    // FLOOR LOWERED 9 -> 8 ON 2026-08-23, in the same change that caused it:
    // 'author-pulse-narrative' was a judgement duty about authoring the text of a
    // Telegram /start pulse, and it went with the connector. The floor is lowered
    // rather than left at 9 because a floor that is already breached stops being a
    // guard -- but it is lowered by exactly one, so the next duty to go silently
    // still trips it.
    assert.ok(registry.JUDGEMENT_DUTY_IDS.length >= 8,
      `expected the declared judgement duties to be present, found ${registry.JUDGEMENT_DUTY_IDS.length}`);
  });

  await check('validateRegistry REFUSES a judgement duty that carries a run()', () => {
    const verdict = registry.validateRegistry([
      { id: 'sneaky', kind: registry.DUTY_KIND.JUDGEMENT, description: 'answer him for him', humanAction: 'none', run: async () => ({}) }
    ]);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors.join('; '), /judgement duty sneaky carries a run\(\)/);
  });

  await check('validateRegistry REFUSES a mechanical duty with no run() (it would report silent success)', () => {
    const verdict = registry.validateRegistry([
      { id: 'ghost', kind: registry.DUTY_KIND.MECHANICAL, description: 'does nothing', intervalMs: 1000 }
    ]);
    assert.equal(verdict.valid, false);
    assert.match(verdict.errors.join('; '), /ghost has no run\(\)/);
  });

  await check('validateRegistry rejects duplicate ids and unknown kinds', () => {
    const dup = registry.validateRegistry([
      { id: 'a', kind: registry.DUTY_KIND.MECHANICAL, description: 'x', intervalMs: 1, run: () => {} },
      { id: 'a', kind: registry.DUTY_KIND.MECHANICAL, description: 'x', intervalMs: 1, run: () => {} }
    ]);
    assert.equal(dup.valid, false);
    assert.match(dup.errors.join('; '), /duplicate duty id a/);

    const bad = registry.validateRegistry([{ id: 'b', kind: 'vibes', description: 'x' }]);
    assert.equal(bad.valid, false);
    assert.match(bad.errors.join('; '), /unknown kind/);
  });

  await check('the registry SOURCE never reaches ownerChat.reply', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'duty-registry.js'), 'utf8');
    assert.equal(referencesReplyCapability(source), false,
      'duty-registry.js reaches a reply capability; composing a reply to the owner is a judgement duty');
  });

  await check('the source guard catches alternate JavaScript spellings of ownerChat.reply', () => {
    for (const source of [
      'ownerChat.reply("answer")',
      'ownerChat["reply"]("answer")',
      "ownerChat['reply']('answer')",
      'const { reply } = ownerChat; reply("answer")',
      "const { reply: answer } = require('../owner-chat.js'); answer('text')"
    ]) {
      assert.equal(referencesReplyCapability(source), true, `guard missed: ${source}`);
    }
    assert.equal(referencesReplyCapability('ownerChat.summarize(); sink.replyPolicy = "manual";'), false,
      'non-reply APIs and similarly named properties must remain allowed');
  });

  await check('compose-owner-reply is declared as judgement, and names the human action', () => {
    const duty = registry.getDuty('compose-owner-reply');
    assert.equal(duty.kind, registry.DUTY_KIND.JUDGEMENT);
    assert.equal(duty.run, undefined);
    assert.match(duty.humanAction, /owner-chat/);
  });

  // --- OWNER INBOX DETECTION ------------------------------------------------

  await check('owner-inbox-detect reports OWNER_WAITING_FOR_REPLY without answering', async () => {
    const ctx = makeCtx({
      deps: {
        ownerChat: {
          CONDITIONS: ownerChat.CONDITIONS,
          summarize: () => ({
            condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY,
            ownerWaiting: true, unread: 2, ownerUnread: 1,
            waitingMs: 15 * 60_000, staleThresholdMs: ownerChat.STALE_UNREAD_MS,
            lastDrainedAtMs: null, drainCommand: ownerChat.DRAIN_COMMAND
          })
        }
      }
    });
    const result = await registry._internals.runOwnerInboxDetect(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.condition, 'OWNER_WAITING_FOR_REPLY');
    assert.equal(result.detail.ownerWaiting, true);
  });

  await check('owner-inbox-detect reports UNAVAILABLE when the inbox cannot be read', async () => {
    const ctx = makeCtx({
      deps: {
        ownerChat: {
          CONDITIONS: ownerChat.CONDITIONS,
          summarize: () => ({ condition: ownerChat.CONDITIONS.UNAVAILABLE, drainCommand: ownerChat.DRAIN_COMMAND })
        }
      }
    });
    const result = await registry._internals.runOwnerInboxDetect(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE,
      '"I cannot read the inbox" must never render as "he is not waiting"');
  });

  // --- ESCALATION IS A NOTICE, NOT A REPLY ---------------------------------

  await check('owner-waiting-escalate sends a notice ABOUT the condition, carrying no owner text', async () => {
    const sent = [];
    const ctx = makeCtx({
      deps: {
        ownerChat: { CONDITIONS: ownerChat.CONDITIONS, summarize: () => { throw new Error('should use cycle value'); } },
        escalationSink: { escalate: async candidate => { sent.push(candidate); return { decision: 'SEND', delivered: true }; } }
      }
    });
    ctx.cycle.ownerInbox = {
      condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY,
      waitingMs: 12 * 60_000, drainCommand: ownerChat.DRAIN_COMMAND
    };
    const result = await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.escalated, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].state, 'OWNER_WAITING_FOR_REPLY');
    assert.match(sent[0].reason, /no agent reply/i);
    assert.match(sent[0].reason, /owner-chat/, 'the notice must tell a human what to run');
  });

  await check('owner-waiting-escalate does nothing when the owner is not waiting', async () => {
    let called = 0;
    const ctx = makeCtx({ deps: { escalationSink: { escalate: async () => { called += 1; return {}; } } } });
    ctx.cycle.ownerInbox = { condition: ownerChat.CONDITIONS.CLEAR, drainCommand: ownerChat.DRAIN_COMMAND };
    const result = await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.escalated, false);
    assert.equal(called, 0);
  });

  await check('owner-waiting-escalate reports UNAVAILABLE (not OK) when the sink is unloadable', async () => {
    // Was previously written with NO escalationSink injected, so it fell through
    // to the REAL module. Two problems, both real, both fixed here:
    //   1. Once escalation-sink.js landed, the "missing" branch stopped being
    //      exercised at all -- the test silently changed meaning.
    //   2. The real sink defaults to state/coordinator-escalation.json, so every
    //      run of this SUITE mutated PRODUCTION durable state, inflating the
    //      suppressed-duplicate counter the owner reads via --status.
    // An injected unloadable sink tests the declared behaviour deterministically
    // and touches nothing outside the process.
    const ctx = makeCtx({ deps: { escalationSink: { /* no escalate() */ } } });
    ctx.cycle.ownerInbox = {
      condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY, waitingMs: 60_000, drainCommand: ownerChat.DRAIN_COMMAND
    };
    const result = await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.ok([DUTY_OUTCOME.UNAVAILABLE, DUTY_OUTCOME.FAILED].includes(result.outcome),
      'a sink with no escalate() must never read as OK');
    assert.equal(result.detail.escalated, false,
      'a failed escalation must never report as escalated');
  });

  await check('optional module lookup keeps could-not-tell separate from absent and does not cache it', () => {
    const relativePath = './escalation-sink.js';
    const originalStatSync = fs.statSync;
    let statCalls = 0;
    try {
      fs.statSync = filename => {
        statCalls += 1;
        if (statCalls === 1) {
          const error = new Error('file table temporarily exhausted');
          error.code = 'EMFILE';
          throw error;
        }
        return originalStatSync(filename);
      };

      const unavailableResult = registry._internals.optionalModule(makeCtx(), 'escalationSink', relativePath);
      assert.equal(unavailableResult.ok, false);
      assert.equal(unavailableResult.code, 'COORDINATOR_OPTIONAL_MODULE_LOOKUP_UNAVAILABLE');
      assert.match(unavailableResult.reason, /does NOT claim the module is absent/);

      const recoveredResult = registry._internals.optionalModule(makeCtx(), 'escalationSink', relativePath);
      assert.equal(recoveredResult.ok, true,
        'a transient lookup failure must not be cached or latched as absence');
      assert.equal(statCalls, 2, 'the lookup must be retried after a could-not-tell result');

      const cachedControl = registry._internals.optionalModule(makeCtx(), 'escalationSink', relativePath);
      assert.equal(cachedControl.ok, true);
      assert.strictEqual(cachedControl.module, recoveredResult.module,
        'CONTROL: successful CommonJS loads must retain the require cache that existed before this fix');
    } finally {
      fs.statSync = originalStatSync;
    }
  });

  // INTEGRATION SEAM (R100 integrate phase). escalate() RESOLVES for
  // SUPPRESS_RATE_LIMIT / SUPPRESS_DUPLICATE just as it does for SEND. Reading
  // "it did not throw" as "the owner was told" is the false-OK-from-a-suppressed
  // -escalation failure, and it lands hardest on exactly the R100 condition:
  // the owner is waiting, an unrelated alarm trips the global 60s send floor,
  // and his notice is dropped while the heartbeat claims escalated:true.
  await check('a SUPPRESSED escalation never reports escalated:true', async () => {
    for (const decision of ['SUPPRESS_RATE_LIMIT', 'SUPPRESS_DUPLICATE', 'SUPPRESS_QUIET_HOURS']) {
      const ctx = makeCtx({
        deps: { escalationSink: { escalate: async () => ({ decision, delivered: false }) } }
      });
      ctx.cycle.ownerInbox = {
        condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY,
        waitingMs: 23 * 60_000, drainCommand: ownerChat.DRAIN_COMMAND
      };
      const result = await registry._internals.runOwnerWaitingEscalate(ctx);
      assert.equal(result.detail.escalated, false, `${decision} must not read as escalated`);
      assert.equal(result.detail.suppressedDecision, decision);
      assert.match(result.reason, /STILL WAITING AND HAS NOT BEEN NOTIFIED/,
        'the reason must say the owner has not been told');
      // A suppressed send exercised no wire, so it must not manufacture a
      // green escalation channel either.
      assert.notEqual(ctx.cycle.escalationChannel.state, 'OK');
    }
  });

  await check('owner-waiting-escalate is SKIPPED, not silently dropped, under the kill switch', async () => {
    let called = 0;
    const ctx = makeCtx({
      killSwitchActive: true,
      deps: { escalationSink: { escalate: async () => { called += 1; return {}; } } }
    });
    ctx.cycle.ownerInbox = { condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY, waitingMs: 60_000, drainCommand: 'x' };
    const result = await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.SKIPPED);
    assert.equal(called, 0);
  });

  await check('a throwing escalation sink is recorded as a BROKEN channel, not as quiet', async () => {
    const ctx = makeCtx({
      deps: {
        escalationSink: {
          escalate: async () => { const error = new Error('not paired'); error.code = 'TELEGRAM_BRIDGE_NOT_PAIRED'; throw error; }
        }
      }
    });
    ctx.cycle.ownerInbox = { condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY, waitingMs: 60_000, drainCommand: 'x' };
    const result = await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.FAILED);
    assert.equal(ctx.cycle.escalationChannel.state, 'BROKEN');
    assert.match(ctx.cycle.escalationChannel.reason, /TELEGRAM_BRIDGE_NOT_PAIRED/);
  });

  // INTEGRATION SEAM (R100 integrate phase). escalation-sink.js#withLock throws
  // ESCALATION_STATE_BUSY after 5x25ms when another writer holds the advisory
  // lock on state/coordinator-escalation.json -- which happens whenever the duty
  // host cycles while a human runs tools/coordinator-escalate.js. Before this
  // was fixed, escalateVia's catch rendered that transient contention with the
  // same word as a dead Telegram channel: BROKEN, which the dashboard headlines
  // as "NOT reaching the owner". Two builders were each locally right; the
  // COMPOSITION cried wolf on the one channel that carries every other alarm.
  await check('lock CONTENTION is deferred, not reported as a BROKEN owner channel', async () => {
    const ctx = makeCtx({
      deps: {
        escalationSink: {
          escalate: async () => {
            const error = new Error('The escalation state file is busy; retry shortly.');
            error.code = 'ESCALATION_STATE_BUSY';
            throw error;
          }
        }
      }
    });
    ctx.cycle.ownerInbox = { condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY, waitingMs: 60_000, drainCommand: 'x' };
    await registry._internals.runOwnerWaitingEscalate(ctx);
    assert.notEqual(ctx.cycle.escalationChannel.state, 'BROKEN');
    assert.equal(ctx.cycle.escalationChannel.state, 'UNKNOWN');
    // It must also never read as delivered: the escalation is still owed.
    assert.match(ctx.cycle.escalationChannel.reason, /still owed/);
    assert.equal(ctx.cycle.escalationChannel.lastSendAtMs, null);
  });

  await check('every OTHER sink error code still reports BROKEN (the narrow set stays narrow)', async () => {
    for (const code of ['ESCALATION_INVALID', 'ESCALATION_STATE_CORRUPT',
      'ESCALATION_STATE_UNAVAILABLE', 'ESCALATION_LOOKS_SENSITIVE']) {
      const ctx = makeCtx({
        deps: {
          escalationSink: {
            escalate: async () => { const error = new Error('x'); error.code = code; throw error; }
          }
        }
      });
      ctx.cycle.ownerInbox = { condition: ownerChat.CONDITIONS.OWNER_WAITING_FOR_REPLY, waitingMs: 60_000, drainCommand: 'x' };
      await registry._internals.runOwnerWaitingEscalate(ctx);
      assert.equal(ctx.cycle.escalationChannel.state, 'BROKEN', `${code} must stay BROKEN: it needs a human`);
    }
  });

  // --- ACK NEVER TOUCHES AN OWNER MESSAGE ----------------------------------

  await check('machine-directive-ack acknowledges NOTHING when the host actioned nothing', async () => {
    let called = 0;
    const ctx = makeCtx({ deps: { ownerChat: { acknowledgeWithoutReply: () => { called += 1; } } } });
    const result = await registry._internals.runMachineDirectiveAck(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.acknowledged, 0);
    assert.equal(called, 0, 'the host must never walk the inbox filing away things it did not handle');
  });

  await check('an owner-sourced item refused by acknowledgeWithoutReply is REPORTED, not swallowed', async () => {
    const ctx = makeCtx({
      deps: {
        ownerChat: {
          acknowledgeWithoutReply: () => {
            const error = new Error('his messages get answered, not filed');
            error.code = 'OWNER_CHAT_NEEDS_A_REPLY';
            throw error;
          }
        }
      }
    });
    ctx.cycle.actionedDirectiveIds = ['owner-directive-00000000-0000-4000-8000-000000000000'];
    const result = await registry._internals.runMachineDirectiveAck(ctx);
    assert.equal(result.detail.acknowledged, 0);
    assert.equal(result.detail.refused.length, 1);
    assert.equal(result.detail.refused[0].code, 'OWNER_CHAT_NEEDS_A_REPLY');
  });

  // --- WAKE MONITOR ---------------------------------------------------------
  // THE TWO WAKE-MONITOR CASES WERE REMOVED 2026-08-23 with the
  // 'wake-signal-monitor' duty. They fed a stubbed
  // telegramBridgeCommands.WAKE_SIGNAL_FILE; nothing writes that log any more.

  // --- SIBLING-OWNED MODULES ------------------------------------------------

  await check('argv-drift-detect reports UNAVAILABLE (never fabricates) when the module is absent', async () => {
    const ctx = makeCtx();
    const onDisk = fs.existsSync(path.join(__dirname, '..', 'src', 'lib', 'argv-drift.js'));
    if (!onDisk) {
      const result = await registry._internals.runArgvDriftDetect(ctx);
      assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
      assert.match(result.reason, /argv-drift\.js/);
      return;
    }
    // The module landed. Simulate its absence by injecting a module object
    // that exports nothing, which is the same class of failure.
    const broken = makeCtx({ deps: { argvDrift: {} } });
    const result = await registry._internals.runArgvDriftDetect(broken);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.match(result.reason, /detectAllDrift/);
  });

  await check('argv-drift-detect consumes the REAL detectAllDrift shape', async () => {
    // Shape read from src/lib/argv-drift.js#detectAllDrift, not invented.
    const ctx = makeCtx({
      deps: {
        argvDrift: {
          detectAllDrift: async () => ({
            observedAtMs: 1,
            processTableReadable: true,
            drifted: ['fleet-supervisor'],
            unknown: ['sidecar'],
            records: {
              'fleet-supervisor': {
                id: 'fleet-supervisor', state: 'DRIFT',
                declaredArgv: ['--serve', '--quiet', '--project', 'p', '--backend', 'vertex'],
                missing: ['--project', 'p', '--backend', 'vertex'], extra: [],
                reason: 'live argv is missing --project and --backend'
              },
              'sidecar': { id: 'sidecar', state: 'UNKNOWN' },
              'telegram-bridge': { id: 'telegram-bridge', state: 'MATCH' }
            }
          })
        }
      }
    });
    const result = await registry._internals.runArgvDriftDetect(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.checked, 3);
    assert.equal(result.detail.drifted, 1);
    assert.equal(result.detail.unknown, 1, 'UNKNOWN must be its own bucket, never folded into "no drift"');
    assert.equal(result.detail.records[0].id, 'fleet-supervisor');
    assert.deepEqual(result.detail.records[0].missing, ['--project', 'p', '--backend', 'vertex']);
  });

  await check('argv-drift-detect reports UNAVAILABLE when the process table is unreadable', async () => {
    const ctx = makeCtx({
      deps: {
        argvDrift: {
          detectAllDrift: async () => ({ processTableReadable: false, drifted: [], unknown: ['a'], records: { a: { id: 'a', state: 'UNKNOWN' } } })
        }
      }
    });
    const result = await registry._internals.runArgvDriftDetect(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.match(result.reason, /not a liveness claim/);
  });

  await check('argv-drift-detect refuses an incomplete or zero-item scan', async () => {
    for (const resultValue of [
      {},
      { processTableReadable: true, drifted: [], unknown: [], records: {} }
    ]) {
      const ctx = makeCtx({ deps: { argvDrift: { detectAllDrift: async () => resultValue } } });
      const result = await registry._internals.runArgvDriftDetect(ctx);
      assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE,
        'an incomplete or empty scan must not become a definite no-drift answer');
    }
  });

  // --- LIVENESS AND DURABILITY STAY SEPARATE --------------------------------

  await check('task-registration-check reports UNKNOWN, not NOT_REGISTERED, when it cannot look', async () => {
    const ctx = makeCtx({
      deps: {
        managedProcesses: { listProcesses: () => ([{ id: 'x', taskName: 'Task X' }]) },
        observer: { collectScheduledTasks: () => undefined }        // could not query
      }
    });
    const result = await registry._internals.runTaskRegistrationCheck(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.match(result.reason, /UNKNOWN, not absent/);
  });

  await check('task-registration-check reports durability WITHOUT implying liveness', async () => {
    const ctx = makeCtx({
      deps: {
        managedProcesses: { listProcesses: () => ([{ id: 'a', taskName: 'A' }, { id: 'b', taskName: 'B' }]) },
        observer: { collectScheduledTasks: () => new Map([['A', { state: 'Running' }]]) }
      }
    });
    const result = await registry._internals.runTaskRegistrationCheck(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.OK);
    assert.equal(result.detail.registered.length, 1);
    assert.equal(result.detail.notRegistered[0].id, 'b');
    assert.match(result.detail.note, /may still be alive/,
      'collapsing "cannot self-restart" into "is not running" is the verified false-DOWN bug');
  });

  await check('task-registration-check refuses a zero-task scan', async () => {
    const ctx = makeCtx({
      deps: {
        managedProcesses: { listProcesses: () => [] },
        observer: { collectScheduledTasks: () => new Map() }
      }
    });
    const result = await registry._internals.runTaskRegistrationCheck(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE,
      'zero declared tasks must not vacuously become ALL_REGISTERED');
  });

  // --- BRIDGE: LIVENESS IS NOT FUNCTION -------------------------------------

  // THE BRIDGE-FUNCTION AND PULSE-STALL CASES WERE REMOVED 2026-08-23 with the
  // two duties they covered. Both drove a stubbed telegramBridge/telegramPulse
  // through registry._internals; those modules are deleted and the duties are
  // gone from DUTIES.

  // --- THE REGISTRY'S SHAPE AFTER THE TELEGRAM REMOVAL ----------------------

  await check('the three Telegram duties are gone and no OTHER duty went with them', async () => {
    const ids = registry.listDuties().map(duty => duty.id);
    for (const gone of ['wake-signal-monitor', 'bridge-function-probe', 'pulse-stall-probe', 'author-pulse-narrative']) {
      assert.equal(ids.includes(gone), false, `${gone} is a Telegram duty and must not come back`);
      assert.equal(registry.getDuty(gone), null, `getDuty('${gone}') must not resolve`);
    }
    // The count is pinned, not just the three names. A removal that quietly took a
    // fourth duty with it would otherwise pass every assertion above -- which is
    // exactly how a coordinator ends up doing less than anyone thinks it does.
    assert.equal(ids.length, 19, 'the registry held 23 duties before the Telegram removal and must hold exactly 19 after');
    assert.equal(new Set(ids).size, ids.length, 'duty ids must stay unique');
    // Every surviving MECHANICAL duty must still be runnable: a dangling `run` is
    // what the deleted _internals exports would have left behind. Judgement duties
    // deliberately have no run -- they carry a humanAction instead -- so they are
    // checked for THAT rather than lumped in and asserted loosely.
    for (const duty of registry.listDuties()) {
      if (duty.kind === 'judgement') {
        assert.equal(typeof duty.humanAction, 'string', `${duty.id} is a judgement duty with no humanAction`);
        assert.equal(duty.run, undefined, `${duty.id} is a judgement duty and must not carry a run function`);
      } else {
        assert.equal(typeof duty.run, 'function', `${duty.id} has no run function`);
      }
    }
    assert.deepEqual(registry.validateRegistry(), { valid: true, errors: [] });
  });

  await check('the registry module no longer requires any Telegram module', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'coordinator', 'duty-registry.js'), 'utf8');
    // Comments recording the removal are expected and wanted; a live require is not.
    // Mutation proof (temporary product edit, then restored byte-for-byte):
    //   if (false) require("../telegram-mutant.js");
    // RED after strengthening:
    //   FAILED: duty-registry still requires a Telegram module:
    //   require("../telegram-mutant.js")
    // Restored-source confirmation:
    //   coordinator-duty-registry: 36 checks passed
    const requires = source.match(/\brequire\s*\(\s*(['"])[^'"]+\1\s*\)/g) || [];
    const telegram = requires.filter(line => line.includes('telegram'));
    assert.deepEqual(telegram, [], `duty-registry still requires a Telegram module: ${telegram.join(', ')}`);
  });

  // --- DASHBOARD PROBE: PORT IS NOT PROCESS ---------------------------------

  await check('dashboard probe reports identity UNKNOWN even when the port is held', async () => {
    const ctx = makeCtx({ probeListener: async () => ({ listeners: [{ pid: 29420 }] }) });
    const result = await registry._internals.runDashboardListenerProbe(ctx);
    assert.equal(result.detail.listening, true);
    assert.equal(result.detail.identity, 'UNKNOWN',
      'the listener command line is unreadable unelevated; that must never be "fixed" into OK');
  });

  await check('dashboard probe escalates when nothing holds the port', async () => {
    const sent = [];
    const ctx = makeCtx({
      probeListener: async () => ({ listeners: [] }),
      deps: { escalationSink: { escalate: async candidate => { sent.push(candidate); return { decision: 'SEND', delivered: true }; } } }
    });
    const result = await registry._internals.runDashboardListenerProbe(ctx);
    assert.equal(result.detail.listening, false);
    assert.equal(sent.length, 1);
    // CANONICAL FIELD NAME. escalation-policy.js keys its dedupe identity on
    // `subsystemId`; escalation-sink.js additionally accepts `id` as an alias
    // purely because this registry used to send that spelling. Asserting the
    // canonical name here means the alias is a courtesy rather than something
    // load-bearing -- if the sink ever drops it, nothing here breaks. That
    // matters because the sink turns an unknown field into ESCALATION_INVALID,
    // which the host would surface as "escalation channel BROKEN": a field-name
    // typo would have masqueraded as a dead Telegram channel.
    assert.equal(sent[0].subsystemId, 'dashboard');
  });

  await check('dashboard probe reports UNAVAILABLE when the probe itself throws', async () => {
    const ctx = makeCtx({ probeListener: async () => { throw new Error('probe blew up'); } });
    const result = await registry._internals.runDashboardListenerProbe(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.equal(result.detail.listening, 'UNKNOWN');
  });

  await check('dashboard probe reports UNAVAILABLE when the probe result has no listener measurement', async () => {
    const ctx = makeCtx({ probeListener: async () => ({}) });
    const result = await registry._internals.runDashboardListenerProbe(ctx);
    assert.equal(result.outcome, DUTY_OUTCOME.UNAVAILABLE);
    assert.equal(result.detail.listening, 'UNKNOWN',
      'a malformed probe response must not become a definite no-listener answer');
  });

  // --- RESTART IS GATED ------------------------------------------------------

  await check('the restart gate matches the REAL policy action vocabulary', async () => {
    // Regression guard. policy.decide emits 'none' | 'quarantine' | 'correct'
    // and NEVER 'restart'. Gating on 'restart' made --allow-restart a silent
    // no-op: a duty reporting success while doing nothing.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'lib', 'supervision', 'policy.js'), 'utf8');
    const emitted = new Set([...source.matchAll(/action:\s*'([a-z]+)'/g)].map(match => match[1]));
    assert.ok(emitted.has('correct'),
      `policy.js no longer emits action 'correct' (it emits ${[...emitted].join(', ')}); the duty host restart gate must be updated`);

    // And prove the gate actually opens on that string.
    let spawned = 0;
    const ctx = makeCtx({
      allowRestart: true,
      spawnManaged: async () => { spawned += 1; return { pid: 4242 }; },
      deps: {
        observer: { sweep: () => ({ subsystems: { x: { id: 'x', state: 'DOWN', reason: 'down', correctable: true } } }) },
        policy: { decide: () => ({ action: 'correct', outcome: 'CORRECTION_ATTEMPT', reason: 'permitted' }), recordAttempt: () => {} },
        managedProcesses: {
          resolveArgv: () => ['tools/x.js', '--serve'],
          checkArgvPreconditions: () => ({ ok: true, code: 'OK', missing: [], reason: 'ok' })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(spawned, 1, "action 'correct' with --allow-restart must actually spawn");
    assert.equal(result.detail.decisions[0].outcome, 'RESTART_ATTEMPTED');
    assert.equal(result.detail.decisions[0].spawnedPid, 4242);
  });

  await check('bounded restart WITHHOLDS by default and says so', async () => {
    let spawned = 0;
    const ctx = makeCtx({
      allowRestart: false,
      spawnManaged: async () => { spawned += 1; return { pid: 1 }; },
      deps: {
        observer: { sweep: () => ({ subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'DOWN', reason: 'down', correctable: true } } }) },
        policy: { decide: () => ({ id: 'fleet-supervisor', action: 'correct', outcome: 'CORRECTION_ATTEMPT', reason: 'permitted' }) },
        managedProcesses: {
          resolveArgv: () => ['tools/fleet-supervisor.js', '--serve', '--quiet', '--project', 'p', '--backend', 'vertex'],
          checkArgvPreconditions: () => ({ ok: true, code: 'OK', missing: [], reason: 'ok' })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(spawned, 0);
    assert.equal(result.detail.decisions[0].outcome, 'RESTART_WITHHELD_REPORT_ONLY');
  });

  await check('wrapper-only dashboard correction remains report-only with zero spawn', async () => {
    let spawned = 0;
    let argvResolved = 0;
    const ctx = makeCtx({
      allowRestart: true,
      spawnManaged: async () => { spawned += 1; return { pid: 1 }; },
      deps: {
        observer: { sweep: () => ({ subsystems: { dashboard: { id: 'dashboard', state: 'DOWN', failedRung: 'alive', correctable: true } } }) },
        policy: { decide: () => ({ action: 'correct', outcome: 'CORRECT', reason: 'bounded correction permitted' }) },
        managedProcesses: {
          correctionMode: id => id === 'dashboard' ? 'report-only' : 'direct-node',
          resolveArgv: () => { argvResolved += 1; throw new Error('report-only correction resolved argv'); },
          checkArgvPreconditions: () => ({ ok: true })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(spawned, 0);
    assert.equal(argvResolved, 0);
    assert.equal(result.detail.decisions[0].outcome, 'RESTART_INAPPLICABLE_LAUNCH_CONTRACT');
  });

  await check('bounded restart REPORTS a precondition failure and never attempts the spawn', async () => {
    let spawned = 0;
    const ctx = makeCtx({
      allowRestart: true,
      spawnManaged: async () => { spawned += 1; return { pid: 1 }; },
      deps: {
        observer: { sweep: () => ({ subsystems: { 'fleet-supervisor': { id: 'fleet-supervisor', state: 'DOWN', reason: 'down', correctable: true } } }) },
        policy: { decide: () => ({ action: 'correct', outcome: 'CORRECTION_ATTEMPT', reason: 'permitted' }) },
        managedProcesses: {
          // The verified live drift: no --project, no --backend.
          resolveArgv: () => ['tools/fleet-supervisor.js', '--serve', '--quiet'],
          checkArgvPreconditions: (id, argv) => ({
            ok: false, code: 'CORRECTION_PRECONDITION_FAILED',
            missing: ['--project', '--backend'],
            reason: `resolved argv for ${id} is missing required flag(s): --project, --backend (${argv.length} tokens)`
          })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(spawned, 0, 'a restart whose preconditions fail is REPORTED, never attempted');
    assert.equal(result.detail.decisions[0].outcome, 'CORRECTION_PRECONDITION_FAILED');
  });

  // INTEGRATION SEAM (R100 integrate phase). Reproduces the MEASURED live case:
  // the duty host was running healthily as pid 34848 with a 5s-old heartbeat,
  // yet observer.sweep() reported coordinator-duty-host DOWN with failedRung
  // 'registered' -- the ONLY rung evaluated, because health-invariants.js
  // returns at the first failure and maps registered->DOWN. Under --allow-restart
  // this duty would have spawned a second duty host against a healthy one every
  // cycle, and a spawn cannot register a scheduled task, so it could never clear
  // the condition either.
  await check('a DOWN meaning NOT REGISTERED never triggers a restart, even with --allow-restart', async () => {
    let spawned = 0;
    const ctx = makeCtx({
      allowRestart: true,
      deps: {
        observer: {
          sweep: () => ({
            subsystems: {
              'coordinator-duty-host': {
                id: 'coordinator-duty-host',
                state: 'DOWN',
                failedRung: 'registered',
                reason: "scheduled task 'ToolsEnabled Coordinator Duty Host' is NOT registered",
                correctable: true,
                rungs: [{ rung: 'registered', state: 'fail' }]
              }
            }
          })
        },
        policy: { decide: () => { throw new Error('policy must not even be consulted for a registration gap'); } },
        managedProcesses: {
          resolveArgv: () => { spawned += 1; return []; },
          checkArgvPreconditions: () => ({ ok: true })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(result.detail.attempted, 0, 'no restart may be attempted for a registration gap');
    assert.equal(spawned, 0, 'argv must not even be resolved');
    const record = result.detail.decisions.find(d => d.id === 'coordinator-duty-host');
    assert.equal(record.outcome, 'RESTART_INAPPLICABLE_NOT_REGISTERED');
    assert.match(record.decisionReason, /DURABILITY/,
      'the record must name durability, not liveness');
  });

  await check('a genuine liveness DOWN is still acted on (the guard stays narrow)', async () => {
    const ctx = makeCtx({
      allowRestart: true,
      deps: {
        observer: {
          sweep: () => ({
            subsystems: {
              'telegram-bridge': {
                id: 'telegram-bridge', state: 'DOWN', failedRung: 'alive',
                reason: 'pid lock names a dead pid', correctable: true
              }
            }
          })
        },
        policy: { decide: () => ({ action: 'correct', outcome: 'CORRECT', reason: 'bounded restart permitted' }) },
        managedProcesses: {
          resolveArgv: () => ['x.js', '--serve'],
          checkArgvPreconditions: () => ({ ok: false, code: 'BLOCKED', missing: ['--x'], reason: 'blocked in test' })
        }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    const record = result.detail.decisions.find(d => d.id === 'telegram-bridge');
    assert.notEqual(record.outcome, 'RESTART_INAPPLICABLE_NOT_REGISTERED',
      'an alive-rung failure must still reach the policy/precondition path');
  });

  await check('bounded restart ignores subsystems that are not DOWN', async () => {
    const ctx = makeCtx({
      allowRestart: true,
      deps: {
        observer: { sweep: () => ({ subsystems: { a: { id: 'a', state: 'DEGRADED', correctable: true } } }) },
        policy: { decide: () => { throw new Error('must not be consulted'); } },
        managedProcesses: { resolveArgv: () => [], checkArgvPreconditions: () => ({ ok: true }) }
      }
    });
    const result = await registry._internals.runBoundedRestart(ctx);
    assert.equal(result.detail.downSubsystems, 0);
  });

  process.stdout.write(`\ncoordinator-duty-registry: ${passed} checks passed\n`);
}

run().catch(error => {
  process.stdout.write(`\nFAILED: ${error && error.message}\n${error && error.stack}\n`);
  process.exitCode = 1;
});
