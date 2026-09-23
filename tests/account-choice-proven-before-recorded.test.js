'use strict';
/* An account becomes this computer's active one only once it can actually be
 * handed to a session.
 *
 * WHAT WENT WRONG. resolveForLaunch records its choice itself unless it is told
 * not to, and the agent-start path let it. So the account was written to the
 * rotation record -- as `activeAccount`, and therefore as the head of the next
 * start's order -- at the moment it was CHOSEN. Everything that can still
 * refuse it happens after that: the chosen account's folder still has to
 * resolve, and when it cannot, the same function answers `account: null` and
 * "the usual sign-in is used". The session then ran as nobody while the record
 * named an account it had never used, and every start after it preferred that
 * same account.
 *
 * Seen from outside that is: agents moved onto an account before anything
 * checked it could take them, sessions ending on their first turn, and the
 * fleet staying pointed at the account that had just failed.
 *
 * WHY NO EXISTING SUITE CAUGHT IT. The switcher's own tests prove
 * commitLaunchSelection writes what it is given and that persistSelection:false
 * holds the write back. Both were right. Nothing asserted which of the two
 * rotation.js asks for, so the whole feature sat one argument away from the
 * caller that needed it.
 *
 * The registry, the rotation record and the account homes here are all made in
 * a fresh temporary directory. No account of the operator's is read.
 *
 *   node --test tests/account-choice-proven-before-recorded.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { STATUS } = require('../src/lib/multi-account/health.js');

/* The state root is read once per process by registry-location.js, so it is
   set before rotation.js is required and left alone afterwards. */
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-proof-root-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;

const { CODE, STATE_LEAF, resolveAccountForSession } = require('../src/lib/multi-account/rotation.js');

const REGISTRY_FILE = path.join(STATE_ROOT, 'config', 'accounts.json');

/* The directory is written by the caller: an absolute one resolves, a relative
   one with no home directory known does not, and that is the whole difference
   between the two halves of this file. A Codex entry names it `profileDir`,
   which is the field its own registry rule requires. */
function writeRegistry(profileDir) {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, `${JSON.stringify({
    exhaustedAtPercent: 90,
    accounts: [{ provider: 'codex', name: 'accta', profileDir, priority: 1 }]
  }, null, 2)}\n`);
}

/* A signed-in home with room to spare. The probe is injected, so no provider
   program is started and nothing is measured for real. */
function healthyProbe() {
  return async account => Object.freeze({
    account: account.name,
    email: 'accta@example.test',
    usedPercent: 10,
    resetsAt: null,
    planType: 'pro',
    windows: { hourly: null, weekly: null },
    status: STATUS.HEALTHY,
    canServe: true,
    reason: 'Room left.'
  });
}

function freshServicesRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-proof-services-'));
}

function recordedState(servicesRoot) {
  const file = path.join(servicesRoot, STATE_LEAF);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('an account whose folder cannot be worked out is never recorded as the active one', async () => {
  /* A relative directory and no home directory to resolve it against. The
     account is listed, it is healthy, it is chosen -- and it cannot be handed
     to a session, which is exactly the gap the record used to be written in. */
  writeRegistry('codex-homes/accta');
  const servicesRoot = freshServicesRoot();

  const answer = await resolveAccountForSession({
    provider: 'codex',
    servicesRoot,
    homeDir: '',
    mode: 'auto',
    probe: healthyProbe()
  });

  assert.equal(answer.rotated, false, 'the folder could not be resolved, so no account was handed over');
  assert.equal(answer.account, null);
  assert.equal(answer.env, null);
  // Linux's profile boundary refuses an unresolved folder explicitly; it
  // does not claim the default sign-in was selected after a failed lookup.
  assert.equal(answer.code, process.platform === 'linux' ? CODE.UNREADABLE : CODE.NONE_FOR_PROVIDER);

  const state = recordedState(servicesRoot);
  const active = state && (state.activeAccount || (state.activeByProvider || {}).codex);
  assert.notEqual(active, 'accta',
    'the account the session never used must not be this computer\'s active one, nor the next start\'s preference');
});

test('an account that can be handed to a session is still recorded, exactly as before', async () => {
  /* The positive control. Holding the write back is only correct if the write
     still happens on the path that works; a change that recorded nothing would
     pass the test above and break rotation entirely. */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-proof-home-'));
  writeRegistry(home);
  const servicesRoot = freshServicesRoot();

  const answer = await resolveAccountForSession({
    provider: 'codex',
    servicesRoot,
    homeDir: '',
    mode: 'auto',
    probe: healthyProbe()
  });

  assert.equal(answer.rotated, true, 'an absolute home resolves, so the account is handed over');
  assert.equal(answer.account.name, 'accta');
  assert.equal(answer.account.resolvedHome, path.resolve(home));
  assert.equal(answer.env.CODEX_HOME, path.resolve(home));

  const state = recordedState(servicesRoot);
  assert.ok(state, 'the rotation record must exist after a successful start');
  const active = state.activeAccount || (state.activeByProvider || {}).codex;
  assert.equal(active, 'accta', 'the account that was actually handed over is the active one');
  assert.ok(Array.isArray(state.history) && state.history.some(entry => entry.outcome === 'selected'),
    'the successful start is still written to the history');
});

test('rotation asks for the choice to be held back, and commits it itself', () => {
  /* The structural half. The behaviour above depends on one argument at each
     call site, and dropping it restores the old order silently: every suite
     still passes, because the account is still chosen and still handed over.
     Only the moment of the write moves. */
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'lib', 'multi-account', 'rotation.js'), 'utf8'
  );

  const calls = source.split('resolveForLaunch({').length - 1;
  assert.equal(calls, 2, 'this file expects the two agent-start call sites; a third needs the same argument');
  const held = source.split('persistSelection: false').length - 1;
  assert.equal(held, calls,
    'every resolveForLaunch call on the start path must resolve without recording');

  const commit = source.indexOf('commitLaunchSelection(');
  const prove = source.indexOf('const answer = selected(');
  assert.ok(prove > 0 && commit > prove,
    'the commit must come after the answer that can still refuse the account');
});
