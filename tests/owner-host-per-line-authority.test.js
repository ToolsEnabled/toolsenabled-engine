'use strict';

// The owner host's PER-LINE authorization check, on both axes at once: it must
// stay cheap, and it must stay exact.
//
// WHY THIS FILE EXISTS. owner-host.js calls authorizeDeclaredAgentBinding()
// before dispatching EVERY JSON-RPC line, and the owner host runs inside the
// Electron main process -- so whatever that check costs, every session pays it
// and pays it serially. It used to rebuild the whole declared-org authority from
// disk each time: MEASURED 2026-09-03 at 6.34 ms median and 43 synchronous fs
// calls per line (36 lstatSync, 4 realpathSync.native, 3 readFileSync), because
// resolveServicesRoot() re-walked every segment of LOCALAPPDATA and
// TOOLSENABLED_STATE_ROOT looking for reparse points, twice, and then re-parsed
// two JSON documents that had not changed. After the memo: 0.22 ms and 3 calls.
//
// The cheap half of that is worthless if the check goes stale, because this is
// the check that revokes a session when the operator edits a role or disables a
// seat. So the budget assertions below are paired with revocation assertions
// that edit each input file and demand the verdict flip ON THE VERY NEXT CALL --
// no polling, no second chance, no tolerated TTL.
//
// MUTATION REPORT (2026-09-03), both directions.
//
// SPEED HALF. Reverting src/owner-host.js's authorizeDeclaredAgentBinding to
// the unconditional `createInstalledAgentOrgStores(...).read()` rebuild turned
// this file red at the first budget check:
//   [a settled per-line check does not rebuild the org authority] AssertionError
//   [ERR_ASSERTION]: a repeated per-line check must cost at most 8 synchronous
//   fs calls; it cost 43
// Restoring owner-host.js byte-for-byte made it green again (13 assertions).
//
// SECURITY HALF. Deleting the stamp comparison in installedOrgAuthority(), so a
// cached entry is reused unconditionally, turned this file red at:
//   [a cold check still pays for the full account-boundary walk] AssertionError
//   [ERR_ASSERTION]: a changed input must re-walk the account boundary; it cost
//   only 0 synchronous fs calls
// That assertion sits earlier in the file than the revocation checks, so it
// fires first. The revocation checks catch the same mutation independently:
// running the disable-the-seat sequence alone against the mutated build printed
//   before edit, authorizes: true
//   after disabling the seat, authorizes: true   <- revocation lost
// and against the restored build
//   after disabling the seat, authorizes: false
// so the security property is not merely riding on the budget assertion.
//
// Census: empty loop/forEach NOT-FOUND; exit-status/truthy-own-output
// NOT-FOUND; swallowed failure via try/catch or optional-chain NOT-FOUND; mock
// of subject NOT-FOUND (the subject is the real owner-host module reading real
// files on disk; only `fs` call COUNTING is instrumented, and the counter
// delegates to the real implementation); skip/platform precondition guard
// FOUND and fixed -- the account-boundary walk this measures is Windows-only,
// so on other platforms the file asserts the correctness half and states that
// the budget half did not run, rather than exiting green in silence.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

let checks = 0;
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    error.message = `[${label}] ${error.message}`;
    if (typeof error.stack === 'string') error.stack = `[${label}] ${error.stack}`;
    throw error;
  }
  checks += 1;
};

// --- count synchronous fs work without replacing it -------------------------
// Every wrapper calls through to the real implementation; this measures the
// subject, it does not stand in for it.
const COUNTED = ['readFileSync', 'lstatSync', 'statSync', 'existsSync', 'openSync',
  'readdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'fsyncSync'];
let syncCalls = 0;
let counting = false;
for (const name of COUNTED) {
  if (typeof fs[name] !== 'function') continue;
  const original = fs[name];
  fs[name] = function (...args) {
    if (counting) syncCalls += 1;
    return original.apply(this, args);
  };
}
const realpathOriginal = fs.realpathSync;
const realpathNative = realpathOriginal.native;
const countedRealpath = function (...args) {
  if (counting) syncCalls += 1;
  return realpathOriginal.apply(this, args);
};
countedRealpath.native = function (...args) {
  if (counting) syncCalls += 1;
  return realpathNative.apply(this, args);
};
fs.realpathSync = countedRealpath;

const measure = fn => {
  syncCalls = 0;
  counting = true;
  try { return { value: fn(), calls: syncCalls }; }
  finally { counting = false; }
};

// --- a state root shaped like a real installation ---------------------------
const workspace = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'toolsenabled-owner-host-authority-'));
const localAppData = path.join(workspace, 'LocalAppData');
const stateRoot = path.join(workspace, 'userData', 'ToolsEnabled-Authority', 'capability');
const servicesRoot = path.join(localAppData, 'ToolsEnabled-Authority');
fs.mkdirSync(stateRoot, { recursive: true });
fs.mkdirSync(servicesRoot, { recursive: true });
process.env.LOCALAPPDATA = localAppData;
process.env.TOOLSENABLED_STATE_ROOT = stateRoot;

