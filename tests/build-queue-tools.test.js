'use strict';

/* THE BUILD QUEUE, REACHED THE WAY AN AGENT REACHES IT.
 *
 * These are behaviour tests: they call the real mission-bridge queue action
 * through the same helper the three build_queue tools call, against a real
 * BUILD-QUEUE.md in a scratch workspace, and assert on what actually happened
 * -- the file on disk, the chain hash, and the refusals. Nothing here asserts
 * a message spelling, because a spelling pin fails against a better
 * implementation and the quickest way green is to reinstate the defect.
 *
 * THE SCRATCH ROOT IS SET BEFORE ANY PRODUCT MODULE IS REQUIRED. A host.exec
 * shell inherits TOOLSENABLED_STATE_ROOT pointed at the live product, so a
 * test that trusts the ambient environment writes into the running
 * installation's own state. Setting it here, first, is not a nicety.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratchState = fs.mkdtempSync(path.join(os.tmpdir(), 'w52-state-'));
process.env.TOOLSENABLED_STATE_ROOT = scratchState;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'w52-workspace-'));
const queueFile = path.join(workspace, 'BUILD-QUEUE.md');

/* The queue REFUSES to create itself: "Refusing to create a queue file
 * implicitly" (QUEUE_NOT_FOUND). That is a deliberate product rule and this
 * test respects it rather than routing around it, so the file is seeded with
 * an empty queue document first, exactly as a workspace that has one would
 * already look. Discovered by running the suite, not assumed. */
fs.writeFileSync(queueFile, '# Build queue\n\n', 'utf8');

const corpus = require('../src/lib/build-queue-corpus.js');
const missionBridge = require('../src/lib/mission-bridge/actions.js');
// The code W52 adds. Driving the bridge action directly would exercise code
// that was already shipping and prove nothing about the three new tools.
const { buildQueueOperation } = require('../src/lib/tool-registry.js');
const taxonomy = require('../src/lib/error-taxonomy');

/* A SCRATCH ORGANISATION, because the real gate is the point.
 *
 * The bridge refuses any actor that is not an enabled declared agent whose
 * current role grants the action class -- BRIDGE_ACTOR_REFUSED, fail-closed.
 * That gate is exercised here rather than bypassed: `agentOrg` and
 * `knownRoles` are the injection points the module already offers, so the
 * admission code under test is the real one and only the directory it reads
 * is scratch. */
/* The product's own shipped declaration, not one invented here. Inventing an
 * org shape would test my guess at the schema; reading the real baseline tests
 * the seats the product actually ships with, and keeps this suite honest if
 * that schema ever changes. */
const agentOrg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8')
);
const TEST_ACTOR = (agentOrg.agents.find(agent => agent.enabled === true
  && agent.role === 'builder') || agentOrg.agents[0]).id;

/* A RECORDING AUDIT, and the cap that comes with it, stated plainly.
 *
 * The real canonical audit writer refuses here for an environmental reason
 * that has nothing to do with the queue: the protected audit head is held per
 * machine while the ledger lives under the state root, so ANY scratch root
 * looks like a ledger rolled back behind its head
 * ("The protected audit head is ahead of an empty canonical ledger").
 * Pointing the test at the real ledger instead would mean writing test rows
 * into the running installation's signed audit, which is precisely what this
 * tree spent the afternoon stopping.
 *
 * So the audit is injected -- the module offers `options.audit` for exactly
 * this reason -- and the receipts it is asked for are asserted instead. CAP:
 * these tests do NOT exercise the real signed ledger. What they do prove is
 * that the queue path demands a durable, anchored receipt before and after
 * every write, because a stub returning anything less is refused by
 * durableReceipt and the action fails. That is checked below.
 */
const auditCalls = [];
function recordingAudit({ durable = true, anchored = true } = {}) {
  let sequence = 0;
  return {
    requireRecord(action, target, details) {
      sequence += 1;
      auditCalls.push({ action, target, details });
      return { durable, anchored, sequence, eventHash: `w52-event-${sequence}` };
    }
  };
}

/* Every call below goes through buildQueueOperation -- the function the three
 * build_queue tools are each one line on top of -- with the workspace and the
 * bridge factory injected, exactly the way spawnSubagent takes its
 * dependencies. The mission-bridge module itself is the real one. */
function queueThroughTool(operation, args, overrides = {}) {
  return buildQueueOperation(operation, args, { agentId: TEST_ACTOR }, {
    workspaceRoots: [workspace],
    createMissionActions: options => missionBridge.createMissionActions({
      ...options,
      agentOrg,
      audit: recordingAudit(),
      ...overrides
    })
  });
}

// The chain hash the queue currently holds. Every write must cite it, which is
// what stops two writers overwriting each other.
function currentHash() {
  try {
    return corpus.sha256(fs.readFileSync(queueFile, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return corpus.sha256('');
    throw error;
  }
}

/* A REFUSAL, NOT MERELY A THROW.
 *
 * The first version of this helper returned any error at all, and three tests
 * went green while the code under test was dying on a ReferenceError -- a
 * crash reported as "the product correctly refused". A refusal carries a
 * `code` or a `status`; a programming mistake carries neither and is a
 * ReferenceError or TypeError. Distinguishing them is the whole difference
 * between a gate that works and a test that cannot tell. */
async function refusalOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ReferenceError || error instanceof TypeError) {
      throw error;
    }
    const code = error && (error.code || error.status);
    assert.ok(code, `expected a refusal carrying a code, got ${error && error.name}: ${error && error.message}`);
    return error;
  }
}

