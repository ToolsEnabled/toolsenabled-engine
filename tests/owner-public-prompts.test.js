'use strict';
// Binds the engine's owner-prompt half to Mission Control's renderer half.
//
// The defect this exists to prevent is the one that created the work: the app
// shipped a complete in-app owner popup that validated a snapshot shape the
// engine never produced, so it displayed "the owner prompt service is
// unavailable" forever and every prompt fell back to a native dialog. Nothing
// failed loudly; the feature was simply never connected.
//
// So the load-bearing check here does NOT re-implement the renderer's rules.
// It imports the renderer's OWN normalizeOwnerPromptSnapshot from the app tree
// and feeds it a real snapshot straight out of the engine. If either side
// changes a key, this fails instead of an owner meeting a blank popup.
//
// When the app tree is not checked out beside the engine, that binding check
// reports SKIPPED and is counted separately from passes -- a check that
// silently passes when it cannot see the other side reports a verification
// that did not happen.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = require('../src/lib/mission-bridge/owner-prompts.js');

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === 'function') return outcome.then(
      () => { passed += 1; console.log(`  ok  ${name}`); },
      error => { failures.push(name); console.log(`  FAIL ${name}: ${error.message}`); }
    );
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}: ${error.message}`);
  }
  return Promise.resolve();
}

function tempDeps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-prompts-'));
  return { stateFile: path.join(dir, 'prompts.json') };
}

const PURCHASE = () => ({
  kind: 'purchase_batch',
  title: 'Review this shopping list',
  message: 'Each line is decided independently. Undecided lines are denied.',
  ttlMs: null,
  items: [
    { id: 'dom-ai', description: 'toolsenabled.ai domain, first year', amountCents: 7999, currency: 'USD', merchant: 'Namecheap', purpose: 'Primary product domain' },
    { id: 'dom-io', description: 'toolsenabled.io domain, first year', amountCents: 3499, currency: 'USD', merchant: 'Namecheap', purpose: 'Redirect and brand protection' },
    { id: 'de-inc', description: 'Delaware incorporation filing', amountCents: 24400, currency: 'USD', merchant: 'Delaware Division of Corporations', purpose: 'Entity formation' }
  ]
});

function presentEvidence() {
  return { mounted: true, visible: true, focused: true };
}

async function main() {
  console.log('owner public prompts');

  await check('a lock that could not be inspected is UNAVAILABLE, not definitely BUSY', () => {
    const deps = tempDeps();
    fs.writeFileSync(`${deps.stateFile}.lock`, 'unreadable lock metadata');
    const originalStatSync = fs.statSync;
    fs.statSync = candidate => {
      if (candidate === `${deps.stateFile}.lock`) {
        const error = new Error('device could not answer');
        error.code = 'EIO';
        throw error;
      }
      return originalStatSync(candidate);
    };
    try {
      assert.throws(
        () => store.snapshot({ ...deps, clock: (() => { let now = 0; return () => now += 1_000; })() }),
        error => error.code === 'OWNER_PROMPT_STORE_UNAVAILABLE'
          && /could not be inspected/.test(error.message)
          && /does not claim that the lock is absent or held/.test(error.message)
      );
    } finally {
      fs.statSync = originalStatSync;
    }

    // CONTROL: when the metadata read succeeds and establishes a live lock,
    // preserve the definite BUSY result. A blanket "never decide" change must
    // not pass this regression while discarding the useful established fact.
    const busyDeps = tempDeps();
    fs.writeFileSync(`${busyDeps.stateFile}.lock`, 'live lock');
    assert.throws(
      () => store.snapshot({ ...busyDeps, clock: (() => { let now = 0; return () => now += 1_000; })() }),
      error => error.code === 'OWNER_PROMPT_STORE_BUSY'
    );
  });

  await check('a purchase batch enqueues and totals from its own line items', () => {
    const deps = tempDeps();
    const result = store.enqueue(PURCHASE(), deps);
    assert.strictEqual(result.itemCount, 3);
    assert.strictEqual(result.totalCents, 7999 + 3499 + 24400);
    assert.strictEqual(result.currency, 'USD');
  });

  await check('a decision is REFUSED until the prompt was measurably presented', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    assert.throws(
      () => store.decide({ promptId, decision: 'submit', itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }] }, deps),
      error => error.code === 'OWNER_PROMPT_NOT_PRESENTED'
    );
  });

  await check('presentation evidence that is not visible is REFUSED', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    assert.throws(
      () => store.markPresented({ promptId, evidence: { mounted: true, visible: false, focused: false } }, deps),
      error => error.code === 'OWNER_PROMPT_NOT_VISIBLE'
    );
  });

  await check('an UNDECIDED purchase line is denied, never approved by omission', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    store.markPresented({ promptId, evidence: presentEvidence() }, deps);
    // Only one of three lines is approved; two are simply omitted.
    const outcome = store.decide({
      promptId, decision: 'submit',
      itemDecisions: [{ itemId: 'dom-ai', decision: 'approve' }]
    }, deps);
    assert.strictEqual(outcome.approvedCount, 1);
    assert.strictEqual(outcome.deniedCount, 2);
    assert.strictEqual(outcome.approvedTotalCents, 7999, 'only the approved line may contribute to the approved total');
    const denied = outcome.items.filter(item => item.decision === 'deny').map(item => item.itemId).sort();
    assert.deepStrictEqual(denied, ['de-inc', 'dom-io']);
  });

  await check('the approved total is bound to the approved lines, not to the batch total', () => {
    const deps = tempDeps();
    const { promptId, totalCents } = store.enqueue(PURCHASE(), deps);
    store.markPresented({ promptId, evidence: presentEvidence() }, deps);
    const outcome = store.decide({
      promptId, decision: 'submit',
      itemDecisions: [
        { itemId: 'dom-ai', decision: 'approve' },
        { itemId: 'dom-io', decision: 'deny' },
        { itemId: 'de-inc', decision: 'deny' }
      ]
    }, deps);
    assert.notStrictEqual(outcome.approvedTotalCents, totalCents);
    assert.strictEqual(outcome.approvedTotalCents, 7999);
  });

  await check('a settled decision reads back, and an unknown id reads back as null (not an error)', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    store.markPresented({ promptId, evidence: presentEvidence() }, deps);
    store.decide({ promptId, decision: 'submit', itemDecisions: [] }, deps);
    const settled = store.settledDecision(promptId, deps);
    assert.strictEqual(settled.decision.approvedCount, 0, 'submitting with no approvals approves nothing');
    // The spend executor must be able to distinguish "denied" from "never asked",
    // and BOTH must mean do-not-spend.
    assert.strictEqual(store.settledDecision('never-enqueued-id', deps), null);
  });

  await check('a decided prompt leaves the pending snapshot', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    store.markPresented({ promptId, evidence: presentEvidence() }, deps);
    store.decide({ promptId, decision: 'submit', itemDecisions: [] }, deps);
    assert.strictEqual(store.snapshot(deps).prompts.length, 0);
  });

  await check('an expired prompt disappears rather than lingering as decidable', () => {
    const deps = tempDeps();
    let now = Date.parse('2026-08-09T00:00:00.000Z');
    const clockDeps = { ...deps, clock: () => now };
    const { promptId } = store.enqueue({ ...PURCHASE(), ttlMs: 60_000 }, clockDeps);
    now += 61_000;
    assert.strictEqual(store.snapshot(clockDeps).prompts.length, 0);
    assert.throws(() => store.markPresented({ promptId, evidence: presentEvidence() }, clockDeps),
      error => error.code === 'OWNER_PROMPT_UNKNOWN');
  });

  await check('a mixed-currency batch is refused rather than silently summed', () => {
    const deps = tempDeps();
    const bad = PURCHASE();
    bad.items[1].currency = 'EUR';
    assert.throws(() => store.enqueue(bad, deps), error => error.code === 'OWNER_PROMPT_MALFORMED');
  });

  await check('an item decision naming an unknown item is refused', () => {
    const deps = tempDeps();
    const { promptId } = store.enqueue(PURCHASE(), deps);
    store.markPresented({ promptId, evidence: presentEvidence() }, deps);
    assert.throws(
      () => store.decide({ promptId, decision: 'submit', itemDecisions: [{ itemId: 'not-on-the-list', decision: 'approve' }] }, deps),
      error => error.code === 'OWNER_PROMPT_MALFORMED'
    );
  });

  await check('credential kinds cannot be enqueued onto the public surface', () => {
    const deps = tempDeps();
    for (const kind of ['credential', 'payment_card']) {
      assert.throws(() => store.enqueue({ kind, title: 'x', message: 'y', ttlMs: null }, deps),
        error => error.code === 'OWNER_PROMPT_MALFORMED', `${kind} must not be enqueueable here`);
    }
  });

  // REGRESSION for agent-coord finding/fable-review/mission-bridge-three-
  // defects item (2): withLock's header comment claims breaking a stale
  // lock "is logged into the state rather than silent", but the code did
  // nothing of the kind, and separately compared the injected `clock()`
  // against the lock file's real (never-injectable) mtime -- meaningless
  // whenever a fake clock is in play, which is exactly this test file's own
  // convention (see the expiry test above). This drives a genuinely stale
  // lock (old by REAL wall-clock time) under an injected clock frozen at an
  // unrelated timestamp, so it only passes if staleness is judged by real
  // time and the break is actually recorded.
  await check('a stale lock is broken by real wall-clock time (not an injected clock) and the break is recorded', () => {
    const deps = tempDeps();
    const lockFile = `${deps.stateFile}.lock`;
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, '');
    const trulyStaleMs = Date.now() - 10_000; // 10 REAL seconds old, past the 5s LOCK_TIMEOUT_MS
    fs.utimesSync(lockFile, trulyStaleMs / 1000, trulyStaleMs / 1000);

    // A business clock frozen far from real wall-clock time. Before the fix,
    // this value was compared directly against the lock file's real mtime,
    // so an injected clock this far off made the staleness verdict wrong in
    // whichever direction the drift happened to point.
    const businessNowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clockDeps = { ...deps, clock: () => businessNowMs };

    const result = store.enqueue(PURCHASE(), clockDeps);
    assert.ok(result.promptId, 'a lock stale by real elapsed time must be broken so the write can proceed');
    assert.strictEqual(fs.existsSync(lockFile), false, 'the lock file is removed once the operation completes normally');

    const state = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8'));
    assert.strictEqual(state.lockBreaks.length, 1, 'breaking a stale lock must be recorded, not silent');
    assert.strictEqual(
      state.lockBreaks[0].at, new Date(businessNowMs).toISOString(),
      'the recorded break uses the injected business clock, consistent with every other timestamp this module writes'
    );
  });

  await check('an on-disk state file written before lockBreaks existed still loads (backward compatible)', () => {
    const deps = tempDeps();
    fs.writeFileSync(deps.stateFile, `${JSON.stringify({ version: 1, prompts: [], settled: [] })}\n`, 'utf8');
    const snapshot = store.snapshot(deps);
    assert.strictEqual(snapshot.ok, true, 'a pre-lockBreaks state file must not be treated as corrupt');
    // The field is backfilled going forward, not required retroactively.
    store.enqueue({ kind: 'notice', title: 'x', message: 'y', ttlMs: null }, deps);
    const state = JSON.parse(fs.readFileSync(deps.stateFile, 'utf8'));
    assert.deepStrictEqual(state.lockBreaks, []);
  });

  await check('an unreadable lockBreaks history is REFUSED rather than reported as empty', () => {
    const deps = tempDeps();
    fs.writeFileSync(deps.stateFile, `${JSON.stringify({ version: 1, prompts: [], settled: [], lockBreaks: null })}\n`, 'utf8');
    assert.throws(
      () => store.snapshot(deps),
      error => error.code === 'OWNER_PROMPT_STORE_CORRUPT'
    );
  });

  // -------------------------------------------------------------------------
  // The binding check: the renderer's own validator, against a real snapshot.
  // -------------------------------------------------------------------------
  const candidates = [
    process.env.MISSION_CONTROL_POPUP,
    // THE WORKING-FOLDER LAYOUT, MEASURED 2026-09-03: this engine checkout sits
    // beside the app checkout as siblings under one working folder, not under
    // Desktop\wt-installer or Desktop\mission-control -- neither legacy name
    // has existed in that role for a long time. With no candidate below ever
    // resolving, `rendererPath` was always undefined and this file's one load
    // -bearing check -- "the engine snapshot satisfies the renderer's OWN
    // validator", the exact regression this file's header names ("displayed
    // 'the owner prompt service is unavailable' forever") -- had not run a
    // single time in this working folder, in either possible outcome, while
    // still exiting 0. `wt-app-1.0.41-fixes` is the real, git-tracked
    // app-integration sibling this engine checkout is developed beside;
    // `app` is the working folder's base app checkout, kept as a second
    // sibling candidate for the same reason the pre-existing entries below
    // already tried more than one name.
    path.join(__dirname, '..', '..', 'wt-app-1.0.41-fixes', 'src', 'owner-popup.js'),
    path.join(__dirname, '..', '..', 'app', 'src', 'owner-popup.js'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'wt-installer', 'src', 'owner-popup.js'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'mission-control', 'src', 'owner-popup.js'),
    path.join(__dirname, '..', '..', 'wt-installer', 'src', 'owner-popup.js')
  ].filter(Boolean);
  const rendererPath = candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });

  if (!rendererPath) {
    skipped += 1;
    console.log('  SKIPPED  the engine snapshot satisfies the renderer\'s own validator');
    console.log('           Mission Control owner-popup.js not found. Looked in:');
    for (const candidate of candidates) console.log(`             ${candidate}`);
    console.log('           Set MISSION_CONTROL_POPUP to run this binding check.');
    console.log('           THIS CHECK DID NOT RUN. It is not a pass.');
  } else {
    let renderer = null;
    try { renderer = await import(pathToFileURL(rendererPath).href); }
    catch (error) {
      failures.push('import the renderer validator');
      console.log(`  FAIL import the renderer validator: ${error.message}`);
    }
    if (renderer) {
      console.log(`  using renderer: ${rendererPath}`);

      await check('the engine snapshot satisfies the renderer OWN validator', () => {
        const deps = tempDeps();
        store.enqueue(PURCHASE(), deps);
        store.enqueue({ kind: 'confirmation', title: 'Confirm this step', message: 'A single yes or no.', ttlMs: null }, deps);
        store.enqueue({ kind: 'notice', title: 'For your information', message: 'Nothing to decide.', ttlMs: null }, deps);
        const snapshot = store.snapshot(deps);
        // Throws on ANY shape disagreement, including unknown keys.
        const normalized = renderer.normalizeOwnerPromptSnapshot(snapshot);
        assert.strictEqual(normalized.prompts.length, 3);
        const purchase = normalized.prompts.find(prompt => prompt.kind === 'purchase_batch');
        assert.strictEqual(purchase.items.length, 3);
        assert.strictEqual(purchase.defaultDecision, 'deny', 'purchase batches must default to deny');
        const notice = normalized.prompts.find(prompt => prompt.kind === 'notice');
        assert.strictEqual(notice.defaultDecision, 'acknowledge');
      });

      await check('the engine theme manifest satisfies the renderer theme validator', () => {
        const deps = tempDeps();
        store.enqueue({ kind: 'notice', title: 'Theme probe', message: 'Checking the shared manifest.', ttlMs: null }, deps);
        const snapshot = store.snapshot(deps);
        const root = { style: { setProperty() {} }, dataset: {} };
        const applied = renderer.applyOwnerPopupTheme(root, snapshot.theme, 'tan');
        assert.strictEqual(applied, 'tan');
        assert.strictEqual(root.dataset.ownerTheme, 'tan');
      });

      await check('a decision body built by the renderer is accepted by the engine verbatim', () => {
        const deps = tempDeps();
        const { promptId } = store.enqueue(PURCHASE(), deps);
        store.markPresented({ promptId, evidence: presentEvidence() }, deps);
        const prompt = renderer.normalizeOwnerPromptSnapshot(store.snapshot(deps)).prompts[0];
        // Exactly what the popup's Submit button sends.
        const decisions = new Map([['dom-ai', 'approve'], ['dom-io', 'deny']]);
        const body = renderer.purchaseDecisionBody(prompt, decisions);
        const outcome = store.decide(body, deps);
        assert.strictEqual(outcome.approvedCount, 1);
        assert.strictEqual(outcome.deniedCount, 2, 'the line the owner never touched is denied');
        assert.strictEqual(outcome.approvedTotalCents, 7999);
      });
    }
  }

  console.log('');
  if (failures.length) {
    console.log(`owner-public-prompts: ${failures.length} FAILED, ${passed} passed, ${skipped} skipped`);
    process.exitCode = 1;
  } else {
    console.log(`owner-public-prompts: ${passed} checks passed${skipped ? `, ${skipped} SKIPPED (did not run)` : ''}`);
  }
}

main().catch(error => {
  console.error('owner-public-prompts: harness error', error);
  process.exitCode = 1;
});
