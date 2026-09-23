'use strict';

// "THE OPERATION STOPPED SAFELY BECAUSE OF AN INTERNAL ERROR" IS THE WRONG
// SENTENCE FOR A QUEUE THAT IS WAITING ON A HUMAN.
//
// MEASURED 2026-08-19, after the two-pass containment fix landed. That change
// rescued seven of the twenty OWNER_PROMPT_* codes from the INTERNAL_ERROR
// blanket, but four agent-facing members of runtime.js's
// OWNER_PROMPT_QUEUE_CODES allowlist still fell through it, because no rule in
// the ladder spoke about their condition phrases at all:
//
//   OWNER_PROMPT_IN_PROGRESS    a prompt is open and being answered right now
//   OWNER_PROMPT_QUEUE_BUSY     the queue's lock file is contended
//   OWNER_PROMPT_QUEUE_FULL     too many prompts pending; someone must decide
//   OWNER_PROMPT_QUEUE_FAILED   runtime.js's catch-all
//
// WHY THIS IS NOT A COSMETIC COMPLAINT. The owner-prompt queue is how an agent
// asks a person for a credential, and its single active slot can be held by one
// unanswered prompt (a real one sat about seventeen hours on 2026-08-11 and
// failed four unrelated tool calls). While it is held, every other credential
// path on the machine refuses -- and the only sentence the agent could render
// said "internal error", terminal, with nothing to act on. A person watching
// their agent fail had no way to learn that a stale dialog was the cause. The
// product's first external user reported exactly this shape: that agents "were
// not able to use credential manager or vault".
//
// THE DISTINCTION THIS TABLE EXISTS TO HOLD. A full queue is capacity almost
// everywhere in this tree -- TASK_QUEUE_FULL and
// three siblings drain on their own, so RESOURCE_PRESSURE is the honest class.
// The owner-prompt queue is the one that CANNOT drain on its own: it empties
// only when a person answers. So PROMPT_QUEUE_FULL is INPUT_REQUIRED and bare
// QUEUE_FULL is RESOURCE_PRESSURE, and an edit that collapses the two would
// tell five unrelated subsystems that a human must act, or tell the one that
// genuinely needs a human to just wait. Both directions are lies.
//
// The same split applies to "already running": BROWSER_OWNER_START_IN_PROGRESS
// finishes by itself (UNAVAILABLE, retry), while CREDENTIAL_CAPTURE_IN_PROGRESS
// and OWNER_PROMPT_IN_PROGRESS are open dialogs a person must close.
//
// Measured over the 3,977 distinct source codes in this tree: these tokens
// rescue 34 codes from INTERNAL_ERROR and move ZERO already-classified ones,
// which is the two-pass design's contract.
//
// Run: node tests/owner-prompt-queue-refusals-name-their-condition.test.js

const assert = require('node:assert/strict');
const errorTaxonomy = require('../src/lib/error-taxonomy');