test('the build queue through the real tool helper', async t => {
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(scratchState, { recursive: true, force: true });
  });
  const results = [];
  const record = (name, fn) => results.push({ name, fn });

  record('an item opened through the agent surface lands in BUILD-QUEUE.md', async () => {
    const answer = await queueThroughTool('open', {
      expectedHash: currentHash(),
      title: 'W52 behaviour probe item',
      authority: 'R18 tree scope; directiveId: w52-behaviour-test',
      brief: 'An item opened by the test so the queue can be read back.'
    });
    assert.ok(answer && answer.ok === true, 'opening an item must succeed');
    assert.ok(fs.existsSync(queueFile), 'BUILD-QUEUE.md must exist after an open');
    const text = fs.readFileSync(queueFile, 'utf8');
    assert.ok(text.includes('W52 behaviour probe item'), 'the queue must contain the title that was opened');
    assert.ok(text.includes('w52-behaviour-test'), 'the queue must carry the directive that authorised the item');
  });

  record('an authority that cites no R-number and no directive is refused', async () => {
    const error = await refusalOf(queueThroughTool('open', {
      expectedHash: currentHash(),
      title: 'W52 item with no authority',
      authority: 'because I felt like it',
      brief: 'This must not reach the queue.'
    }));
    assert.ok(error, 'an uncited authority must be refused, not accepted');
    const text = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf8') : '';
    assert.ok(!text.includes('W52 item with no authority'),
      'a refused item must not appear in the queue');
  });

  record('a stale chain hash is refused rather than merged', async () => {
    const stale = corpus.sha256('this is not the queue');
    const error = await refusalOf(queueThroughTool('open', {
      expectedHash: stale,
      title: 'W52 item written against a stale hash',
      authority: 'R18 tree scope; directiveId: w52-behaviour-test',
      brief: 'This must not reach the queue either.'
    }));
    assert.ok(error, 'a write citing a stale hash must be refused');
    assert.equal(error.code, 'QUEUE_CONCURRENT_EDIT');
    const failure = taxonomy.publicFailure(taxonomy.adaptToolError(error));
    assert.equal(failure.code, 'STALE_DATA');
    assert.equal(failure.retryable, false);
    const text = fs.readFileSync(queueFile, 'utf8');
    assert.ok(!text.includes('W52 item written against a stale hash'),
      'a refused stale write must not appear in the queue');
  });

  record('a phase outside the current queue requires a corrected request without altering the file', async () => {
    const before = fs.readFileSync(queueFile, 'utf8');
    const error = await refusalOf(queueThroughTool('claim', {
      expectedHash: currentHash(), phaseId: 'Q999', reason: 'This phase does not exist in the fixture.'
    }));
    assert.equal(error.code, 'QUEUE_PHASE_UNKNOWN');
    const failure = taxonomy.publicFailure(taxonomy.adaptToolError(error));
    assert.equal(failure.code, 'INVALID_REQUEST');
    assert.equal(failure.retryable, false);
    assert.equal(fs.readFileSync(queueFile, 'utf8'), before);
  });

  record('the hash moves when the queue is written, so the chain is real', async () => {
    const before = currentHash();
    await queueThroughTool('open', {
      expectedHash: before,
      title: 'W52 second item',
      authority: 'R18 tree scope; directiveId: w52-behaviour-test',
      brief: 'A second item, so the chain has to advance.'
    });
    const after = currentHash();
    assert.notEqual(after, before, 'writing an item must change the queue hash');
  });

  record('every queue write is audited, intent first, before and after the write', async () => {
    const before = auditCalls.length;
    await queueThroughTool('open', {
      expectedHash: currentHash(),
      title: 'W52 audited item',
      authority: 'R18 tree scope; directiveId: w52-behaviour-test',
      brief: 'An item opened so the audit trail can be inspected.'
    });
    const written = auditCalls.slice(before).map(call => call.action);
    assert.ok(written.some(action => /\.intent$/.test(action)),
      'an intent must be recorded before the queue is written');
    assert.ok(written.some(action => /queue/.test(action) && !/\.intent$/.test(action)),
      'the completed write must be recorded too');
  });

  record('a write whose audit receipt is not durably anchored is refused', async () => {
    const error = await refusalOf(queueThroughTool('open', {
      expectedHash: currentHash(),
      title: 'W52 unanchored item',
      authority: 'R18 tree scope; directiveId: w52-behaviour-test',
      brief: 'This must not reach the queue, because its receipt was not anchored.'
    }, { audit: recordingAudit({ anchored: false }) }));
    assert.ok(error, 'an unanchored audit receipt must refuse the write');
    const text = fs.readFileSync(queueFile, 'utf8');
    assert.ok(!text.includes('W52 unanchored item'),
      'an item refused for a weak audit receipt must not appear in the queue');
  });

  for (const { name, fn } of results) {
    await t.test(name, fn);
  }
});