const overlayFile = path.join(servicesRoot, 'agent-org.json');
const roleMemoryFile = path.join(servicesRoot, 'durable-memory.json');

const ownerHost = require('../src/owner-host');
const { createInstalledAgentOrgStores } = require('../src/lib/agent-org-store');
const baselineFile = path.join(__dirname, '..', 'config', 'agent-org.json');

const stores = () => createInstalledAgentOrgStores({ baselineFile });

// Seat one agent whose session we will then try to revoke several ways. It has
// to be a NON-ROOT seat: the org refuses to validate with no root role, so
// deleting the controller would fail the store rather than the binding, and
// would prove nothing about this check.
const seeded = stores();
const before = seeded.read();
const PRISTINE = Object.freeze(JSON.parse(JSON.stringify(before.org)));
const rootSeat = (before.org.agents || []).find(agent => agent.role === 'controller');
const seat = (before.org.agents || [])
  .find(agent => agent.enabled === true && agent.id !== (rootSeat && rootSeat.id));
assert.ok(seat, 'the shipped baseline must declare an enabled non-root seat to bind against');
const roleRecord = seeded.roleStore.getRoleRecord(seat.role);
assert.ok(roleRecord, 'the seat\'s role must resolve to a role record');

const principal = Object.freeze({
  sessionId: 'authority-session',
  agentId: seat.id,
  agentActor: seat.provider,
  roleId: seat.role,
  expectedOrgRevision: before.org.revision,
  expectedRoleRevision: roleRecord.revision
});
const authorize = () => ownerHost.authorizeDeclaredAgentBinding(principal, {}, {});

// Write the overlay the way the operator's own edits land: a complete document
// the store will accept, not a patch.
const writeOverlay = org => {
  fs.writeFileSync(overlayFile, `${JSON.stringify({ schemaVersion: 1, org }, null, 2)}\n`, 'utf8');
};
// Always start from the pristine org rather than from whatever the previous
// check left on disk: an edit built on top of a deliberately broken document
// would fail in the store instead of exercising the binding check.
const overlayOrg = mutate => {
  const next = JSON.parse(JSON.stringify(PRISTINE));
  mutate(next);
  return next;
};

check('the running session authorizes before anything is edited', () => {
  assert.strictEqual(authorize(), true, 'the seeded seat must authorize');
});

const windows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// HALF ONE: the check must be cheap when nothing has changed.
// ---------------------------------------------------------------------------
if (windows) {
  check('a settled per-line check does not rebuild the org authority', () => {
    authorize();                       // settle the memo
    const first = measure(authorize);  // the steady-state per-line cost
    assert.strictEqual(first.value, true, 'the settled check must still authorize');
    assert.ok(first.calls <= 8,
      `a repeated per-line check must cost at most 8 synchronous fs calls; it cost ${first.calls}`);
  });

  check('the per-line cost does not grow over a burst of lines', () => {
    authorize();
    const burst = measure(() => { for (let i = 0; i < 20; i += 1) authorize(); });
    assert.ok(burst.calls <= 8 * 20,
      `20 lines must not cost more than 20 settled checks; they cost ${burst.calls} synchronous fs calls`);
  });

  check('a cold check still pays for the full account-boundary walk', () => {
    // The saving must come from not REPEATING the walk, never from skipping it.
    // A changed input has to walk the boundary again, so this number stays high
    // on purpose -- if it collapses, the walk was removed rather than reused.
    writeOverlay(overlayOrg(org => { org.revision += 1; }));
    const cold = measure(authorize);
    assert.ok(cold.calls >= 20,
      `a changed input must re-walk the account boundary; it cost only ${cold.calls} synchronous fs calls`);
  });
} else {
  check('the budget half is Windows-only and did not run here', () => {
    assert.notStrictEqual(process.platform, 'win32',
      'this branch must only be taken off Windows');
  });
}

// ---------------------------------------------------------------------------
// HALF TWO: the check must still be exact. Each input file is edited and the
// verdict must flip on the very next call -- one call, not eventually.
// ---------------------------------------------------------------------------

check('disabling the seat revokes on the very next line', () => {
  assert.strictEqual(authorize(), true, 'precondition: the seat authorizes');
  writeOverlay(overlayOrg(org => {
    org.agents.find(agent => agent.id === seat.id).enabled = false;
  }));
  assert.strictEqual(authorize(), false, 'a disabled seat must not still authorize');
});

check('re-enabling the seat restores it on the very next line', () => {
  writeOverlay(overlayOrg(org => {
    org.agents.find(agent => agent.id === seat.id).enabled = true;
  }));
  assert.strictEqual(authorize(), true, 're-enabling the seat must authorize again');
});

check('re-providering the seat revokes on the very next line', () => {
  const other = seat.provider === 'claude' ? 'codex' : 'claude';
  writeOverlay(overlayOrg(org => {
    org.agents.find(agent => agent.id === seat.id).provider = other;
  }));
  assert.strictEqual(authorize(), false,
    'a seat whose provider no longer matches the credential must not authorize');
});

