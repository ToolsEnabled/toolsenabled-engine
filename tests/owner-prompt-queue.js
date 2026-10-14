// EXECUTABLE CHANGE
// testcanfail-tests-owner-prompt-queue-js
//
// Strengthened assertion: the identity-bound attribution-refusal loop below.
// Mutation: changed IDENTITY_BOUND_KINDS in src/lib/providers/owner-prompt-queue.js
// from ['payment_card'] to []. Before this
// strengthening the loop executed zero assertions (the later independent
// payment-card check eventually failed). With the strengthening, the test was
// RED at the vacuity boundary:
//   AssertionError [ERR_ASSERTION]: identity-bound refusal cases must be enumerated before testing each one
//   + actual - expected
//   + []
//   - [ 'payment_card' ]
// The source mutation was restored byte-for-byte (matching SHA-256
// 4b905110628a1558ad18f6955824475826c9903a835397a03ea1af7c471103eb).
// Restored GREEN run: "Owner prompt queue tests passed."
//
// NOT-FOUND (2): no exit-status/truthy-process-return assertion uses something
// other than the subject's own output as evidence; this file spawns only mocks
// and does not assert their exit status.
// NOT-FOUND (3): no try/catch or optional chain swallows the failure under test.
// The attribution try/catch rethrows by an explicit sentinel when no exception
// occurs, and the fs.renameSync restoration uses finally.
// NOT-FOUND (4): no assertion tests a mock of the behavior under test. Spawn
// doubles record boundary effects while queue persistence/results are asserted.
// NOT-FOUND (5): no skip or platform precondition guard can make the file a
// no-op; the PowerShell runner is inspected as text on every platform.
// NOT-FOUND (6): no expected value is computed by the same product code it
// checks. Fixtures derive IDs/timestamps locally, while expectations are fixed.
// Preconditions not met: none.

'use strict';