function mapped(code) {
  return errorTaxonomy.publicFailure({ code, message: 'irrelevant provider prose' }).code;
}

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok: ${label}`); }
  catch (error) {
    failures += 1;
    console.error(`  FAIL: ${label}\n    ${error.message}`);
  }
}

console.log('owner-prompt queue: a refusal names its condition instead of claiming a fault');

// --- 1. THE FOUR THAT WERE STILL BLANKETED ----------------------------------
const STILL_BLANKETED = Object.freeze({
  OWNER_PROMPT_IN_PROGRESS: 'INPUT_REQUIRED',
  OWNER_PROMPT_QUEUE_BUSY: 'UNAVAILABLE',
  OWNER_PROMPT_QUEUE_FULL: 'INPUT_REQUIRED',
});
for (const [code, expected] of Object.entries(STILL_BLANKETED)) {
  check(`${code} -> ${expected}`, () => {
    assert.equal(mapped(code), expected,
      `${code} still renders as ${mapped(code)}; an agent blocked by this cannot tell a stale dialog from a broken tool`);
  });
}

// OWNER_PROMPT_QUEUE_FAILED IS DELIBERATELY LEFT ALONE, and this assertion
// pins that decision so a later "consistency" pass does not quietly reclassify
// it. runtime.js returns it when a queue error's code is off the allowlist OR
// its message fails the prose regex -- that is our own surfacing layer giving
// up, and we genuinely do not know what happened underneath. INTERNAL_ERROR is
// the true statement there. Claiming a more specific class would be inventing
// knowledge we refused to accept two lines earlier.
check('OWNER_PROMPT_QUEUE_FAILED stays INTERNAL_ERROR, because that is what it is', () => {
  assert.equal(mapped('OWNER_PROMPT_QUEUE_FAILED'), 'INTERNAL_ERROR');
});

// --- 2. THE CONDITION IS THE RULE, NOT THE SUBSYSTEM ------------------------
// Each of these composes the same condition under a different subsystem. If the
// fix were another one-code patch they would still be blanketed.
const CONTENDED = Object.freeze([
  'OWNER_PROMPT_STORE_BUSY', 'AGENT_CONFINEMENT_CREDENTIAL_BUSY', 'CLAUDE_ADAPTER_BUSY',
  'SQLITE_BUSY', 'BRIDGE_ALL_SEATS_BUSY', 'OWNER_CHAT_BUSY',
  'BRIDGE_TERMINATE_IN_PROGRESS', 'BROWSER_OWNER_START_IN_PROGRESS', 'DUO_DESKTOP_LOGIN_IN_PROGRESS',
]);
for (const code of CONTENDED) {
  check(`${code} -> UNAVAILABLE (retry; nobody has to do anything)`, () => {
    assert.equal(mapped(code), 'UNAVAILABLE');
  });
}

// --- 3. THE SPLIT THAT MUST NOT BE COLLAPSED --------------------------------
check('a full task queue is capacity, not a request for input', () => {
  for (const code of ['TASK_QUEUE_FULL', 'OVERNIGHT_ADVISORY_QUEUE_FULL',
    'HOME_NODE_LOCAL_QUEUE_FULL', 'ONLINE_MAINTENANCE_QUEUE_FULL']) {
    assert.equal(mapped(code), 'RESOURCE_PRESSURE',
      `${code} says a person must act; that queue drains on its own`);
  }
});
check('the owner-prompt queue is the one that only a person can drain', () => {
  assert.equal(mapped('OWNER_PROMPT_QUEUE_FULL'), 'INPUT_REQUIRED');
  assert.notEqual(mapped('OWNER_PROMPT_QUEUE_FULL'), mapped('TASK_QUEUE_FULL'),
    'the two full-queue stories have collapsed into one; one of them is now a lie');
});
check('an open dialog waits for a person; an already-running start does not', () => {
  assert.equal(mapped('CREDENTIAL_CAPTURE_IN_PROGRESS'), 'INPUT_REQUIRED');
  assert.equal(mapped('OWNER_PROMPT_IN_PROGRESS'), 'INPUT_REQUIRED');
  assert.equal(mapped('BROWSER_OWNER_START_IN_PROGRESS'), 'UNAVAILABLE');
});

// --- 4. THE 2026-08-11 PATCHES ARE STILL LOAD-BEARING -----------------------
// These two were exact-code patches; generalising the rule around them must not
// change what they answer. Neither shares a whole segment with any rule value,
// so containment does not cover them -- deleting them as "now redundant" would
// silently re-blanket the deadlock they were written for.
check('the two exact owner-prompt patches keep their classification', () => {
  assert.equal(mapped('OWNER_PROMPT_DIFFERENT_ACTIVE'), 'INPUT_REQUIRED');
  assert.equal(mapped('OWNER_PROMPT_QUEUED'), 'INPUT_REQUIRED');
});
check('OWNER_PROMPT_ATTRIBUTION_REQUIRED is still a policy decision, not missing input', () => {
  assert.equal(mapped('OWNER_PROMPT_ATTRIBUTION_REQUIRED'), 'POLICY_DENIED');
});

// --- 5. FAIL-CLOSED STAYS FAIL-CLOSED ---------------------------------------
check('a code no rule speaks about still answers INTERNAL_ERROR', () => {
  assert.equal(mapped('SOMETHING_NOBODY_HAS_A_RULE_ABOUT'), 'INTERNAL_ERROR');
});
check('partial words never match a condition token', () => {
  for (const code of ['REPORT_BUSYWORK', 'BUSYWORK', 'PROGRESS_REPORT_STALLED', 'QUEUE_FULLNESS_UNKNOWN']) {
    assert.equal(mapped(code), 'INTERNAL_ERROR',
      `${code} matched a token on a partial word and answered ${mapped(code)}`);
  }
});
check('prose in the message never classifies anything', () => {
  assert.equal(errorTaxonomy.publicFailure({
    code: 'SOMETHING_NOBODY_HAS_A_RULE_ABOUT',
    message: 'the owner prompt queue is busy and in progress and full',
  }).code, 'INTERNAL_ERROR');
});

console.log(failures === 0
  ? '\n✅ owner-prompt queue refusals: all checks passed'
  : `\n❌ ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