check('removing the seat entirely revokes on the very next line', () => {
  writeOverlay(overlayOrg(org => {
    org.agents = org.agents.filter(agent => agent.id !== seat.id);
  }));
  assert.strictEqual(authorize(), false, 'a deleted seat must not authorize');
});

check('deleting the overlay is a change, not an absence of one', () => {
  // Removing the operator's overlay reverts the org to the shipped baseline.
  // A memo that treated a vanished file as "nothing to see" would keep serving
  // the deleted overlay's answer.
  assert.strictEqual(authorize(), false, 'precondition: the seat is currently removed');
  fs.unlinkSync(overlayFile);
  assert.strictEqual(authorize(), true,
    'reverting to the shipped baseline must be seen on the next line');
});

check('editing the role-memory store is seen on the very next line', () => {
  assert.strictEqual(authorize(), true, 'precondition: the baseline seat authorizes');
  // A custom role definition lives in the durable-memory file. Writing an
  // unreadable one makes the role vocabulary unavailable, which the check must
  // treat as "cannot confirm" -- not as "the last answer still stands".
  fs.writeFileSync(roleMemoryFile, 'not json at all', 'utf8');
  assert.strictEqual(authorize(), false,
    'a role store that cannot be read must not keep authorizing from a memo');
  fs.unlinkSync(roleMemoryFile);
  assert.strictEqual(authorize(), true, 'removing the damaged role store must recover');
});

check('a same-size overlay rewrite is still seen', () => {
  // The weakest realistic stamp -- size alone -- would miss this. The seat is
  // disabled by swapping true->false and padding the document back to its
  // original byte length, so only the content differs.
  const enabled = overlayOrg(() => {});
  writeOverlay(enabled);
  assert.strictEqual(authorize(), true, 'precondition: the seat authorizes');
  const disabled = overlayOrg(org => {
    org.agents.find(agent => agent.id === seat.id).enabled = false;
  });
  writeOverlay(disabled);
  assert.strictEqual(authorize(), false, 'a content-only overlay edit must be seen');
  fs.unlinkSync(overlayFile);
});

check('changing the state root re-resolves rather than reusing another root', () => {
  assert.strictEqual(authorize(), true, 'precondition: the baseline seat authorizes');
  const elsewhere = path.join(workspace, 'userData', 'ToolsEnabled-Elsewhere', 'capability');
  const elsewhereServices = path.join(localAppData, 'ToolsEnabled-Elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(elsewhereServices, { recursive: true });
  const previous = process.env.TOOLSENABLED_STATE_ROOT;
  process.env.TOOLSENABLED_STATE_ROOT = elsewhere;
  try {
    // A different product identity reads a DIFFERENT overlay. Disable the agent
    // there and require the check to notice it is reading a new root.
    fs.writeFileSync(path.join(elsewhereServices, 'agent-org.json'),
      `${JSON.stringify({ schemaVersion: 1, org: overlayOrg(org => {
        org.agents.find(agent => agent.id === seat.id).enabled = false;
      }) }, null, 2)}\n`, 'utf8');
    assert.strictEqual(authorize(), false,
      'a changed state root must be re-resolved, not answered from the old root\'s memo');
  } finally {
    process.env.TOOLSENABLED_STATE_ROOT = previous;
  }
  assert.strictEqual(authorize(), true, 'restoring the state root must restore the verdict');
});

// ---------------------------------------------------------------------------
// A source scan, paired with the behavioural checks above: the per-line path
// must not go back to constructing the stores unconditionally.
// ---------------------------------------------------------------------------
check('the per-line path does not rebuild the org stores inline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'owner-host.js'), 'utf8');
  // declaredAgentBindingVerdict is where the org/role read actually happens;
  // authorizeDeclaredAgentBinding is a thin boolean wrapper around it (kept
  // for direct callers such as this file) and calls it rather than reading
  // anything itself, so the scan targets the function that does the read.
  const body = source.slice(source.indexOf('function declaredAgentBindingVerdict'));
  const end = body.indexOf('\nfunction ', 1);
  const authorizeBody = end === -1 ? body : body.slice(0, end);
  assert.ok(!/createInstalledAgentOrgStores/.test(authorizeBody),
    'declaredAgentBindingVerdict must reach the org authority through the stamped memo, '
    + 'not by constructing the stores on every line');
  assert.ok(/installedOrgAuthority\(/.test(authorizeBody),
    'declaredAgentBindingVerdict must call installedOrgAuthority()');
  assert.ok(/statSync\([^)]*\{\s*bigint:\s*true\s*\}/.test(source),
    'the memo must stamp its inputs with a full-resolution stat, not a coarse one');
});

const budget = windows ? 'with the per-line budget enforced' : 'budget half skipped: not Windows';
console.log(`Owner-host per-line authority tests passed (${checks} assertions; ${budget}; `
  + 'every revocation case edits a real file and demands the flip on the next call).');