require('./lib/isolated-environment').activate('owner-prompt-queue');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const queue = require('../src/lib/providers/owner-prompt-queue');
const errorTaxonomy = require('../src/lib/error-taxonomy');
const runner = fs.readFileSync(queue.WINDOWS_UI, 'utf8');
assert.match(runner, /A quiet, one-at-a-time check-in/);
assert.match(runner, /Begin securely/);
assert.match(runner, /\[string\]::IsNullOrWhiteSpace\(\$promptHint\)/);
assert.match(runner, /We stopped safely/);
assert.match(runner, /function Invoke-OwnerPromptAttentionSound/);
assert.match(runner, /\[System\.Media\.SystemSounds\]::Exclamation\.Play\(\)/);
assert.match(runner, /\[Console\]::Beep\(880, 180\)/);
assert.match(runner, /if \(\$script:OwnerPromptAttentionSoundPlayed\) \{ return \}/);
assert.equal((runner.match(/Invoke-OwnerPromptAttentionSound/g) || []).length, 2);
// Queue mutation and attribution are exercised through the shared runner in
// owner-prompt-shared-runner.test.js. The native adapter must not duplicate them.
assert.doesNotMatch(runner, /function (?:Write-Queue|Try-Present-Request|Set-RequestStatus|Recover-InterruptedRequests)/);
const native = require('../src/lib/owner-prompt-platform');
const hintItem = { requester: 'claude', requestContext: { purpose: 'A local request', scope: 'A local scope', lifetime: 'Until done' } };
assert.match(native.publicMessage(hintItem), /Claude \(declared, not verified\)/);
assert.match(native.publicMessage({ ...hintItem, requester: 'unattributed' }), /Not established - no agent identity was recorded/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-queue-'));
const queueFile = path.join(root, 'queue.json');
const launches = [];
// relaunchThrottleMs: 0 makes the wedge-recovery launch deterministic here. In
// production it is throttled per process so a caller retrying in a loop cannot
// spawn a pile of runners; the throttle is timing, not behaviour, so the tests
// below assert the behaviour with it disabled.
const options = { queueFile, relaunchThrottleMs: 0, spawn(command, args, spawnOptions) { launches.push({ command, args, spawnOptions }); return { pid: 1234, unref() {} }; } };
const credentialContext = Object.freeze({
  purpose: 'Connect the approved provider workflow',
  scope: 'Read the minimum account metadata needed for this task',
  lifetime: 'Short-lived and owner-revocable'
});
const attributedCard = Object.freeze({ requestContext: credentialContext, requester: 'codex' });

// A failed filesystem lookup is not evidence that the runner is absent. Keep
// the genuine-absence answer as the control, and prove transient lookup errors
// get a distinct, explicitly uncertain answer rather than the absent one.
const missingRunner = path.join(root, 'missing-owner-prompt-runner.ps1');
assert.throws(
  () => queue.launchWaitingDialog({ ...options, runner: missingRunner }),
  error => error && error.code === 'OWNER_PROMPT_RUNNER_UNAVAILABLE',
  'CONTROL: ENOENT must retain the established genuinely-absent answer'
);
const originalStatSync = fs.statSync;
try {
  fs.statSync = candidate => {
    if (path.resolve(candidate) === path.resolve(queue.RUNNER)) {
      const error = new Error('machine is temporarily out of file descriptors');
      error.code = 'EMFILE';
      throw error;
    }
    return originalStatSync(candidate);
  };
  assert.throws(
    () => queue.launchWaitingDialog(options),
    error => error && error.code === 'OWNER_PROMPT_RUNNER_LOOKUP_UNAVAILABLE'
      && /does not mean the runner is absent/.test(error.message),
    'EMFILE must report that lookup did not answer, never that the runner is absent'
  );
} finally {
  fs.statSync = originalStatSync;
}

const created = queue.enqueue({ kind: 'payment_card', vaultKey: 'payment_card_default', label: 'default payment card', ...attributedCard }, options);
assert.equal(created.status, 'queued');
assert.equal(created.replayed, false);
assert.equal(created.launcherRequested, true);
assert.equal(launches.length, 1);
assert.ok(!JSON.stringify(created).includes('cardNumber'));
const replay = queue.enqueue({ kind: 'payment_card', vaultKey: 'payment_card_default', label: 'default payment card', ...attributedCard }, options);
assert.equal(replay.replayed, true);
assert.equal(replay.requestId, created.requestId);
assert.equal(replay.launcherRequested, false, 'same-key replay must not launch a duplicate hidden runner');
assert.equal(launches.length, 1, 'same-key replay leaves the original runner as the only launch');
const persisted = queue.readQueue(queueFile);
assert.equal(persisted.items.length, 1);
assert.equal(persisted.events[0].type, 'queued');
// A DIFFERENT KEY IS A DIFFERENT QUESTION, SO IT QUEUES -- it does not refuse.
// This asserted the opposite until 2026-08-21: a second key threw
// OWNER_PROMPT_DIFFERENT_ACTIVE, which is precisely how ONE unanswered prompt
// starved every credential request for every other key for ~17 hours
// (logs/actions.jsonl seq 20592, 20594, 22217, 23323). The single slot is gone;
// the runner presents a queue in order and always could.
const launchesBeforeSecond = launches.length;
const second = queue.enqueue({ kind: 'credential', vaultKey: 'different_credential', label: 'different credential', requestContext: credentialContext, requester: 'codex' }, options);
assert.ok(second.requestId, 'a different key must queue rather than be refused');
assert.notEqual(second.requestId, created.requestId, 'a different key is a different request, not a replay');
assert.equal(second.replayed, false);
const bothPersisted = queue.readQueue(queueFile);
assert.equal(bothPersisted.items.filter(item => ['queued', 'presenting'].includes(item.status)).length, 2,
  'both prompts must be durable and active at once');
assert.ok(bothPersisted.items.some(item => item.vaultKey === 'payment_card_default'),
  'queueing a second key must never terminate the first');
assert.equal(launches.length, launchesBeforeSecond + 1, 'each newly queued prompt starts the runner');

// NOTHING EXPIRES A PROMPT THE OWNER HAS NOT ANSWERED. He is putting a secret
// IN, not taking one out, so walking away must cost him nothing. This replaces
// the two-hour queued / four-hour presenting sweep, whose only justification was
// clearing the single slot that no longer exists.
const aged = queue.readQueue(queueFile);
aged.items[0].updatedAtMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
fs.writeFileSync(queueFile, JSON.stringify(aged));
queue.enqueue({ kind: 'credential', vaultKey: 'third_credential', label: 'third credential', requestContext: credentialContext, requester: 'codex' }, options);
const afterAged = queue.readQueue(queueFile);
const survivor = afterAged.items.find(item => item.requestId === created.requestId);
assert.equal(survivor.status, 'queued', 'a 30-day-old queued prompt must still be waiting for the owner');
assert.ok(!afterAged.events.some(event => event.requestId === created.requestId && event.type === 'cancelled'),
  'nothing may cancel a prompt the owner has not answered');
const statusAfterAged = queue.status({}, options);
assert.equal('activeAbandoned' in statusAfterAged, false, 'abandonment-by-age is gone from the reported shape');
assert.equal(statusAfterAged.activeCount, 3, 'status reports how many prompts are waiting');
queue.cancel({ requestId: second.requestId }, options);
queue.cancel({ requestId: afterAged.items.at(-1).requestId }, options);

const cancelled = queue.cancel({ requestId: created.requestId }, options);
assert.equal(cancelled.status, 'cancelled');
assert.equal(queue.readQueue(queueFile).events.at(-1).type, 'cancelled');

// A form the owner could genuinely be looking at right now: recently claimed,
// nowhere near the abandonment floor. Epoch-1 timestamps would make this item
// abandoned by definition and would stop testing the live-blocker path at all.
const presentingClaimedAtMs = Date.now() - 1000;
fs.writeFileSync(queueFile, JSON.stringify({
  version: 1,
  nextSequence: 2,
  items: [{
    requestId: 'owner-prompt-00000000-0000-4000-8000-000000000003',
    kind: 'credential',
    vaultKey: 'presenting_credential',
    label: 'presenting credential',
    status: 'presenting',
    createdAtMs: presentingClaimedAtMs,
    updatedAtMs: presentingClaimedAtMs,
    requestContext: credentialContext,
    requester: 'codex'
  }],
  events: [{
    sequence: 1,
    requestId: 'owner-prompt-00000000-0000-4000-8000-000000000003',
    kind: 'credential',
    type: 'presented',
    status: 'presenting',
    atMs: presentingClaimedAtMs
  }]
}));
// A LIVE `presenting` FORM DOES NOT BLOCK A NEW PROMPT EITHER, and -- the part
// that matters -- the owner's half-finished form is not disturbed by the new
// arrival. It used to refuse here, naming the presenting request.
const launchesBeforePresenting = launches.length;
const alongsidePresenting = queue.enqueue({ kind: 'payment_card', vaultKey: 'different_presenting', label: 'different presenting prompt', ...attributedCard }, options);
assert.ok(alongsidePresenting.requestId, 'a new key queues while another form is on screen');
const withPresenting = queue.readQueue(queueFile);
const stillPresenting = withPresenting.items.find(item => item.requestId === 'owner-prompt-00000000-0000-4000-8000-000000000003');
assert.equal(stillPresenting.status, 'presenting', 'the form in front of the owner must be left exactly as it is');
assert.equal(stillPresenting.updatedAtMs, presentingClaimedAtMs, 'and must not even be re-stamped');
assert.equal(launches.length, launchesBeforePresenting + 1);

// A LIVE FORM STILL CANNOT BE CANCELLED FROM ANOTHER PROCESS. This is the fence
// that stops anything yanking a dialog out from under the owner mid-entry, and
// removing the expiry must not have weakened it.
assert.throws(
  () => queue.cancel({ requestId: 'owner-prompt-00000000-0000-4000-8000-000000000003' }, { ...options, runnerAlive: () => true }),
  error => error && error.code === 'OWNER_PROMPT_IN_PROGRESS'
);
// And the reverse, which is the whole point of recovery: the SAME call with a
// dead runner succeeds. If both answers were the same, the probe would be
// decorative.
assert.equal(queue.status({}, { ...options, runnerAlive: () => false }).presentingWithoutRunner, true);
assert.equal(queue.status({}, { ...options, runnerAlive: () => true }).presentingWithoutRunner, false);
assert.throws(
  () => queue.status({}, { ...options, runnerAlive: () => { throw new Error('probe unavailable'); } }),
  error => error && error.code === 'OWNER_PROMPT_RUNNER_UNAVAILABLE',
  'status must refuse instead of reporting a definite runner state when the probe fails'
);
const uncertainRecoveryQueue = queue.readQueue(queueFile);
assert.deepEqual(
  queue.recoverOrphanedPresenting(uncertainRecoveryQueue, Date.now(), {
    ...options,
    runnerAlive: () => { throw new Error('probe unavailable'); }
  }),
  [],
  'recovery must not interpret an unavailable probe as a dead runner'
);
assert.equal(
  uncertainRecoveryQueue.items.find(item => item.requestId === 'owner-prompt-00000000-0000-4000-8000-000000000003').status,
  'presenting',
  'an unmeasured runner must leave the presenting form untouched'
);

// BUT A FORM WHOSE RUNNER IS GONE MUST COME BACK, because cancel() refuses a
// presenting item outright, so without recovery a dialog lost to a reboot is
// stranded forever. Recovery RE-QUEUES it -- it never cancels, so nothing the
// owner typed is thrown away and the prompt is asked again.
const recovered = queue.recoverOrphanedPresenting(queue.readQueue(queueFile), Date.now(), { ...options, runnerAlive: () => false });
assert.deepEqual(recovered, ['owner-prompt-00000000-0000-4000-8000-000000000003'],
  'a presenting item with no live runner is recovered by id');
queue.cancel({ requestId: alongsidePresenting.requestId }, options);

const terminalQueue = queue.readQueue(queueFile);
// Pin this fixture to exactly one starting item. It used to inherit whatever the
// preceding assertions happened to leave behind, so adding a test above silently
// broke a count down here -- a fixture that depends on its neighbours is a test
// that fails for reasons unrelated to what it checks.
terminalQueue.items = terminalQueue.items.filter(item => item.requestId === 'owner-prompt-00000000-0000-4000-8000-000000000003');
assert.equal(terminalQueue.items.length, 1, 'the terminal fixture starts from exactly one item');
terminalQueue.items[0].status = 'cancelled';
terminalQueue.items.push(
  {
    requestId: 'owner-prompt-00000000-0000-4000-8000-000000000004',
    kind: 'payment_card',
    vaultKey: 'completed_payment',
    label: 'completed payment',
    status: 'completed',
    createdAtMs: 3,
    updatedAtMs: 4,
    completedAtMs: 4
  },
  {
    requestId: 'owner-prompt-00000000-0000-4000-8000-000000000005',
    kind: 'owner_host_start',
    vaultKey: 'failed_owner_host_start',
    label: 'failed owner host start',
    status: 'failed',
    createdAtMs: 5,
    updatedAtMs: 6,
    completedAtMs: 6
  },
  {
    requestId: 'owner-prompt-00000000-0000-4000-8000-000000000006',
    kind: 'credential',
    vaultKey: 'legacy_credential',
    label: 'legacy credential',
    status: 'cancelled',
    createdAtMs: 7,
    updatedAtMs: 8,
    completedAtMs: 8
  }
);
fs.writeFileSync(queueFile, JSON.stringify(terminalQueue));
const terminalLaunches = launches.length;
const terminalResult = queue.enqueue({ kind: 'credential', vaultKey: 'new_credential', label: 'new credential', requestContext: credentialContext, requester: 'codex' }, options);
assert.equal(terminalResult.replayed, false, 'terminal requests must not be replayed');
assert.equal(launches.length, terminalLaunches + 1, 'a new prompt after terminal requests launches once');
const afterTerminal = queue.readQueue(queueFile);
assert.deepEqual(afterTerminal.items.map(item => item.status), ['cancelled', 'completed', 'failed', 'cancelled', 'queued']);
assert.equal(afterTerminal.items[3].requestContext, undefined, 'pre-existing terminal credential entries remain readable without new metadata');
assert.equal(afterTerminal.items[1].requestContext, undefined, 'non-credential terminal entries remain metadata-free');
assert.deepEqual(afterTerminal.items.at(-1).requestContext, credentialContext, 'new credential context is persisted internally');
assert.equal(afterTerminal.items.at(-1).requester, 'codex', 'derived requester is persisted internally');
assert.equal(Object.hasOwn(terminalResult, 'requestContext'), false, 'enqueue results stay redacted');
assert.equal(Object.hasOwn(terminalResult, 'requester'), false, 'enqueue results stay redacted');

const replayContext = { ...credentialContext, purpose: 'A different explanation must not overwrite the first request' };
const credentialReplay = queue.enqueue({ kind: 'credential', vaultKey: 'new_credential', label: 'changed label', requestContext: replayContext, requester: 'claude' }, options);
assert.equal(credentialReplay.replayed, true, 'same-key credential replay remains idempotent');
assert.equal(credentialReplay.requestId, terminalResult.requestId);
assert.deepEqual(queue.readQueue(queueFile).items.at(-1).requestContext, credentialContext, 'same-key replay does not replace public context');
assert.equal(queue.readQueue(queueFile).items.at(-1).requester, 'codex', 'same-key replay does not replace attribution');

const safeStatus = queue.status({}, options);
assert.deepEqual(Object.keys(safeStatus.requests.at(-1)).sort(), ['completedAtMs', 'createdAtMs', 'kind', 'requestId', 'status', 'updatedAtMs']);
assert.doesNotMatch(JSON.stringify(safeStatus), /Connect the approved provider workflow|Short-lived and owner-revocable|codex|new credential/,
  'owner_prompts.status must not reveal context, requester, or queue labels');
const safeEvents = queue.events({ afterSequence: 0, limit: 100 }, options);
assert.ok(safeEvents.events.length > 0);
assert.deepEqual(Object.keys(safeEvents.events.at(-1)).sort(), ['atMs', 'kind', 'requestId', 'sequence', 'status', 'type']);
assert.doesNotMatch(JSON.stringify(safeEvents), /Connect the approved provider workflow|Short-lived and owner-revocable|codex/,
  'owner_prompts.events must remain redacted');
assert.throws(() => queue.enqueue({ kind: 'credential', vaultKey: 'bad_requester', label: 'bad requester', requestContext: credentialContext, requester: 'owner' }, options), error => error.code === 'OWNER_PROMPT_ATTRIBUTION_REQUIRED');
assert.ok(queue.REQUESTERS.includes('toolsenabled'), 'fixed local workflows must have a bounded non-agent requester identity');
assert.deepEqual(queue.CONTEXTUAL_KINDS, ['credential', 'payment_card']);
assert.throws(() => queue.enqueue({ kind: 'credential', vaultKey: 'extra_context', label: 'extra context', requestContext: { ...credentialContext, extra: 'not allowed' }, requester: 'codex' }, options), error => error.code === 'OWNER_PROMPT_INVALID');
assert.throws(() => queue.enqueue({ kind: 'credential', vaultKey: 'blank_context', label: 'blank context', requestContext: { ...credentialContext, purpose: '   ' }, requester: 'codex' }, options), error => error.code === 'OWNER_PROMPT_INVALID');
assert.throws(() => queue.enqueue({ kind: 'credential', vaultKey: 'secret_context', label: 'secret context', requestContext: { ...credentialContext, purpose: 'token=abcdefghijklmnopqrstuvwxyz0123456789' }, requester: 'codex' }, options), error => error.code === 'OWNER_PROMPT_INVALID');
assert.throws(() => queue.enqueue({ kind: 'payment_card', vaultKey: 'bad key', label: 'x' }, options), error => error.code === 'OWNER_PROMPT_INVALID');
// ATTRIBUTION IS RECORDED, NOT GUESSED, AND NO LONGER SILENTLY FATAL.
//
// Measured 2026-08-11 and still reproducing on 2026-08-13: every credential
// request from a transport that names no actor was refused before the queue
// lock, and the refusal reached the caller as INTERNAL_ERROR / "The operation
// stopped safely because of an internal error." -- the same sentence as the
// queue deadlock that had just been fixed, which is how it was misdiagnosed as
// a returning deadlock. The four calls the deadlock fix was built from
// (github.repo_get x2, github.release_list, instagram.verify) still failed.
//
// The fix does not invent an identity. It writes down which of the two true
// things happened, exactly as src/lib/agent-launch-audit.js writes `gated:
// false` rather than filing an observed launch under the controller's action.
const attributionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-attribution-'));
const attributionOptions = {
  queueFile: path.join(attributionRoot, 'queue.json'), relaunchThrottleMs: 0,
  spawn() { return { pid: 4242, unref() {} }; }
};
const unattributedCredential = queue.enqueue({
  kind: 'credential', vaultKey: 'github_pat', label: 'GitHub personal access token',
  requestContext: credentialContext, requester: 'unattributed'
}, attributionOptions);
assert.equal(unattributedCredential.status, 'queued',
  'a credential request from a caller that names no agent must reach the owner, not die before the lock');
const unattributedItem = queue.readQueue(attributionOptions.queueFile).items.at(-1);
assert.equal(unattributedItem.requester, 'unattributed');
assert.equal(unattributedItem.requesterEvidence, 'none',
  'a record with no requester must SAY it has none rather than omitting the question');
assert.equal(Object.hasOwn(unattributedCredential, 'requesterEvidence'), false, 'enqueue results stay redacted');

// A named requester is recorded as a CLAIM. `declared` is written even when the
// name is present, because a marker that appeared only on failures would read
// as verification by omission everywhere else.
const namedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-declared-'));
const namedOptions = {
  queueFile: path.join(namedRoot, 'queue.json'), relaunchThrottleMs: 0,
  spawn() { return { pid: 4243, unref() {} }; }
};
queue.enqueue({
  kind: 'credential', vaultKey: 'github_pat', label: 'GitHub personal access token',
  requestContext: credentialContext, requester: 'claude'
}, namedOptions);
assert.equal(queue.readQueue(namedOptions.queueFile).items.at(-1).requesterEvidence, 'declared',
  'a named requester is a claim the queue cannot check, and the record must not present it as more');
assert.deepEqual(queue.REQUESTER_EVIDENCE, ['declared', 'none'],
  'the evidence vocabulary must never gain a value that asserts verification');

// The card form keeps the hard fence: an unnamed requester is refused there,
// because a wrong answer is not recoverable by rotating a key.
assert.deepEqual(queue.IDENTITY_BOUND_KINDS, ['payment_card'],
  'identity-bound refusal cases must be enumerated before testing each one');
for (const kind of queue.IDENTITY_BOUND_KINDS) {
  assert.throws(
    () => queue.enqueue({ kind, vaultKey: 'payment_card_default', label: 'default payment card', requestContext: credentialContext, requester: 'unattributed' }, attributionOptions),
    error => error.code === 'OWNER_PROMPT_ATTRIBUTION_REQUIRED',
    `${kind} must still refuse a request that names no requester`
  );
}

// That surviving refusal must stop impersonating a crash. Without the taxonomy
// rule it falls through every `includesCode` branch to INTERNAL_ERROR, and the
// caller reads "The operation stopped safely because of an internal error."
const attributionRefusal = (() => {
  try { queue.enqueue({ kind: 'payment_card', vaultKey: 'payment_card_default', label: 'default payment card', requestContext: credentialContext, requester: 'unattributed' }, attributionOptions); }
  catch (error) { return error; }
  throw new Error('the identity-bound attribution fence did not refuse');
})();
const attributionFailure = errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(attributionRefusal));
assert.equal(attributionFailure.code, 'POLICY_DENIED',
  'an attribution refusal is a policy decision; reporting it as INTERNAL_ERROR is what cost the 2026-08-11 lane its re-diagnosis');
assert.notEqual(attributionFailure.safeSummary, 'The operation stopped safely because of an internal error.');

// A queue file written before this field existed must still read. Absence means
// "this record predates the distinction", which is the truth about it.
const legacyEvidenceFile = path.join(attributionRoot, 'legacy-evidence.json');
fs.writeFileSync(legacyEvidenceFile, JSON.stringify({
  version: 1, nextSequence: 2, events: [], items: [{
    requestId: 'owner-prompt-00000000-0000-4000-8000-00000000000a', kind: 'credential',
    vaultKey: 'github_pat', label: 'GitHub personal access token', status: 'queued',
    createdAtMs: 1, updatedAtMs: 2, requestContext: credentialContext, requester: 'codex'
  }]
}));
assert.equal(queue.readQueue(legacyEvidenceFile).items[0].requesterEvidence, undefined,
  'records written before the evidence field must not be retro-stamped');
const forgedEvidenceFile = path.join(attributionRoot, 'forged-evidence.json');
fs.writeFileSync(forgedEvidenceFile, JSON.stringify({
  version: 1, nextSequence: 2, events: [], items: [{
    requestId: 'owner-prompt-00000000-0000-4000-8000-00000000000b', kind: 'credential',
    vaultKey: 'github_pat', label: 'GitHub personal access token', status: 'queued',
    createdAtMs: 1, updatedAtMs: 2, requestContext: credentialContext, requester: 'codex',
    requesterEvidence: 'verified'
  }]
}));
assert.throws(() => queue.readQueue(forgedEvidenceFile), error => error.code === 'OWNER_PROMPT_QUEUE_INVALID',
  'no writer may introduce an evidence value that claims the queue verified anything');

assert.throws(
  () => queue.enqueue({ kind: 'credential', vaultKey: 'legacy_runtime', label: 'legacy runtime' }, options),
  error => error.code === 'OWNER_PROMPT_INVALID'
);

const emptyStartRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-empty-start-'));
const emptyStartFile = path.join(emptyStartRoot, 'queue.json');
fs.writeFileSync(emptyStartFile, JSON.stringify({ version: 1, nextSequence: 1, items: [], events: [] }));
let emptyStartLaunches = 0;
const emptyStarted = queue.start({}, {
  queueFile: emptyStartFile,
  spawn() { emptyStartLaunches += 1; return { pid: 2000, unref() {} }; }
});
assert.equal(emptyStarted.status, 'no_pending_prompts');
assert.equal(emptyStarted.launcherRequested, false);
assert.equal(emptyStartLaunches, 0, 'starting an empty queue must not launch a hidden runner');

function capacityRequestId(index) {
  return `owner-prompt-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
const capacityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-capacity-'));
const capacityFile = path.join(capacityRoot, 'queue.json');
const capacityItems = Array.from({ length: queue.MAX_ITEMS }, (_, index) => ({
  requestId: capacityRequestId(index), kind: 'payment_card', vaultKey: `terminal_${index}`, label: `terminal ${index}`,
  status: 'cancelled', createdAtMs: index + 1, updatedAtMs: index + 2, completedAtMs: index + 2
}));
const capacityEvents = Array.from({ length: queue.MAX_EVENTS }, (_, index) => ({
  sequence: index + 1, requestId: capacityItems[index % capacityItems.length].requestId,
  kind: 'payment_card', type: 'cancelled', status: 'cancelled', atMs: index + 1
}));
fs.writeFileSync(capacityFile, JSON.stringify({ version: 1, nextSequence: queue.MAX_EVENTS + 1, items: capacityItems, events: capacityEvents }));
const capacityCreated = queue.enqueue({ kind: 'payment_card', vaultKey: 'new_capacity_item', label: 'new capacity item', ...attributedCard }, {
  queueFile: capacityFile,
  spawn() { return { pid: 1236, unref() {} }; }
});
const capacityAfter = queue.readQueue(capacityFile);
assert.equal(capacityAfter.items.length, queue.MAX_ITEMS, 'terminal pruning keeps item count bounded');
assert.equal(capacityAfter.items.some(item => item.requestId === capacityItems[0].requestId), false, 'the oldest terminal item is pruned first');
assert.ok(capacityAfter.items.some(item => item.requestId === capacityCreated.requestId), 'the new item is retained after pruning');
assert.equal(capacityAfter.events.length, queue.MAX_EVENTS, 'the event log remains bounded after pruning and enqueue');
assert.equal(capacityAfter.events.at(-1).type, 'queued', 'the new enqueue remains represented in the bounded event log');
assert.ok(capacityAfter.events.some(event => event.requestId === capacityItems[0].requestId), 'pruning an item does not erase its retained event history');

const activeCapacityFile = path.join(capacityRoot, 'active-queue.json');
// Recently queued: a live blocker, not an abandoned one, so this still tests
// that an ACTIVE item is never pruned to make room.
const activeItem = {
  requestId: capacityRequestId(1000), kind: 'payment_card', vaultKey: 'active_payment', label: 'active payment',
  status: 'queued', createdAtMs: Date.now() - 2000, updatedAtMs: Date.now() - 2000,
  requestContext: credentialContext, requester: 'codex'
};
fs.writeFileSync(activeCapacityFile, JSON.stringify({
  version: 1, nextSequence: 1, items: [...capacityItems.slice(1), activeItem], events: []
}));
const activeBefore = fs.readFileSync(activeCapacityFile, 'utf8');
// AN ACTIVE ITEM IS NEVER PRUNED TO MAKE ROOM. This used to be proved via the
// single-slot refusal; that refusal is gone, so the vehicle is now the capacity
// cap -- which is the FIRST time it has been exercised at all, because the slot
// check always returned before reaching it.
const activeFull = queue.readQueue(activeCapacityFile);
activeFull.items = Array.from({ length: 24 }, (unused, index) => ({
  requestId: capacityRequestId(2000 + index), kind: 'credential', vaultKey: `full_${index}`, label: `full ${index}`,
  status: 'queued', createdAtMs: Date.now() - 1000, updatedAtMs: Date.now() - 1000,
  requestContext: credentialContext, requester: 'codex'
}));
fs.writeFileSync(activeCapacityFile, JSON.stringify(activeFull));
const fullBefore = fs.readFileSync(activeCapacityFile, 'utf8');
assert.throws(
  () => queue.enqueue({ kind: 'credential', vaultKey: 'one_too_many', label: 'one too many', requestContext: credentialContext, requester: 'codex' }, {
    queueFile: activeCapacityFile,
    spawn() { return { pid: 1237, unref() {} }; }
  }),
  error => error && error.code === 'OWNER_PROMPT_QUEUE_FULL'
);
assert.equal(fs.readFileSync(activeCapacityFile, 'utf8'), fullBefore,
  'queued active items are never pruned to make room, and a refusal leaves the file byte-identical');

// And below the cap, many DIFFERENT keys coexist -- the property the old single
// slot made impossible.
const manyFile = path.join(capacityRoot, 'many-keys.json');
fs.writeFileSync(manyFile, JSON.stringify({ version: 1, nextSequence: 1, items: [], events: [] }));
const manyOptions = { queueFile: manyFile, spawn() { return { pid: 1238, unref() {} }; } };
for (let index = 0; index < 5; index += 1) {
  queue.enqueue({ kind: 'credential', vaultKey: `coexist_${index}`, label: `coexist ${index}`, requestContext: credentialContext, requester: 'codex' }, manyOptions);
}
assert.equal(queue.readQueue(manyFile).items.filter(item => item.status === 'queued').length, 5,
  'five different credentials queue together instead of the first refusing the rest');
assert.equal(queue.status({}, manyOptions).activeCount, 5);

// ---------------------------------------------------------------------------
// NO EXPIRY. A prompt the owner has not answered is not stale -- he is entering
// information, not taking it out. The two-hour queued / four-hour presenting
// sweep existed solely to clear the single active slot; the slot is gone, so
// the deadline went with it. What replaces it is RECOVERY of a form whose
// runner is provably dead, which re-queues rather than cancels.
// ---------------------------------------------------------------------------
const abandonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-noexpiry-'));
let noExpirySeq = 0;
function noExpiryQueue(name, status, ageMs) {
  const file = path.join(abandonRoot, name + '.json');
  const stamp = Date.now() - ageMs;
  noExpirySeq += 1;
  const item = {
    requestId: 'owner-prompt-00000000-0000-4000-8000-' + String(700 + noExpirySeq).padStart(12, '0'),
    kind: 'credential', vaultKey: name + '_key', label: name + ' label', status,
    createdAtMs: stamp, updatedAtMs: stamp, requestContext: credentialContext, requester: 'codex'
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, nextSequence: 2, items: [item], events: [] }));
  return { file, item };
}
const noExpiryLaunch = { spawn: () => ({ pid: process.pid, unref() {}, once() {} }), livenessMs: 1 };
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

// A month old, and every entry point leaves it exactly where it is.
const ancient = noExpiryQueue('ancient', 'queued', thirtyDaysMs);
const ancientBytes = fs.readFileSync(ancient.file, 'utf8');
assert.equal(queue.status({}, { queueFile: ancient.file }).waitingForOwner, true);
assert.equal(fs.readFileSync(ancient.file, 'utf8'), ancientBytes, 'a status read must never mutate the queue');
queue.start({}, Object.assign({}, noExpiryLaunch, { queueFile: ancient.file }));
assert.equal(queue.readQueue(ancient.file).items[0].status, 'queued', 'start() must not expire a waiting prompt');
queue.enqueue({ kind: 'credential', vaultKey: 'unrelated_key', label: 'unrelated', requestContext: credentialContext, requester: 'codex' },
  Object.assign({}, noExpiryLaunch, { queueFile: ancient.file }));
const afterUnrelated = queue.readQueue(ancient.file);
assert.equal(afterUnrelated.items[0].status, 'queued', 'another caller arriving must not expire a waiting prompt');
assert.ok(!afterUnrelated.events.some(event => event.type === 'cancelled'), 'nothing is cancelled by age');

// A month-old form still on screen, with a LIVE runner: untouched.
const liveForm = noExpiryQueue('liveform', 'presenting', thirtyDaysMs);
queue.start({}, Object.assign({}, noExpiryLaunch, { queueFile: liveForm.file, runnerAlive: () => true }));
assert.equal(queue.readQueue(liveForm.file).items[0].status, 'presenting',
  'a form the owner may still be filling in is never reclaimed, however old');

// The same form with a DEAD runner: re-queued, never cancelled.
const deadForm = noExpiryQueue('deadform', 'presenting', 60 * 1000);
const deadResult = queue.start({}, Object.assign({}, noExpiryLaunch, { queueFile: deadForm.file, runnerAlive: () => false }));
const afterDead = queue.readQueue(deadForm.file);
assert.equal(afterDead.items[0].status, 'queued', 'a form whose runner died returns to the queue');
assert.deepEqual(deadResult.expired, [deadForm.item.requestId], 'start() names what it recovered');
assert.equal(afterDead.events.at(-1).type, 'requeued_after_interruption',
  'recovery reuses the runner own event word so an older reader still parses the file');
assert.ok(!afterDead.events.some(event => event.type === 'cancelled'), 'recovery never cancels');

// The retired surface is really gone, so nothing can quietly depend on it.
assert.equal(queue.ABANDONED_QUEUED_AFTER_MS, undefined);
assert.equal(queue.ABANDONED_PRESENTING_AFTER_MS, undefined);
assert.equal(typeof queue.blockedMessage, 'undefined', 'the single-slot refusal message is gone with the rule');
assert.equal('activeAbandoned' in queue.status({}, { queueFile: ancient.file }), false);

// OWNER_PROMPT_QUEUED is still owner input to a caller.
assert.equal(errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(
  Object.assign(new Error('Owner credential input is queued.'), { code: 'OWNER_PROMPT_QUEUED' })
)).code, 'INPUT_REQUIRED');
// EXACT, not a prefix rule: the rest of the family is not owner input.
for (const code of ['OWNER_PROMPT_RUNNER_UNAVAILABLE', 'OWNER_PROMPT_QUEUE_UNAVAILABLE', 'OWNER_PROMPT_INVALID', 'OWNER_PROMPT_QUEUE_BUSY']) {
  assert.notEqual(errorTaxonomy.publicFailure(errorTaxonomy.adaptToolError(Object.assign(new Error('x'), { code }))).code, 'INPUT_REQUIRED',
    code + ' is not owner input and must not inherit the owner-input classification');
}

// Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8 BOM;
// the queue file must still read cleanly if one slipped in (tools/owner-
// prompt-queue.ps1's Write-Queue now writes BOM-less UTF-8, but a
// previously-written BOM'd file must not break every subsequent read).
const bomFile = path.join(root, 'bom-queue.json');
fs.writeFileSync(bomFile, `﻿${JSON.stringify({ version: 1, nextSequence: 1, items: [], events: [] })}`, 'utf8');
const bomRead = queue.readQueue(bomFile);
assert.equal(bomRead.items.length, 0);
assert.equal(bomRead.nextSequence, 1);

/* A LAUNCH FAILURE MUST NOT SWALLOW THE REQUEST ID.
 *
 * The item is durable before the launcher is ever started, so a throw from
 * launchWaitingDialog() used to skip the return and leave the caller holding an
 * exception instead of an id -- for a request that now existed forever. Because
 * `queued` is an ACTIVE status, that orphan then refused EVERY later enqueue
 * for ANY key, naming an id nobody had been told and therefore could not
 * cancel. One failed launch wedged the whole queue.
 *
 * Observed in production 2026-08-20: a credential request "failed", the next
 * identical one succeeded once a runner happened to be alive, and the
 * difference was never the request. */
const launchFailRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-launchfail-'));
const launchFailQueue = path.join(launchFailRoot, 'queue.json');
const throwingOptions = {
  queueFile: launchFailQueue,
  relaunchThrottleMs: 0,
  spawn() { throw new Error('powershell is unavailable on this machine'); }
};

const stranded = queue.enqueue(
  { kind: 'credential', vaultKey: 'github_pat', label: 'GitHub token', ...attributedCard },
  throwingOptions
);
// The id is the whole point: without it there is no route back.
assert.ok(stranded.requestId, 'a failed launch must still return the requestId');
assert.equal(stranded.status, 'queued', 'the item is durable regardless of the launcher');
assert.equal(stranded.launcherRequested, false, 'it must not claim a launcher it could not start');
assert.equal(stranded.launchFailure, 'OWNER_PROMPT_RUNNER_UNAVAILABLE',
  'the reason is reported by code, not thrown over the top of the result');

// And the caller can act on it -- which is what "holding the id" has to mean.
const strandedCancelled = queue.cancel({ requestId: stranded.requestId }, throwingOptions);
assert.equal(strandedCancelled.status, 'cancelled', 'a returned id must be usable to cancel');

// With the wedge cleared, an unrelated key enqueues normally. Before the fix
// this refused with OWNER_PROMPT_DIFFERENT_ACTIVE forever.
const afterRecovery = queue.enqueue(
  { kind: 'credential', vaultKey: 'tavily_api_key', label: 'search key', ...attributedCard },
  throwingOptions
);
assert.equal(afterRecovery.status, 'queued',
  'a different key must enqueue once the stranded request has been cancelled');
assert.notEqual(afterRecovery.requestId, stranded.requestId);
// RECOVERY THAT ONLY RUNS ON CONTENTION IS NOT RECOVERY, IT IS A COINCIDENCE.
//
// THE DEADLOCK THIS CAME FROM, kept because the reachability lesson outlived the
// rule that caused it. One queued prompt used to hold a single active slot, and
// every other credential request on the machine was refused while it was held.
// The sweep that could clear it was reachable from exactly two places --
// enqueue() and cancel() -- so the only thing that ever cleared a stale slot was
// ANOTHER caller arriving to be refused by it. A machine whose owner missed one
// dialog before lunch had no working credential path until some unrelated agent
// happened to ask for one, and if none did, never.
//
// The slot and its expiry are both gone now. What remains, and still must not
// depend on a coincidence, is a `presenting` form whose runner died: cancel()
// refuses a presenting item outright, so without a reachable recovery path it is
// stranded forever.
//
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-recovery-'));
const noLaunch = { spawn: () => ({ pid: process.pid, unref() {}, once() {} }), livenessMs: 1 };

function recoveryQueue(name, status, ageMs) {
  const file = path.join(recoveryRoot, name + '.json');
  const at = Date.now() - ageMs;
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    nextSequence: 2,
    items: [{
      requestId: 'owner-prompt-00000000-0000-4000-8000-000000000901',
      kind: 'credential', vaultKey: 'recovery_key', label: 'recovery key', status,
      createdAtMs: at, updatedAtMs: at, requestContext: credentialContext, requester: 'codex'
    }],
    events: []
  }));
  return file;
}

// start() RECOVERS; it does not expire. What it used to do -- cancel anything
// past two hours -- is gone, so the assertions that pinned that behaviour are
// replaced by the ones that pin its successor.
//
// The reachability argument survives the change and is why recovery lives here:
// it must not depend on another caller arriving to be refused first. start() is
// the moment a person is dealing with their prompts and is already a write path,
// while status() stays a pure read that must never rewrite the queue under a
// running dialog.
const oldQueued = recoveryQueue('old-queued', 'queued', 30 * 24 * 60 * 60 * 1000);
const oldStart = queue.start({}, { ...noLaunch, queueFile: oldQueued });
assert.equal(oldStart.counts.queued, 1, 'an old queued prompt is still waiting for the owner, not cancelled');
assert.equal(oldStart.status, 'waiting_for_owner');
assert.deepEqual(oldStart.expired, [], 'start cancels nothing by age');
assert.equal(queue.readQueue(oldQueued).items[0].status, 'queued');

// A dead-runner form is recovered by start, named in its result, and re-queued.
const orphaned = recoveryQueue('orphaned', 'presenting', 60_000);
const orphanStart = queue.start({}, { ...noLaunch, queueFile: orphaned, runnerAlive: () => false });
assert.deepEqual(orphanStart.expired, ['owner-prompt-00000000-0000-4000-8000-000000000901'],
  'start must NAME what it recovered rather than silently changing the queue');
assert.equal(queue.readQueue(orphaned).items[0].status, 'queued');
assert.equal(orphanStart.status, 'waiting_for_owner', 'the recovered prompt is now presentable again');

// A live form is left alone by the same call.
const attended = recoveryQueue('attended', 'presenting', 60_000);
const attendedStart = queue.start({}, { ...noLaunch, queueFile: attended, runnerAlive: () => true });
assert.deepEqual(attendedStart.expired, []);
assert.equal(queue.readQueue(attended).items[0].status, 'presenting',
  'a form in front of the owner is never reclaimed by start');

// And a DIFFERENT key never had to wait for any of this: it simply queues.
const alongside = queue.enqueue({
  kind: 'credential', vaultKey: 'unblocked_key', label: 'unblocked key',
  requestContext: credentialContext, requester: 'claude'
}, { ...noLaunch, queueFile: oldQueued });
assert.equal(alongside.status, 'queued', 'a fresh request queues alongside rather than waiting for a slot');
assert.equal(queue.status({}, { queueFile: oldQueued }).activeCount, 2);

// A RETURNED requestId IS NOT A QUEUED REQUEST. Observed 2026-08-20: three
// credential requests returned {status:'queued'} while none of their ids
// reached the queue file, so the runner drained an empty queue and no dialog
// ever appeared. enqueue() must read its own write back and refuse to report
// an id that is not on disk. This simulates the exact shape -- an atomic
// rename that returns without landing -- and requires the named failure.
const persistRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompt-persist-'));
const persistFile = path.join(persistRoot, 'state', 'owner-prompt-queue.json');
const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === persistFile) { try { fs.unlinkSync(from); } catch { /* gone */ } return; }
  return realRenameSync(from, to);
};
try {
  assert.throws(() => queue.enqueue({
    kind: 'credential', vaultKey: 'never_lands', label: 'never lands',
    requestContext: credentialContext, requester: 'claude'
  }, { ...noLaunch, queueFile: persistFile }),
  error => error.code === 'OWNER_PROMPT_NOT_PERSISTED',
  'a write that did not land must be reported by name, never returned as queued');
} finally {
  fs.renameSync = realRenameSync;
}
assert.equal(queue.status({}, { queueFile: persistFile }).counts.queued, 0,
  'nothing was persisted, and status agrees');

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(persistRoot, { recursive: true, force: true });
fs.rmSync(emptyStartRoot, { recursive: true, force: true });
fs.rmSync(capacityRoot, { recursive: true, force: true });
fs.rmSync(abandonRoot, { recursive: true, force: true });
fs.rmSync(launchFailRoot, { recursive: true, force: true });
fs.rmSync(recoveryRoot, { recursive: true, force: true });
process.stdout.write('Owner prompt queue tests passed.\n');
